/**
 * PixiJS renderer. Reads BattleState only; never mutates it.
 */
import { Application, Container, Graphics, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import {
  formationHalfDepth,
  formationHalfWidth,
  isAlive,
  strengthOf,
  type BattleState,
  type Params,
  type Unit,
} from '@warsim/sim';

const SIDE_COLOR: [number, number] = [0x4f8cff, 0xff6b57];
const SIDE_COLOR_DIM: [number, number] = [0x2c4a80, 0x80362c];
const TERRAIN_COLOR = { plain: 0x3a4a2f, forest: 0x1f3a22, hill: 0x5a5a3a } as const;

export interface RendererCallbacks {
  onUnitClick(unitId: number, shift: boolean): void;
  onUnitDrag(unitId: number, x: number, y: number): void;
  onDragEnd(unitId: number): void;
  onEmptyClick(): void;
}

interface UnitVisual {
  outline: Graphics;
  label: Text;
  sprites: Sprite[];
}

export class Renderer {
  app = new Application();
  world = new Container();
  private terrainLayer = new Graphics();
  private zoneLayer = new Graphics();
  private fxLayer = new Graphics();
  private soldierLayer = new Container();
  private unitLayer = new Container();
  private visuals = new Map<number, UnitVisual>();
  private dotTexture!: Texture;
  private dragging: { unitId: number } | null = null;
  private panning: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private recentVolleys: { fromId: number; toId: number; tick: number; artillery: boolean }[] = [];
  selected = new Set<number>();
  showDeployZone = false;
  deployMode = false;
  private lastTick = -1;
  private ready = false;

  constructor(
    private host: HTMLElement,
    private params: Params,
    private cb: RendererCallbacks,
  ) {}

  async init(): Promise<void> {
    await this.app.init({ background: 0x0f1114, resizeTo: this.host, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
    this.host.appendChild(this.app.canvas);
    this.world.addChild(this.terrainLayer, this.zoneLayer, this.soldierLayer, this.fxLayer, this.unitLayer);
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;

    const g = new Graphics().circle(0, 0, 4).fill(0xffffff);
    this.dotTexture = this.app.renderer.generateTexture(g);

    this.fitToMap();
    this.installCamera();
    this.ready = true;
  }

  private fitToMap(): void {
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 600;
    const s = Math.min(w / this.params.map.width, h / this.params.map.height) * 0.96;
    this.world.scale.set(s);
    this.world.position.set((w - this.params.map.width * s) / 2, (h - this.params.map.height * s) / 2);
  }

  private installCamera(): void {
    const canvas = this.app.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0012);
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = this.toWorld(mx, my);
        const ns = Math.min(8, Math.max(0.3, this.world.scale.x * factor));
        this.world.scale.set(ns);
        const after = this.toWorld(mx, my);
        this.world.position.x += (after.x - before.x) * ns;
        this.world.position.y += (after.y - before.y) * ns;
      },
      { passive: false },
    );
    this.app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
      if (e.button === 2 || e.button === 1) {
        this.panning = { sx: e.global.x, sy: e.global.y, wx: this.world.position.x, wy: this.world.position.y };
        return;
      }
      const hit = this.unitAt(e.global.x, e.global.y);
      if (hit) {
        this.cb.onUnitClick(hit.id, e.shiftKey);
        if (this.deployMode && hit.side === 0) this.dragging = { unitId: hit.id };
      } else {
        this.cb.onEmptyClick();
      }
    });
    this.app.stage.on('pointermove', (e: FederatedPointerEvent) => {
      if (this.panning) {
        this.world.position.set(this.panning.wx + (e.global.x - this.panning.sx), this.panning.wy + (e.global.y - this.panning.sy));
      } else if (this.dragging) {
        const p = this.toWorld(e.global.x, e.global.y);
        this.cb.onUnitDrag(this.dragging.unitId, p.x, p.y);
      }
    });
    const end = () => {
      if (this.dragging) this.cb.onDragEnd(this.dragging.unitId);
      this.dragging = null;
      this.panning = null;
    };
    this.app.stage.on('pointerup', end);
    this.app.stage.on('pointerupoutside', end);
    window.addEventListener('resize', () => this.fitToMap());
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.world.position.x) / this.world.scale.x, y: (sy - this.world.position.y) / this.world.scale.y };
  }

  private currentState: BattleState | null = null;

  private unitAt(sx: number, sy: number): Unit | null {
    const s = this.currentState;
    if (!s) return null;
    const p = this.toWorld(sx, sy);
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of s.units) {
      if (!isAlive(u)) continue;
      const r = Math.max(14, formationHalfWidth(u.formation.kind, u.type, strengthOf(u)) + 6);
      const d = Math.hypot(u.formation.x - p.x, u.formation.y - p.y);
      if (d <= r && d < bestD) {
        best = u;
        bestD = d;
      }
    }
    return best;
  }

  drawTerrain(state: BattleState): void {
    const t = state.terrain;
    const g = this.terrainLayer;
    g.clear();
    g.rect(0, 0, this.params.map.width, this.params.map.height).fill(TERRAIN_COLOR.plain);
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const k = t.kinds[r * t.cols + c]!;
        if (k === 'plain') continue;
        let color: number = TERRAIN_COLOR[k];
        if (k === 'hill') {
          const h = t.heights[r * t.cols + c] ?? 1;
          color = h >= 2 ? 0x6e6e48 : 0x5a5a3a;
        }
        g.rect(c * t.cellSize, r * t.cellSize, t.cellSize, t.cellSize).fill(color);
      }
    }
    // Contour lines for hills (cell edges where height changes).
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const h = t.heights[r * t.cols + c] ?? 0;
        const hr = c + 1 < t.cols ? (t.heights[r * t.cols + c + 1] ?? 0) : 0;
        const hd = r + 1 < t.rows ? (t.heights[(r + 1) * t.cols + c] ?? 0) : 0;
        if (h !== hr) g.moveTo((c + 1) * t.cellSize, r * t.cellSize).lineTo((c + 1) * t.cellSize, (r + 1) * t.cellSize).stroke({ color: 0x8a8a5a, width: 1, alpha: 0.7 });
        if (h !== hd) g.moveTo(c * t.cellSize, (r + 1) * t.cellSize).lineTo((c + 1) * t.cellSize, (r + 1) * t.cellSize).stroke({ color: 0x8a8a5a, width: 1, alpha: 0.7 });
      }
    }
    g.rect(0, 0, this.params.map.width, this.params.map.height).stroke({ color: 0x777777, width: 2 });
  }

  private drawZone(zoneFrac: number): void {
    const g = this.zoneLayer;
    g.clear();
    if (!this.showDeployZone) return;
    const w = this.params.map.width;
    const h = this.params.map.height;
    g.rect(0, 0, w * zoneFrac, h).fill({ color: SIDE_COLOR[0], alpha: 0.08 }).stroke({ color: SIDE_COLOR[0], width: 1, alpha: 0.5 });
    g.rect(w * (1 - zoneFrac), 0, w * zoneFrac, h).fill({ color: SIDE_COLOR[1], alpha: 0.06 }).stroke({ color: SIDE_COLOR[1], width: 1, alpha: 0.4 });
  }

  private ensureVisual(u: Unit): UnitVisual {
    let v = this.visuals.get(u.id);
    if (v) return v;
    const outline = new Graphics();
    const label = new Text({
      text: `${u.index + 1}`,
      style: { fontFamily: 'system-ui, sans-serif', fontSize: 11, fill: 0xffffff, fontWeight: '700', stroke: { color: 0x000000, width: 3 } },
    });
    label.anchor.set(0.5);
    const sprites: Sprite[] = [];
    for (let i = 0; i < u.soldiers.length; i++) {
      const sp = new Sprite(this.dotTexture);
      sp.anchor.set(0.5);
      sp.scale.set(0.3);
      sp.tint = SIDE_COLOR[u.side];
      this.soldierLayer.addChild(sp);
      sprites.push(sp);
    }
    this.unitLayer.addChild(outline, label);
    v = { outline, label, sprites };
    this.visuals.set(u.id, v);
    return v;
  }

  render(state: BattleState, zoneFrac: number): void {
    if (!this.ready) return;
    this.currentState = state;
    if (state.tick === 0 && this.lastTick !== 0) this.drawTerrain(state);
    this.drawZone(zoneFrac);
    this.lastTick = state.tick;

    // Remember volleys for a short flash.
    for (const v of state.volleys) this.recentVolleys.push({ ...v, tick: state.tick });
    this.recentVolleys = this.recentVolleys.filter((v) => state.tick - v.tick < 6);

    const fx = this.fxLayer;
    fx.clear();

    for (const u of state.units) {
      const v = this.ensureVisual(u);
      const alive = isAlive(u);
      const n = strengthOf(u);
      // soldiers
      u.soldiers.forEach((s, i) => {
        const sp = v.sprites[i]!;
        if (!alive || !s.alive) {
          sp.visible = false;
          return;
        }
        sp.visible = true;
        sp.position.set(s.x, s.y);
        sp.tint = s.fled ? SIDE_COLOR_DIM[u.side] : SIDE_COLOR[u.side];
        sp.alpha = s.fled ? 0.55 : 1;
        sp.scale.set(u.type === 'cavalry' ? 0.38 : u.type === 'artillery' ? 0.34 : 0.3);
      });
      // outline
      const g = v.outline;
      g.clear();
      v.label.visible = alive;
      if (!alive) continue;
      const kind = u.formationTarget ?? u.formation.kind;
      const hw = formationHalfWidth(kind, u.type, n) + 3;
      const hd = formationHalfDepth(kind, u.type, n) + 3;
      const sel = this.selected.has(u.id);
      const color = u.stance === 'rout' ? SIDE_COLOR_DIM[u.side] : SIDE_COLOR[u.side];
      g.position.set(u.formation.x, u.formation.y);
      g.rotation = u.formation.facing;
      const width = sel ? 2.5 : u.charging || u.meleeWith !== null ? 2 : 1;
      const alpha = u.stance === 'rout' ? 0.5 : 0.9;
      g.rect(-hd, -hw, hd * 2, hw * 2).stroke({ color: sel ? 0xffffff : color, width, alpha });
      if (u.charging || u.meleeWith !== null) {
        g.rect(-hd - 2, -hw - 2, hd * 2 + 4, hw * 2 + 4).stroke({ color: 0xffd166, width: 1.5, alpha: 0.9 });
      }
      // facing tick
      g.moveTo(hd, 0).lineTo(hd + 6, 0).stroke({ color, width: 1.5, alpha });
      if (u.formationTarget) {
        // dashed hint: reforming
        g.circle(0, 0, 3).fill({ color: 0xffffff, alpha: 0.6 });
      }
      v.label.position.set(u.formation.x, u.formation.y - hw - 10);
      v.label.text = u.stance === 'rout' ? `${u.index + 1} ✕` : `${u.index + 1}`;
      v.label.alpha = u.stance === 'rout' ? 0.6 : 1;
      // morale mini bar
      const mw = 20;
      const mx = u.formation.x - mw / 2;
      const my = u.formation.y + hw + 6;
      fx.rect(mx, my, mw, 2.5).fill({ color: 0x000000, alpha: 0.5 });
      fx.rect(mx, my, (mw * u.morale) / 100, 2.5).fill({ color: u.morale > 50 ? 0x58c46b : u.morale > 30 ? 0xf5b942 : 0xd9534f });
    }

    // volleys
    for (const vv of this.recentVolleys) {
      const a = state.units[vv.fromId];
      const b = state.units[vv.toId];
      if (!a || !b) continue;
      const age = (state.tick - vv.tick) / 6;
      fx.moveTo(a.formation.x, a.formation.y)
        .lineTo(b.formation.x, b.formation.y)
        .stroke({ color: vv.artillery ? 0xffa64d : 0xfff4c2, width: vv.artillery ? 2 : 1, alpha: (1 - age) * 0.8 });
      // smoke puff at the muzzle
      fx.circle(a.formation.x + (b.formation.x - a.formation.x) * 0.08, a.formation.y + (b.formation.y - a.formation.y) * 0.08, 4 + age * 8).fill({
        color: 0xdddddd,
        alpha: (1 - age) * 0.35,
      });
    }
  }
}
