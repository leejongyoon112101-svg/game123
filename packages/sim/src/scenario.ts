import type { Commander, SideId, Stance, TerrainKind, UnitType } from './types';

export interface ScenarioUnit {
  type: UnitType;
  name?: string;
  commander: Commander;
  x: number;
  y: number;
  /** Facing in degrees (0 = east, 90 = south in screen coordinates). */
  facingDeg?: number;
  stance?: Exclude<Stance, 'rout'>;
}

export interface TerrainPatch {
  kind: TerrainKind;
  /** Axis-aligned rectangle in metres. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** For hills: integer height. */
  height?: number;
}

export interface SideScenario {
  name: string;
  units: ScenarioUnit[];
  /** Alternative deployments (enemy picks one by seed). */
  altDeployments?: ScenarioUnit[][];
}

export interface Scenario {
  name: string;
  description?: string;
  /** Deployment zone widths as fractions of map width for each side. */
  deployZoneFrac: number;
  terrain: TerrainPatch[];
  sides: [SideScenario, SideScenario];
  /** Optional parameter overrides merged over params/default.json. */
  paramOverrides?: Record<string, unknown>;
}

export function sideOf(i: number): SideId {
  return i === 0 ? 0 : 1;
}
