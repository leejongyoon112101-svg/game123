import type { Formation, FormationKind, Stance, UnitType } from './types';

export interface FormationShape {
  files: number;
  fileSpacing: number;
  rankSpacing: number;
}

/**
 * Formation geometry per kind. `files` is the number of soldiers per rank
 * (i.e. width); ranks are filled front to back.
 */
export function formationShape(kind: FormationKind, type: UnitType): FormationShape {
  if (type === 'artillery') {
    // Gun crews cluster around ~4 pieces regardless of stance.
    return { files: 10, fileSpacing: 2.2, rankSpacing: 2.0 };
  }
  switch (kind) {
    case 'line':
      return { files: 25, fileSpacing: 1.0, rankSpacing: 1.5 };
    case 'assault':
      return { files: 17, fileSpacing: 1.0, rankSpacing: 1.4 };
    case 'column':
      return { files: 5, fileSpacing: 1.2, rankSpacing: 1.5 };
    case 'skirmish':
      return { files: 25, fileSpacing: 2.6, rankSpacing: 4.0 };
    case 'mass':
      return { files: 8, fileSpacing: 0.9, rankSpacing: 1.0 };
    default:
      return { files: 25, fileSpacing: 1.0, rankSpacing: 1.5 };
  }
}

export function formationForStance(stance: Stance, type: UnitType): FormationKind {
  if (type === 'cavalry') {
    if (stance === 'assault') return 'assault';
    if (stance === 'withdraw' || stance === 'rout') return 'column';
    if (stance === 'screen') return 'skirmish';
    return 'line';
  }
  switch (stance) {
    case 'assault':
      return 'assault';
    case 'hold':
      return 'line';
    case 'screen':
      return 'skirmish';
    case 'withdraw':
    case 'rout':
      return 'column';
    case 'rally':
      return 'mass';
    default:
      return 'line';
  }
}

/** World position of slot `i` (0-based) for `n` soldiers in the given formation. */
export function slotPosition(f: Formation, kind: FormationKind, type: UnitType, i: number, n: number): { x: number; y: number } {
  const s = formationShape(kind, type);
  const files = Math.min(s.files, Math.max(1, n));
  const rank = Math.floor(i / files);
  const file = i % files;
  const ranks = Math.ceil(n / files);
  // Local coords: +u = forward (facing), +v = right.
  const v = (file - (files - 1) / 2) * s.fileSpacing;
  const u = -(rank - (ranks - 1) / 2) * s.rankSpacing;
  const cos = Math.cos(f.facing);
  const sin = Math.sin(f.facing);
  return { x: f.x + u * cos - v * sin, y: f.y + u * sin + v * cos };
}

/** Approximate half-width (across the front) of the formation, in metres. */
export function formationHalfWidth(kind: FormationKind, type: UnitType, n: number): number {
  const s = formationShape(kind, type);
  return (Math.min(s.files, Math.max(1, n)) * s.fileSpacing) / 2;
}

/** Approximate half-depth (front to back) of the formation, in metres. */
export function formationHalfDepth(kind: FormationKind, type: UnitType, n: number): number {
  const s = formationShape(kind, type);
  const ranks = Math.ceil(Math.max(1, n) / s.files);
  return (ranks * s.rankSpacing) / 2;
}
