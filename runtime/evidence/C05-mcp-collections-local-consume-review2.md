# C05 collection local consume — 후속 정적 검토

작성 시각: 2026-09-07T15:04:37.518135+00:00

검토 대상은 아래 지문의 staging 사본과 작성된 13개 인수 시험이다. 제품 적용·소스 수정·빌드·시험·SSH는 수행하지 않았다. 아래 결론은 코드 경로를 읽어 확인한 것이며 재현 시험 결과가 아니다.

## 수정이 필요한 경계 1건

**일반 read의 이미 수신된 결과를 거절·정산하는 경로에 collection용 실행 권한 검사가 추가된다.**

- `staging/root/src/application/execution-runtime.ts:785–791`: `settleStoredCollection()`이 collection 후보를 찾기 전에 `assertExecutionAuthority`를 호출한다.
- 같은 파일 `:817–838`: `step()`은 이 함수를 기존 control/adopt보다 먼저 호출한다. `settleStoredResult()`는 `restoreResult`가 있는 plain proof read만 별도 처리하므로, 해당 선택 콜백이 없는 일반 read는 앞선 함수에서 처리되지 않는다(`:767–771`).
- 기존 `adoptOnce()`의 `:627–635`에는 권한이 철회된 received 결과를 본문 채택 없이 `result_permission_revoked`로 정산하는 경로가 있다. `application/execution-control.ts:27–32`의 `prepareExecutionBoundary`도 이를 막는 host authority 검사를 하지 않는다.

따라서 일반 read가 `received`이고 업무는 `ready`인 상태에서 host authority의 signal만 abort하면, 다음 `runtime.step()`은 기존 거절 정산에 도달하기 전에 `execution_authority_denied`를 던진다. 원 응답이 삭제되거나 본문이 유출된다는 주장이 아니라, collection 기능을 쓰지 않는 도구의 기존 정산 진행이 막힌다는 결함이다. 현재 공개 workflow는 자체 권한 검사를 별도로 유지하므로 그 정책을 완화할 필요는 없다.

최소 교정: collection 후보가 전혀 없으면 새로운 권한 검사 없이 `null`을 반환한다. 실제 collection 후보에 필요한 검사는 선택 직후 및 현재의 변경/게시 경계에 그대로 둔다. 새로운 일반 정산 루프나 저장소는 필요 없다.

필요 회귀: 기존 `tests/tool-availability-runtime.test.ts`의 일반 read fixture를 재사용하여 `restoreResult` 없는 도구의 실제 `receive` 뒤 host signal을 abort하고 `runtime.step()`을 호출한다. 추가 도구 호출 없이 `failed`, `adopted=false`, `result_permission_revoked`가 되고, 원 result artifact/receive 영수증/known usage와 논리 호출 수가 보존되는지 확인한다. 기존 13개 시험은 모두 collection을 등록하므로 이 경계를 포함하지 않는다.

## 나머지 검토 범위

- `read-collections.ts:150–193,268–283`: 완전 parent는 원문/head/query/contract를 검증한다. local child 게시의 parent successor 결합은 기존 한 state transaction을 사용한다. 게시 이후에는 이전 parent의 successor=null 조건을 재사용하지 않고 자기 child/head 연결을 확인한다. 이 경로에서 추가로 확인된 중대한 누락은 없다.
- `execution-runtime.ts:260–366`, `tool-broker.ts:60–118,163–169`: local 소비는 새 논리 시도의 예약/dispatch 한도를 그대로 소비한다. 일반 `Tool.execute`/source.fetch/reuse를 건너뛰어도 논리 시도 1회와 로컬 구현 진입 1회는 별개이며, 원 부모의 transport 사용량을 child에 다시 합산하지 않는 기존 projection을 사용한다. 작성된 정상 2개 시험이 이 구분과 원 부모/영수증/bytes를 검사한다.
- `workflow-runtime.ts:94–121`: 이미 수신된 collection 결과와 복구 가능한 저장 응답 정산을 첫 compact/context restore보다 앞에 둔다. `planning-runtime.ts:687–707`은 활성 reserved/running/received 도구가 있으면 자동 compact를 새로 만들지 않는다. 불완전 offline checkpoint의 connection wait는 별도 `read-connection-control.ts` 검토 결과를 따르며, 본 메모는 모델 품질이나 실제 서버 재개의 성공을 주장하지 않는다.
- 13개 시험은 정상 2개, partial/query/head/raw 거절 4개, 원문 읽기/child artifact 저장 후 authority·등록·취소 변경 6개, 게시 후 취소 1개이다. 실행되지 않았으며 정상 통과 수로 취급할 수 없다.

## 읽은 사본의 SHA256

- `runtime/evidence/C05-mcp-collections-staging/root/src/application/read-collections.ts`: `d10955ecfcb008974287ec6aae6a63cfeafcf2c642a5913959858c1720485472`
- `runtime/evidence/C05-mcp-collections-staging/root/src/application/read-waits.ts`: `36ca4789356c7d019e01c53d9ec73f2fbcfda68e67f7f4736d1762872c849c27`
- `runtime/evidence/C05-mcp-collections-staging/root/src/application/tool-broker.ts`: `c27f2b5877c645a411c434c521536ec8aa43291bf0a09db401a91e48b296d028`
- `runtime/evidence/C05-mcp-collections-staging/root/src/application/execution-runtime.ts`: `0963261192860f9c7252a983d10857072f83a6f09eae6befadb15c39a3fc28d2`
- `runtime/evidence/C05-mcp-collections-staging/root/src/application/read-reconciliation.ts`: `2efeb2b099e49ca86716593fac9595d2d58792b0571b34431d212c78d032776b`
- `runtime/evidence/C05-mcp-collections-staging/root/src/application/workflow-runtime.ts`: `bab17744465210024bbd34827c4ff765dadbc422921e852ca01e80d9684aa737`
- `runtime/evidence/C05-mcp-collections-staging/metadata/src/application/planning-runtime.ts`: `661af03bf4558cfad3009d3f9cd57f280cee03d20a3fe7846601a966739f091c`
- `runtime/evidence/C05-mcp-collections-staging/linux/src/application/read-connection-control.ts`: `16a4058717e87be50caa74f3af1e450f96ee81c06b7de5e90eaa7337e22b2694`
- `runtime/evidence/C05-mcp-collections-staging/windows/src/tests/read-complete-resume.test.ts`: `a681a9245b75474e62378c1786c0473b7f655b9acf773e2d47a20500af6df89b`
