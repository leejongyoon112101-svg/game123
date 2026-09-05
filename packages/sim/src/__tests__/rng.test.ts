import { describe, expect, it } from 'vitest';
import { Rng, nextFloat, seedRng } from '../rng';

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(seedRng(42));
    const b = new Rng(seedRng(42));
    for (let i = 0; i < 1000; i++) expect(a.float()).toBe(b.float());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(seedRng(1));
    const b = new Rng(seedRng(2));
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.float() === b.float()) same++;
    expect(same).toBeLessThan(3);
  });

  it('floats are in [0,1) with a roughly uniform mean', () => {
    let s = seedRng(7);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const [ns, f] = nextFloat(s);
      s = ns;
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      sum += f;
    }
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
  });

  it('roundStochastic is unbiased', () => {
    const r = new Rng(seedRng(3));
    let total = 0;
    for (let i = 0; i < 10000; i++) total += r.roundStochastic(2.3);
    expect(total / 10000).toBeGreaterThan(2.25);
    expect(total / 10000).toBeLessThan(2.35);
  });
});
