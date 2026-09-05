/**
 * One simulation tick. Mutates `state` in place and returns it.
 *
 * Order of operations (fixed for determinism):
 *  1. player stance inputs
 *  2. unit brains (every reactionInterval)
 *  3. movement & formation timers
 *  4. soldier motion
 *  5. volleys
 *  6. charges / melee
 *  7. morale, cohesion, fatigue bookkeeping
 *  8. automatic transitions (rout, recovery, under-fire)
 *  9. destroyed / exited, victory, morale sampling
 */
import type { UnitBrain } from './brain';
import { formationForStance, formationHalfDepth, slotPosition } from './formation';
import { angleTo, aspectOfAttack, clamp, dist, lerp, relativeBearing, turnToward, wrapAngle } from './geom';
import type { Params } from './params';
import {
  collapseThreshold,
  isAlive,
  isAvailable,
  isFormationChanging,
  recoverThreshold,
  strengthOf,
  unitDistance,
  visibleEnemies,
} from './queries';
import { Rng } from './rng';
import { coverMultiplier, heightAt, terrainAt } from './terrain';
import type { BattleEvent, BattleState, SideId, Stance, StanceInput, Unit, VolleyRecord } from './types';

const STANCE_LABEL: Record<Stance, string> = {
  assault: '공세',
  hold: '방어',
  screen: '은폐',
  withdraw: '후퇴',
  rally: '재편',
  rout: '패주',
};

export function stanceLabel(s: Stance): string {
  return STANCE_LABEL[s];
}

function pushEvent(state: BattleState, e: Omit<BattleEvent, 'tick'>): void {
  state.events.push({ tick: state.tick, ...e });
}

// ---------------------------------------------------------------------------
// Stance changes
// ---------------------------------------------------------------------------

function beginFormationChange(u: Unit, params: Params): void {
  const target = formationForStance(u.stance, u.type);
  if (target === u.formation.kind) {
    u.formationTarget = null;
    u.formationChangeRemaining = 0;
    return;
  }
  if (u.formationTarget === target) return; // already heading there
  const mult = u.type === 'cavalry' ? 0.5 : 1;
  u.formationTarget = target;
  u.formationChangeRemaining = Math.round(params.unit.formationChangeSec * params.ticksPerSecond * mult);
}

export function setStance(state: BattleState, params: Params, u: Unit, stance: Stance, source: 'player' | 'auto', reason?: string): void {
  if (u.stance === stance) return;
  const from = u.stance;
  u.prevStance = from;
  u.stance = stance;
  u.stanceSinceTick = state.tick;
  u.holdPos = null;
  u.chargeAnnouncedTarget = null;
  if (stance !== 'assault') u.charging = false;
  // A new stance always re-plans; keep melee lock though.
  u.action = { kind: 'idle' };
  beginFormationChange(u, params);
  if (stance === 'rout') {
    for (const s of u.soldiers) if (s.alive) s.fled = true;
  } else if (from === 'rout') {
    for (const s of u.soldiers) s.fled = false;
  }
  if (source === 'player') {
    pushEvent(state, {
      kind: 'stance_player',
      side: u.side,
      unitId: u.id,
      text: `${u.name}: ${STANCE_LABEL[from]} → ${STANCE_LABEL[stance]} (명령)`,
      data: { from, to: stance },
    });
  } else if (stance !== 'rout') {
    pushEvent(state, {
      kind: 'stance_auto',
      side: u.side,
      unitId: u.id,
      text: `${u.name}: ${STANCE_LABEL[from]} → ${STANCE_LABEL[stance]} (자동${reason ? ': ' + reason : ''})`,
      data: { from, to: stance, reason: reason ?? '' },
    });
  }
}

function applyInputs(state: BattleState, params: Params, inputs: StanceInput[]): void {
  for (const inp of inputs) {
    if (inp.tick !== state.tick) continue;
    const u = state.units[inp.unitId];
    if (!u || !isAlive(u)) continue;
    if (u.stance === 'rout') continue; // player cannot pull a routing unit out
    setStance(state, params, u, inp.stance, 'player');
  }
}

// ---------------------------------------------------------------------------
// Casualties & morale
// ---------------------------------------------------------------------------

type DamageKind = 'fire' | 'artillery' | 'melee' | 'shock';

/**
 * Kill up to `n` soldiers of `target`, closest to the attacker first. Applies the
 * morale/cohesion consequences. Returns actual kills.
 */
