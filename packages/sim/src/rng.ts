/**
 * Deterministic PRNG (mulberry32). The state is a single uint32 stored in
 * BattleState so that the entire battle is replayable from (seed, inputs).
 *
 * Never use the global random generator inside packages/sim or packages/ai.
 */

export function seedRng(seed: number): number {
  // Mix the seed so that adjacent seeds don't produce correlated streams.
  let s = (seed ^ 0x9e3779b9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  return (s ^ (s >>> 16)) >>> 0;
}

/** Advance the state and return [nextState, float in [0,1)]. */
export function nextFloat(state: number): [number, number] {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [a, f];
}

/**
 * Small mutable wrapper used inside a single `step()` call. The final state is
 * written back into BattleState so the wrapper never outlives the tick.
 */
export class Rng {
  constructor(public state: number) {}

  float(): number {
    const [s, f] = nextFloat(this.state);
    this.state = s;
    return f;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Round a real-valued expectation to an integer stochastically (unbiased). */
  roundStochastic(v: number): number {
    const base = Math.floor(v);
    const frac = v - base;
    return base + (this.float() < frac ? 1 : 0);
  }
}
