/**
 * Replay = seed + deployment + input events. Re-running a replay through the
 * same sim/ai versions reproduces the battle exactly (see hashState).
 */
import type { Scenario, ScenarioUnit } from './scenario';
import type { StanceInput } from './types';

export interface ReplayDeployment {
  x: number;
  y: number;
  facingDeg: number;
  stance: StanceInput['stance'];
}

export interface Replay {
  version: 1;
  scenarioName: string;
  seed: number;
  /** Alternative deployment index used for side 1 (null = base). */
  altDeployment: number | null;
  /** Side-0 deployment overrides, by unit index. */
  deployment: ReplayDeployment[];
  /** Strategy profile name driving side 1 (interpreted by the ai package). */
  enemyProfile: string;
  /** Side-0 stance inputs in tick order. */
  inputs: StanceInput[];
  /** Whether per-soldier motion was simulated (affects the hash, not outcomes). */
  soldiers: boolean;
  /** hashState() of the final state when recorded, for verification. */
  finalHash?: string;
  endTick?: number;
}

/** Apply a replay's side-0 deployment to a scenario (returns a new scenario). */
export function applyDeployment(scenario: Scenario, deployment: ReplayDeployment[]): Scenario {
  const units: ScenarioUnit[] = scenario.sides[0].units.map((u, i) => {
    const d = deployment[i];
    return d ? { ...u, x: d.x, y: d.y, facingDeg: d.facingDeg, stance: d.stance } : u;
  });
  return { ...scenario, sides: [{ ...scenario.sides[0], units }, scenario.sides[1]] };
}

export function isReplay(v: unknown): v is Replay {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.version === 1 && typeof r.seed === 'number' && Array.isArray(r.inputs) && Array.isArray(r.deployment);
}
