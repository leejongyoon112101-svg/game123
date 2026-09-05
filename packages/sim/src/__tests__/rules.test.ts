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
