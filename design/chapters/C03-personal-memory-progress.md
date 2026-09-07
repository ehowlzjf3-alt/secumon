# C03 개인 기억 구현 진행 기록

2026-09-07 · 이번 명시 기억 흐름 검증 완료 · C03 전체 진행 중

직전 C02는 최종 Linux 전체 2,836개·compact 46개 통과와 회수·정리를 확정한 진전이다. 종료된 NAS 실행을 다시 기다리거나 동일 전체 시험을 반복하지 않는다. 그 검증을 현재 편집 중인 C03 소스의 결과로 옮겨 적지 않는다.

## 현재 구현 단위

명시적 기억하기 → 담당·사용자가 같은 새 대화에서 회상 → 실제 입력 문맥 → 정정·잊기 후 낡은 입력 거절을 CLI/Web까지 연결한다. 기본 SQLite와 기존 KnowledgeService의 저장·버전·검색·의존성 검증을 재사용한다. 원문 대화/요약을 자동으로 개인 기억에 복사하지 않는다.

- root: KnowledgeRecord/Dependency의 개인 owner와 사용자 원문 source, 기존 KnowledgeService의 개인 범위·등록/정정/잊기·혼합 의존성 검증, SessionKnowledgeSources와 core.memory 도구 연결.
- 저장 담당: SQLite agent/work/personal 범위, 명시 공유 DB 등록·고정 handle, 기존 JSON/receipt digest 보존 이행과 저장소 회귀.
- 문맥 담당: 영속 선택 refs/basis, 실제 ContextPacket·프레임·모델 호출·현재성 검사/무효화/복구, compose 연결과 통합 회귀.
- 표면 담당: C01 CLI/Web 호스트 actor 제한·기억 카드/관리·선택과 실제 사용자 흐름 시험.

## 확정한 구현 경계

개인 기억은 schemaVersion2와 tenant/agent/principal 범위를 명시한다. 기존 Evidence 기억의 JSON과 의미를 유지하고 사용자의 발언을 가짜 Evidence로 바꾸지 않는다. 개인 원문은 적용 receipt+같은 원문 이력+현재 출처 정책/세대를 검사한다. 사용자의 입력 자체를 당시 업무의 모델 산출물에서 파생된 것으로 처리하지 않아 자기 기억을 회상할 때 순환 의존성을 만들지 않는다.

기억 본문은 이번 명시 등록에서는 사용자가 선택한 정확한 원문 문구다. 모델 자동 선별은 후속 범위이며 실제 모델/API 시험은 중단 상태다. 개인 검색은 개인 범위, 회상 선택은 현재 업무와 입력 basis에 연결한다. 새 입력이 도착한 뒤 오래된 업무 버전으로 선택을 바꾸는 명령은 거절한다. 이미 선택한 유효 기억은 후속 입력에서도 유지하며 매번 현재성을 확인한다. 잊기는 활성 정본 본문/인용을 제거하며 원문 대화·백업의 물리 삭제와 구분한다.

## 검증 및 다음 행동

아래에 각 실행 결과를 보존한다. 기존 C02 통과를 새 변경의 통과로 주장하지 않는다. Windows 실제 실행·호스트 격리, 파일/등록형 PostgreSQL 어댑터, C04~C10은 남아 있다.

## 첫 계약 진단과 원문 세대 보완

- core1은 새 optional knowledge 필드의 exactOptionalPropertyTypes 불일치로 exit2였다. 정의를 수정한 중간 core2는 exit0이었다. 이후 compose/선택/표면 변경이 추가돼 최종 타입 통과로 취급하지 않는다.
- 전체 typecheck1은 compose의 배열 타입2건, actor의 선택 목적지 타입과 기존 BoardActor→WorkActor 전달, 새 시험의 transact 인자 수 오류로 exit2였다. 원로그를 보존하고 수정 중이다. 아직 빌드/동작 시험 전이다.
- 같은 업무에서 새 정정 원문을 기억한 뒤 옛 기억 사본을 격리하면 전체 dataGeneration이 증가한다. 사용자 원문은 그 격리로 바뀌지 않으므로 session_user_receipt 세대는 정본에 기록된 knowledge dependency_changed 격리 증가만 제외한다. 임의 세대 변화나 실제 접근 변경을 전부 무시하지 않는다. Evidence 출처의 세대/기존 해시는 유지한다. 원문/정책/receipt 검사를 계속 수행하며 관련 회귀를 추가했다.

