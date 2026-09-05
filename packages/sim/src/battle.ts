import { formationForStance, slotPosition } from './formation';
import type { Params } from './params';
import { Rng, seedRng } from './rng';
import type { Scenario, ScenarioUnit } from './scenario';
import { createTerrain } from './terrain';
import type { BattleState, Soldier, Unit } from './types';

export interface CreateBattleOptions {
  /** Which alternative deployment to use for each side (null = base deployment). */
  altDeployment?: [number | null, number | null];
}

function makeUnit(params: Params, id: number, side: 0 | 1, index: number, su: ScenarioUnit, rng: Rng, tick: number): Unit {
  const type = su.type;
  const stance = su.stance ?? 'hold';
  const facing = ((su.facingDeg ?? (side === 0 ? 0 : 180)) * Math.PI) / 180;
  const n = params.unit.soldiersPerUnit;
  const kind = formationForStance(stance, type);
  const formation = { kind, facing, x: su.x, y: su.y };
  const soldiers: Soldier[] = [];
  for (let i = 0; i < n; i++) {
    const p = slotPosition(formation, kind, type, i, n);
    // Tiny jitter so identical seeds still look alive; deterministic through rng.
    soldiers.push({ x: p.x + (rng.float() - 0.5) * 0.4, y: p.y + (rng.float() - 0.5) * 0.4, alive: true, fled: false });
  }
  const tp = params.types[type];
  return {
    id,
    side,
    index,
    name: su.name ?? `${side === 0 ? 'A' : 'B'}${index + 1}`,
    type,
    commander: { aggression: su.commander.aggression, composure: su.commander.composure },
    stance,
    prevStance: stance,
    stanceSinceTick: tick,
    formation,
    formationTarget: null,
    formationChangeRemaining: 0,
    morale: params.morale.start,
    cohesion: params.cohesion.start,
    fatigue: 0,
    ammo: tp.ammo,
    soldiers,
    action: { kind: 'idle' },
    moving: false,
    charging: false,
    targetId: null,
    lastVolleyTick: -100000,
    meleeWith: null,
    meleeSinceTick: 0,
    lastChargeFailTick: -100000,
    underFireTick: -100000,
    sawEnemyRoutTick: -100000,
    chargeAnnouncedTarget: null,
    recentLosses: 0,
    initialStrength: n,
    casualties: 0,
    destroyed: false,
    exited: false,
    holdPos: null,
  };
}

/** Build the initial BattleState from a scenario, params and a seed. */
export function createBattle(scenario: Scenario, params: Params, seed: number, opts: CreateBattleOptions = {}): BattleState {
  const rng = new Rng(seedRng(seed));
  const terrain = createTerrain(params, scenario.terrain);
  const units: Unit[] = [];
  let id = 0;
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 0 : 1;
    const sc = scenario.sides[side];
    const alt = opts.altDeployment?.[side] ?? null;
    const list = alt !== null && sc.altDeployments?.[alt] ? sc.altDeployments[alt] : sc.units;
    list.forEach((su, index) => {
      units.push(makeUnit(params, id++, side, index, su, rng, 0));
    });
  }
  const state: BattleState = {
    tick: 0,
    rng: rng.state,
    terrain,
    units,
    events: [
      {
        tick: 0,
        kind: 'battle_start',
        side: null,
        unitId: null,
        text: `Battle "${scenario.name}" begins (seed ${seed}).`,
      },
    ],
    moraleHistory: [{ tick: 0, morale: units.map((u) => u.morale) }],
    result: null,
    volleys: [],
    sideRearDir: [-1, 1],
    scenarioName: scenario.name,
    seed,
  };
  return state;
}
