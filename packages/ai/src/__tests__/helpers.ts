import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertParams, createBattle, step, type Params, type Scenario, type ScenarioUnit, type BattleState, type StanceInput } from '@warsim/sim';
import { createStrategyMemory, strategyDecide, unitBrain, type StrategyProfile } from '..';

export function loadDefaultParams(): Params {
  const p = JSON.parse(readFileSync(resolve(__dirname, '../../../../params/default.json'), 'utf8')) as unknown;
  assertParams(p);
  return p;
}

export function loadDefaultScenario(): Scenario {
  return JSON.parse(readFileSync(resolve(__dirname, '../../../../scenarios/default.json'), 'utf8')) as Scenario;
}

export function duel(a: ScenarioUnit[], b: ScenarioUnit[], name = 'duel'): Scenario {
  return { name, deployZoneFrac: 0.33, terrain: [], sides: [{ name: 'A', units: a }, { name: 'B', units: b }] };
}

export const calm = { aggression: 0.5, composure: 0.5 };

/** Run a battle with the unit brain only (stances fixed by the scenario). */
export function runBrainOnly(sc: Scenario, params: Params, seed: number, maxTicks = 6000, inputs: StanceInput[] = []): BattleState {
  const s = createBattle(sc, params, seed);
  while (!s.result && s.tick < maxTicks) step(s, params, inputs, { brain: unitBrain, skipSoldiers: true });
  return s;
}

/** Run a full AI-vs-AI battle with strategy scripts on both sides. */
export function runAiVsAi(sc: Scenario, params: Params, seed: number, profiles: [StrategyProfile, StrategyProfile] = ['balanced', 'balanced'], alt: number | null = null): BattleState {
  const s = createBattle(sc, params, seed, { altDeployment: [null, alt] });
  const mems = [createStrategyMemory(), createStrategyMemory()];
  const max = params.battleTimeLimitSec * params.ticksPerSecond + 1;
  while (!s.result && s.tick < max) {
    const inputs = [...strategyDecide(s, 0, params, mems[0]!, profiles[0]), ...strategyDecide(s, 1, params, mems[1]!, profiles[1])];
    step(s, params, inputs, { brain: unitBrain, skipSoldiers: true });
  }
  return s;
}

export function winRate(n: number, run: (seed: number) => BattleState, side: 0 | 1): number {
  let w = 0;
  for (let seed = 1; seed <= n; seed++) if (run(seed).result?.winner === side) w++;
  return w / n;
}