## Checkpoint237 · 첫 동작 검증

- build1은 exit0. 신규 관련 5개 파일의 실제 시험은 49개 중 46개 통과·3개 실패였다. 로그 C03-personal-build1.log / C03-personal-target1.log와 build1 manifest를 보존했다.
- 저장 이행 두 실패는 SQLite null-prototype 행과 rest-spread 일반 객체의 비교 차이였다. 행의 값만 동일 방식으로 정규화했고 원문 JSON 문자열·모든 컬럼·receipt digest·실제 SIGKILL 비교는 유지했다.
- Web 한 실패는 기존 취소 명령의 내부 messageId를 HTTP requestId와 같다고 가정한 시험 오류였다. 실제 applied 입력의 messageId/workId/kind 및 원문 3개를 확인하도록 수정했다. 제품 동작을 시험 기대에 맞춰 바꾸지 않았다.
- 신규 동작에서 실제 core.memory.get/search의 개인 범위 옵션, 새 업무 scope에서의 회상, 개인 owner 인자 위조 거절과 잊기 후 dependency 무효화를 확인했다. 입력 packet/프레임/복구와 실행 중인 합성 모델의 지연 응답 거절·보고 사용량 보존도 target1 통과 범위다.
- build2를 시작했다. 아직 수정 후 시험 통과나 Linux 전체 통과를 주장하지 않는다. NAS는 기존 전용 시험 폴더·권한0700·Node24만 확인하고 새 C03 runner를 준비했으며 실제 모델/API/사내 서비스는 호출하지 않았다. 개인 기억 Web 자산도 새 build pin과 확인 항목에 포함한다.

## Checkpoint238 · 검토 의무 경계 보완

- build2 exit0 및 target2 49/49 통과. 이어진 독립 코드 검토에서 개인 선택의 의무 면제 조건이 기존 업무 기억 검토까지 해제하는 실제 결함을 찾았다. 이 발견 이후 build2를 최종 결과로 취급하지 않는다.
- baseline 빌드를 고정하고 clear/recall 재현2개가 기존 의무 pending→waived 차이로 실패함을 확인했다(C03-personal-review-baseline2.log). 첫 baseline 이름 패턴은 일치하는 시험이 없어 파일 wrapper만 통과한 잘못된 실행이므로 유효 검증에서 제외한다(C03-personal-review-baseline.log).
- select 직전 기존 의무 ID를 고정하고 이번 선택이 새로 만든 검토 의무만 처리하도록 수정했다. 개인 기억 계획 재검토 gate는 유지한다. 기존 검토는 소급해 면제하지 않고 기존 runtime resolve 명령으로 이유를 제공해 처리한다. 새 인간 승인 절차를 요구하지 않는다.
- 재현2개+혼합 의무1개, 기존 정정시험의 resolve→재계획 gate 확인을 추가했다. build3과 새 관련52개 검증을 진행한다. 결과/모델/API/NAS 통과를 앞당겨 표시하지 않는다.

## Checkpoint240 · 최종 Linux 결과와 정리

동일 build3 소스로 NAS 전체2,888/2,888·관련52/52, 빌드/코어/구조/CLI/fixture가 통과했다. 종료2026-09-07T00:11:56.350Z. 원로그8개 회수·해시, 시험프로세스0·SSH종료·전용root0700·시스템Node18유지를 확인했다. exec29539/97747은 모두 terminal exit0이다. 확정 증거는 [C03-personal-verification.json](../../runtime/evidence/C03-personal-verification.json). 실제 브라우저와 단회 계측도 같은 소스이며 각각 정리 완료했다.

전체계획·작업목록·README·검증/이어가기·HTML을 현재 상태에 연결했다. 다음 문서 기억·PG 계획은 제안이며 구현으로 표시하지 않는다. C03 전체/전체 goal은 진행 중이고 Windows·실제모델·호스트격리·C05/C06 개선은 남아 있다.
