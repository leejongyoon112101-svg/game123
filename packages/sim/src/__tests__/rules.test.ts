import { describe, expect, it } from 'vitest';
import { createBattle } from '../battle';
import { idleBrain } from '../brain';
import { strengthOf } from '../queries';
import { runBattle, step } from '../step';
import { calm, duel, loadDefaultParams } from './helpers';

describe('sim rules', () => {
  const params = loadDefaultParams();

  it('two facing infantry units in range shoot each other and someone routs', () => {
    const sc = duel(
      [{ type: 'infantry', commander: calm, x: 300, y: 500, stance: 'hold' }],
      [{ type: 'infantry', commander: calm, x: 360, y: 500, stance: 'hold', facingDeg: 180 }],
    );
    const s = runBattle(createBattle(sc, params, 1), params, [], { brain: idleBrain, maxTicks: 6000 });
    expect(s.result).not.toBeNull();
    expect(s.events.some((e) => e.kind === 'rout')).toBe(true);
    expect(s.units.every((u) => u.casualties > 0)).toBe(true);
  });

  it('a unit in forest takes fewer casualties than one in the open', () => {
    const open = duel(
      [{ type: 'infantry', commander: calm, x: 300, y: 500, stance: 'hold' }],
      [{ type: 'infantry', commander: calm, x: 380, y: 500, stance: 'hold', facingDeg: 180 }],
    );
    const wood = { ...open, terrain: [{ kind: 'forest' as const, x: 340, y: 450, w: 100, h: 100 }] };
    let openCas = 0;
    let woodCas = 0;
    for (let seed = 0; seed < 20; seed++) {
      const a = createBattle(open, params, seed);
      const b = createBattle(wood, params, seed);
      for (let i = 0; i < 600; i++) {
        step(a, params, [], { brain: idleBrain, skipSoldiers: true });
        step(b, params, [], { brain: idleBrain, skipSoldiers: true });
      }
      openCas += a.units[1]!.casualties;
      woodCas += b.units[1]!.casualties;
    }
    expect(woodCas).toBeLessThan(openCas * 0.8);
  });

  it('player stance input changes the stance and starts a formation change', () => {
    const sc = duel([{ type: 'infantry', commander: calm, x: 300, y: 500, stance: 'hold' }], [{ type: 'infantry', commander: calm, x: 900, y: 500, stance: 'hold' }]);
    const s = createBattle(sc, params, 1);
    step(s, params, [{ tick: 0, unitId: 0, stance: 'withdraw' }], { brain: idleBrain });
    const u = s.units[0]!;
    expect(u.stance).toBe('withdraw');
    expect(u.formationTarget).toBe('column');
    expect(u.formationChangeRemaining).toBeGreaterThan(0);
    expect(s.events.some((e) => e.kind === 'stance_player')).toBe(true);
  });

  it('routing units flee to their rear edge and exit', () => {
    const sc = duel(
      [
        { type: 'infantry', commander: calm, x: 100, y: 500, stance: 'hold' },
        { type: 'infantry', commander: calm, x: 100, y: 300, stance: 'hold' },
        { type: 'infantry', commander: calm, x: 100, y: 700, stance: 'hold' },
      ],
      [{ type: 'infantry', commander: calm, x: 900, y: 500, stance: 'hold' }],
    );
    const s = createBattle(sc, params, 1);
    s.units[0]!.morale = 5; // force collapse
    // Keep the enemy far so morale never recovers past the rally threshold.
    let exited = false;
    for (let i = 0; i < 3000 && !exited; i++) {
      step(s, params, [], { brain: idleBrain, skipSoldiers: true });
      exited = s.units[0]!.exited;
    }
    expect(s.events.some((e) => e.kind === 'rout' && e.unitId === 0)).toBe(true);
    expect(exited || s.units[0]!.stance === 'rally').toBe(true);
    expect(strengthOf(s.units[0]!)).toBeGreaterThan(0);
  });

  it('ends by available-unit ratio', () => {
    const sc = duel([{ type: 'infantry', commander: calm, x: 100, y: 500, stance: 'hold' }], [{ type: 'infantry', commander: calm, x: 900, y: 500, stance: 'hold' }]);
    const s = createBattle(sc, params, 1);
    s.units[0]!.morale = 0;
    step(s, params, [], { brain: idleBrain });
    expect(s.result?.winner).toBe(1);
    expect(s.result?.reason).toBe('available');
  });
});

describe('sim rules: withdraw and pursuit', () => {
  const params = loadDefaultParams();

  it('a withdrawing unit stops at its rally line instead of leaving the map', () => {
    const sc = duel(
      [
        { type: 'infantry', commander: calm, x: 300, y: 500, stance: 'withdraw' },
        { type: 'infantry', commander: calm, x: 300, y: 300, stance: 'hold' },
        { type: 'infantry', commander: calm, x: 300, y: 700, stance: 'hold' },
      ],
      [{ type: 'infantry', commander: calm, x: 1200, y: 500, stance: 'hold' }],
    );
    const s = createBattle(sc, params, 1);
    // Drive the withdraw with a minimal brain: move to the rear point.
    const brain = (state: typeof s, u: (typeof s.units)[number]) => {
      if (u.stance !== 'withdraw') return { action: { kind: 'idle' as const } };
      const dir = state.sideRearDir[u.side];
      const x = dir < 0 ? params.stance.withdrawRearMargin : params.map.width - params.stance.withdrawRearMargin;
      return { action: { kind: 'move' as const, x, y: u.formation.y, charge: false } };
    };
    for (let i = 0; i < 3000; i++) step(s, params, [], { brain, skipSoldiers: true });
    const u = s.units[0]!;
    expect(u.exited).toBe(false);
    expect(u.formation.x).toBeGreaterThanOrEqual(params.stance.withdrawRearMargin - 5);
    expect(u.formation.x).toBeLessThanOrEqual(params.stance.withdrawRearMargin + 5);
  });

  it('pursuing a routing unit announces the charge once and cuts men down over time', () => {
    const sc = duel(
      [{ type: 'cavalry', commander: calm, x: 700, y: 500, stance: 'assault' }],
      [
        { type: 'infantry', commander: calm, x: 760, y: 500, stance: 'hold', facingDeg: 180 },
        { type: 'infantry', commander: calm, x: 1300, y: 300, stance: 'hold', facingDeg: 180 },
        { type: 'infantry', commander: calm, x: 1300, y: 700, stance: 'hold', facingDeg: 180 },
      ],
    );
    const s = createBattle(sc, params, 1);
    s.units[1]!.morale = 0; // routs on the first tick
    const brain = (_state: typeof s, u: (typeof s.units)[number]) =>
      u.type === 'cavalry' ? { action: { kind: 'charge' as const, targetId: 1 } } : { action: { kind: 'idle' as const } };
    for (let i = 0; i < 300; i++) step(s, params, [], { brain, skipSoldiers: true });
    const charges = s.events.filter((e) => e.kind === 'charge_start' && e.unitId === 0).length;
    expect(charges).toBe(1);
    expect(s.units[1]!.casualties).toBeGreaterThan(3);
    expect(s.events.filter((e) => e.kind === 'melee_start').length).toBe(0);
  });
});
