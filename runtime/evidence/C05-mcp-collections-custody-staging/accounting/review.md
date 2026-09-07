# B accounting helper — 실제 구현 검토와 한정 보완

[채택 계획](../../../../design/chapters/C05-mcp-collections-custody-plan.md)에 맞춰 accounting의 실제 소스 두 파일을 읽었다. 최초 읽기 당시 별도 notes/완료 manifest/시험은 없었다. helper 본문은 끝까지 작성돼 있지만 **B의 실행기·문맥 연결과 인수가 끝난 상태는 아니다**. 이후 root가 승인한 두 지적만 staging에서 수정했다. 정본 적용·빌드·시험·SSH는 하지 않았다.

## 코드가 현재 제공하는 범위

| 파일/API | 실제 작성된 내용 | 완료와 구분할 점 |
| --- | --- | --- |
| [read-usage.ts](src/application/read-usage.ts), `sumReadUsage` | 네 usage 필드의 strict parse·null 전파·안전한 정수 합계. 빈 자기 요청 집합은 0이다. | 기존 합산 의미를 유지하는 순수 helper다. 원 요청 집합의 증명이나 상태 정산은 하지 않는다. |
| [stored-read-usage.ts](src/application/stored-read-usage.ts), `candidate` | 실제 read collection/proof 계약과 callback 존재, 원 attempt·contract, 예약 취소/만료·reuse/computer/effect 제외. | 현재 본문 권한이나 전송 가능성을 허용하는 API가 아니다. |
| `inspectCustody` | 원 dispatch, 현재 head의 게시/reconcile 영수증, 부모 chain·자기 request 목록, 원 intent/response/ref·원 bytes를 검증한다. 같은 instance의 WeakMap에 frozen 결과를 등록한다. | 현재 필수 head/result/evidence를 숨길 권한은 주지 않는다. |
| `prepareUsage` | 발급 inspection의 현재성을 다시 검증하고 received/종료 상태 또는 고정 attempt lease 경과 후에만 자기 호출 합계를 만든다. work pause나 변경 가능한 deadline만으로 종료시키지 않는다. | 아직 실행 중인 요청 목록의 부분 known 합계를 확정하지 않는다. `mergeToolExecution`이나 정산 commit을 직접 호출하지 않는다. |
| `assertCurrent` | 입력 state·등록 객체·발급 티켓·sourceDigest·usage 종료 조건을 재검증한다. 늦은 receipt로 원 증명이 바뀌면 기존 티켓을 거절하고 fresh inspection이 필요하다. | 새 정산 장부·DB·모델/원격 호출·본문 projection은 없다. 호출자가 현재 owner/scope와 CAS를 연결해야 한다. |

부모 호출은 child 합계에서 제외한다. source가 `absent`이면 관측을 null로 남기고 알려진 값으로 만들어 내지 않는다. 보관 참조는 검증한 raw/intent·record chain 및 연결된 normalized 응답에서 모으며 `checkpoint.artifacts` 전량을 제외 목록으로 쓰지 않는다. 다만 반환 목록에 현재 head도 있을 수 있으므로 **ContextRecovery 소비자가 required ref를 다시 보호해야 한다**.

## 발견과 이번 보완

1. 최초 `stored-read-usage.ts:4`의 `visibleArtifact` import는 사용되지 않았다. 실제 `tsconfig.json`의 `noUnusedLocals: true`와 충돌하는 정적 결함이라 제거했다. 실제 compiler 진단을 실행한 것은 아니다.
2. 최초 `branch`의 reader 검증 뒤 여러 `restoreReadUsage`·영수증 await가 이어졌지만 inspect 마지막은 state/receipt만 확인했다. 예를 들어 정상 settled head를 읽은 뒤 후반 MCP response receipt seam에서 head 파일만 삭제/치환하고 state/ref/receipt를 유지하면 동일 inspect 또는 assertCurrent pass가 이전 bytes로 승인될 수 있었다. 새 inspect 시작 시 재읽기만으로는 그 pass 후반의 소실을 막지 못한다.

