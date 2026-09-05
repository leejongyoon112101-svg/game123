import type { Params } from './params';
import type { BattleState, Stance, Unit, UnitAction } from './types';

/** What a unit brain returns once per reaction interval. */
export interface UnitDecision {
  action: UnitAction;
  /** Optional self-initiated stance change — logged as an automatic transition. */
  stance?: Exclude<Stance, 'rout'>;
  /** Human-readable reason for the stance change (shown in the event feed). */
  reason?: string;
}

/**
 * A unit brain decides what a (non-routed, living) unit does within its current
 * stance. The sim only executes; it never chooses targets by itself except for
 * opportunistic volleys.
 */
export type UnitBrain = (state: BattleState, unit: Unit, params: Params) => UnitDecision;

/** Fallback brain: do nothing. Units still fire opportunistically and defend in melee. */
export const idleBrain: UnitBrain = () => ({ action: { kind: 'idle' } });
