# warsim — 태세(stance) 기반 흑색화약 전투 프로토타입

플레이어는 대대장이다. 10개 부대(각 50명)의 **태세**만 정하고, 부대가 스스로 싸우는 것을 지켜보며 태세를 바꾸는 **타이밍**으로 승부한다.
설계 문서: [`docs/design-v0.1.md`](docs/design-v0.1.md). 이 저장소는 그 문서의 M1~M4를 구현한 프로토타입이다.

## 빠른 시작

```bash
pnpm install
pnpm test                      # 결정성 + 규칙 + 시나리오 밸런스 테스트 (vitest)
pnpm headless --runs 100       # AI vs AI 100판, 승률/길이 분포 출력
pnpm headless --runs 1 --seed 7 --verbose   # 1판의 이벤트 로그와 최종 부대 상태
pnpm web                       # 브라우저 프로토타입 (Vite dev server)
```

헤드리스 옵션:

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--scenario path` | `scenarios/default.json` | 시나리오 |
| `--params path` | `params/default.json` | 밸런스 파라미터 |
| `--runs N` / `--seed S` | 1 / 1 | 시드 S, S+1, … 로 N판 |
| `--a profile` / `--b profile` | balanced / balanced | 양측 전략 프로필: `balanced` `aggressive` `defensive` `passive` |
| `--alt random\|none\|k` | random | 적(B측) 대체 배치 선택 |
| `--out results/x.csv` | 없음 | 판별 결과 CSV |
| `--verbose` | 끔 | 1판일 때 이벤트 로그 출력 |
| `--full` | 끔 | 병사 개별 이동까지 시뮬 (기본은 부대 수치만; 결과 분포는 동일, 해시는 다름) |

## 구조

```
packages/sim        순수 시뮬레이션 코어. DOM/Pixi 의존 0. Node에서 실행.
packages/ai         부대 유틸리티 AI + 측 전략 스크립트. sim에만 의존.
apps/headless       CLI 배치 실행기 (tsx).
apps/web            Vite + PixiJS + 순수 DOM UI.
params/default.json 모든 수치 (사거리, 사기 계수, 병과 계수, AI 가중치…).
scenarios/*.json    맵 지형, 양측 부대·지휘관 성향·초기 배치, 적 대체 배치 3종.
docs/               설계 문서.
```

### 시뮬레이션 API (`@warsim/sim`)

```ts
const state = createBattle(scenario, params, seed);        // BattleState (직렬화 가능)
step(state, params, inputs, { brain: unitBrain });         // 1 tick (0.1 s). 제자리 갱신 후 반환
runBattle(state, params, inputs, { brain });               // 종료까지
hashState(state);                                          // 결정성 검사용 해시
```

- `inputs`는 `{ tick, unitId, stance }` 배열. **리플레이 = 시드 + 입력 배열.**
- `step`은 성능상 상태를 제자리에서 변경하고 같은 객체를 반환한다. 렌더러는 읽기만 한다.
- 난수는 `state.rng`(mulberry32) 하나뿐. `Math.random`, `Date.now`, `performance`는 sim/ai에서 ESLint로 금지.
- 부대 두뇌는 `UnitBrain = (state, unit, params) => { action, stance?, reason? }` 인터페이스로 주입. `packages/ai`가 구현, sim은 실행만.

### 틱 처리 순서 (`packages/sim/src/step.ts`)

1. 플레이어 태세 입력 → 2. 부대 두뇌(1초마다) → 3. 이동·대형 변경 타이머 → 4. 병사 슬롯 이동 → 5. 일제사격 → 6. 돌격 접촉·근접전 → 7. 사기/응집/피로 → 8. 자동 전이(패주, 회복, 피격 시 방어) → 9. 전멸/이탈, 승패, 사기 샘플링.

## 설계 문서와 다른 점 / 해석

- **탄약 소진** (§6.2): 강제 태세 전환 대신 `ammo_out` 경고 이벤트만 낸다. 공세 부대는 사격 없이 돌격만 하게 되고, 방어 부대는 사격을 못한다. 문서의 "공세/방어 → 방어 (돌격만)"이 자기모순이라 경고로 해석.
- **지휘관 성향 자동 전이**(방어→공세, 공세→후퇴)는 `packages/ai`에 있다. 규칙 자체는 결정적 임계값(공격성 ≥ 0.6, 냉정함 < 0.4)이며 확률이 아니다. 사기 붕괴/회복/피격 전이는 `sim`의 규칙이다.
- **응집도**: 행군만으로는 0.7 아래로 떨어지지 않고, 돌격만으로는 0.5 아래로 떨어지지 않는다(`cohesion.moveFloor`, `chargeFloor`). 초기 구현에서 600m 행군 후 응집 0.2로 도착해 공격 측이 절대 못 이기는 문제가 있었다.
- **사기 상한**: 수동 회복(방어/인접 아군)은 90까지, 그리고 남은 병력 비율에 따라 상한이 내려간다 (`passiveCap × (0.4 + 0.6 × 병력비)`). 17/50 남은 부대가 사기 100으로 돌아오는 것을 막는다.
- **기병 돌격 vs 정지 방어 보병**: 60% 확률로 격퇴(`cavalryChargeVsSteadyInfantryFailChance`). 격퇴 시 방어측이 근접 일제사격을 하고 기병은 35m 밀려나며 사기 −15. 통과하면 "대열 속으로 들어간" 것으로 보고 이동 중 보병과 같은 충격을 준다.
- **돌격 커밋**: 두뇌가 1초마다 재판단하면 돌격이 중간에 사격으로 되돌아가는 문제가 있어, 시작된 돌격은 목표가 붕괴·소멸·멀어지지 않는 한 유지한다.
- **접촉 순서**: 기병과 보병이 서로 돌격 중이면 기병 접촉을 먼저 처리한다(충격을 주는 쪽이 기병).
- **속도**: 기준 속도 1.4 m/s로는 첫 접촉까지 5분이 걸려 1.8 m/s로 올렸다. 배치 위치도 40m씩 안쪽으로.

## 현재 밸런스 (헤드리스, `params/default.json`)

| 실험 | 결과 |
|---|---|
| 방어 보병 1 vs 돌격 기병 1 (60판) | 보병 승률 60~85% 대역 안 (테스트가 강제) |
| 공세 보병 1 vs 공세 기병 1 (이동 중 피격) | 기병 ≥ 60% |
| 방어 보병 2 vs 공세 보병 1 | 방어 ≥ 75% |
| 방어 보병 1 vs 공세 보병 1 (정면) | 공격 3~50% (대부분 실패, 가끔 성공) |
| 포병 1 vs 공세 보병 1 | 보병 ≥ 70% |
| 기본 시나리오 balanced vs balanced 40판 | A 21 : B 19, 평균 16.6분, 종료 사유 가용부대 29 / 시간초과 11 |
| balanced vs passive (반응 없음) 12판 | balanced ≥ 60% |

같은 시드·입력이면 해시가 동일하다는 결정성 테스트가 sim 단독과 sim+ai 전체 전투 양쪽에 있다.

## 웹 프로토타입 조작

- **배치**: 아군 부대를 좌측 1/3 구역 안에서 드래그. 선택 후 `Q`/`E` 또는 카드의 ↶↷로 15° 회전. 카드에서 초기 태세. 시드·적 전략 프로필 선택 후 **전투 시작**.
- **전투**: 카드 또는 지도 클릭으로 선택(Shift로 다중). 카드의 5개 버튼 또는 숫자키 `1`~`5`(공세·방어·은폐·후퇴·재편)로 태세 변경. 선택된 부대 모두에 일괄 적용. `Space` 일시정지, 1×/2×/4× 속도. 마우스 휠 줌, 우클릭 드래그 팬.
- **자동 전이**는 이벤트 피드에 "(자동: 이유)"로 표시되고 해당 카드의 태세 버튼이 깜빡인다.
- **결과**: 부대별 손실, 사기 곡선(적군 토글), 태세 변경 로그(명령+자동). 같은 시드/다음 시드로 재시작.

## 다음 단계 (문서 §15 M5, §17)

- 5명 이상 플레이 테스트. "부대가 멍청하다" vs "내가 늦었다" 피드백 수집.
- 열린 질문 중 파라미터로 열려 있는 것: `unit.formationChangeSec`(20), `morale.routDeserterFraction`(0.15), 일시정지 중 명령(UI 체크박스).
- 전략 AI를 유틸리티 기반으로 교체. 지금은 문서 §10의 규칙 + "7분 후 우세하면 예비대 투입".
- 결과 CSV(`--out`)로 파라미터 스윕 스크립트 추가.
