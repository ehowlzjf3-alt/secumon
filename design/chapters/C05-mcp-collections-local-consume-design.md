# 완전 collection checkpoint의 로컬 successor 소비

2026-09-07 · **코어 연결 제안이며 미구현·미검증이다.** [일반 입구 계획](C05-mcp-collections-entry-plan.md), [복구 검토](C05-mcp-collections-recovery-review.md), [planning 검토](C05-mcp-collections-planning-review.md)를 대체하지 않는다. 여기서는 이미 현재 plan에 있는 명시 `TaskSpec.readResume`가 완전 checkpoint를 소비하는 경로만 정한다. 모델의 선택·plan 등록, partial 부모의 대기 판정, MCP host 조립은 해당 문서의 범위다. 제품·시험·기존 문서·SSH는 변경하거나 실행하지 않았다.

## 선택: 같은 실행기, 단계별 임시 permit, 별도 로컬 호출 분기

**compose가 만든 `ReadCollections` 하나를 `ExecutionRuntime`에 주입하고, 기존 reserve/dispatch/receive/adopt는 유지한다.** 원 checkpoint를 비동기로 검증한 임시 permit에 한해서 `connection_required`만 구분한다. Broker의 원 호출 guard는 공유하지만, 실제 실행은 같은 `ReadCollections`의 완료 parent→child checkpoint→project 경로를 직접 호출한다. 일반 `Tool.execute`, source `fetch`, result reuse callback, MCP client는 호출하지 않는다.

새 영속 mode·permit·claim·DB는 필요 없다. 기존 plan의 `readResume`, reserve/dispatch 영수증, parent의 successor 연결, child checkpoint와 결과 영수증이 재시작의 근거다. permit은 이 자료를 현재 프로세스가 검증했다는 짧은 수명의 객체이며 재시작 후 복원하지 않는다.

### 실제 조립 위치

[compose-runtime.ts](../../runtime/src/application/compose-runtime.ts) 141~147행은 contracts→ReadCollections→ExecutionRuntime 순서다. 따라서 순서를 바꾸거나 두 번째 collection 실행기를 만들 필요 없이 마지막 인자 하나를 추가할 수 있다.

```ts
const readCollections = new ReadCollections(services, contracts, input.owner);
const runtime = new ExecutionRuntime(
  services, contracts, input.owner, input.leaseMs, resultReuse, readCollections,
);

// 기존 5인자 호출을 유지하는 선택 인자 제안
constructor(services, tools, owner, leaseMs = 30000,
  resultReuse?: ToolResultReuse, readCollections?: ReadCollections);
```

`ExecutionRuntime`은 주입된 객체의 `services === services`, `contracts === tools`, `owner === owner`를 검사한다. 기존 resultReuse의 동일 인스턴스 검사와 같은 방식이다([execution-runtime.ts](../../runtime/src/application/execution-runtime.ts) 66행). 주입이 없으면 기존 실행만 지원하고 로컬 소비는 명시적으로 불가하다. fallback 실행기를 만들지 않는다. 주입된 경우 `readCheckpoints`도 그 객체의 `checkpoints`를 사용할 수 있다. 모델/host factory에 새 실행기 포트를 노출하거나 `RuntimeServices`에 전역 registry를 추가하지 않는다.

## `ReadCollections`에 필요한 작은 경계

다음은 application 내부용 시그니처 제안이다. `Context`는 현재 `Tool.execute`의 실행 context 타입을 재사용한다. public 사용자 입력이나 serialized schema가 아니다.

