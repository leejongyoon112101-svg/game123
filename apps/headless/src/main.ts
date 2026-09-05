/**
 * warsim headless runner.
 *
 *   pnpm headless --scenario scenarios/default.json --runs 100 --seed 1 --out results/run.csv
 *   pnpm headless --runs 1 --seed 7 --verbose          # print the event log of one battle
 *   pnpm headless --a aggressive --b defensive --runs 50
 *   --full   also simulate individual soldier motion (default off in headless; the web app always does)
 *
 * Both sides are driven by the strategy script (profiles: balanced|aggressive|defensive|passive)
 * on top of the shared unit brain.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertParams,
  createBattle,
  hashState,
  mergeParams,
  step,
  strengthOf,
  isAvailable,
  type BattleState,
  type Params,
  type Scenario,
  type StanceInput,
} from '@warsim/sim';
import { createStrategyMemory, strategyDecide, unitBrain, type StrategyProfile } from '@warsim/ai';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]!;
  return def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export interface RunSummary {
  seed: number;
  winner: number | null;
  reason: string;
  endTick: number;
  seconds: number;
  availA: number;
  availB: number;
  strengthA: number;
  strengthB: number;
  routsA: number;
  routsB: number;
  hash: string;
}

export function runOne(
  scenario: Scenario,
  params: Params,
  seed: number,
  profiles: [StrategyProfile, StrategyProfile],
  altDeployment: number | null,
  verbose: boolean,
  full = false,
): RunSummary {
  const state = createBattle(scenario, params, seed, { altDeployment: [null, altDeployment] });
  const mems = [createStrategyMemory(), createStrategyMemory()];
  const maxTicks = params.battleTimeLimitSec * params.ticksPerSecond + 1;
  while (!state.result && state.tick < maxTicks) {
    const inputs: StanceInput[] = [
      ...strategyDecide(state, 0, params, mems[0]!, profiles[0]),
      ...strategyDecide(state, 1, params, mems[1]!, profiles[1]),
    ];
    step(state, params, inputs, { brain: unitBrain, skipSoldiers: !full });
  }
  if (verbose) printLog(state, params);
  return summarize(state, seed);
}

function summarize(state: BattleState, seed: number): RunSummary {
  const s = (side: 0 | 1) => state.units.filter((u) => u.side === side);
  const sum = (side: 0 | 1) => s(side).reduce((a, u) => a + (u.destroyed || u.exited ? 0 : strengthOf(u)), 0);
  const avail = (side: 0 | 1) => s(side).filter(isAvailable).length;
  const routs = (side: 0 | 1) => state.events.filter((e) => e.kind === 'rout' && e.side === side).length;
  return {
    seed,
    winner: state.result?.winner ?? null,
    reason: state.result?.reason ?? 'unfinished',
    endTick: state.tick,
    seconds: Math.round(state.tick / 10),
    availA: avail(0),
    availB: avail(1),
    strengthA: sum(0),
    strengthB: sum(1),
    routsA: routs(0),
    routsB: routs(1),
    hash: hashState(state),
  };
}

function fmtTime(tick: number, tps: number): string {
  const s = Math.floor(tick / tps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function printLog(state: BattleState, params: Params): void {
  for (const e of state.events) {
    if (e.kind === 'melee_end' || e.kind === 'melee_start') continue;
    console.log(`[${fmtTime(e.tick, params.ticksPerSecond)}] ${e.side === null ? ' ' : e.side === 0 ? 'A' : 'B'} ${e.text}`);
  }
  console.log('');
  for (const u of state.units) {
    console.log(
      `${u.side === 0 ? 'A' : 'B'} ${u.name.padEnd(6)} ${u.type.padEnd(9)} stance=${u.stance.padEnd(8)} str=${String(strengthOf(u)).padStart(2)} morale=${u.morale.toFixed(0).padStart(3)} ammo=${String(u.ammo).padStart(2)} cas=${u.casualties}${u.destroyed ? ' DESTROYED' : ''}${u.exited ? ' EXITED' : ''}`,
    );
  }
}

function main(): void {
  const scenarioPath = resolve(root, arg('scenario', 'scenarios/default.json'));
  const paramsPath = resolve(root, arg('params', 'params/default.json'));
  const runs = Number(arg('runs', '1'));
  const seed0 = Number(arg('seed', '1'));
  const out = arg('out', '');
  const verbose = flag('verbose');
  const a = arg('a', 'balanced') as StrategyProfile;
  const b = arg('b', 'balanced') as StrategyProfile;
  const altArg = arg('alt', 'random');

  const scenario = loadJson<Scenario>(scenarioPath);
  const base = loadJson<unknown>(paramsPath);
  const params = mergeParams(base, scenario.paramOverrides ?? {}) as Params;
  assertParams(params);

  const rows: RunSummary[] = [];
  const t0 = Date.now();
  for (let i = 0; i < runs; i++) {
    const seed = seed0 + i;
    const alt = altArg === 'random' ? (scenario.sides[1].altDeployments ? seed % scenario.sides[1].altDeployments.length : null) : altArg === 'none' ? null : Number(altArg);
    rows.push(runOne(scenario, params, seed, [a, b], alt, verbose && runs === 1, flag('full')));
  }
  const ms = Date.now() - t0;

  const winsA = rows.filter((r) => r.winner === 0).length;
  const winsB = rows.filter((r) => r.winner === 1).length;
  const draws = rows.length - winsA - winsB;
  const avg = (f: (r: RunSummary) => number) => (rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(1);
  console.log(`\n${rows.length} runs in ${ms} ms (${(ms / rows.length).toFixed(0)} ms/run)  A=${a} B=${b}`);
  console.log(`A wins ${winsA}  B wins ${winsB}  draws ${draws}`);
  console.log(`avg length ${avg((r) => r.seconds)} s  avg avail A ${avg((r) => r.availA)} B ${avg((r) => r.availB)}  avg routs A ${avg((r) => r.routsA)} B ${avg((r) => r.routsB)}`);
  const reasons = new Map<string, number>();
  for (const r of rows) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  console.log('end reasons:', Object.fromEntries(reasons));

  if (out) {
    const p = resolve(root, out);
    mkdirSync(dirname(p), { recursive: true });
    const header = Object.keys(rows[0]!).join(',');
    const lines = rows.map((r) => Object.values(r).join(','));
    writeFileSync(p, [header, ...lines].join('\n') + '\n');
    console.log(`wrote ${p}`);
  }
}

main();