function applyCasualties(
  state: BattleState,
  params: Params,
  target: Unit,
  n: number,
  fromX: number,
  fromY: number,
  kind: DamageKind,
  attackerComposureIgnored = false,
): number {
  if (n <= 0) return 0;
  const before = strengthOf(target);
  if (before === 0) return 0;
  const alive: { i: number; d: number }[] = [];
  for (let i = 0; i < target.soldiers.length; i++) {
    const s = target.soldiers[i]!;
    if (!s.alive) continue;
    alive.push({ i, d: (s.x - fromX) * (s.x - fromX) + (s.y - fromY) * (s.y - fromY) });
  }
  alive.sort((a, b) => a.d - b.d || a.i - b.i);
  const kills = Math.min(n, alive.length);
  for (let k = 0; k < kills; k++) target.soldiers[alive[k]!.i]!.alive = false;

  target.casualties += kills;
  target.recentLosses += kills;
  target.underFireTick = state.tick;

  const lossFrac = kills / before;
  const aspect = aspectOfAttack(target.formation.x, target.formation.y, target.formation.facing, fromX, fromY);
  const aspectMult = aspect === 'rear' ? params.morale.rearHitMult : aspect === 'flank' ? params.morale.flankHitMult : 1;
  const mitigation = attackerComposureIgnored ? 1 : 1 - target.commander.composure * params.morale.composureLossMitigation;
  let drop = params.morale.lossFactor * lossFrac * 100 * aspectMult * mitigation;
  if (kind === 'melee') drop *= params.morale.meleeLossMult;
  if (kind === 'artillery') drop += params.morale.artilleryHitFlat * mitigation;
  target.morale = clamp(target.morale - drop, 0, 100);
  target.cohesion = clamp(target.cohesion - params.cohesion.perLossFrac * lossFrac, params.cohesion.min, 1);
  return kills;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function unitSpeed(params: Params, u: Unit, mult: number): number {
  const tp = params.types[u.type];
  let s = params.unit.baseSpeedMps * tp.speed * mult;
  s *= 1 - params.unit.fatigueSpeedPenalty * u.fatigue;
  if (isFormationChanging(u)) s *= 0.7;
  return s;
}

/** Move the anchor toward (tx, ty). Returns true if it moved. */
function moveAnchorToward(state: BattleState, params: Params, u: Unit, tx: number, ty: number, speedMult: number, stopWithin: number): boolean {
  const dt = 1 / params.ticksPerSecond;
  const d = dist(u.formation.x, u.formation.y, tx, ty);
  if (d <= stopWithin) return false;
  const speed = unitSpeed(params, u, speedMult);
  const stepLen = Math.min(speed * dt, d - stopWithin);
  const ang = angleTo(u.formation.x, u.formation.y, tx, ty);
  // Turn toward movement direction; move regardless (units can side-step).
  u.formation.facing = turnToward(u.formation.facing, ang, (params.unit.turnRateRadPerSec * dt) / (speedMult > 1 ? 1 : 0.6));
  u.formation.x += Math.cos(ang) * stepLen;
  u.formation.y += Math.sin(ang) * stepLen;
  return stepLen > 1e-6;
}

function faceToward(params: Params, u: Unit, tx: number, ty: number): void {
  const dt = 1 / params.ticksPerSecond;
  const ang = angleTo(u.formation.x, u.formation.y, tx, ty);
  u.formation.facing = turnToward(u.formation.facing, ang, params.unit.turnRateRadPerSec * dt);
}

function clampToMap(params: Params, u: Unit): void {
  // Withdrawing/routing units may leave through their own rear edge.
  const dir = u.stance === 'rout' || u.stance === 'withdraw' ? (u.side === 0 ? -1 : 1) : 0;
  const minX = dir < 0 ? -60 : 5;
  const maxX = dir > 0 ? params.map.width + 60 : params.map.width - 5;
  u.formation.x = clamp(u.formation.x, minX, maxX);
  u.formation.y = clamp(u.formation.y, 5, params.map.height - 5);
}

function executeMovement(state: BattleState, params: Params, u: Unit): void {
  u.moving = false;
  u.charging = false;
  if (u.meleeWith !== null) {
    const t = state.units[u.meleeWith];
    if (t) faceToward(params, u, t.formation.x, t.formation.y);
    return; // locked in melee: no movement
  }
  if (u.stance === 'rout') {
    const dir = state.sideRearDir[u.side];
    const tx = dir < 0 ? -80 : params.map.width + 80;
    u.moving = moveAnchorToward(state, params, u, tx, u.formation.y, params.unit.routSpeedMult, 0);
    return;
  }
  const a = u.action;
  switch (a.kind) {
    case 'idle':
      break;
    case 'move':
    case 'reposition':
    case 'fallback': {
      const charge = a.kind === 'move' && a.charge;
      u.moving = moveAnchorToward(state, params, u, a.x, a.y, charge ? params.unit.chargeSpeedMult : 1, 1.5);
      u.charging = charge && u.moving;
      break;
    }
    case 'approach': {
      const t = state.units[a.targetId];
      if (!t || !isAlive(t)) break;
      u.moving = moveAnchorToward(state, params, u, t.formation.x, t.formation.y, 1, a.stopAt);
      if (!u.moving) faceToward(params, u, t.formation.x, t.formation.y);
      break;
    }
    case 'charge': {
      const t = state.units[a.targetId];
      if (!t || !isAlive(t)) break;
      u.moving = moveAnchorToward(state, params, u, t.formation.x, t.formation.y, params.unit.chargeSpeedMult, 0);
      u.charging = u.moving;
      break;
    }
    case 'volley': {
      const t = state.units[a.targetId];
      if (t && isAlive(t)) faceToward(params, u, t.formation.x, t.formation.y);
      break;
    }
    default:
      break;
  }
  clampToMap(params, u);
}

function tickFormationChange(u: Unit): void {
  if (u.formationTarget === null) return;
  u.formationChangeRemaining -= 1;
  if (u.formationChangeRemaining <= 0) {
    u.formation.kind = u.formationTarget;
    u.formationTarget = null;
    u.formationChangeRemaining = 0;
  }
}

// ---------------------------------------------------------------------------
// Soldiers (visual layer)
// ---------------------------------------------------------------------------

function moveSoldiers(state: BattleState, params: Params, u: Unit, rng: Rng): void {
  const dt = 1 / params.ticksPerSecond;
  const n = strengthOf(u);
  if (n === 0) return;
  const kind = u.formationTarget ?? u.formation.kind;
  const baseMult = u.charging ? params.unit.chargeSpeedMult : u.stance === 'rout' ? params.unit.routSpeedMult : 1;
  const speed = unitSpeed(params, u, baseMult) * params.unit.soldierCatchUpMult + 0.3;
  const maxStep = speed * dt;
  let slot = 0;
  const scatter = u.stance === 'rout' ? 2.2 : 1;
  for (const s of u.soldiers) {
    if (!s.alive) continue;
    let p = slotPosition(u.formation, u.stance === 'rout' ? 'skirmish' : kind, u.type, slot, n);
    if (scatter !== 1) {
      p = { x: u.formation.x + (p.x - u.formation.x) * scatter, y: u.formation.y + (p.y - u.formation.y) * scatter };
    }
    slot++;
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.05) continue;
    const step = Math.min(d, maxStep);
    s.x += (dx / d) * step;
    s.y += (dy / d) * step;
    if (s.fled && d > 3) {
      // Routing men stumble: small deterministic jitter.
      s.x += (rng.float() - 0.5) * 0.6;
      s.y += (rng.float() - 0.5) * 0.6;
    }
  }
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

function canFireNow(state: BattleState, params: Params, u: Unit): boolean {
  const tp = params.types[u.type];
  if (tp.fire <= 0 || u.ammo <= 0) return false;
  if (u.meleeWith !== null) return false;
  if (u.stance === 'rally' || u.stance === 'rout' || u.stance === 'screen') return false;
  if (u.type === 'artillery' && (u.stance !== 'hold' || u.moving || isFormationChanging(u))) return false;
  const interval = Math.round(tp.volleyIntervalSec * params.ticksPerSecond);
  if (state.tick - u.lastVolleyTick < interval) return false;
  return true;
}

function pickFireTarget(state: BattleState, params: Params, u: Unit): Unit | null {
  const tp = params.types[u.type];
  const enemies = visibleEnemies(state, params, u);
  let best: Unit | null = null;
  let bestScore = -Infinity;
  for (const e of enemies) {
    const d = unitDistance(u, e);
    if (d > tp.range) continue;
    if (u.type === 'artillery' && d < params.fire.artilleryMinRange) continue;
    if (u.stance === 'withdraw' && d > params.stance.withdrawPursuitDistance) continue;
    const bearing = Math.abs(relativeBearing(u.formation.facing, u.formation.x, u.formation.y, e.formation.x, e.formation.y));
    if (bearing > params.fire.firingArcRad) continue;
    // Prefer the action target, then nearest.
    let score = -d;
    if (u.action.kind === 'volley' && u.action.targetId === e.id) score += 1000;
    if (u.action.kind === 'approach' && u.action.targetId === e.id) score += 500;
    if (e.stance === 'rout') score -= 200; // don't waste volleys on the fleeing
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

function expectedFireCasualties(state: BattleState, params: Params, u: Unit, t: Unit, d: number, pointBlank = false): number {
  const tp = params.types[u.type];
  const shooters = strengthOf(u);
  const isArt = u.type === 'artillery';
  const perSoldier = isArt ? params.fire.artilleryHitPerSoldier : params.fire.baseHitPerSoldier;
  let falloff: number;
  if (pointBlank) falloff = 1;
  else if (isArt) falloff = lerp(1, 0.6, clamp(d / tp.range, 0, 1));
  else {
    const start = tp.range * params.fire.falloffStartFrac;
    falloff = d <= start ? 1 : lerp(1, params.fire.falloffEndMult, clamp((d - start) / (tp.range - start), 0, 1));
  }
  const cover = coverMultiplier(params, terrainAt(state.terrain, t.formation.x, t.formation.y), t.stance === 'hold');
  let exp = perSoldier * tp.fire * shooters * falloff * cover * u.cohesion * (1 - params.fire.fatiguePenalty * u.fatigue);
  if (isFormationChanging(u)) exp *= params.unit.formationChangingFireMult;
  if (u.stance === 'withdraw') exp *= params.fire.withdrawDelayFireMult;
  // Skirmishers are hard to hit but so are the men in a scattered rout column.
  if (t.formation.kind === 'skirmish' && !isFormationChanging(t)) exp *= 0.7;
  return exp;
}

function resolveVolleys(state: BattleState, params: Params, rng: Rng): void {
  state.volleys = [];
  for (const u of state.units) {
    if (!isAlive(u)) continue;
    if (!canFireNow(state, params, u)) continue;
    const t = pickFireTarget(state, params, u);
    if (!t) continue;
    const d = unitDistance(u, t);
    const exp = expectedFireCasualties(state, params, u, t, d);
    const n = rng.roundStochastic(exp);
    const kind: DamageKind = u.type === 'artillery' ? 'artillery' : 'fire';
    const kills = applyCasualties(state, params, t, n, u.formation.x, u.formation.y, kind);
    u.ammo -= 1;
    u.lastVolleyTick = state.tick;
    u.targetId = t.id;
    const rec: VolleyRecord = { fromId: u.id, toId: t.id, casualties: kills, artillery: u.type === 'artillery' };
    state.volleys.push(rec);
    if (u.ammo === 0) {
      pushEvent(state, {
        kind: 'ammo_out',
        side: u.side,
        unitId: u.id,
        text: `${u.name}: 탄약 소진 — 사격 불가, 돌격만 가능`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Charges & melee
// ---------------------------------------------------------------------------

function isSteadyInfantry(u: Unit): boolean {
  return u.type === 'infantry' && u.stance === 'hold' && !u.moving && !isFormationChanging(u) && u.cohesion >= 0.5;
}

function meleePower(state: BattleState, params: Params, u: Unit, t: Unit): number {
  const tp = params.types[u.type];
  const strength = strengthOf(u);
  const chargeWindow = state.tick - u.meleeSinceTick < params.melee.chargeWindowSec * params.ticksPerSecond;
  // The unit that delivered the charge keeps its charge bonus for a few seconds.
  const attacker = u.chargeAnnouncedTarget === t.id;
  const coef = chargeWindow && attacker ? tp.meleeCharge : tp.melee;
  let power = strength * u.cohesion * coef * (1 - params.melee.fatigueMeleePenalty * u.fatigue);
  if (isFormationChanging(u)) power *= params.unit.formationChangingMeleeMult;
  // Terrain
  const hu = heightAt(state.terrain, u.formation.x, u.formation.y);
  const ht = heightAt(state.terrain, t.formation.x, t.formation.y);
  if (ht > hu) power /= params.melee.hillDefenderBonus;
  if (u.type === 'cavalry' && terrainAt(state.terrain, u.formation.x, u.formation.y) === 'forest') power *= params.melee.forestCavalryPenalty;
  // Aspect (hitting a flank/rear)
  const aspect = aspectOfAttack(t.formation.x, t.formation.y, t.formation.facing, u.formation.x, u.formation.y);
  if (aspect === 'flank') power *= params.melee.flankBonus;
  else if (aspect === 'rear') power *= params.melee.rearBonus;
  return power;
}

function startMelee(state: BattleState, params: Params, a: Unit, b: Unit): void {
  a.meleeWith = b.id;
  a.meleeSinceTick = state.tick;
  a.action = { kind: 'idle' };
  a.morale = clamp(a.morale + params.melee.chargeElan, 0, 100); // charging home lifts the attackers
  if (b.meleeWith === null) {
    b.meleeWith = a.id;
    b.meleeSinceTick = state.tick;
    b.action = { kind: 'idle' };
  }
  b.underFireTick = state.tick;
  pushEvent(state, {
    kind: 'melee_start',
    side: a.side,
    unitId: a.id,
    text: `${a.name} ↔ ${b.name}: 근접전 시작`,
    data: { targetId: b.id },
  });
  // Rally / screen units caught in melee snap to hold.
  if (b.stance === 'rally' || b.stance === 'screen') setStance(state, params, b, 'hold', 'auto', '근접 피격');
}

function resolveCharges(state: BattleState, params: Params, rng: Rng): void {
  // Cavalry contacts resolve first: when horse and foot charge each other the
  // horsemen deliver the shock. Order is fixed (type, then id) for determinism.
  const order = state.units
    .filter((u) => u.action.kind === 'charge')
    .sort((a, b) => (a.type === 'cavalry' ? 0 : 1) - (b.type === 'cavalry' ? 0 : 1) || a.id - b.id);
  for (const u of order) {
    if (!isAlive(u) || u.meleeWith !== null) continue;
    if (u.action.kind !== 'charge') continue;
    const t = state.units[u.action.targetId];
    if (!t || !isAlive(t)) {
      u.action = { kind: 'idle' };
      continue;
    }
    if (u.chargeAnnouncedTarget !== t.id) {
      u.chargeAnnouncedTarget = t.id;
      pushEvent(state, {
        kind: 'charge_start',
        side: u.side,
        unitId: u.id,
        text: `${u.name}: ${t.name}에 돌격!`,
        data: { targetId: t.id },
      });
    }
    const n = strengthOf(u);
    const nt = strengthOf(t);
    const contact =
      params.unit.contactDistance +
      formationHalfDepth(u.formation.kind, u.type, n) +
      formationHalfDepth(t.formation.kind, t.type, nt);
    if (unitDistance(u, t) > contact) continue;

    // --- Contact ---
    u.targetId = t.id;
    if (t.stance === 'rout') {
      // Riding down a routing unit: free casualties, no melee.
      const kills = applyCasualties(state, params, t, rng.roundStochastic(n * 0.06), u.formation.x, u.formation.y, 'melee');
      u.action = { kind: 'idle' };
      u.chargeAnnouncedTarget = null;
      void kills;
      continue;
    }

    const steady = isSteadyInfantry(t);
    let brokeIn = false;
    if (u.type === 'cavalry' && steady) {
      brokeIn = true; // unless repulsed below, the horsemen get in among the files
      if (rng.chance(params.melee.cavalryChargeVsSteadyInfantryFailChance)) {
        // Repulsed by a steady line: closing volley + push back.
        if (t.ammo > 0 && params.types[t.type].fire > 0) {
          const exp = expectedFireCasualties(state, params, t, u, 0, true);
          applyCasualties(state, params, u, rng.roundStochastic(exp), t.formation.x, t.formation.y, 'fire');
          t.ammo -= 1;
          t.lastVolleyTick = state.tick;
          state.volleys.push({ fromId: t.id, toId: u.id, casualties: 0, artillery: false });
        }
        u.morale = clamp(u.morale - params.melee.chargeFailMoraleLoss, 0, 100);
        u.lastChargeFailTick = state.tick;
        const back = angleTo(t.formation.x, t.formation.y, u.formation.x, u.formation.y);
        u.formation.x += Math.cos(back) * params.melee.chargeFailPushbackM;
        u.formation.y += Math.sin(back) * params.melee.chargeFailPushbackM;
        clampToMap(params, u);
        u.action = { kind: 'idle' };
        u.chargeAnnouncedTarget = null;
        t.morale = clamp(t.morale + 5, 0, 100);
        pushEvent(state, {
          kind: 'charge_repulsed',
          side: u.side,
          unitId: u.id,
          text: `${u.name}의 돌격이 ${t.name}의 정연한 대열에 격퇴됨`,
          data: { targetId: t.id },
        });
        continue;
      }
    }

    // Shock test on the defender.
    const aspect = aspectOfAttack(t.formation.x, t.formation.y, t.formation.facing, u.formation.x, u.formation.y);
    const aspectMult = aspect === 'rear' ? params.morale.rearHitMult : aspect === 'flank' ? params.morale.flankHitMult : 1;
    const mitigation = 1 - t.commander.composure * params.morale.composureLossMitigation;
    let shock = params.melee.chargeShockBase * u.cohesion * aspectMult;
    if (u.type === 'cavalry' && t.type === 'infantry' && (!steady || brokeIn)) {
      shock = params.melee.cavalryChargeShockVsMoving * u.cohesion * aspectMult + params.morale.cavalryChargeReceived;
    }
    t.morale = clamp(t.morale - shock * mitigation, 0, 100);
    t.underFireTick = state.tick;
    if (t.morale < collapseThreshold(params, t)) {
      routUnit(state, params, t, `${u.name}의 돌격 앞에서`);
      pushEvent(state, {
        kind: 'charge_broke_enemy',
        side: u.side,
        unitId: u.id,
        text: `${u.name}의 돌격에 ${t.name} 접촉 전 붕괴!`,
        data: { targetId: t.id },
      });
      u.action = { kind: 'idle' };
      u.chargeAnnouncedTarget = null;
      u.morale = clamp(u.morale + 5, 0, 100);
      continue;
    }
    startMelee(state, params, u, t);
  }
}

function resolveMelee(state: BattleState, params: Params, rng: Rng): void {
  const dt = 1 / params.ticksPerSecond;
  for (const u of state.units) {
    if (!isAlive(u) || u.meleeWith === null) continue;
    const t = state.units[u.meleeWith];
    if (!t || !isAlive(t) || t.stance === 'rout' || unitDistance(u, t) > params.melee.disengageDistance) {
      u.meleeWith = null;
      u.chargeAnnouncedTarget = null;
      u.action = { kind: 'idle' };
      pushEvent(state, {
        kind: 'melee_end',
        side: u.side,
        unitId: u.id,
        text: `${u.name}: 근접전 종료${t && t.stance === 'rout' ? ` — ${t.name} 붕괴` : ''}`,
        data: { targetId: t ? t.id : null },
      });
      if (t && t.stance === 'rout') u.morale = clamp(u.morale + 6, 0, 100);
      continue;
    }
    const power = meleePower(state, params, u, t);
    const exp = power * params.melee.casualtiesPerPowerPerSec * dt;
    const n = rng.roundStochastic(exp);
    if (n > 0) applyCasualties(state, params, t, n, u.formation.x, u.formation.y, 'melee');
    u.targetId = t.id;
  }
}

// ---------------------------------------------------------------------------
// Morale / cohesion / fatigue / transitions
// ---------------------------------------------------------------------------

function routUnit(state: BattleState, params: Params, u: Unit, cause: string): void {
  if (u.stance === 'rout') return;
  const from = u.stance;
  setStance(state, params, u, 'rout', 'auto');
  u.meleeWith = null;
  pushEvent(state, {
    kind: 'rout',
    side: u.side,
    unitId: u.id,
    text: `${u.name} 패주! (${STANCE_LABEL[from]} 중, ${cause})`,
    data: { from },
  });
  // Witnesses
  for (const o of state.units) {
    if (o.id === u.id || !isAlive(o) || o.stance === 'rout') continue;
    const d = unitDistance(o, u);
    if (o.side === u.side) {
      if (d <= params.morale.friendlyRoutWitnessRadius) {
        const mit = 1 - o.commander.composure * params.morale.composureLossMitigation;
        o.morale = clamp(o.morale - params.morale.friendlyRoutWitnessed * mit, 0, 100);
      }
    } else if (d <= params.morale.enemyRoutWitnessRadius) {
      o.morale = clamp(o.morale + params.morale.enemyRoutWitnessed, 0, 100);
      o.sawEnemyRoutTick = state.tick;
    }
  }
}

function updateBookkeeping(state: BattleState, params: Params): void {
  const dt = 1 / params.ticksPerSecond;
  const decay = 1 / (params.morale.recentWindowSec * params.ticksPerSecond);
  for (const u of state.units) {
    if (!isAlive(u)) continue;
    const tp = params.types[u.type];
    // Recent-loss decay
    u.recentLosses -= u.recentLosses * decay;
    if (u.recentLosses < 0.01) u.recentLosses = 0;

    // Passive morale
    let dm = params.morale.recoveryPerSec[u.stance] * dt;
    if (u.stance === 'rout') {
      let enemyNear = false;
      for (const e of state.units) {
        if (e.side === u.side || !isAlive(e)) continue;
        if (unitDistance(u, e) <= params.morale.routRecoveryEnemyRadius) {
          enemyNear = true;
          break;
        }
      }
      if (enemyNear) dm = 0;
    }
    let friendNear = false;
    for (const f of state.units) {
      if (f.side !== u.side || f.id === u.id || !isAvailable(f)) continue;
      if (unitDistance(u, f) <= params.morale.adjacentFriendlyRadius) {
        friendNear = true;
        break;
      }
    }
    dm += friendNear ? params.morale.adjacentFriendlyPerSec * dt : -params.morale.isolationPerSec * dt;
    // Passive recovery only restores morale up to a ceiling that shrinks as the
    // unit is worn down: a company at a third of its strength never feels fresh.
    const frac = strengthOf(u) / Math.max(1, u.initialStrength);
    const cap = params.morale.passiveCap * (params.morale.strengthCapFloor + (1 - params.morale.strengthCapFloor) * frac);
    if (dm > 0 && u.morale >= cap) dm = 0;
    u.morale = clamp(u.morale + dm, 0, Math.max(cap, u.morale));

    // Cohesion
    let dc: number;
    if (isFormationChanging(u)) dc = params.cohesion.formationChangePerSec;
    else if (u.charging) dc = u.cohesion > params.cohesion.chargeFloor ? params.cohesion.chargePerSec : 0;
    else if (u.moving) dc = u.cohesion > params.cohesion.moveFloor ? params.cohesion.movePerSec : 0;
    else if (u.stance === 'rally') dc = params.cohesion.rallyPerSec;
    else if (u.stance === 'rout') dc = -0.05;
    else dc = params.cohesion.stillPerSec;
    u.cohesion = clamp(u.cohesion + dc * dt, params.cohesion.min, 1);

    // Fatigue
    let df: number;
    if (u.meleeWith !== null) df = params.fatigue.meleePerSec;
    else if (u.charging) df = params.fatigue.chargePerSec * tp.fatigueMult;
    else if (u.moving) df = params.fatigue.movePerSec * tp.fatigueMult;
    else df = -params.fatigue.restPerSec;
    u.fatigue = clamp(u.fatigue + df * dt, 0, 1);
  }
}

function autoTransitions(state: BattleState, params: Params, rng: Rng): void {
  for (const u of state.units) {
    if (!isAlive(u)) continue;
    if (u.stance === 'rout') {
      if (u.morale >= recoverThreshold(params, u)) {
        // Deserters: a fraction never comes back.
        const n = strengthOf(u);
        const deserters = Math.floor(n * params.morale.routDeserterFraction);
        let left = deserters;
        for (const s of u.soldiers) {
          if (left <= 0) break;
          if (s.alive) {
            s.alive = false;
            left--;
          }
        }
        u.casualties += deserters;
        setStance(state, params, u, 'rally', 'auto', '사기 회복');
        pushEvent(state, {
          kind: 'rally_recovered',
          side: u.side,
          unitId: u.id,
          text: `${u.name}: 패주 수습, 재편 시작 (탈영 ${deserters}명)`,
          data: { deserters },
        });
      }
      continue;
    }
    if (u.morale < collapseThreshold(params, u)) {
      routUnit(state, params, u, '사기 붕괴');
      continue;
    }
    // Rally / screen under fire -> hold
    if ((u.stance === 'rally' || u.stance === 'screen') && u.underFireTick === state.tick) {
      setStance(state, params, u, 'hold', 'auto', '피격');
    }
  }
  void rng;
}

function checkDestroyedExited(state: BattleState, params: Params): void {
  for (const u of state.units) {
    if (!isAlive(u)) continue;
    const n = strengthOf(u);
    if (n < params.unit.destroyedBelowStrength) {
      u.destroyed = true;
      u.meleeWith = null;
      for (const o of state.units) if (o.meleeWith === u.id) o.meleeWith = null;
      pushEvent(state, { kind: 'unit_destroyed', side: u.side, unitId: u.id, text: `${u.name} 전멸 (생존 ${n}명)` });
      continue;
    }
    const x = u.formation.x;
    const outLeft = u.side === 0 && x <= -30;
    const outRight = u.side === 1 && x >= params.map.width + 30;
    if ((u.stance === 'rout' || u.stance === 'withdraw') && (outLeft || outRight)) {
      u.exited = true;
      u.meleeWith = null;
      pushEvent(state, { kind: 'unit_exited', side: u.side, unitId: u.id, text: `${u.name} 전장 이탈 (${STANCE_LABEL[u.stance]})` });
    }
  }
}

function checkVictory(state: BattleState, params: Params): void {
  if (state.result) return;
  const total: [number, number] = [0, 0];
  const avail: [number, number] = [0, 0];
  const anyAlive: [boolean, boolean] = [false, false];
  for (const u of state.units) {
    total[u.side]++;
    if (isAvailable(u)) avail[u.side]++;
    if (isAlive(u)) anyAlive[u.side] = true;
  }
  const lost: [boolean, boolean] = [
    avail[0] / Math.max(1, total[0]) <= params.victory.availableFractionToLose,
    avail[1] / Math.max(1, total[1]) <= params.victory.availableFractionToLose,
  ];
  const timeout = state.tick >= params.battleTimeLimitSec * params.ticksPerSecond;
  let winner: SideId | null = null;
  let reason: 'available' | 'exited' | 'timeout' | 'annihilation' | null = null;
  if (!anyAlive[0] || !anyAlive[1]) {
    reason = 'exited';
    winner = !anyAlive[0] && !anyAlive[1] ? null : !anyAlive[0] ? 1 : 0;
  } else if (lost[0] || lost[1]) {
    reason = 'available';
    if (lost[0] && lost[1]) {
      const v0 = fightingValueOf(state, 0);
      const v1 = fightingValueOf(state, 1);
      winner = v0 === v1 ? null : v0 > v1 ? 0 : 1;
    } else winner = lost[0] ? 1 : 0;
  } else if (timeout) {
    reason = 'timeout';
    const v0 = fightingValueOf(state, 0);
    const v1 = fightingValueOf(state, 1);
    winner = v0 === v1 ? null : v0 > v1 ? 0 : 1;
  }
  if (reason) {
    state.result = { winner, reason, endTick: state.tick };
    pushEvent(state, {
      kind: 'battle_end',
      side: winner,
      unitId: null,
      text:
        winner === null
          ? `전투 종료 — 무승부 (${reason})`
          : `전투 종료 — ${winner === 0 ? '아군' : '적군'} 승리 (${reason === 'available' ? '가용 부대 30% 이하' : reason === 'timeout' ? '시간 초과, 전투력 우세' : '전원 이탈'})`,
      data: { winner, reason },
    });
  }
}

function fightingValueOf(state: BattleState, side: SideId): number {
  let v = 0;
  for (const u of state.units) if (u.side === side && isAvailable(u)) v += strengthOf(u) * u.morale;
  return v;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StepOptions {
  brain?: UnitBrain;
  /** Sample morale every N ticks (default 5 s). */
  moraleSampleTicks?: number;
  /**
   * Skip per-soldier motion (visual layer). Combat outcomes do not depend on
   * soldier positions except for which individual soldier dies, so batch runs
   * can turn this off for a large speed-up. Hashes differ between modes.
   */
  skipSoldiers?: boolean;
}

/**
 * Advance the battle by one tick. Mutates and returns `state`.
 * `inputs` are stance commands; only those with `tick === state.tick` apply.
 */
export function step(state: BattleState, params: Params, inputs: readonly StanceInput[], opts: StepOptions = {}): BattleState {
  if (state.result) return state;
  const rng = new Rng(state.rng);
  const brain = opts.brain;
  const reactionTicks = Math.max(1, Math.round(params.stance.reactionIntervalSec * params.ticksPerSecond));

  // 1. player inputs
  applyInputs(state, params, inputs as StanceInput[]);

  // 2. brains
  if (brain && state.tick % reactionTicks === 0) {
    for (const u of state.units) {
      if (!isAlive(u) || u.stance === 'rout' || u.meleeWith !== null) continue;
      const d = brain(state, u, params);
      if (d.stance && d.stance !== u.stance) {
        setStance(state, params, u, d.stance, 'auto', d.reason);
      }
      u.action = d.action;
    }
  }

  // 3. movement
  for (const u of state.units) {
    if (!isAlive(u)) continue;
    tickFormationChange(u);
    executeMovement(state, params, u);
  }

  // 4. soldiers
  if (!opts.skipSoldiers) {
    for (const u of state.units) {
      if (!isAlive(u)) continue;
      moveSoldiers(state, params, u, rng);
    }
  }

  // 5–6. combat
  resolveVolleys(state, params, rng);
  resolveCharges(state, params, rng);
  resolveMelee(state, params, rng);

  // 7–8. bookkeeping & transitions
  updateBookkeeping(state, params);
  autoTransitions(state, params, rng);

  // 9. end-of-tick checks
  checkDestroyedExited(state, params);
  state.tick += 1;
  const sample = opts.moraleSampleTicks ?? 5 * params.ticksPerSecond;
  if (state.tick % sample === 0) {
    state.moraleHistory.push({ tick: state.tick, morale: state.units.map((u) => Math.round(u.morale * 10) / 10) });
  }
  checkVictory(state, params);
  state.rng = rng.state;
  return state;
}

/** Run until the battle ends or `maxTicks` elapse. */
export function runBattle(
  state: BattleState,
  params: Params,
  inputs: readonly StanceInput[],
  opts: StepOptions & { maxTicks?: number; onTick?: (s: BattleState) => void } = {},
): BattleState {
  const max = opts.maxTicks ?? params.battleTimeLimitSec * params.ticksPerSecond + 1;
  while (!state.result && state.tick < max) {
    step(state, params, inputs, opts);
    opts.onTick?.(state);
  }
  return state;
}

export { wrapAngle };