```ts
// 객체 식별자는 해당 ReadCollections 인스턴스의 WeakMap으로 검증한다.
// 외부에서 같은 필드의 객체를 만들어도 유효한 permit이 아니다.
type LocalReadConsumePermit = /* opaque, non-serializable */ object;

prepareLocalConsume(
  state: WorkState, task: TaskSpec, consumerId: string, signal?: AbortSignal,
): Promise<LocalReadConsumePermit>;

assertLocalConsumeBound(
  state: WorkState, task: TaskSpec, consumerId: string, permit: LocalReadConsumePermit,
): void; // 동기 edit 안의 동일 상태/등록/인자 확인. 원문 검증을 대신하지 않는다.

assertLocalConsumeCurrent(
  state: WorkState, task: TaskSpec, consumerId: string,
  permit: LocalReadConsumePermit, signal?: AbortSignal,
): Promise<void>; // 원 checkpoint/proof를 다시 읽고 await 뒤 상태·권한을 재확인

consumeComplete(
  task: TaskSpec, context: Context, permit: LocalReadConsumePermit,
): Promise<ToolResult>;
```

실제 TypeScript에서는 opaque 타입을 exported brand로 표시하고, 유효성은 private WeakMap의 객체 membership으로 확인한다. permit에 임의 callback을 넣어 실행 권한을 주지 않는다. 이는 신뢰된 application 내부의 실수·경합을 막는 방식이며, 호스트 코드 전체를 sandbox하는 기능은 아니다.

### permit이 고정하는 것

발급 시 실제 `ReadCheckpoints.read(state, parentId, exactHead)`를 사용한다. 그 뒤 기존 `ReadCollections.parent`, query/contract/limits, manifest 검사와 현재 host 권한을 재사용한다([read-collections.ts](../../runtime/src/application/read-collections.ts) 103·202행). 최소 고정값은 다음과 같다.

- 이 `ReadCollections` 인스턴스, 현재 `RegisteredTool` 객체와 definition digest, work ID/현재 revision·state digest, 현재 goal·plan·policy·data generation.
- 현재 plan의 정확한 task와 taskDigest, consumer attempt ID, 정확한 `readResume.attemptId/checkpointId`, 전체 ArtifactRef와 원 parent checkpoint의 지문.
- parent가 기존 재개 가능한 terminal 상태이고 effectState가 none이며, 아직 소비되지 않은 현재 tip이라는 사실. 기존 adopted complete 부모는 다시 소비하지 않는다.
- 검증된 checkpoint가 `phase === 'complete'`이고 `collection.exhausted === true`라는 사실, 현재 task의 원 query/도구/limits/manifest와의 일치.
- stage에 맞는 consumer 상태: reserve 전에는 해당 ID가 없고, dispatch 전에는 같은 owner의 reserved attempt, 실행 전에는 같은 owner의 running attempt와 원 dispatch receipt가 있어야 한다.

`ReadCheckpoints`가 검증하는 원문 SHA, page/deferral proof, parent chain, source snapshot, knowledge/input dependencies와 현재 접근권한을 새 간이 검사로 대체하지 않는다. 과거 unknown call이 있다는 이유만으로 추가 거절 규칙을 만들지도 않는다. 기존 검증으로 완전성이 성립하는 checkpoint를 기준으로 한다. parent의 옛 policy와 현재 policy를 임의로 byte 동일 강제하는 등 기존 유효 재개를 좁히지 않고, 현재 원문 접근·권한 검사를 그대로 따른다.

permit은 한 phase의 state revision에만 묶는다. reserve가 성공하면 dispatch용을, dispatch가 성공하면 실행용을 새로 발급한다. 오래된 permit을 새 revision에 덮어 씌우지 않는다. 반환된 checkpoint 객체나 `readProgress.phase`를 이후 phase의 권한으로 재사용하지 않는다.

## 기존 reserve/dispatch guard를 공유하는 방법

[reserve](../../runtime/src/application/execution-runtime.ts) 248행과 [dispatch](../../runtime/src/application/execution-runtime.ts) 297행의 public 시그니처·영수증·예산 편집은 유지한다. `local: true`, `skipCallable`, `allowStored` 같은 사용자 선택 인자를 추가하지 않는다.

각 메서드가 현재 task의 exact complete readResume 후보를 발견하면 실제 permit을 준비한다. ordinary task는 기존 경로 그대로다. 내부 `requireCallable`과 이번 transaction의 control 계산만 다음 구분을 공유한다.

