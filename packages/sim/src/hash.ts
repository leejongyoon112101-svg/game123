import { strengthOf } from './queries';
import type { BattleState } from './types';

/** FNV-1a over a numeric stream; used for determinism tests and replay checks. */
export function hashState(state: BattleState): string {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    // Fold a float into 4 bytes via an int32 view of its rounded value.
    const i = Math.round(v * 1000) | 0;
    for (let k = 0; k < 4; k++) {
      h ^= (i >>> (k * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  mix(state.tick);
  mix(state.rng);
  for (const u of state.units) {
    mix(u.id);
    mix(u.formation.x);
    mix(u.formation.y);
    mix(u.formation.facing);
    mix(u.morale);
    mix(u.cohesion);
    mix(u.fatigue);
    mix(u.ammo);
    mix(strengthOf(u));
    mix(u.stance.length + u.stance.charCodeAt(0));
    mix(u.destroyed ? 1 : 0);
    mix(u.exited ? 1 : 0);
    for (const s of u.soldiers) {
      mix(s.x);
      mix(s.y);
    }
  }
  mix(state.events.length);
  return h.toString(16).padStart(8, '0');
}