두 번째 경계는 `Scope.revalidate()`로 보완했다. 그 scope에서 **실제로 조회한 ref와 당시 원 정책**을 유지하고, 모든 per-call 관측 처리 뒤 실제 `services.artifacts.get`으로 각 파일을 다시 읽어 exact byteLength/SHA256을 확인한다. 같은 pass의 캐시 값이나 `exists`는 이 검사를 대체하지 않는다. hash 대상 bytes는 저장소 반환 직후 복사해 외부 공유 버퍼 변경과 분리한다. 이후 기존 dispatch/publication receipt 및 현재 state/등록 guard는 유지한다.

이 fence는 유한한 재검증이며 파일·state·영수증의 다중 저장소 원자 commit을 만들지 않는다. 검사 뒤 파일이 바뀌지 않는 전역 보장이나 후속 소비자의 검증 생략을 주장하지 않는다. 해당 수정은 권한 완화·본문 채택·사용량 추정과 무관하다.

최초 범위의 고유 조회 집합은 기존 10,000 ref·64MiB 상한을 유지하고 최종 fence에서 같은 집합을 한 번 더 실제 읽는다. 이 helper scope의 최초/최종 byte 조회는 최대 두 번이며 adapter 내부 원문 조회와 별도다. `prepareUsage`/`assertCurrent`의 새로운 검사 pass도 비용이 있으므로 전체 읽기·latency 절감이나 새 성능 측정을 주장하지 않는다.

## 아직 없는 B 연결과 필요한 인수

읽은 정본에는 `StoredReadUsages`/`sumReadUsage` 소비가 없고 `ExecutionRuntime`·`ContextRecovery`는 여전히 plain `StoredToolUsages`만 사용한다. 다음 연결은 root 소유다.

- 기존 정산 명령·원 attempt identity·`mergeToolExecution`·CAS와 결합하고, 이미 known 또는 null이 기록된 collection도 늦은 receipt를 다시 확인한다. plain metadata skip을 collection에 그대로 적용하지 않는다.
- 보호 투영에서 필요한 ref를 제외하지 않고, 실제 증명한 보관 raw/역사적 checkpoint와 관계없는 비공개 ref를 구분한다. 현재 실행 정책·원 사용자 입력 검사는 유지한다.
- 아직 진행 중인 요청 목록의 합계 미확정, lease 이후 null→known, 부모 중복 없음, 두 복구자의 단회 정산, 원 소유·세대·계약 교체와 티켓 위조, 필수/무관 ref, 후반 원문 삭제/치환을 실제 저장소에서 시험한다.
- adapter A 및 일반 CLI/HTTP·종료/중단 C와 함께 검증한다. raw-only는 response receipt나 known usage의 증명이 아니다.

Windows 담당에게 마지막 원문 fence 위치와 API 유지 사항을 전달했다. 담당자는 정상 settled head 최초 읽기 후 MCP page receipt 조회에서 .blob 삭제/치환하는 staging 인수를 작성 중이라고 알렸다. 이 메모는 그 시험이 저장되거나 통과했다고 주장하지 않는다.

## 보존과 상태

[before-review1 manifest](before-review1/manifest.json)에 수정 전 두 파일의 byte/SHA를 보존했다. `read-usage.ts`는 변경하지 않았다. 수정된 helper와 적용 대상·검증 미실행 상태는 [manifest.json](manifest.json)에 기록한다. 기존 source·A staging·updater·증거는 변경하지 않았다.

최초 `stored-read-usage.ts` SHA: `ccaa8b5e5fc53befa7d883fb059625e588a9be8eb4b1cbc2fe3edf027af7a87e`.
수정본 SHA: `1a8bb16b9e7c9f6f7a40659abe15cde7df349b7a4475cdae17a6667ba5c679c9`.