1. 먼저 기존 `tools.check(task, state.policy)`의 오류를 그대로 거절한다. task/도구/권한/schema/재개 종류를 약화하지 않는다.
2. 일반 실행에서는 계속 `checkExecution`을 사용한다.
3. 로컬 permit 경로에서는 `assertLocalConsumeBound`가 현재 state·task·consumer·등록을 확인한 경우에만 **연결 가능 여부 항목 하나**를 분리한다. 다른 budget/progress/dependency/의무/목표·owner·lease 제약은 기존 control/edit가 그대로 검사한다.
4. 비동기 `beforeCommit`에서는 새 state를 읽고 기존 budget authority, session/input, knowledge/effect, wait, host authority 검사를 유지하면서 `assertLocalConsumeCurrent`로 parent 원 proof를 다시 확인한다. 마지막 await 뒤 state·등록·권한을 다시 확인한다.

현재 `transact`는 edit 후 artifact 확인과 `beforeCommit`을 거쳐 expectedRevision CAS를 실행한다([work-transactions.ts](../../runtime/src/application/work-transactions.ts), [commit-artifacts.ts](../../runtime/src/application/commit-artifacts.ts)). 동기 edit에서 비교한 permit은 이 CAS의 원 prior revision에 묶인다. 경합으로 CAS가 실패하여 새 prior를 읽으면 같은 permit으로 계속 진행하지 않는다. 해당 단계가 fresh state/proof를 다시 준비하거나 명시 contention으로 반환해야 한다. 일반 transaction의 모든 재시도를 새 permit의 자동 성공으로 바꾸지 않는다.

후보 요약과 모델의 `stored_complete` 표시는 스케줄 힌트일 뿐이다. public `control`이 후보를 reserve/로컬 소비 대상으로 보여 주더라도 실제 쓰기는 위 비동기 검사 없이는 불가능하다. 동기 `checkExecution` 자체에 async proof callback을 끼우지 않는다. 원 parent proof를 읽는 시점과 state CAS의 시간 차이는 기존 원자료 읽기/transaction 계약의 한계이며 파일·외부 출처까지 물리적으로 원자적이라고 주장하지 않는다.

## Broker의 공통 권한 확인과 무송신 실행

[ToolBroker.invoke](../../runtime/src/application/tool-broker.ts) 36행은 원 dispatch, owner/lease/task/goal, 정책, budget/effect/knowledge, disclosure, 현재 등록을 검사하고 재검사 가능한 `authorize`를 만든다. 이 부분을 private 공통 준비 메서드로 추출하여 기존 invoke와 로컬 진입이 함께 쓴다. normal invoke의 reuse·custody·Tool.execute 순서는 보존한다.

제안은 Broker의 마지막 선택 인자에 같은 `ReadCollections`를 전달하고, 다음 application 내부 메서드를 추가하는 것이다.

```ts
consumeStoredCollection(
  workId: string, attemptId: string, owner: string, signal: AbortSignal,
  hooks?: Pick<InvocationHooks, 'entered'>,
): Promise<ToolResult>;
```

이 메서드는 원 dispatch와 현재 task를 읽고 **실행 단계 permit을 스스로 준비**한다. arbitrary caller callback이나 runtime이 전달한 boolean을 실행 허가로 받지 않는다. 공통 guard의 `contractCurrent`는 local branch에서도 현재 registered 객체와 contract digest를 대조하고 `tools.check`와 permit binding을 검사한다. 반복 `authorize`에는 기존 session/knowledge/effect/budget/owner/lease/goal/labels/destination/abort 확인과 새 원 proof 재검사가 포함된다. `authorizeResponseCustody`의 원 호출 보관 예외는 사용하지 않는다. 로컬 소비도 현재 본문 권한이 있어야 한다.

검사 뒤 `entered`를 호출하고 `readCollections.consumeComplete(task, context, permit)`만 실행한다. 일반 Tool.execute, fetch, reuse callback으로 내려가는 분기는 없다. availability가 online으로 바뀌었다고 remote 경로로 fallback하지 않는다. exact complete readResume는 online에서도 같은 로컬 소비 의미로 두어 분기 의미를 일정하게 유지한다. 원 proof가 맞지 않으면 거절하며, 불완전 parent를 대신 조회하는 일반 실행으로 전환하지 않는다.

