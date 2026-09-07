# C07 등록·아카이브 연결 결과

2026-09-08. 게시판 호스트 등록과 아카이브 공급자/도구를 일반 에이전트 profile에 연결했고 최종 빌드가 통과했다. **C07 전체 구현 완료는 아니다. 서로 다른 담당의 게시판 scope와 원자료 조회 연결이 남아 있다.** 상세 시험은 전체 구현 이후 단계로 유지한다.

## 구현한 연결

- 기존 config.features.board/archive를 사용한다. false이면 공급자를 열지 않고 도구를 추가하지 않는다. true인데 호스트 등록이 없으면 agent_board_registration_required 또는 agent_archive_registration_required로 거절한다. 기본 비활성은 유지된다.
- AgentExecutionHost.board가 기존 BoardRepository/actors/InputAuthority를 공급한다. 기존 게시판 서비스·발행/답변 도구·요청 의무·watch·입력 검사를 composeRuntime에 그대로 연결한다. 로컬 등록은 createLocalHostBoard로 기존 SQLite/file 게시판 저장소를 재사용한다. 호스트가 명시한 도구 ID와 쓰기 허가만 추가한다.
- AgentExecutionHost.archive를 추가했다. 공급자는 search/get과 선택 mutate를 구현하고 각 자료에 ID·revision·원문·경로·sourceVersion을 제공한다. 외부 원문을 가짜 업무 Evidence나 개인 기억으로 만들지 않는다. 별도 Knowledge 저장 엔진을 복제하지 않고, 외부 사례에 맞는 작은 참조 자료 계약과 기존 파일 게시 primitive를 사용한 로컬 공급자를 추가했다.
- 아카이브 모델 도구는 공급자 ID가 archive인 기본값에서 archive.search/get/register/revise/delete다. 검색에는 크기 제한과 본문 없는 목록을, get에는 명시 원문 조회를 사용한다. read_register 능력과 registration.allowWrites=true를 둘 다 충족해야 모델·관리 쓰기가 활성화된다. 조회만으로 개인 장기기억에 복사하지 않는다.
- 쓰기 명령 ID는 원 workId/attemptId에서 고정한다. 공급자의 원 명령 digest/ID/버전/결과를 대조하고 같은 명령 재처리를 구분한다. 성공 응답은 기존 EffectState의 confirmed로 반환한다. 미확인 쓰기를 자동 재전송하지 않으며 기존 unknown/효과 대조 의무를 유지한다. 이 영수증을 별도 독립 효과 검증 proof라고 부르지는 않는다.
- CLI/Web/Knox는 같은 profile 조립을 사용한다. 공개 호스트 서비스는 profile.board/boardCommands/boardWatch/archive다. 종료 시 실행 정리 뒤 등록 리소스를 한 번 닫으며 다른 담당의 저장소를 임의 종료하지 않는다.

## 배치 방법과 한계

기존 담당 config.json의 features를 선택하고 시작 프로그램에서 board/archive 등록을 전달한다. createLocalArchiveRegistration()은 조회 전용 허가이며 명시 쓰기는 createLocalArchiveRegistration(undefined, {allowWrites:true})로 등록한다. 로컬 원문/영수증은 담당 디렉터리 archive 아래 소유자·공급자별로 보관한다. 공유/외부 아카이브는 호스트가 같은 ArchiveProvider 계약으로 등록한다. 경로는 파일 경로 또는 DB/시스템 참조 문자열이며 에이전트 본체는 저장 기술을 해석하지 않는다.

외부 공급자는 원 명령과 결과를 내구성 있게 연결하고 재전달 시 같은 영수증을 반환해야 한다. 자료 삭제/정정 후 get/search의 현재 상태와 버전을 반환해야 한다. 로컬 공급자의 검색 규모·물리 삭제/보존·영수증 이관과 장기 운영 용량은 운영 검증 대상이며 성능을 측정하지 않았다.

## 남은 실제 구현

기존 게시판은 업무 scope와 게시판 scope가 같고 원 work/원문/proof를 같은 서비스 저장소에서 읽는 전제가 있다. 일반 담당은 scope=agent:ID와 각자 DB를 사용하므로 단순 등록만으로 여러 담당의 공유 게시판이 완성되지 않는다. 이 문제는 미검증으로 감추지 않고 미구현 연결로 남긴다.

다음은 [공유 출처 연결 메모](C07-board-shared-source-notes.md)에 따라 게시판 접근 scope와 원 업무 scope를 명시 권한으로 구분하고, 게시판 전용의 owner 고정 읽기 resolver로 work·artifact·기존 현재성 proof를 같은 소유자에게서 확인하는 것이다. WorkInputGraph의 원출처 재검증까지 동일한 resolver를 사용해야 한다. 현재 담당의 DB/쓰기 포트에 전역 fallback을 넣거나 DB를 합치지 않는다.

아카이브의 unknown 쓰기는 지금 자동 복구하지 않는다. 공급자 영수증 재조회와 일반 효과 대조 연결은 추가 구현 항목으로 유지한다. 실제 외부 공급자의 연결/인증/능력은 별도 환경 조건이다.

## 확인한 범위

최종 npm run build는 macOS Node24에서 actual exit0이다. [최종 로그](../../runtime/evidence/C07-build2.log). 최초 build1의 Zod union omit 타입과 EffectState 이름 오류를 교정했고 원 실패 로그를 보존했다. 기능 시험·장애 주입·브라우저·NAS/Linux·native Windows·외부/API 연결은 수행하지 않았다.

[별도 검증 목록](C06-C10-verification-plan.md#c07)에 인수 항목을 유지한다. 세부 구현은 [게시판 등록](C07-board-host-progress.md), [아카이브](C07-archive-progress.md), [연결 계획](C07-integration-plan.md)에 기록했다. 다음 구현은 C07 공유 게시판의 원출처 연결이며 C08~C10 순서를 유지한다.
