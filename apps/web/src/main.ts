import type { Scenario } from '@warsim/sim';
import scenarioJson from '../../../scenarios/default.json';
import paramsJson from '../../../params/default.json';
import { Game } from './game';
import { Renderer } from './renderer';
import { UI } from './ui';

async function boot(): Promise<void> {
  const scenario = scenarioJson as unknown as Scenario;
  let ui: UI | null = null;
  let renderer: Renderer | null = null;

  const game = new Game(scenario, paramsJson, {
    onPhase(phase) {
      ui?.setPhase(phase);
      if (renderer) {
        renderer.deployMode = phase === 'deploy';
        renderer.showDeployZone = phase === 'deploy';
      }
    },
    onTick(state) {
      renderer?.render(state, scenario.deployZoneFrac);
      if (ui) {
        ui.refreshTopbar(state);
        ui.refreshCards(state);
        ui.refreshFeed(state);
      }
    },
  });

  ui = new UI(game);
  const host = document.getElementById('canvas-wrap')!;
  renderer = new Renderer(host, game.params, {
    onUnitClick(unitId, shift) {
      const u = game.state.units[unitId];
      if (!u || u.side !== 0) return; // enemy units are visible but not selectable
      ui!.select(unitId, shift);
    },
    onUnitDrag(unitId, x, y) {
      game.moveDeploy(unitId, x, y);
    },
    onDragEnd() {},
    onEmptyClick() {
      ui!.clearSelection();
    },
  });
  ui.onSelectionChange = (sel) => {
    renderer!.selected = new Set(sel);
    renderer!.render(game.state, scenario.deployZoneFrac);
  };
  await renderer.init();
  renderer.deployMode = true;
  renderer.showDeployZone = true;
  renderer.render(game.state, scenario.deployZoneFrac);
  ui.refreshTopbar(game.state);
  ui.refreshCards(game.state);

  // Expose for debugging / automated smoke tests.
  (window as unknown as { warsim: unknown }).warsim = { game, renderer, ui };
}

void boot();