## `ReadCollections.execute`에서 추출할 부분

현재 execute 196~225행의 dispatch basis/current guard, parent 읽기, query/limits/manifest 검사와 초기 child checkpoint 구성을 작은 private 함수로 추출한다. normal execute는 그 반환값으로 기존 페이지 loop를 계속 사용한다. `consumeComplete`는 검증된 complete parent만 받아 같은 초기 child 생성→기존 `publish`→`checkpoints.project`를 사용하고 페이지 loop에는 들어가지 않는다.

기존 `publish`는 같은 transaction에서 parent.successorAttemptId와 child.readProgress를 게시한다(113~140행). 로컬 경로는 해당 `beforeCommit`에 parent 원 proof 재검사를 더해, 직전 준비 뒤 raw/head/registry가 바뀐 경우 차단한다. `publish`의 기존 guard/CAS를 없애거나 parent를 별도 영수증으로 먼저 잠그지 않는다. callback을 source에 공개하지 않고 내부의 검증된 로컬 소비 경로에서만 사용한다.

child가 게시된 뒤 parent.successor는 null이 아니므로 준비 단계의 “미소비 parent” 조건을 그대로 반복하면 자기 게시를 거절한다. 이 시점에는 parent가 **정확히 현재 child를 가리키는지**와 child의 parent ref·원 operation/root/query/limits·head를 검사한다. `ReadCheckpoints.project(child, head)`가 기존 chain과 원 response를 다시 검증하는 경계를 재사용한다([read-checkpoints.ts](../../runtime/src/application/read-checkpoints.ts) 246행). 무조건 successor null을 요구하는 재검사나 parent 제한을 통째로 생략하는 처리는 하지 않는다.

실행 단계 permit의 원 state digest는 child 게시 transaction까지 사용하고 성공 시 소비한다. 그 뒤에는 그 permit의 옛 revision을 다시 맞추지 않는다. 원 dispatch에 대한 공통 owner/lease/goal/policy/authority guard와 **게시된 현재 child의 proof**를 새 state에서 확인한다. 이 전환은 정확한 child 게시 영수증·head에만 묶이며, 임의 revision 변경을 허용하는 ticket 갱신이 아니다. result receive/adopt 역시 원 permit을 재사용하지 않고 기존 현재성 검사를 한다.

## receive/adopt·회계·수명은 그대로

[ExecutionRuntime.execute](../../runtime/src/application/execution-runtime.ts) 333행의 controller/lease timer/`#pending`/close drain과 오류→receive 처리를 공유한다. 코드 복제를 피하려면 실제 구현 호출만 private 분기로 나누고 기존 배경 정산 수명을 그대로 쓴다. 호출 분기는 현재 task의 exact complete readResume를 비동기로 확인하여 선택하며, 실패한 로컬 검증 뒤 일반 invoke로 fallback하지 않는다.

반환값은 기존 `ToolResult`이며 `receive`의 artifact·schema·계약·collection proof 검사, `adopt`의 현재성 검사를 그대로 거친다. 부모 failed/result null/adopted false/원 owner는 바꾸지 않는다. 정상 child dispatch는 기존 논리 toolCalls를 1 늘리고 reserved를 반납한다. 로컬 구현에 실제 진입했으면 `mode: 'invoked'`/implementationCalls 1이며, 이는 등록된 Tool.execute나 원격 호출이 있었다는 뜻이 아니다. 별도 시험 계수로 그 둘은 0임을 확인한다.

`ReadCheckpoints.project`는 현재 child ID에 속한 calls만 사용량에 합산한다(215행). 새 page call이 없는 child의 transportCalls 등은 기존 의미대로 0이고, 부모의 물리 호출 사용량을 child에 다시 합산하지 않는다. 이를 result reuse로 가장하거나 부모의 미확정 회계를 임의로 복원하지 않는다. permission/close/lease 실패 시 기존 실패·채택 거절 의미를 유지하며, 알려지지 않은 수치를 0으로 만들지 않는다.

