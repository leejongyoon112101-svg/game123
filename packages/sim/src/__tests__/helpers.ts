import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertParams, type Params } from '../params';
import type { Scenario, ScenarioUnit } from '../scenario';

export function loadDefaultParams(): Params {
  const p = JSON.parse(readFileSync(resolve(__dirname, '../../../../params/default.json'), 'utf8')) as unknown;
  assertParams(p);
  return p;
}

export function loadDefaultScenario(): Scenario {
  return JSON.parse(readFileSync(resolve(__dirname, '../../../../scenarios/default.json'), 'utf8')) as Scenario;
}

/** A flat, empty map with the given units. Side 0 faces east, side 1 west. */
export function duel(a: ScenarioUnit[], b: ScenarioUnit[], name = 'duel'): Scenario {
  return {
    name,
    deployZoneFrac: 0.33,
    terrain: [],
    sides: [
      { name: 'A', units: a },
      { name: 'B', units: b },
    ],
  };
}

export const calm = { aggression: 0.5, composure: 0.5 };
