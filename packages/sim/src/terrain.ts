import type { Params } from './params';
import type { TerrainPatch } from './scenario';
import type { Terrain, TerrainKind } from './types';

export function createTerrain(params: Params, patches: TerrainPatch[]): Terrain {
  const cellSize = params.map.cellSize;
  const cols = Math.ceil(params.map.width / cellSize);
  const rows = Math.ceil(params.map.height / cellSize);
  const kinds: TerrainKind[] = new Array<TerrainKind>(cols * rows).fill('plain');
  const heights: number[] = new Array<number>(cols * rows).fill(0);

  for (const p of patches) {
    const c0 = Math.max(0, Math.floor(p.x / cellSize));
    const r0 = Math.max(0, Math.floor(p.y / cellSize));
    const c1 = Math.min(cols, Math.ceil((p.x + p.w) / cellSize));
    const r1 = Math.min(rows, Math.ceil((p.y + p.h) / cellSize));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const i = r * cols + c;
        kinds[i] = p.kind;
        if (p.kind === 'hill') heights[i] = p.height ?? 1;
        else heights[i] = 0;
      }
    }
  }
  return { cols, rows, cellSize, kinds, heights };
}

export function cellIndex(t: Terrain, x: number, y: number): number {
  const c = Math.min(t.cols - 1, Math.max(0, Math.floor(x / t.cellSize)));
  const r = Math.min(t.rows - 1, Math.max(0, Math.floor(y / t.cellSize)));
  return r * t.cols + c;
}

export function terrainAt(t: Terrain, x: number, y: number): TerrainKind {
  return t.kinds[cellIndex(t, x, y)] ?? 'plain';
}

export function heightAt(t: Terrain, x: number, y: number): number {
  return t.heights[cellIndex(t, x, y)] ?? 0;
}

/** Cover multiplier applied to incoming fire (lower = safer). */
export function coverMultiplier(params: Params, kind: TerrainKind, holding: boolean): number {
  if (kind === 'forest') return params.fire.coverForest;
  if (kind === 'hill' && holding) return params.fire.coverHillHold;
  return params.fire.coverPlain;
}

/** Desirability of a position for a defending unit (higher = better). */
export function defensiveValue(kind: TerrainKind): number {
  if (kind === 'hill') return 1.0;
  if (kind === 'forest') return 0.6;
  return 0;
}
