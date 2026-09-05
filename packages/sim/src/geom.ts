import type { Vec2 } from './types';

export const TAU = Math.PI * 2;

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Rotate `current` toward `target` by at most `maxDelta`. */
export function turnToward(current: number, target: number, maxDelta: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
}

/**
 * Relative bearing of a point as seen from a unit facing `facing`:
 * 0 = dead ahead, ±PI = directly behind.
 */
export function relativeBearing(facing: number, fromX: number, fromY: number, toX: number, toY: number): number {
  return wrapAngle(angleTo(fromX, fromY, toX, toY) - facing);
}

export type Aspect = 'front' | 'flank' | 'rear';

/** From which aspect is the defender (facing `defFacing`) being hit by something at (ax, ay)? */
export function aspectOfAttack(defX: number, defY: number, defFacing: number, ax: number, ay: number): Aspect {
  const b = Math.abs(relativeBearing(defFacing, defX, defY, ax, ay));
  if (b < Math.PI / 3) return 'front';
  if (b < (Math.PI * 2) / 3) return 'flank';
  return 'rear';
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}
