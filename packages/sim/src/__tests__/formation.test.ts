import { describe, expect, it } from 'vitest';
import { formationHalfWidth, formationShape, slotPosition } from '../formation';

describe('formation', () => {
  it('lays out 50 men in a 2-rank line 25 wide', () => {
    const f = { kind: 'line' as const, facing: 0, x: 100, y: 100 };
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 50; i++) {
      const p = slotPosition(f, 'line', 'infantry', i, 50);
      xs.push(p.x);
      ys.push(p.y);
    }
    // Facing east: the line spreads along y, ranks along x.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(24, 5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.5, 5);
    expect(formationHalfWidth('line', 'infantry', 50)).toBeCloseTo(12.5, 5);
  });

  it('column is narrow and deep', () => {
    const s = formationShape('column', 'infantry');
    expect(s.files).toBeLessThan(10);
  });

  it('slots are centred on the anchor', () => {
    const f = { kind: 'mass' as const, facing: 1.1, x: 50, y: 60 };
    let sx = 0;
    let sy = 0;
    const n = 40;
    for (let i = 0; i < n; i++) {
      const p = slotPosition(f, 'mass', 'infantry', i, n);
      sx += p.x;
      sy += p.y;
    }
    expect(sx / n).toBeCloseTo(50, 3);
    expect(sy / n).toBeCloseTo(60, 3);
  });
});