## 재시작과 중단 시 복원 기준

| 중단 위치 | 다음 프로세스에서 사용할 근거 |
|---|---|
| permit 발급 후 reserve 전 | 아무 영속 효과가 없다. 현재 plan/readResume/head를 다시 읽어 새 permit을 만든다. |
| reserve 뒤 dispatch 전 | 기존 reserved attempt의 owner/lease를 따른다. 다른 owner가 permit을 재생성했다고 lease를 탈취하지 않는다. 만료·재예약은 기존 실행 의미를 따른다. |
| dispatch 뒤 child 게시 전 | 원 dispatch는 유지하며 원격 송신은 없다. 기존 만료 복구 후 현재 tip과 실제 plan을 다시 검증한다. parent가 아직 미소비인지 확인하고, 사용자가 선택한 기존 목표/계획·한도 밖에서 새 task를 자동 발급하지 않는다. |
| child checkpoint 게시 뒤 result_received 전 | parent가 이미 그 child에 연결되어 있다. root parent를 다시 소비하지 않는다. 현재 child의 정확한 complete head를 다음 명시 readResume tip으로 사용하려면 기존 만료/재계획·successor 규칙을 따른다. 원 owner를 바꿔 결과를 밀어 넣지 않는다. |
| received/adopt 뒤 | 기존 receive/adopt 영수증·proof 경로를 재사용한다. 새 successor·usage·응답 중복을 만들지 않는다. |

permit은 직렬화하지 않는다. state에 mode가 없더라도 exact `readResume`와 검증된 complete checkpoint로 로컬 소비 자격을 다시 판정할 수 있다. 원 task가 현재 plan에 없거나 head가 최신 tip이 아니면 임의 query/새 계획을 생성하지 않는다. 모델 선택과 frontier 전달은 planning 문서가 담당한다.

## 최소 변경 파일과 판단 근거

| 파일 | 필요한 변경 |
|---|---|
| `application/compose-runtime.ts` | 이미 만든 ReadCollections를 runtime에 전달. |
| `application/read-collections.ts` | permit 발급/재검사, 기존 parent→child 초기화 추출, 무송신 consumeComplete. 원 publish/checkpoints 인스턴스 유지. |
| `application/execution-runtime.ts` | 선택 주입 검사, reserve/dispatch 내부 permit 처리, 기존 execute 수명 안의 로컬 broker 호출 분기. |
| `application/tool-broker.ts` | 공통 원 호출 guard 추출과 consumeStoredCollection. 일반 invoke의 Tool.execute/reuse/custody 동작 유지. |

`ReadCheckpoints`, ToolResult/TaskSpec/장부 스키마, MCP wire 형식은 현재 기능을 재사용한다. hint를 제어에 연결하는 변경은 기존 planning/control 설계와 함께 조율하며 이 문서에서 새 전역 도구 언어를 정하지 않는다. proof를 검사할 때마다 전체를 다시 읽는 비용은 우선 보존한다. 성능 이유로 발급 당시 boolean을 재사용하는 최적화는 이 단위에 포함하지 않는다.

이 안은 클래스 주입 1곳과 작은 공통 메서드 추출이 필요하지만, 별도 실행기·별도 회계·권한 우회 옵션을 피한다. 핵심 회귀는 같은 singleton 사용, Tool.execute/fetch 0, 정확한 parent/head와 task, reserve/dispatch/child publish 전후의 권한·등록·raw 변경, 동시 소비의 successor 1개, 재시작 후 원 owner/논리 호출·물리 호출 보존이다. 성공 인수에는 실제 일반 입구의 최종 답변까지 포함하며, source capacity나 중단 뒤 정산만 성공한 것을 완료 소비로 대체하지 않는다. 이번 문서는 해당 구현·시험을 수행하지 않았다.
