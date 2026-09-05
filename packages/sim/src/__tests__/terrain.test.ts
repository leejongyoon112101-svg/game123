import { describe, expect, it } from 'vitest';
import { loadDefaultParams } from './helpers';
import { createTerrain, heightAt, terrainAt } from '../terrain';

describe('terrain', () => {
  const params = loadDefaultParams();
  it('rasterises patches onto the cell grid', () => {
    const t = createTerrain(params, [
      { kind: 'forest', x: 100, y: 100, w: 50, h: 50 },
      { kind: 'hill', x: 500, y: 500, w: 100, h: 100, height: 2 },
    ]);
    expect(t.cols).toBe(150);
    expect(t.rows).toBe(100);
    expect(terrainAt(t, 120, 120)).toBe('forest');
    expect(terrainAt(t, 10, 10)).toBe('plain');
    expect(terrainAt(t, 550, 550)).toBe('hill');
    expect(heightAt(t, 550, 550)).toBe(2);
    expect(heightAt(t, 120, 120)).toBe(0);
  });
  it('clamps out-of-range queries', () => {
    const t = createTerrain(params, []);
    expect(terrainAt(t, -100, -100)).toBe('plain');
    expect(terrainAt(t, 99999, 99999)).toBe('plain');
  });
});
