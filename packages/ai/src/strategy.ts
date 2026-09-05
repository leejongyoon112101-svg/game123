/**
 * Side-level strategy script: decides stances for a whole side. Used for the
 * enemy in the web app and for both sides in headless AI-vs-AI runs.
 */
import {
  availableCount,
  enemySide,
  isAlive,
  isAvailable,
  strengthOf,
  unitDistance,
  visibleEnemies,
  type BattleState,
  type Params,
  type SideId,
  type Stance,
  type StanceInput,
  type Unit,
} from '@warsim/sim';

export type StrategyProfile = 'balanced' | 'aggressive' | 'defensive' | 'passive';

export interface StrategyMemory {
  lastRunTick: number;
  lastEventIndex: number;
  /** Tick at which an initial plan was issued. */
  planned: boolean;
}

export function createStrategyMemory(): StrategyMemory {
  return { lastRunTick: -1, lastEventIndex: 0, planned: false };
}

type PlayerStance = Exclude<Stance, 'rout'>;

function order(out: StanceInput[], state: BattleState, u: Unit, stance: PlayerStance): void {
  if (u.stance === stance || u.stance === 'rout' || !isAlive(u)) return;
  if (out.some((o) => o.unitId === u.id)) return;
  out.push({ tick: state.tick, unitId: u.id, stance });
}

function initialPlan(state: BattleState, side: SideId, profile: StrategyProfile, out: StanceInput[]): void {
  const mine = state.units.filter((u) => u.side === side);
  const inf = mine.filter((u) => u.type === 'infantry');
  for (const u of mine) {
    let s: PlayerStance = 'hold';
    if (u.type === 'artillery') s = 'hold';
    else if (u.type === 'cavalry') s = profile === 'aggressive' ? 'assault' : 'screen';
    else {
      const i = inf.indexOf(u);
      if (profile === 'aggressive') s = 'assault';
      else if (profile === 'defensive' || profile === 'passive') s = 'hold';
      else s = i === 1 || i === 4 ? 'assault' : 'hold'; // balanced: 2 assault, 4 hold
    }
    order(out, state, u, s);
  }
}

/**
 * Evaluate the side every `strategyIntervalSec` and return stance commands for
 * the current tick. Deterministic: depends only on state and memory.
 */
export function strategyDecide(
  state: BattleState,
  side: SideId,
  params: Params,
  mem: StrategyMemory,
  profile: StrategyProfile = 'balanced',
): StanceInput[] {
  const out: StanceInput[] = [];
  const interval = Math.round(params.ai.strategyIntervalSec * params.ticksPerSecond);
  if (state.tick !== 0 && (mem.lastRunTick >= 0 && state.tick - mem.lastRunTick < interval)) return out;
  mem.lastRunTick = state.tick;

  if (!mem.planned) {
    mem.planned = true;
    initialPlan(state, side, profile, out);
    if (profile !== 'passive') return out;
  }
  if (profile === 'passive') return out; // holds everything, never reacts

  const mine = state.units.filter((u) => u.side === side && isAlive(u));
  const foe = enemySide(side);
  const myAvail = availableCount(state, side);
  const foeAvail = availableCount(state, foe);

  // New events since last run
  const newEvents = state.events.slice(mem.lastEventIndex);
  mem.lastEventIndex = state.events.length;
  const friendlyRouts = newEvents.filter((e) => e.kind === 'rout' && e.side === side && e.unitId !== null);

  // 1. A friendly unit broke: the nearest fresh reserve counter-attacks.
  for (const ev of friendlyRouts) {
    const routed = state.units[ev.unitId!];
    if (!routed) continue;
    const reserves = mine
      .filter((u) => u.type === 'infantry' && u.stance === 'hold' && u.morale >= 60 && u.meleeWith === null)
      .sort((a, b) => unitDistance(a, routed) - unitDistance(b, routed));
    const r = reserves[0];
    if (r && unitDistance(r, routed) <= 300) order(out, state, r, 'assault');
  }

  for (const u of mine) {
    if (u.stance === 'rout') continue;
    const enemies = visibleEnemies(state, params, u);
    const nearest = enemies[0];
    const dNear = nearest ? unitDistance(u, nearest) : Infinity;
    const strength = strengthOf(u);

    // 2. Shaken units pull back, rally, then return to the line.
    if (u.morale <= 40 && u.stance !== 'withdraw' && u.stance !== 'rally' && u.meleeWith === null) {
      order(out, state, u, 'withdraw');
      continue;
    }
    if (u.stance === 'withdraw' && dNear > 220 && u.morale < 70) {
      order(out, state, u, 'rally');
      continue;
    }
    if (u.stance === 'rally' && u.morale >= 70 && u.cohesion >= 0.8) {
      order(out, state, u, 'hold');
      continue;
    }

    // 3. Cavalry: pounce on artillery or broken units; otherwise screen.
    if (u.type === 'cavalry') {
      if (u.morale < 50 && u.stance === 'assault') {
        order(out, state, u, 'withdraw');
        continue;
      }
      const prey = enemies.find((e) => (e.type === 'artillery' || e.stance === 'rout' || e.stance === 'rally' || e.morale < 45) && unitDistance(u, e) <= 450);
      if (prey && u.stance !== 'assault' && u.morale >= 55) order(out, state, u, 'assault');
      else if (!prey && u.stance === 'assault' && dNear > 300) order(out, state, u, 'screen');
      continue;
    }

    // 4. Infantry out of ammo and shaky: fall back.
    if (u.type === 'infantry' && u.ammo === 0 && u.morale < 55 && u.stance === 'assault') {
      order(out, state, u, 'withdraw');
      continue;
    }

    // 5. Press the advantage when the enemy is collapsing, or when the line has
    //    held long enough and we are not the weaker side.
    const late = state.tick >= params.ai.pressAdvantageAfterSec * params.ticksPerSecond;
    const fresh = strength >= 30 && state.tick - u.stanceSinceTick >= 10 * params.ticksPerSecond;
    if (
      u.type === 'infantry' &&
      u.stance === 'hold' &&
      u.morale >= 65 &&
      fresh &&
      ((foeAvail <= 4 && myAvail >= 6) || (late && myAvail >= foeAvail && profile !== 'defensive') || (profile === 'aggressive' && dNear < 250))
    ) {
      order(out, state, u, 'assault');
      continue;
    }

    // 6. Aggressive profile: infantry keep pressing after a rally.
    if (profile === 'aggressive' && u.type === 'infantry' && u.stance === 'hold' && u.morale >= 75 && strength >= 30) {
      order(out, state, u, 'assault');
    }
  }
  void isAvailable;
  return out;
}
