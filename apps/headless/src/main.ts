/**
 * warsim headless runner.
 *
 *   pnpm headless --scenario scenarios/default.json --runs 100 --seed 1 --out results/run.csv
 *   pnpm headless --runs 1 --seed 7 --verbose             # event log of one battle
 *   pnpm headless --a aggressive --b defensive --runs 50   # strategy profiles per side
 *   pnpm headless --runs 30 --set fire.baseHitPerSoldier=0.13 --set morale.lossFactor=1.1
 *   pnpm headless --runs 30 --sweep melee.chargeShockBase=8,12,16
 *   pnpm headless --replay results/replay.json             # re-run a recorded battle, verify hash
 *   --alt random|none|k   enemy alternative deployment
 *   --full                simulate individual soldier motion (default off; replays force it on)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDeployment,
  assertParams,
  createBattle,
  hashState,
  isAvailable,
  isReplay,
  mergeParams,
  step,
  strengthOf,
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
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]!);
  });
  return out;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

/** Parse "a.b.c=1.5" into a nested override object. */
function overrideFrom(path: string, raw: string): Record<string, unknown> {
  const keys = path.split('.');
  let value: unknown = raw;
  if (raw === 'true' || raw === 'false') value = raw === 'true';
  else if (raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);
  const out: Record<string, unknown> = {};
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      const next: Record<string, unknown> = {};
      cur[k] = next;
      cur = next;
    }
  });
  return out;
}

export interface RunSummary {
  seed: number;
  sweep: string;
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
  charges: number;
  melees: number;
  hash: string;
}

interface RunConfig {
  scenario: Scenario;
  params: Params;
  seed: number;
  profiles: [StrategyProfile | 'replay', StrategyProfile];
  altDeployment: number | null;
  soldiers: boolean;
  /** Scripted side-0 inputs (replay mode). */
  scripted?: StanceInput[];
}

export function runOne(cfg: RunConfig, verbose: boolean): { state: BattleState; summary: RunSummary } {
  const state = createBattle(cfg.scenario, cfg.params, cfg.seed, { altDeployment: [null, cfg.altDeployment] });
  const mems = [createStrategyMemory(), createStrategyMemory()];
  const maxTicks = cfg.params.battleTimeLimitSec * cfg.params.ticksPerSecond + 1;
  const scripted = cfg.scripted ?? [];
  while (!state.result && state.tick < maxTicks) {
    const a = cfg.profiles[0] === 'replay' ? scripted.filter((i) => i.tick === state.tick) : strategyDecide(state, 0, cfg.params, mems[0]!, cfg.profiles[0]);
    const b = strategyDecide(state, 1, cfg.params, mems[1]!, cfg.profiles[1]);
    step(state, cfg.params, [...a, ...b], { brain: unitBrain, skipSoldiers: !cfg.soldiers });
  }
  if (verbose) printLog(state, cfg.params);
  return { state, summary: summarize(state, cfg.seed) };
}

function summarize(state: BattleState, seed: number, sweep = ''): RunSummary {
  const s = (side: 0 | 1) => state.units.filter((u) => u.side === side);
  const sum = (side: 0 | 1) => s(side).reduce((a, u) => a + (u.destroyed || u.exited ? 0 : strengthOf(u)), 0);
  const avail = (side: 0 | 1) => s(side).filter(isAvailable).length;
  const count = (kind: string, side?: 0 | 1) => state.events.filter((e) => e.kind === kind && (side === undefined || e.side === side)).length;
  return {
    seed,
    sweep,
    winner: state.result?.winner ?? null,
    reason: state.result?.reason ?? 'unfinished',
    endTick: state.tick,
    seconds: Math.round(state.tick / 10),
    availA: avail(0),
    availB: avail(1),
    strengthA: sum(0),
    strengthB: sum(1),
    routsA: count('rout', 0),
    routsB: count('rout', 1),
    charges: count('charge_start'),
    melees: count('melee_start'),
    hash: hashState(state),
  };
}

