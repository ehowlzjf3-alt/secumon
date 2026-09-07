# C06 설치·초기화 구현 진행

2026-09-08. C06 → C10 기능 구현을 먼저 진행하고 상세 검증은 이후 통합 단계에서 수행한다. 이 문서는 설치 지원 완료나 배포 결과가 아니다. C05 추가 작업은 중단 상태를 유지한다.

현재 `runtime/package.json`에는 `secumon-agent` bin과 Node 24.20.0 이상/25 미만 조건이 있고, `agent-cli.ts`는 버전·기존 담당 상태·초기화·복구·복제 명령을 제공한다. 그러나 C01 초기화는 상태 저장소를 SQLite로 고정하며 패키지 포함 파일 목록도 지정하지 않았다.

이번 작은 변경은 다음과 같다.

1. `secumon-agent init --state-backend sqlite|file-journal`을 기존 C01 `initialize`에 전달한다. 기본값은 SQLite다. 첫 저장소를 열기 전에 최초 setup 의도와 config에 선택을 기록한다. 중단 setup은 저장된 선택을 따르고 명시 충돌은 거절한다. 기존 담당의 backend를 이 옵션으로 전환하지 않는다.
2. `AgentSetupOptionsSchema`와 기존 initialize operation의 선택 필드만 확장한다. 필드가 없는 옛 setup의 의미와 clone의 기존 config를 보존한다. 파일 경계·잠금·저장소 구현을 재작성하지 않는다.
3. 도움말·준비 완료 출력에서 상태 저장소와 개인 기억을 구분한다. 엔진 버전과 문서 개정 번호를 섞지 않는다.
4. 패키지에는 빌드된 제품 계층·guidance·설치 예제만 명시적으로 포함한다. 테스트·evidence·담당 자료를 설치 묶음에 넣지 않는다. 등록 모델/도구는 기존 신뢰된 host API를 사용한다.
5. 공통 엔진 밖의 두 담당 디렉터리를 준비하는 짧은 설치·배치 예제를 추가한다. 실제 SDK/사내 서비스 어댑터나 네트워크 연결 예제는 만들지 않는다.

소유 범위는 `agent-cli.ts`, `agent-profile-contracts.ts`, `file-agent-profile.ts`, package manifest/lock 및 신규 설치 예제다. root는 모델/도구/채널 조립을 별도로 담당한다. npm install/pack/publish·원격 접속·배포·API·시험·빌드는 여기서 실행하지 않는다. 최종 빌드는 root가 통합하여 수행하며 검증 대기 항목은 [C06~C10 검증 계획](C06-C10-verification-plan.md#c06)에 남긴다.

상태: 아래 기능 수정 완료, 실행 검증 전.

- `init --state-backend`를 C01 선택으로 전달하고 `repair --state-backend`는 저장된 선택 확인으로 제한했다. 옵션 생략 재개는 저장된 operation/config를 따른다. 새 file-journal 및 명시 선택은 initialize operation에 기록하며, 옛 필드 없는 setup과 기존 config는 계속 읽는다.
- `help` 명령과 준비 완료 출력에서 상태 저장소·개인 기억을 구분했다. 기존 `version`/`--version`과 엔진 `0.1.0`은 유지한다.
- package `files`를 제품 dist 4계층·최상위 fixture JSON·Web HTML/CSS·guidance·examples로 한정했다. `agent-turn-profile`의 기본 합성 읽기와 `local-profile`은 fixture JSON을 읽고, `web-server`는 현재 source 경로의 HTML/CSS를 제공하므로 이 assets도 포함한다. README와 package metadata는 npm의 기본 포함 대상이다. 버전/의존성/bin이 바뀌지 않아 `package-lock.json`은 수정하지 않았다. 레지스트리 공개를 막는 `private: true`도 유지한다.
- [두 담당 설치·배치 예제](../../runtime/examples/two-agents.md)를 추가했다. 실제 모델·도구 등록은 기존 host API를 재사용하며 예제는 원격 연결을 수행하지 않는다.

이번 담당이 실행한 빌드·타입 검사·시험·npm 설치/pack/publish·원격 접속은 없다. 이 상태를 설치·Linux/Windows 지원 또는 C06 전체 완료로 판정하지 않는다. root의 통합 빌드와 뒤로 미룬 설치/재접속 검증이 남아 있다.
