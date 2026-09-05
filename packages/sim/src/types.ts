/**
 * Core data model of the warsim simulation.
 *
 * Everything here must be plain, JSON-serialisable data. The renderer reads it,
 * `step()` produces a new one, nothing else mutates it.
 */

export type SideId = 0 | 1;

export type UnitType = 'infantry' | 'cavalry' | 'artillery';

/** The five player-selectable stances plus the hidden `rout` state. */
export type Stance = 'assault' | 'hold' | 'screen' | 'withdraw' | 'rally' | 'rout';

export const PLAYER_STANCES: readonly Exclude<Stance, 'rout'>[] = [
  'assault',
  'hold',
  'screen',
  'withdraw',
  'rally',
] as const;

export type FormationKind = 'line' | 'column' | 'skirmish' | 'mass' | 'assault';

export type TerrainKind = 'plain' | 'forest' | 'hill';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Commander {
  /** 0..1 — weight on charge scores, chance of hold→assault. */
  aggression: number;
  /** 0..1 — mitigates morale loss, suppresses assault→withdraw. */
  composure: number;
}

export interface Soldier {
  x: number;
  y: number;
  alive: boolean;
  /** Visual only: while true the soldier scatters rearwards instead of seeking its slot. */
  fled: boolean;
}

export interface Formation {
  kind: FormationKind;
  /** Facing angle in radians. 0 = +x (east). */
  facing: number;
  /** Anchor (centre) of the formation in map metres. */
  x: number;
  y: number;
}

/** The action a unit is currently executing, chosen by the unit brain. */
export type UnitAction =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; y: number; charge: boolean }
  | { kind: 'approach'; targetId: number; stopAt: number }
  | { kind: 'charge'; targetId: number }
  | { kind: 'volley'; targetId: number }
  | { kind: 'reposition'; x: number; y: number }
  | { kind: 'fallback'; x: number; y: number };

export interface Unit {
  id: number;
  side: SideId;
  /** 0-based index within its side (display number = index + 1). */
  index: number;
  name: string;
  type: UnitType;
  commander: Commander;

  stance: Stance;
  /** Stance before the current one (for UI). */
  prevStance: Stance;
  stanceSinceTick: number;

  formation: Formation;
  /** Formation the unit is transitioning into; null when settled. */
  formationTarget: FormationKind | null;
  formationChangeRemaining: number;

  morale: number;
  cohesion: number;
  fatigue: number;
  ammo: number;

  soldiers: Soldier[];

  /** Current action (chosen by the brain, executed by the sim). */
  action: UnitAction;
  /** Convenience for renderer/AI: did the anchor move this tick? */
  moving: boolean;
  charging: boolean;

  /** Unit id currently being fired at / charged (for rendering). */
  targetId: number | null;
  lastVolleyTick: number;
  /** Id of the enemy unit this unit is locked in melee with. */
  meleeWith: number | null;
  /** Tick at which the current melee began (charge bonus applies for a few seconds). */
  meleeSinceTick: number;
  /** Tick of the last failed charge (AI cooldown). */
  lastChargeFailTick: number;
  /** Last tick this unit took casualties from any source. */
  underFireTick: number;
  /** Last tick this unit saw an enemy unit rout nearby (AI trigger). */
  sawEnemyRoutTick: number;
  /** Target id of the charge currently announced (avoid duplicate events). */
  chargeAnnouncedTarget: number | null;
  /** Last tick this unit cut down fleeing men while pursuing a routing unit. */
  lastRideDownTick: number;

  /** Casualties suffered in the recent window (decays). */
  recentLosses: number;
  /** Strength at battle start. */
  initialStrength: number;
  /** Casualties (dead + deserted) so far. */
  casualties: number;

  destroyed: boolean;
  /** Left the map through its own rear edge. */
  exited: boolean;
  /** Hold-stance chosen position (null until picked). */
  holdPos: Vec2 | null;
}

export interface Terrain {
  cols: number;
  rows: number;
  cellSize: number;
  /** Row-major, length cols*rows. */
  kinds: TerrainKind[];
  /** Row-major integer height (0 = plain level). */
  heights: number[];
}

export type EventKind =
  | 'battle_start'
  | 'stance_player'
  | 'stance_auto'
  | 'rout'
  | 'rally_recovered'
  | 'charge_start'
  | 'charge_broke_enemy'
  | 'charge_repulsed'
  | 'melee_start'
  | 'melee_end'
  | 'ammo_out'
  | 'unit_destroyed'
  | 'unit_exited'
  | 'battle_end';

export interface BattleEvent {
  tick: number;
  kind: EventKind;
  side: SideId | null;
  unitId: number | null;
  /** Free-form human-readable detail (for the feed and the result screen). */
  text: string;
  /** Structured extras (target id, stance from/to, ...). */
  data?: Record<string, string | number | boolean | null>;
}

export interface StanceInput {
  tick: number;
  unitId: number;
  stance: Exclude<Stance, 'rout'>;
}

export interface MoraleSample {
  tick: number;
  /** morale per unit id (index = unit id). */
  morale: number[];
}

export interface BattleResult {
  winner: SideId | null;
  reason: 'available' | 'exited' | 'timeout' | 'annihilation';
  endTick: number;
}

export interface VolleyRecord {
  fromId: number;
  toId: number;
  casualties: number;
  artillery: boolean;
}

export interface BattleState {
  tick: number;
  /** mulberry32 state. */
  rng: number;
  terrain: Terrain;
  units: Unit[];
  events: BattleEvent[];
  /** Morale history sampled every N ticks, for the result screen. */
  moraleHistory: MoraleSample[];
  result: BattleResult | null;
  /** Volleys fired during the most recent tick (for rendering). Replaced every tick. */
  volleys: VolleyRecord[];
  /** Rear x-direction per side (side 0 retreats to -x, side 1 to +x). */
  sideRearDir: [number, number];
  scenarioName: string;
  seed: number;
}
