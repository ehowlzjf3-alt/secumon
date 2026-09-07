# P1-01/02 — 대역과 저장 기반

현재 P1에서 검증 완료한 범위는 대역 구성과 상태/원본/실행 의도/결과 저장이다. 실행 루프 전체는 다음 작업 P1-03에 남아 있다.

`RuntimeServices`에 state/artifact/planner/tool/clock/ID/digest/sink를 주입한다. 같은 문서/관측 fixture를 MemoryStateRepository와 대역으로 읽을 수 있고, 코어가 DB나 채널 SDK를 불러오지 않는다. 메모리 저장은 프로세스 종료를 견디는 두 번째 영속 adapter로 세지 않는다.

파일 artifact의 ID는 바이트 hash뿐 아니라 tenant/등급/media type을 포함한다. 같은 내용이라고 서로 다른 자료 권한을 합치지 않는다. 읽을 때 참조와 저장 metadata, 길이/hash, 정책을 확인한다. 참조 라벨을 바꾸거나 원본을 다른 파일로 치환하면 실패한다.

실행 시도는 예약·실행 중·결과 수신·수락 상태를 구분할 수 있게 했다. 결과 원본이 있어도 `adopted=false`라면 아직 업무 판단의 근거가 아니다. 재시작 후 시도에 연결된 resultArtifact를 읽고, 중복 수신 명령은 사건/예산을 다시 늘리지 않는다.

## 검증

- `npm run verify`: 빌드, 시험 26개, 내부 계층 파일 9개 의존성 검사, 22개 fixture 판정 통과.
- 26개는 P0 검증을 포함한 누적 수이며, 이번에 추가한 대역/원본/의도·결과 시험은 9개다.
- 실제 파일 저장/SQLite는 OS 임시 디렉터리에서 시험했다. 실제 모델/사내 MCP/Knox 호출은 없다.
- [실행 계약](/Users/seunghanee/Documents/secumon/design/chapters/P1-execution-contract.md)과 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P1-foundation-verification.json)에 범위와 다음 조건을 남겼다.

다음 학습 포인트는 **같은 목표의 현재 상태에서 어떤 작업을 실행해도 되는가**다. 계획 구조가 유효한지, 입력/도구/효과 권한과 예산이 맞는지, 취소나 새 목표가 들어온 뒤 오래된 결과를 어떻게 다룰지를 실제 루프로 구현한다.
