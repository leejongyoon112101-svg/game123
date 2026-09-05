import { describe, expect, it } from 'vitest';
import type { Commander } from '@warsim/sim';
import { calm, duel, loadDefaultParams, loadDefaultScenario, runAiVsAi, runBrainOnly, winRate } from './helpers';

const N = 60;

describe('scenario balance', () => {
  const params = loadDefaultParams();

  it('steady infantry in hold beats charging cavalry 60-85% of the time', () => {
    const sc = duel(
      [{ type: 'infantry', commander: calm, x: 400, y: 500, stance: 'hold' }],
      [{ type: 'cavalry', commander: calm, x: 700, y: 500, stance: 'assault', facingDeg: 180 }],
    );
    const rate = winRate(N, (seed) => runBrainOnly(sc, params, seed), 0);
    expect(rate).toBeGreaterThanOrEqual(0.6);
    expect(rate).toBeLessThanOrEqual(0.85);
  });

  it('cavalry catches infantry caught moving in the open (assault vs assault)', () => {
    const sc = duel(
      [{ type: 'infantry', commander: calm, x: 400, y: 500, stance: 'assault' }],
      [{ type: 'cavalry', commander: calm, x: 800, y: 500, stance: 'assault', facingDeg: 180 }],
    );
    const rate = winRate(N, (seed) => runBrainOnly(sc, params, seed), 1);
    expect(rate).toBeGreaterThanOrEqual(0.6);
  });

  it('two holding infantry beat one assaulting infantry most of the time', () => {
    const sc = duel(
      [
        { type: 'infantry', commander: calm, x: 400, y: 470, stance: 'hold' },
        { type: 'infantry', commander: calm, x: 400, y: 530, stance: 'hold' },
      ],
      [{ type: 'infantry', commander: calm, x: 700, y: 500, stance: 'assault', facingDeg: 180 }],
    );
    const rate = winRate(N, (seed) => runBrainOnly(sc, params, seed), 0);
    expect(rate).toBeGreaterThanOrEqual(0.75);
  });

  it('a lone frontal assault on a steady equal unit usually fails, but not always', () => {
    const sc = duel(
      [{ type: 'infantry', commander: calm, x: 400, y: 500, stance: 'hold' }],
      [{ type: 'infantry', commander: calm, x: 650, y: 500, stance: 'assault', facingDeg: 180 }],
    );
    const rate = winRate(N, (seed) => runBrainOnly(sc, params, seed), 1);
    expect(rate).toBeLessThanOrEqual(0.5);
    expect(rate).toBeGreaterThanOrEqual(0.03);
  });

  it('artillery can never be caught by nothing: infantry that reaches guns wins', () => {
    const sc = duel(
      [{ type: 'artillery', commander: calm, x: 400, y: 500, stance: 'hold' }],
      [{ type: 'infantry', commander: calm, x: 650, y: 500, stance: 'assault', facingDeg: 180 }],
    );
    const rate = winRate(N, (seed) => runBrainOnly(sc, params, seed), 1);
    expect(rate).toBeGreaterThanOrEqual(0.7);
  });

  it('a composed commander holds longer than a nervous one under the same fire', () => {
    const nervous: Commander = { aggression: 0.5, composure: 0.1 };
    const steady: Commander = { aggression: 0.5, composure: 0.9 };
    const mk = (c: Commander) =>
      duel(
        [{ type: 'infantry', commander: c, x: 400, y: 500, stance: 'hold' }],
        [
          { type: 'infantry', commander: calm, x: 470, y: 470, stance: 'hold', facingDeg: 180 },
          { type: 'infantry', commander: calm, x: 470, y: 530, stance: 'hold', facingDeg: 180 },
        ],
      );
    let tNervous = 0;
    let tSteady = 0;
    for (let seed = 1; seed <= 30; seed++) {
      tNervous += runBrainOnly(mk(nervous), params, seed).tick;
      tSteady += runBrainOnly(mk(steady), params, seed).tick;
    }
    expect(tSteady).toBeGreaterThan(tNervous);
  });
});

describe('full battle', () => {
  const params = loadDefaultParams();
  const scenario = loadDefaultScenario();

  it('balanced vs balanced is not one-sided and finishes within the time limit', () => {
    const n = 20;
    let a = 0;
    let b = 0;
    for (let seed = 1; seed <= n; seed++) {
      const s = runAiVsAi(scenario, params, seed, ['balanced', 'balanced'], seed % 3);
      expect(s.result).not.toBeNull();
      expect(s.tick).toBeLessThanOrEqual(params.battleTimeLimitSec * params.ticksPerSecond + 1);
      if (s.result?.winner === 0) a++;
      else if (s.result?.winner === 1) b++;
    }
    expect(a).toBeGreaterThanOrEqual(3);
    expect(b).toBeGreaterThanOrEqual(3);
  });

  it('a passive side (never reacts) loses to a balanced side most of the time', () => {
    const rate = winRate(12, (seed) => runAiVsAi(scenario, params, seed, ['balanced', 'passive']), 0);
    expect(rate).toBeGreaterThanOrEqual(0.6);
  });
});
