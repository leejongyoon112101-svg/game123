/**
 * Unit-level utility AI. Within the current stance the unit scores candidate
 * actions and executes the best one. Commander traits weight the scores; they
 * never add new behaviours.
 */
import {
  aspectOfAttack,
  defensiveValue,
  isAlive,
  isFormationChanging,
  rearPoint,
  strengthOf,
  terrainAt,
  unitDistance,
  visibleEnemies,
  type BattleState,
  type Params,
  type Unit,
  type UnitAction,
  type UnitBrain,
  type UnitDecision,
} from '@warsim/sim';

interface Candidate {
  score: number;
  action: UnitAction;
}

function typeValue(e: Unit): number {
  return e.type === 'artillery' ? 1.3 : 1.0;
}

/** How attractive is enemy `e` as a target for `u`. */
function targetValue(u: Unit, e: Unit): number {
  let v = typeValue(e);
  v *= 1 + (100 - e.morale) / 100; // shaken units are juicy
  if (e.stance === 'rout') v *= 0.15;
  if (e.stance === 'rally') v *= 1.4;
  if (e.stance === 'screen') v *= 0.6;
  if (e.type === 'cavalry' && u.type === 'infantry') v *= 0.7; // can't catch them
  return v;
}

function proximity(d: number): number {
  return 1 / (1 + d / 200);
}

function flankExposure(u: Unit, e: Unit): number {
  const a = aspectOfAttack(e.formation.x, e.formation.y, e.formation.facing, u.formation.x, u.formation.y);
  return a === 'rear' ? 1.8 : a === 'flank' ? 1.4 : 1;
}

function isSteadyInfantry(e: Unit): boolean {
  return e.type === 'infantry' && e.stance === 'hold' && !e.moving && !isFormationChanging(e) && e.cohesion >= 0.5;
}

function enemyDirX(state: BattleState, u: Unit): number {
  return -state.sideRearDir[u.side];
}

// ---------------------------------------------------------------------------

