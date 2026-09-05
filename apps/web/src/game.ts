/**
 * Game controller: owns the BattleState, the fixed-timestep loop, player input
 * queue and the deploy → battle → result phase machine. Knows nothing about
 * rendering or DOM.
 */
import {
  createBattle,
  mergeParams,
  assertParams,
  step,
  type BattleState,
  type Params,
  type Scenario,
  type ScenarioUnit,
  type Stance,
  type StanceInput,
} from '@warsim/sim';
import { createStrategyMemory, strategyDecide, unitBrain, type StrategyMemory, type StrategyProfile } from '@warsim/ai';

export type Phase = 'deploy' | 'battle' | 'result';

export interface DeployUnit {
  x: number;
  y: number;
  facingDeg: number;
  stance: Exclude<Stance, 'rout'>;
}

export interface GameEvents {
  onPhase(phase: Phase): void;
  onTick(state: BattleState): void;
}

export class Game {
  readonly params: Params;
  readonly scenario: Scenario;
  phase: Phase = 'deploy';
  state: BattleState;
  /** Player-side deployment being edited (index = unit index). */
  deploy: DeployUnit[];
  seed = 1;
  enemyProfile: StrategyProfile = 'balanced';
  allowOrdersWhilePaused = true;
  speed = 1;
  paused = false;
  private acc = 0;
  private last = 0;
  private queued: StanceInput[] = [];
  private enemyMem: StrategyMemory = createStrategyMemory();
  private raf = 0;
  /** Visible auto-transition marks for the UI (unitId → tick). */
  autoMarks = new Map<number, number>();
  private lastEventIdx = 0;

  constructor(scenario: Scenario, baseParams: unknown, private events: GameEvents) {
    const p = mergeParams(baseParams, scenario.paramOverrides ?? {}) as Params;
    assertParams(p);
    this.params = p;
    this.scenario = scenario;
    this.deploy = scenario.sides[0].units.map((u) => ({
      x: u.x,
      y: u.y,
      facingDeg: u.facingDeg ?? 0,
      stance: u.stance ?? 'hold',
    }));
    this.state = this.previewState();
  }

  /** A battle state at tick 0 used to render the deployment screen. */
  private previewState(): BattleState {
    return createBattle(this.buildScenario(), this.params, this.seed, { altDeployment: [null, this.altIndex()] });
  }

  private altIndex(): number | null {
    const alts = this.scenario.sides[1].altDeployments;
    return alts && alts.length > 0 ? this.seed % alts.length : null;
  }

  private buildScenario(): Scenario {
    const units: ScenarioUnit[] = this.scenario.sides[0].units.map((u, i) => {
      const d = this.deploy[i]!;
      return { ...u, x: d.x, y: d.y, facingDeg: d.facingDeg, stance: d.stance };
    });
    return { ...this.scenario, sides: [{ ...this.scenario.sides[0], units }, this.scenario.sides[1]] };
  }

  get deployZoneMaxX(): number {
    return this.params.map.width * this.scenario.deployZoneFrac;
  }

  // ---- deployment -------------------------------------------------------

  setSeed(seed: number): void {
    this.seed = seed;
    if (this.phase === 'deploy') this.refreshPreview();
  }

  moveDeploy(index: number, x: number, y: number): void {
    const d = this.deploy[index];
    if (!d || this.phase !== 'deploy') return;
    d.x = Math.min(this.deployZoneMaxX - 15, Math.max(15, x));
    d.y = Math.min(this.params.map.height - 15, Math.max(15, y));
    this.refreshPreview();
  }

  rotateDeploy(index: number, deltaDeg: number): void {
    const d = this.deploy[index];
    if (!d || this.phase !== 'deploy') return;
    d.facingDeg = ((d.facingDeg + deltaDeg) % 360 + 360) % 360;
    this.refreshPreview();
  }

  setDeployStance(index: number, stance: Exclude<Stance, 'rout'>): void {
    const d = this.deploy[index];
    if (!d || this.phase !== 'deploy') return;
    d.stance = stance;
    this.refreshPreview();
  }

  private refreshPreview(): void {
    this.state = this.previewState();
    this.events.onTick(this.state);
  }

  startBattle(): void {
    if (this.phase !== 'deploy') return;
    this.state = this.previewState();
    this.enemyMem = createStrategyMemory();
    this.queued = [];
    this.autoMarks.clear();
    this.lastEventIdx = 0;
    this.acc = 0;
    this.paused = false;
    this.setPhase('battle');
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  restart(): void {
    cancelAnimationFrame(this.raf);
    this.setPhase('deploy');
    this.refreshPreview();
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.events.onPhase(p);
  }

  // ---- battle -----------------------------------------------------------

  setSpeed(speed: number): void {
    if (speed <= 0) {
      this.paused = true;
      return;
    }
    this.paused = false;
    this.speed = speed;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  /** Queue a stance order for the next tick. */
  order(unitId: number, stance: Exclude<Stance, 'rout'>): boolean {
    if (this.phase !== 'battle') return false;
    if (this.paused && !this.allowOrdersWhilePaused) return false;
    const u = this.state.units[unitId];
    if (!u || u.side !== 0 || u.destroyed || u.exited || u.stance === 'rout') return false;
    if (u.stance === stance) return false;
    this.queued = this.queued.filter((q) => q.unitId !== unitId);
    this.queued.push({ tick: this.state.tick, unitId, stance });
    if (this.paused) this.tickOnce(); // apply immediately while paused for feedback
    return true;
  }

  private frame(now: number): void {
    if (this.phase !== 'battle') return;
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused) {
      this.acc += dt * this.speed;
      const tickLen = 1 / this.params.ticksPerSecond;
      let n = 0;
      while (this.acc >= tickLen && n < 40) {
        this.acc -= tickLen;
        this.tickOnce();
        n++;
        if (this.phase !== 'battle') break;
      }
    }
    this.events.onTick(this.state);
    if (this.phase === 'battle') this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private tickOnce(): void {
    const s = this.state;
    const enemyInputs = strategyDecide(s, 1, this.params, this.enemyMem, this.enemyProfile);
    const playerInputs = this.queued.map((q) => ({ ...q, tick: s.tick }));
    this.queued = [];
    step(s, this.params, [...playerInputs, ...enemyInputs], { brain: unitBrain });
    // Track automatic transitions for card flashes.
    for (; this.lastEventIdx < s.events.length; this.lastEventIdx++) {
      const e = s.events[this.lastEventIdx]!;
      if ((e.kind === 'stance_auto' || e.kind === 'rout') && e.unitId !== null) this.autoMarks.set(e.unitId, e.tick);
    }
    if (s.result) {
      this.setPhase('result');
    }
  }
}
