import type { Stance, UnitType } from './types';

export interface TypeParams {
  speed: number;
  fire: number;
  melee: number;
  meleeCharge: number;
  range: number;
  volleyIntervalSec: number;
  ammo: number;
  fatigueMult: number;
}

export interface Params {
  ticksPerSecond: number;
  battleTimeLimitSec: number;
  map: { width: number; height: number; cellSize: number };
  unit: {
    soldiersPerUnit: number;
    destroyedBelowStrength: number;
    baseSpeedMps: number;
    soldierCatchUpMult: number;
    chargeSpeedMult: number;
    routSpeedMult: number;
    fatigueSpeedPenalty: number;
    formationChangeSec: number;
    formationChangingFireMult: number;
    formationChangingMeleeMult: number;
    contactDistance: number;
    turnRateRadPerSec: number;
  };
  types: Record<UnitType, TypeParams>;
  fire: {
    baseHitPerSoldier: number;
    falloffStartFrac: number;
    falloffEndMult: number;
    artilleryMinRange: number;
    artilleryHitPerSoldier: number;
    coverForest: number;
    coverHillHold: number;
    coverPlain: number;
    fatiguePenalty: number;
    firingArcRad: number;
    withdrawDelayFireMult: number;
  };
  melee: {
    casualtiesPerPowerPerSec: number;
    chargeWindowSec: number;
    flankBonus: number;
    rearBonus: number;
    hillDefenderBonus: number;
    forestCavalryPenalty: number;
    chargeShockBase: number;
    chargeElan: number;
    fatigueMeleePenalty: number;
    cavalryChargeShockVsMoving: number;
    cavalryChargeVsSteadyInfantryFailChance: number;
    chargeFailMoraleLoss: number;
    chargeFailPushbackM: number;
    disengageDistance: number;
  };
  morale: {
    start: number;
    collapseThreshold: number;
    recoverThreshold: number;
    composureThresholdShift: number;
    lossFactor: number;
    flankHitMult: number;
    rearHitMult: number;
    artilleryHitFlat: number;
    cavalryChargeReceived: number;
    friendlyRoutWitnessed: number;
    friendlyRoutWitnessRadius: number;
    enemyRoutWitnessed: number;
    enemyRoutWitnessRadius: number;
    adjacentFriendlyRadius: number;
    adjacentFriendlyPerSec: number;
    passiveCap: number;
    strengthCapFloor: number;
    isolationPerSec: number;
    recoveryPerSec: Record<Stance, number>;
    routRecoveryEnemyRadius: number;
    composureLossMitigation: number;
    meleeLossMult: number;
    routDeserterFraction: number;
    recentWindowSec: number;
  };
  cohesion: {
    start: number;
    movePerSec: number;
    moveFloor: number;
    chargePerSec: number;
    chargeFloor: number;
    formationChangePerSec: number;
    stillPerSec: number;
    rallyPerSec: number;
    perLossFrac: number;
    min: number;
  };
  fatigue: {
    movePerSec: number;
    chargePerSec: number;
    meleePerSec: number;
    restPerSec: number;
  };
  vision: {
    baseRange: number;
    forestTargetRange: number;
    screenDetectMult: number;
  };
  stance: {
    holdRepositionRadius: number;
    screenKeepDistance: number;
    screenFallbackDistance: number;
    withdrawPursuitDistance: number;
    assaultRangeHoldFrac: number;
    stagingDistance: number;
    cavalryChargeDistance: number;
    reactionIntervalSec: number;
  };
  victory: {
    availableFractionToLose: number;
  };
  ai: {
    heavyLossWindowFrac: number;
    chargeMoraleAdvantage: number;
    aggressionAutoAssaultThreshold: number;
    composureWithdrawThreshold: number;
    strategyIntervalSec: number;
    pressAdvantageAfterSec: number;
  };
}

/** Deep-merge `patch` over `base` (objects only; arrays/primitives replaced). */
export function mergeParams<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === '$comment') continue;
    const cur = out[k];
    out[k] =
      cur !== undefined && typeof cur === 'object' && cur !== null && !Array.isArray(cur)
        ? mergeParams(cur, v)
        : v;
  }
  return out as T;
}

/** Validate that a loaded JSON object has the shape of Params (shallow keys). */
export function assertParams(p: unknown): asserts p is Params {
  const required = [
    'ticksPerSecond',
    'battleTimeLimitSec',
    'map',
    'unit',
    'types',
    'fire',
    'melee',
    'morale',
    'cohesion',
    'fatigue',
    'vision',
    'stance',
    'victory',
    'ai',
  ];
  if (p === null || typeof p !== 'object') throw new Error('params: not an object');
  for (const k of required) {
    if (!(k in (p as object))) throw new Error(`params: missing key "${k}"`);
  }
}
