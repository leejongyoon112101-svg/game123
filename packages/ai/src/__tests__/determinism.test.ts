import { describe, expect, it } from 'vitest';
import { hashState } from '@warsim/sim';
import { loadDefaultParams, loadDefaultScenario, runAiVsAi } from './helpers';

describe('full battle determinism (sim + ai)', () => {
  const params = loadDefaultParams();
  const scenario = loadDefaultScenario();

  it('same seed => identical hash and event log', () => {
    const a = runAiVsAi(scenario, params, 42);
    const b = runAiVsAi(scenario, params, 42);
    expect(hashState(a)).toBe(hashState(b));
    expect(a.events.map((e) => e.text)).toEqual(b.events.map((e) => e.text));
    expect(a.result).toEqual(b.result);
  });

  it('different seed => different hash', () => {
    const a = runAiVsAi(scenario, params, 42);
    const b = runAiVsAi(scenario, params, 43);
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it('automatic transitions are always logged', () => {
    const s = runAiVsAi(scenario, params, 7);
    const auto = s.events.filter((e) => e.kind === 'stance_auto' || e.kind === 'rout');
    expect(auto.length).toBeGreaterThan(0);
    for (const e of auto) expect(e.text.length).toBeGreaterThan(0);
  });
});
