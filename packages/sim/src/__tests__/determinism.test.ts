import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBattle } from '../battle';
import { hashState } from '../hash';
import { idleBrain } from '../brain';
import { runBattle, step } from '../step';
import { calm, duel, loadDefaultParams } from './helpers';
import type { StanceInput } from '../types';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

describe('determinism', () => {
  const params = loadDefaultParams();
  const scenario = duel(
    [
      { type: 'infantry', commander: calm, x: 300, y: 500, stance: 'hold' },
      { type: 'artillery', commander: calm, x: 200, y: 400, stance: 'hold' },
    ],
    [
      { type: 'infantry', commander: calm, x: 380, y: 500, stance: 'hold', facingDeg: 180 },
      { type: 'infantry', commander: calm, x: 380, y: 600, stance: 'hold', facingDeg: 180 },
    ],
  );
  const inputs: StanceInput[] = [
    { tick: 100, unitId: 2, stance: 'assault' },
    { tick: 600, unitId: 0, stance: 'withdraw' },
    { tick: 900, unitId: 0, stance: 'rally' },
  ];

  it('same seed + same inputs => same hash', () => {
    const s1 = runBattle(createBattle(scenario, params, 11), params, inputs, { brain: idleBrain, maxTicks: 3000 });
    const s2 = runBattle(createBattle(scenario, params, 11), params, inputs, { brain: idleBrain, maxTicks: 3000 });
    expect(hashState(s1)).toBe(hashState(s2));
    expect(s1.events.length).toBe(s2.events.length);
    // Something actually happened in there.
    expect(s1.events.some((e) => e.kind === 'stance_player')).toBe(true);
    expect(s1.units.some((u) => u.casualties > 0)).toBe(true);
  });

  it('different seeds => different hash', () => {
    const s1 = runBattle(createBattle(scenario, params, 11), params, inputs, { brain: idleBrain, maxTicks: 3000 });
    const s2 = runBattle(createBattle(scenario, params, 12), params, inputs, { brain: idleBrain, maxTicks: 3000 });
    expect(hashState(s1)).not.toBe(hashState(s2));
  });

  it('is independent of how the ticks are batched', () => {
    const a = createBattle(scenario, params, 5);
    const b = createBattle(scenario, params, 5);
    for (let i = 0; i < 1500; i++) step(a, params, inputs, { brain: idleBrain });
    runBattle(b, params, inputs, { brain: idleBrain, maxTicks: 1500 });
    expect(hashState(a)).toBe(hashState(b));
  });

  it('step is a no-op after the battle has ended', () => {
    const s = runBattle(createBattle(scenario, params, 2), params, inputs, { brain: idleBrain });
    expect(s.result).not.toBeNull();
    const h = hashState(s);
    step(s, params, [], { brain: idleBrain });
    expect(hashState(s)).toBe(h);
  });

  it('sim and ai sources never call Math.random', () => {
    const roots = [resolve(__dirname, '..'), resolve(__dirname, '../../../ai/src')];
    for (const r of roots) {
      for (const f of walk(r)) {
        expect(readFileSync(f, 'utf8').includes('Math.random'), `${f} uses Math.random`).toBe(false);
      }
    }
  });
});