function fmtTime(tick: number, tps: number): string {
  const s = Math.floor(tick / tps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function printLog(state: BattleState, params: Params): void {
  for (const e of state.events) {
    if (e.kind === 'melee_end') continue;
    console.log(`[${fmtTime(e.tick, params.ticksPerSecond)}] ${e.side === null ? ' ' : e.side === 0 ? 'A' : 'B'} ${e.text}`);
  }
  console.log('');
  for (const u of state.units) {
    console.log(
      `${u.side === 0 ? 'A' : 'B'} ${u.name.padEnd(6)} ${u.type.padEnd(9)} stance=${u.stance.padEnd(8)} str=${String(strengthOf(u)).padStart(2)} morale=${u.morale.toFixed(0).padStart(3)} ammo=${String(u.ammo).padStart(2)} cas=${u.casualties}${u.destroyed ? ' DESTROYED' : ''}${u.exited ? ' EXITED' : ''}`,
    );
  }
}

function printSummary(rows: RunSummary[], label: string, ms: number): void {
  const winsA = rows.filter((r) => r.winner === 0).length;
  const winsB = rows.filter((r) => r.winner === 1).length;
  const draws = rows.length - winsA - winsB;
  const avg = (f: (r: RunSummary) => number) => (rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(1);
  const reasons = new Map<string, number>();
  for (const r of rows) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  console.log(`\n${label}${rows.length} runs in ${ms} ms (${(ms / rows.length).toFixed(0)} ms/run)`);
  console.log(`A wins ${winsA}  B wins ${winsB}  draws ${draws}   (A ${((100 * winsA) / rows.length).toFixed(0)}%)`);
  console.log(
    `avg length ${avg((r) => r.seconds)} s  avail A ${avg((r) => r.availA)} B ${avg((r) => r.availB)}  routs A ${avg((r) => r.routsA)} B ${avg((r) => r.routsB)}  charges ${avg((r) => r.charges)} melees ${avg((r) => r.melees)}`,
  );
  console.log('end reasons:', Object.fromEntries(reasons));
}

function writeCsv(rows: RunSummary[], out: string): void {
  const p = resolve(root, out);
  mkdirSync(dirname(p), { recursive: true });
  const header = Object.keys(rows[0]!).join(',');
  const lines = rows.map((r) => Object.values(r).join(','));
  writeFileSync(p, [header, ...lines].join('\n') + '\n');
  console.log(`wrote ${p}`);
}

function main(): void {
  const scenarioPath = resolve(root, arg('scenario', 'scenarios/default.json'));
  const paramsPath = resolve(root, arg('params', 'params/default.json'));
  const scenario = loadJson<Scenario>(scenarioPath);
  const base = loadJson<unknown>(paramsPath);
  let paramsObj = mergeParams(base, scenario.paramOverrides ?? {}) as unknown;
  for (const s of args('set')) {
    const [k, v] = s.split('=');
    if (!k || v === undefined) throw new Error(`--set expects key.path=value, got "${s}"`);
    paramsObj = mergeParams(paramsObj, overrideFrom(k, v));
  }
  const verbose = flag('verbose');
  const out = arg('out', '');

  // ---- replay mode -------------------------------------------------------
  const replayPath = arg('replay', '');
  if (replayPath) {
    const replay = loadJson<unknown>(resolve(root, replayPath));
    if (!isReplay(replay)) throw new Error('not a warsim replay file');
    const params = paramsObj as Params;
    assertParams(params);
    const sc = applyDeployment(scenario, replay.deployment);
    const t0 = Date.now();
    const { state, summary } = runOne(
      {
        scenario: sc,
        params,
        seed: replay.seed,
        profiles: ['replay', replay.enemyProfile as StrategyProfile],
        altDeployment: replay.altDeployment,
        soldiers: replay.soldiers,
        scripted: replay.inputs,
      },
      true,
    );
    console.log(`\nreplay: seed ${replay.seed}, ${replay.inputs.length} inputs, ended tick ${state.tick}, hash ${summary.hash}`);
    if (replay.finalHash) {
      console.log(replay.finalHash === summary.hash ? 'hash MATCHES the recording' : `hash MISMATCH: recorded ${replay.finalHash}`);
      if (replay.finalHash !== summary.hash) process.exitCode = 1;
    }
    console.log(`${Date.now() - t0} ms`);
    return;
  }

  // ---- batch mode --------------------------------------------------------
  const runs = Number(arg('runs', '1'));
  const seed0 = Number(arg('seed', '1'));
  const a = arg('a', 'balanced') as StrategyProfile;
  const b = arg('b', 'balanced') as StrategyProfile;
  const altArg = arg('alt', 'random');
  const full = flag('full');
  const sweepArg = arg('sweep', '');
  const sweeps: { label: string; patch: Record<string, unknown> }[] = [];
  if (sweepArg) {
    const [k, vs] = sweepArg.split('=');
    if (!k || !vs) throw new Error('--sweep expects key.path=v1,v2,...');
    for (const v of vs.split(',')) sweeps.push({ label: `${k}=${v}`, patch: overrideFrom(k, v) });
  } else sweeps.push({ label: '', patch: {} });

  const all: RunSummary[] = [];
  for (const sw of sweeps) {
    const params = mergeParams(paramsObj, sw.patch) as Params;
    assertParams(params);
    const rows: RunSummary[] = [];
    const t0 = Date.now();
    for (let i = 0; i < runs; i++) {
      const seed = seed0 + i;
      const alts = scenario.sides[1].altDeployments;
      const alt = altArg === 'random' ? (alts && alts.length ? seed % alts.length : null) : altArg === 'none' ? null : Number(altArg);
      const { summary } = runOne({ scenario, params, seed, profiles: [a, b], altDeployment: alt, soldiers: full }, verbose && runs === 1);
      summary.sweep = sw.label;
      rows.push(summary);
    }
    printSummary(rows, sw.label ? `[${sw.label}] ` : `A=${a} B=${b}: `, Date.now() - t0);
    all.push(...rows);
  }
  if (out) writeCsv(all, out);
}

main();
