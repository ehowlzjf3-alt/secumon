# P3-01 MCP 수집 공통 훅 최종 읽기 검토

2026-09-06. 저장된 core hook과 `mcp-read-collections.ts`를 함께 읽었다. 실제 검증 수치는 root 실행 로그로 관리한다. 이 검토자는 빌드·시험·MCP 실행을 하지 않았다.

## 발견한 경합과 승인된 수정

수집 source의 합성 authorize는 Broker authorize를 먼저 호출한 후 current/checkpoint 검사를 기다린다. 처음 구현은 definition의 값만 비교했으므로, 그 대기 중 같은 definition/version의 provider가 새 등록으로 교체되면 checkpoint 검사는 새 등록을 처음부터 선택할 수 있었다. 이전 등록에서 시작한 source가 새 등록 아래서 RPC를 보내는 경합이었다.

승인 후 `ReadCollections.execute`의 첫 await 전에 RegisteredTool 객체를 캡처했다. current/guard, 합성 authorize의 마지막 상태 검사, pageProof 앞뒤 및 publication의 마지막 guard가 이 등록과의 동일성을 확인한다. definition/contract digest 검사도 유지한다. 내부 등록 객체는 source.fetch context에 전달하지 않는다.

양 저장소 회귀는 source가 authorize에 들어간 뒤 첫 intent-head artifact read에서 같은 definition을 새 provider entry로 재등록한다. Broker 초기 검사보다 늦고 checkpoint 검사보다 이른 교체를 명시적으로 만든다. 이전 source의 요청/원본 생성은 0개, 결과 채택은 false여야 한다. 기존 callback await 중 교체 검사와 별개로 전체 권한 합성의 틈을 검증한다.

## 확인한 통합 경계

- `collection.pageValidation`은 계약 digest에 포함된다. snapshotTool과 createReadCollectionTool은 marker가 있는데 callback이 없으면 등록을 거절한다. 함수와 definition을 함께 캡처하여 source 객체에 callback을 다시 대입해도 설치된 callback은 바뀌지 않는다.
- ToolContracts.validateReadPage는 원 호출 attempt/task/tool identity, marker의 rawArtifact 존재, detached 입력, callback 결과 및 await 뒤 동일 등록 entry를 검사한다.
- MCP 어댑터는 task/query와 core ReadRequest를 고정한 typed arguments를 보낸다. fetch와 실제 stdio send에서 합성 authorize를 호출한다. source의 사전 대기 뒤에도 core intent/head와 현재 권한을 다시 확인한다.
- MCP raw envelope와 mapped page는 서로 다른 artifact다. raw envelope는 별도의 requestId 응답 receipt와 exact intentHead에 연결된다. page projector는 SDK decoded body를 host schema로 검증하고 Evidence/usage를 재계산한다. 원격 Evidence나 권한을 그대로 수락하지 않는다.
- core는 각 accepted ReadCall.response의 개별 mapped page를 검증한다. parent call의 task는 parent dispatch receipt에서 선택한다. 성공 항목이 남아 있는 병합 페이지 전체를 마지막 raw 응답 하나와 비교하지 않는다.
- rawArtifact는 빈 페이지도 checkpoint.artifacts에 포함된다. checkpoint delta decoder의 settled artifact closure에도 같은 참조를 추가하여 기록과 재생의 digest를 일치시킨다.
- ReadCheckpointReader.proofOriginal은 최초 읽기부터 필수 raw ref를 보존한다. 마지막 revalidate는 cache reuse/eviction 여부와 무관하게 이 ref의 현재 integrity를 검사한다. ReadCheckpoints는 그 뒤 state 및 캡처한 등록 entry를 다시 확인한다.
- receive/adopt, pending 및 adopted compact, reopen/restore, 명시 parent resume는 기존 ReadCheckpoints 경로로 위 검증을 공유한다. 검증 callback은 SDK call/discover를 실행하지 않는다.
- 새 필드는 선택적이고 기본값을 주입하지 않는다. 기존 marker 없는 collection의 직렬화와 계약 digest는 필드 생략 상태로 유지된다. 원본 proof를 제공하지 않는 기존 source에 새 보장을 소급해 주장하지 않는다.

## 시험 해석

root의 첫 targeted 결과는 40개 중 38개 통과, 2개 실패였다. 실제 MCP 통합 26개는 통과했고, focused core 14개 중 2개는 missing-parent-original 거절의 예외 이름 예상만 달랐다. source 입력 0이라는 검증 의도는 유지하고 `read_checkpoint_unavailable` 또는 실제 ArtifactStore의 `synthetic_original_missing`을 허용하도록 수정했다.

등록 교체 경합 회귀 2개를 추가하여 focused core 시험은 16개다. 이 문서 작성 시 새 소스에 대한 root targeted/전체 verify는 아직 완료 결과가 아니다. 이전 통과 로그를 새 소스의 통과로 간주하지 않는다.

## 비용 및 범위

raw envelope의 크기는 MCP 어댑터의 최대 512 KiB와 collection.maxPageBytes 중 작은 값으로 제한되고, core 역시 raw ref에 maxPageBytes를 적용한다. mapped page·checkpoint 한도는 기존 규칙을 유지한다. 원본/receipt와 체크포인트를 반복 검증하므로 호출 수 절약과 로컬 I/O 비용을 나누어 측정해야 한다.

등록 객체와 로컬 원본 integrity를 재검사하는 것은 원격 서버와 로컬 CAS의 원자 transaction을 뜻하지 않는다. SDK가 보내기 시작한 요청은 취소/응답 유실 후 미전송으로 바꾸지 않는다. 서버 데이터 snapshot은 discovery generation과 구분하며, 원격 snapshot 계약이 없는 임의 MCP 도구의 완전한 수집을 주장하지 않는다. 원본 API 키·모델·사내 MCP·Knox 연동은 이번 검토 범위 밖이다.
