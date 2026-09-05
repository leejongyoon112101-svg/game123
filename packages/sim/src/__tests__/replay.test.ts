import { describe, expect, it } from 'vitest';
import { createBattle } from '../battle';
import { idleBrain } from '../brain';
import { hashState } from '../hash';
import { applyDeployment, isReplay, type Replay } from '../replay';
import { runBattle } from '../step';
import { calm, duel, loadDefaultParams } from './helpers';

describe('replay', () => {
  const params = loadDefaultParams();
  const base = duel(
    [{ type: 'infantry', commander: calm, x: 300, y: 500, stance: 'hold' }],
    [{ type: 'infantry', commander: calm, x: 380, y: 500, stance: 'hold', facingDeg: 180 }, { type: 'infantry', commander: calm, x: 380, y: 620, stance: 'hold', facingDeg: 180 }],
  );

  it('re-running seed + deployment + inputs reproduces the hash', () => {
    const replay: Replay = {
      version: 1,
      scenarioName: base.name,
      seed: 9,
      altDeployment: null,
      deployment: [{ x: 320, y: 520, facingDeg: 10, stance: 'hold' }],
      enemyProfile: 'passive',
      inputs: [
        { tick: 50, unitId: 0, stance: 'assault' },
        { tick: 400, unitId: 0, stance: 'withdraw' },
      ],
      soldiers: true,
    };
    const run = () => runBattle(createBattle(applyDeployment(base, replay.deployment), params, replay.seed), params, replay.inputs, { brain: idleBrain, maxTicks: 1500 });
    const a = run();
    const b = run();
    expect(hashState(a)).toBe(hashState(b));
    expect(a.units[0]!.formation.facing).not.toBe(0); // deployment applied
    expect(a.events.filter((e) => e.kind === 'stance_player').length).toBe(2);
    expect(isReplay(replay)).toBe(true);
    expect(isReplay({ seed: 1 })).toBe(false);
  });
});
