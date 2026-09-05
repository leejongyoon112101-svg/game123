/**
 * Plain-DOM UI: top bar, unit cards, event feed, deployment panel, result screen.
 */
import { PLAYER_STANCES, isAlive, isReplay, stanceLabel, strengthOf, type BattleState, type Stance, type Unit } from '@warsim/sim';
import type { Game, Phase } from './game';

const TYPE_LABEL = { infantry: '선보병', cavalry: '기병', artillery: '포병' } as const;
const TYPE_ICON = { infantry: '▮', cavalry: '♞', artillery: '●' } as const;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function fmtTime(tick: number, tps: number): string {
  const s = Math.floor(tick / tps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function traitText(u: Unit): string {
  const a = u.commander.aggression;
  const c = u.commander.composure;
  const ag = a >= 0.7 ? '성급' : a <= 0.35 ? '신중' : '보통';
  const co = c >= 0.7 ? '침착' : c <= 0.4 ? '동요' : '보통';
  return `공격성 ${ag} · 냉정함 ${co}`;
}

export class UI {
  private cards: HTMLElement[] = [];
  private feedCount = 0;
  private selected = new Set<number>();
  onSelectionChange: (sel: Set<number>) => void = () => {};

  constructor(private game: Game) {
    this.buildCards();
    this.bindTopbar();
    this.bindDeployPanel();
    this.bindResult();
    this.bindKeys();
    this.setPhase('deploy');
  }

  get selection(): ReadonlySet<number> {
    return this.selected;
  }

  // ---- selection --------------------------------------------------------

  select(unitId: number, additive: boolean): void {
    if (!additive) this.selected.clear();
    if (this.selected.has(unitId) && additive) this.selected.delete(unitId);
    else this.selected.add(unitId);
    this.onSelectionChange(this.selected);
    this.refreshCards(this.game.state);
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.onSelectionChange(this.selected);
    this.refreshCards(this.game.state);
  }

  // ---- cards ------------------------------------------------------------

  private buildCards(): void {
    const root = $('cards');
    root.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `
        <div class="row"><span class="name"></span><span class="type"></span></div>
        <div class="bar morale"><i></i></div>
        <div class="row"><span class="stat str"></span><span class="stance"></span></div>
        <div class="traits"></div>
        <div class="stances">${PLAYER_STANCES.map((s) => `<button data-stance="${s}" title="${stanceLabel(s)}">${stanceLabel(s)}</button>`).join('')}</div>
        <div class="rotate"><button data-rot="-15" title="좌회전 (Q)">↶</button><button data-rot="15" title="우회전 (E)">↷</button><span class="stat facing"></span></div>
      `;
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const btn = t.closest('button');
        if (btn?.dataset.stance) {
          e.stopPropagation();
          this.applyStance(i, btn.dataset.stance as Exclude<Stance, 'rout'>);
          return;
        }
        if (btn?.dataset.rot) {
          e.stopPropagation();
          this.game.rotateDeploy(i, Number(btn.dataset.rot));
          return;
        }
        this.select(i, e.shiftKey);
      });
      root.appendChild(el);
      this.cards.push(el);
    }
  }

  /** Apply a stance to the clicked unit and every other selected unit. */
  private applyStance(unitId: number, stance: Exclude<Stance, 'rout'>): void {
    const targets = new Set<number>(this.selected);
    targets.add(unitId);
    for (const id of targets) {
      if (this.game.phase === 'deploy') this.game.setDeployStance(id, stance);
      else this.game.order(id, stance);
    }
  }

  refreshCards(state: BattleState): void {
    const deploy = this.game.phase === 'deploy';
    for (let i = 0; i < 10; i++) {
      const u = state.units[i];
      const el = this.cards[i]!;
      if (!u) continue;
      const alive = isAlive(u);
      el.classList.toggle('selected', this.selected.has(i));
      el.classList.toggle('dead', !alive);
      el.classList.toggle('deploy', deploy);
      el.querySelector<HTMLElement>('.name')!.textContent = `${u.index + 1}. ${u.name}`;
      el.querySelector<HTMLElement>('.type')!.textContent = `${TYPE_ICON[u.type]} ${TYPE_LABEL[u.type]}`;
      el.querySelector<HTMLElement>('.bar.morale > i')!.style.width = `${u.morale}%`;
      const n = strengthOf(u);
      const ammo = u.type === 'cavalry' ? '' : ` · 탄 ${u.ammo}`;
      el.querySelector<HTMLElement>('.str')!.textContent = alive ? `${n}/${u.initialStrength}${ammo}` : u.exited ? '이탈' : '전멸';
      const st = el.querySelector<HTMLElement>('.stance')!;
      const stanceName = deploy ? stanceLabel(this.game.deploy[i]!.stance) : stanceLabel(u.stance);
      st.textContent = u.formationTarget && !deploy ? `${stanceName} ↻${Math.ceil(u.formationChangeRemaining / this.game.params.ticksPerSecond)}s` : stanceName;
      st.className = `stance ${u.stance}`;
      el.querySelector<HTMLElement>('.traits')!.textContent = traitText(u);
      el.querySelector<HTMLElement>('.facing')!.textContent = deploy ? `${this.game.deploy[i]!.facingDeg}°` : '';
      const cur = deploy ? this.game.deploy[i]!.stance : u.stance;
      el.querySelectorAll<HTMLButtonElement>('.stances button').forEach((b) => {
        b.classList.toggle('cur', b.dataset.stance === cur);
        b.disabled = !alive || u.stance === 'rout';
      });
      const mark = this.game.autoMarks.get(i);
      if (mark !== undefined && state.tick - mark < 12) {
        const b = el.querySelector<HTMLButtonElement>(`.stances button[data-stance="${u.stance}"]`);
        if (b && !b.classList.contains('auto-changed')) {
          b.classList.add('auto-changed');
          setTimeout(() => b.classList.remove('auto-changed'), 1300);
        }
      }
    }
  }

  // ---- top bar ----------------------------------------------------------

  private bindTopbar(): void {
    $('speed-controls').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const sp = Number(b.dataset.speed);
      this.game.setSpeed(sp);
      this.updateSpeedButtons();
    });
    $('btn-restart').addEventListener('click', () => this.game.restart());
  }

  private updateSpeedButtons(): void {
    $('speed-controls')
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => {
        const sp = Number(b.dataset.speed);
        b.classList.toggle('active', this.game.paused ? sp === 0 : sp === this.game.speed);
      });
  }

  refreshTopbar(state: BattleState): void {
    $('clock').textContent = fmtTime(state.tick, this.game.params.ticksPerSecond);
    const avail = (side: 0 | 1) => state.units.filter((u) => u.side === side && isAlive(u) && u.stance !== 'rout').length;
    $('avail-a').textContent = `아군 ${avail(0)}`;
    $('avail-b').textContent = `적군 ${avail(1)}`;
    this.updateSpeedButtons();
  }

  // ---- deploy panel -----------------------------------------------------

  private bindDeployPanel(): void {
    const seed = $('seed-input') as HTMLInputElement;
    seed.value = String(this.game.seed);
    seed.addEventListener('change', () => this.game.setSeed(Math.max(0, Number(seed.value) || 0)));
    ($('enemy-profile') as HTMLSelectElement).addEventListener('change', (e) => {
      this.game.enemyProfile = (e.target as HTMLSelectElement).value as typeof this.game.enemyProfile;
    });
    ($('pause-orders') as HTMLInputElement).addEventListener('change', (e) => {
      this.game.allowOrdersWhilePaused = (e.target as HTMLInputElement).checked;
    });
    $('btn-start').addEventListener('click', () => this.game.startBattle());
    ($('replay-file') as HTMLInputElement).addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        const data: unknown = JSON.parse(await f.text());
        if (!isReplay(data)) throw new Error('not a replay');
        if (data.scenarioName !== this.game.scenario.name) throw new Error(`다른 시나리오의 리플레이입니다 (${data.scenarioName})`);
        this.game.loadReplay(data);
        seed.value = String(this.game.seed);
        ($('enemy-profile') as HTMLSelectElement).value = this.game.enemyProfile;
      } catch (err) {
        alert(`리플레이를 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.game.phase === 'battle') {
          this.game.togglePause();
          this.updateSpeedButtons();
        }
      }
      if (this.game.phase === 'deploy' && (e.key === 'q' || e.key === 'e')) {
        for (const id of this.selected) this.game.rotateDeploy(id, e.key === 'q' ? -15 : 15);
      }
      const num = Number(e.key);
      if (this.game.phase === 'battle' && num >= 1 && num <= 5) {
        const stance = PLAYER_STANCES[num - 1]!;
        for (const id of this.selected) this.game.order(id, stance);
      }
      if (e.key === 'Escape') this.clearSelection();
    });
  }

  // ---- feed -------------------------------------------------------------

  refreshFeed(state: BattleState): void {
    const feed = $('feed');
    const tps = this.game.params.ticksPerSecond;
    if (this.feedCount > state.events.length) {
      feed.innerHTML = '';
      this.feedCount = 0;
    }
    const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
    for (; this.feedCount < state.events.length; this.feedCount++) {
      const e = state.events[this.feedCount]!;
      if (e.kind === 'melee_end' || e.kind === 'battle_start') continue;
      const li = document.createElement('li');
      li.className = `kind-${e.kind}${e.side !== null ? ` side-${e.side}` : ''}`;
      li.innerHTML = `<span class="t">${fmtTime(e.tick, tps)}</span>${escapeHtml(e.text)}`;
      feed.appendChild(li);
    }
    while (feed.children.length > 300) feed.removeChild(feed.firstChild!);
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }

  // ---- phases -----------------------------------------------------------

  setPhase(p: Phase): void {
    $('phase-label').textContent = p === 'deploy' ? '배치' : p === 'battle' ? '전투' : '결과';
    $('deploy-panel').classList.toggle('hidden', p !== 'deploy');
    $('replay-badge').classList.toggle('hidden', !this.game.replayLoaded);
    $('deploy-hint').classList.toggle('hidden', p !== 'deploy');
    $('result').classList.toggle('hidden', p !== 'result');
    if (p === 'deploy') {
      $('feed').innerHTML = '';
      this.feedCount = 0;
      this.clearSelection();
    }
    if (p === 'result') this.showResult(this.game.state);
    this.refreshCards(this.game.state);
  }

  // ---- result -----------------------------------------------------------

  private bindResult(): void {
    $('btn-save-replay').addEventListener('click', () => {
      const r = this.game.getReplay();
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `warsim-replay-seed${r.seed}-${r.endTick ?? 0}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('btn-replay-same').addEventListener('click', () => this.game.restart());
    $('btn-replay-next').addEventListener('click', () => {
      this.game.setSeed(this.game.seed + 1);
      ($('seed-input') as HTMLInputElement).value = String(this.game.seed);
      this.game.restart();
    });
    ($('chart-enemy') as HTMLInputElement).addEventListener('change', () => this.drawChart(this.game.state));
  }

  private showResult(state: BattleState): void {
    const r = state.result;
    const tps = this.game.params.ticksPerSecond;
    $('result-title').textContent = r?.winner === 0 ? '승리' : r?.winner === 1 ? '패배' : '무승부';
    const reason = r?.reason === 'available' ? '가용 부대 30% 이하' : r?.reason === 'timeout' ? '시간 초과 — 남은 전투력 판정' : '전원 이탈';
    $('result-sub').textContent = `${fmtTime(r?.endTick ?? state.tick, tps)} · ${reason} · 시드 ${state.seed}`;

    const table = $('result-table');
    const rows = state.units
      .map((u) => {
        const n = strengthOf(u);
        const status = u.destroyed ? '전멸' : u.exited ? '이탈' : stanceLabel(u.stance);
        return `<tr class="side-${u.side}"><td>${u.name}</td><td>${TYPE_LABEL[u.type]}</td><td>${n}/${u.initialStrength}</td><td>−${u.casualties}</td><td>${u.morale.toFixed(0)}</td><td>${status}</td></tr>`;
      })
      .join('');
    table.innerHTML = `<tr><th>부대</th><th>병과</th><th>병력</th><th>손실</th><th>사기</th><th>상태</th></tr>${rows}`;

    const log = $('result-log');
    log.innerHTML = state.events
      .filter((e) => e.kind === 'stance_player' || e.kind === 'stance_auto' || e.kind === 'rout' || e.kind === 'rally_recovered')
      .map((e) => `<li class="kind-${e.kind}"><span class="t">${fmtTime(e.tick, tps)}</span>${escapeHtml(e.text)}</li>`)
      .join('');
    this.drawChart(state);
  }

  private drawChart(state: BattleState): void {
    const canvas = $('morale-chart') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const showEnemy = ($('chart-enemy') as HTMLInputElement).checked;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 30, r: 10, t: 10, b: 20 };
    const hist = state.moraleHistory;
    if (hist.length < 2) return;
    const maxTick = hist[hist.length - 1]!.tick;
    const x = (tick: number) => pad.l + ((W - pad.l - pad.r) * tick) / maxTick;
    const y = (m: number) => pad.t + (H - pad.t - pad.b) * (1 - m / 100);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#9aa0ab';
    ctx.font = '10px system-ui';
    for (const m of [0, 25, 50, 75, 100]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, y(m));
      ctx.lineTo(W - pad.r, y(m));
      ctx.stroke();
      ctx.fillText(String(m), 4, y(m) + 3);
    }
    // collapse threshold band
    ctx.fillStyle = '#ff6b5722';
    ctx.fillRect(pad.l, y(25), W - pad.l - pad.r, y(0) - y(25));
    const tps = this.game.params.ticksPerSecond;
    ctx.fillStyle = '#9aa0ab';
    for (let m = 0; m <= maxTick; m += 120 * tps) ctx.fillText(fmtTime(m, tps), x(m) - 12, H - 6);

    for (const u of state.units) {
      if (u.side === 1 && !showEnemy) continue;
      ctx.beginPath();
      ctx.strokeStyle = u.side === 0 ? `hsl(${215 + u.index * 6} 80% ${55 + (u.index % 3) * 10}%)` : `hsl(${8 + u.index * 5} 80% ${55 + (u.index % 3) * 10}%)`;
      ctx.lineWidth = u.side === 0 ? 1.6 : 1;
      ctx.globalAlpha = u.side === 0 ? 1 : 0.6;
      hist.forEach((h, i) => {
        const m = h.morale[u.id] ?? 0;
        if (i === 0) ctx.moveTo(x(h.tick), y(m));
        else ctx.lineTo(x(h.tick), y(m));
      });
      ctx.stroke();
      const last = hist[hist.length - 1]!;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(String(u.index + 1), x(last.tick) - 8, y(last.morale[u.id] ?? 0) - 3);
    }
    ctx.globalAlpha = 1;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
