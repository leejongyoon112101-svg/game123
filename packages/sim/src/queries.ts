/**
 * Read-only helpers over BattleState shared by the sim, the AI package and the
 * renderer. None of these mutate state.
 */
import { dist } from './geom';
import type { Params } from './params';
import { terrainAt } from './terrain';
import type { BattleState, SideId, Unit } from './types';

export function strengthOf(u: Unit): number {
  let n = 0;
  for (const s of u.soldiers) if (s.alive) n++;
  return n;
}

export function isAlive(u: Unit): boolean {
  return !u.destroyed && !u.exited;
}

/** A unit that still counts toward the "available units" victory condition. */
export function isAvailable(u: Unit): boolean {
  return isAlive(u) && u.stance !== 'rout';
}

export function unitsOfSide(state: BattleState, side: SideId): Unit[] {
  return state.units.filter((u) => u.side === side);
}

export function availableCount(state: BattleState, side: SideId): number {
  let n = 0;
  for (const u of state.units) if (u.side === side && isAvailable(u)) n++;
  return n;
}

export function enemySide(side: SideId): SideId {
  return side === 0 ? 1 : 0;
}

export function unitDistance(a: Unit, b: Unit): number {
  return dist(a.formation.x, a.formation.y, b.formation.x, b.formation.y);
}

export function isFormationChanging(u: Unit): boolean {
  return u.formationTarget !== null;
}

/** Collapse threshold adjusted by the commander's composure. */
export function collapseThreshold(params: Params, u: Unit): number {
  return params.morale.collapseThreshold - (u.commander.composure - 0.5) * 2 * params.morale.composureThresholdShift;
}

export function recoverThreshold(params: Params, u: Unit): number {
  return params.morale.recoverThreshold - (u.commander.composure - 0.5) * 2 * params.morale.composureThresholdShift;
}

/**
 * Can `observer` see `target`? Standard fog: base range, reduced when the target
 * sits in forest or is screening.
 */
export function canSee(state: BattleState, params: Params, observer: Unit, target: Unit): boolean {
  if (!isAlive(target)) return false;
  let range = params.vision.baseRange;
  if (terrainAt(state.terrain, target.formation.x, target.formation.y) === 'forest') {
    range = Math.min(range, params.vision.forestTargetRange);
  }
  if (target.stance === 'screen') range *= params.vision.screenDetectMult;
  return unitDistance(observer, target) <= range;
}

/** Enemies of `u` that `u` can see, sorted nearest first. */
export function visibleEnemies(state: BattleState, params: Params, u: Unit): Unit[] {
  const out: { u: Unit; d: number }[] = [];
  for (const e of state.units) {
    if (e.side === u.side || !isAlive(e)) continue;
    if (!canSee(state, params, u, e)) continue;
    out.push({ u: e, d: unitDistance(u, e) });
  }
  out.sort((a, b) => a.d - b.d || a.u.id - b.u.id);
  return out.map((o) => o.u);
}

/** Every living enemy regardless of visibility (used by the honest player map). */
export function livingEnemies(state: BattleState, u: Unit): Unit[] {
  return state.units.filter((e) => e.side !== u.side && isAlive(e));
}

export function nearestEnemy(state: BattleState, params: Params, u: Unit): Unit | null {
  const v = visibleEnemies(state, params, u);
  return v[0] ?? null;
}

export function livingFriends(state: BattleState, u: Unit): Unit[] {
  return state.units.filter((f) => f.side === u.side && f.id !== u.id && isAlive(f));
}

/** Rear-most safe x for a side (used for withdraw/rout destinations). */
export function rearPoint(state: BattleState, params: Params, u: Unit): { x: number; y: number } {
  const dir = state.sideRearDir[u.side];
  const x = dir < 0 ? -40 : params.map.width + 40;
  return { x, y: u.formation.y };
}

export function unitById(state: BattleState, id: number): Unit {
  const u = state.units[id];
  if (!u) throw new Error(`unit ${id} not found`);
  return u;
}

/** Total fighting value used for the timeout decision: sum(strength * morale). */
export function fightingValue(state: BattleState, side: SideId): number {
  let v = 0;
  for (const u of state.units) {
    if (u.side !== side || !isAvailable(u)) continue;
    v += strengthOf(u) * u.morale;
  }
  return v;
}