function decideAssault(state: BattleState, u: Unit, params: Params): UnitDecision {
  const strength = strengthOf(u);
  // Commander drama: heavy losses + low composure -> withdraw.
  if (strength > 0 && u.recentLosses / strength >= params.ai.heavyLossWindowFrac && u.commander.composure < params.ai.composureWithdrawThreshold) {
    return { action: { kind: 'idle' }, stance: 'withdraw', reason: '손실 급증, 지휘관 동요' };
  }
  const tp = params.types[u.type];
  const enemies = visibleEnemies(state, params, u).slice(0, 6);

  // Commitment: a charge already under way is carried through unless the target
  // has broken, died or run out of reach. Re-deciding every second would let the
  // unit dither at bayonet range.
  if (u.action.kind === 'charge') {
    const t = state.units[u.action.targetId];
    if (t && isAlive(t) && t.stance !== 'rout' && unitDistance(u, t) <= (u.type === 'cavalry' ? 350 : 120)) {
      return { action: u.action };
    }
  }

  // Artillery: advance until in range, then dig in (it can only fire in hold).
  if (u.type === 'artillery') {
    const e = enemies[0];
    if (!e) return { action: { kind: 'move', x: u.formation.x + enemyDirX(state, u) * 150, y: u.formation.y, charge: false } };
    const d = unitDistance(u, e);
    if (d <= tp.range * 0.7) return { action: { kind: 'idle' }, stance: 'hold', reason: '포병 사격 위치 확보' };
    return { action: { kind: 'approach', targetId: e.id, stopAt: tp.range * 0.6 } };
  }

  if (enemies.length === 0) {
    // Nothing in sight: advance toward the enemy side.
    return { action: { kind: 'move', x: u.formation.x + enemyDirX(state, u) * 200, y: u.formation.y, charge: false } };
  }

  const cands: Candidate[] = [];
  const hasFire = tp.fire > 0 && u.ammo > 0;
  const recentFail = state.tick - u.lastChargeFailTick < 15 * params.ticksPerSecond;
  // Units without firepower stage just outside musket range and close only by charging.
  const stopAt = hasFire ? tp.range * params.stance.assaultRangeHoldFrac : params.stance.stagingDistance;

  for (const e of enemies) {
    const d = unitDistance(u, e);
    const value = targetValue(u, e);
    const prox = proximity(d);
    const flank = flankExposure(u, e);
    const steady = isSteadyInfantry(e);

    // approach: close to effective range (or to the staging line if we cannot shoot)
    if (d > stopAt + 5) {
      cands.push({ score: value * prox * flank * 0.9, action: { kind: 'approach', targetId: e.id, stopAt } });
    }

    // volley: halt and shoot. While reloading, standing still at bayonet range is
    // a poor use of time, so the score drops and the charge gets its chance.
    if (hasFire && d <= tp.range) {
      const ammoFactor = Math.min(1, u.ammo / 8);
      const rangeFactor = 1 - (d / tp.range) * 0.6;
      const interval = tp.volleyIntervalSec * params.ticksPerSecond;
      const reloading = state.tick - u.lastVolleyTick < interval * 0.5;
      const reloadFactor = reloading && d < 50 ? 0.5 : 1;
      cands.push({ score: value * ammoFactor * rangeFactor * u.cohesion * 1.15 * reloadFactor, action: { kind: 'volley', targetId: e.id } });
    }

    // charge
    if (e.stance !== 'rout' || u.type === 'cavalry') {
      // Equal morale gives a modest edge; a shaken enemy makes the charge irresistible.
      const moraleEdge = Math.max(0.05, (u.morale - e.morale + params.ai.chargeMoraleAdvantage) / 100);
      let typeMult = 1;
      if (u.type === 'cavalry') typeMult = steady ? 0.5 : e.type === 'artillery' ? 2.0 : 1.5;
      else if (e.type === 'artillery') typeMult = 1.6;
      else if (e.type === 'cavalry') typeMult = 0.4;
      if (e.stance === 'rally' || e.stance === 'rout') typeMult *= 1.5;
      if (steady && u.type === 'infantry') typeMult *= 0.7;
      if (!hasFire) typeMult *= 1.8; // cold steel is all we have
      let score = value * moraleEdge * prox * u.cohesion * (0.4 + u.commander.aggression) * typeMult * flank * 2.0;
      if (d < 50) score *= 3; // already at bayonet range: one volley, then in
      if (recentFail) score *= 0.1;
      if (u.type === 'cavalry' ? d > params.stance.cavalryChargeDistance : d > 250) score *= 0.3; // too far: trot first
      cands.push({ score, action: { kind: 'charge', targetId: e.id } });
    }

    // after a repulsed charge, pull back out of musket range before trying again
    if (!hasFire && recentFail && d < stopAt - 20) {
      const away = Math.atan2(u.formation.y - e.formation.y, u.formation.x - e.formation.x);
      const fx = u.formation.x + Math.cos(away) * (stopAt - d + 20);
      const fy = u.formation.y + Math.sin(away) * (stopAt - d + 20);
      cands.push({ score: value * 1.5, action: { kind: 'fallback', x: Math.min(params.map.width - 15, Math.max(15, fx)), y: Math.min(params.map.height - 15, Math.max(15, fy)) } });
    }

    // reposition to a flank (composed commanders like it) — only from outside musket range
    const underFire = state.tick - u.underFireTick < 5 * params.ticksPerSecond;
    if (d < 260 && d > 140 && !underFire) {
      const a = aspectOfAttack(e.formation.x, e.formation.y, e.formation.facing, u.formation.x, u.formation.y);
      if (a === 'front') {
        // Point 70 m off the enemy's flank, on the side we're already closer to.
        const side = Math.sign(
          Math.sin(-e.formation.facing) * (u.formation.x - e.formation.x) + Math.cos(-e.formation.facing) * (u.formation.y - e.formation.y),
        ) || 1;
        const fx = e.formation.x + Math.cos(e.formation.facing + (side * Math.PI) / 2) * 70;
        const fy = e.formation.y + Math.sin(e.formation.facing + (side * Math.PI) / 2) * 70;
        const inMap = fx > 10 && fx < params.map.width - 10 && fy > 10 && fy < params.map.height - 10;
        if (inMap) cands.push({ score: value * prox * u.commander.composure * 0.7, action: { kind: 'reposition', x: fx, y: fy } });
      }
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return { action: { kind: 'idle' } };
  return { action: best.action };
}

function pickHoldPosition(state: BattleState, u: Unit, params: Params): { x: number; y: number } {
  const r = params.stance.holdRepositionRadius;
  const cs = state.terrain.cellSize;
  const here = terrainAt(state.terrain, u.formation.x, u.formation.y);
  let best = { x: u.formation.x, y: u.formation.y, v: defensiveValue(here), d: 0 };
  for (let dy = -r; dy <= r; dy += cs) {
    for (let dx = -r; dx <= r; dx += cs) {
      const x = u.formation.x + dx;
      const y = u.formation.y + dy;
      if (x < 20 || y < 20 || x > params.map.width - 20 || y > params.map.height - 20) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      const v = defensiveValue(terrainAt(state.terrain, x, y));
      if (v > best.v + 1e-9 || (Math.abs(v - best.v) < 1e-9 && d < best.d - 1e-9 && v > 0)) best = { x, y, v, d };
    }
  }
  return { x: best.x, y: best.y };
}

function decideHold(state: BattleState, u: Unit, params: Params): UnitDecision {
  const enemies = visibleEnemies(state, params, u);
  const nearest = enemies[0];

  // Commander drama: aggressive commander sees an enemy break nearby -> assault.
  if (
    u.type !== 'artillery' &&
    state.tick - u.sawEnemyRoutTick <= 3 * params.ticksPerSecond &&
    u.commander.aggression >= params.ai.aggressionAutoAssaultThreshold &&
    u.morale >= 55 &&
    nearest &&
    unitDistance(u, nearest) <= 200
  ) {
    return { action: { kind: 'idle' }, stance: 'assault', reason: '적 붕괴 목격, 공격적 지휘관' };
  }

  if (!u.holdPos) u.holdPos = pickHoldPosition(state, u, params);
  const hp = u.holdPos;
  const dHome = Math.hypot(hp.x - u.formation.x, hp.y - u.formation.y);
  if (dHome > 2.5) return { action: { kind: 'reposition', x: hp.x, y: hp.y } };
  if (nearest) return { action: { kind: 'volley', targetId: nearest.id } }; // face & fire
  return { action: { kind: 'idle' } };
}

function decideScreen(state: BattleState, u: Unit, params: Params): UnitDecision {
  const enemies = visibleEnemies(state, params, u);
  const nearest = enemies[0];
  if (!nearest) return { action: { kind: 'idle' } };
  const d = unitDistance(u, nearest);
  const keep = params.stance.screenKeepDistance * (u.type === 'cavalry' ? 0.8 : 1);
  if (d < keep) {
    const rear = state.sideRearDir[u.side];
    const away = Math.atan2(u.formation.y - nearest.formation.y, u.formation.x - nearest.formation.x);
    const fx = u.formation.x + Math.cos(away) * params.stance.screenFallbackDistance * 0.5 + rear * params.stance.screenFallbackDistance * 0.7;
    const fy = u.formation.y + Math.sin(away) * params.stance.screenFallbackDistance * 0.5;
    const x = Math.min(params.map.width - 15, Math.max(15, fx));
    const y = Math.min(params.map.height - 15, Math.max(15, fy));
    return { action: { kind: 'fallback', x, y } };
  }
  return { action: { kind: 'volley', targetId: nearest.id } }; // just face them
}

function decideWithdraw(state: BattleState, u: Unit, params: Params): UnitDecision {
  const enemies = visibleEnemies(state, params, u);
  const pursuer = enemies[0];
  // Hot-headed commanders lash back at a weak pursuer.
  if (
    pursuer &&
    u.type !== 'artillery' &&
    u.commander.aggression > 0.75 &&
    unitDistance(u, pursuer) < 60 &&
    pursuer.morale < u.morale - 20 &&
    pursuer.stance !== 'rout'
  ) {
    return { action: { kind: 'charge', targetId: pursuer.id } };
  }
  const rp = rearPoint(state, params, u);
  return { action: { kind: 'move', x: rp.x, y: rp.y, charge: false } };
}

function decideRally(): UnitDecision {
  return { action: { kind: 'idle' } };
}

/** The unit brain used by both sides. */
export const unitBrain: UnitBrain = (state, u, params) => {
  if (!isAlive(u)) return { action: { kind: 'idle' } };
  switch (u.stance) {
    case 'assault':
      return decideAssault(state, u, params);
    case 'hold':
      return decideHold(state, u, params);
    case 'screen':
      return decideScreen(state, u, params);
    case 'withdraw':
      return decideWithdraw(state, u, params);
    case 'rally':
      return decideRally();
    default:
      return { action: { kind: 'idle' } };
  }
};
