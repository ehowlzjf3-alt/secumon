# 공통 엔진 하나와 두 담당 디렉터리

구현된 설치·초기화 입구를 설명하는 예제다. 이번 변경의 패키지 생성·설치·실행 검증은 아직 하지 않았다. 실제 Linux/native Windows 설치 판정, 버전 전환·되돌리기·완전 오프라인 의존성 묶음은 C10 후속 검증 대상이다.

Node.js 24.20.0 이상, 25 미만이 필요하다. 이미 빌드되어 검토된 로컬 패키지가 있다면 다음 형식으로 설치한다. 경로는 실제 파일로 바꾼다. 현재 개발 패키지 이름/버전은 `long-horizon-runtime`/`0.1.0`이며 레지스트리 공개 릴리스를 뜻하지 않는다. `private: true`는 유지한다.

```sh
npm install --global /absolute/path/to/long-horizon-runtime-0.1.0.tgz
secumon-agent version
secumon-agent help
```

이 명령 예제는 실행하지 않았다. 일반 npm 패키지는 필요한 의존성을 설치할 수 있는 환경을 요구하며, tarball 하나만으로 네트워크 없는 설치를 보장하지 않는다. 패키지에는 빌드된 제품 계층, 기본 합성 실행 자료, Web HTML/CSS, guidance/예제가 들어가고 테스트·evidence·담당 자료는 포함하지 않는다.

두 담당은 설치 엔진 디렉터리 밖의 **서로 겹치지 않는 디렉터리**에 둔다. 상위 디렉터리는 먼저 준비한다. 아래는 Linux 셸 예제이며 Windows에서는 설치된 동일 명령에 해당 시스템의 절대 경로를 전달한다.

```sh
mkdir -p "$HOME/secumon-agents"
secumon-agent init --directory "$HOME/secumon-agents/research" \
  --name "자료 조사" --purpose "허용된 자료를 읽고 출처와 비교 결과를 정리" \
  --state-backend sqlite --personal-memory documents
secumon-agent init --directory "$HOME/secumon-agents/review" \
  --name "검토 담당" --purpose "허용된 근거에서 누락과 반론을 확인" \
  --state-backend file-journal
secumon-agent status --directory "$HOME/secumon-agents/research" --json
secumon-agent status --directory "$HOME/secumon-agents/review" --json
```

각 담당은 별도 ID/config/세션/개인 기억/업무 상태를 가진다. 작업 상태는 첫 담당의 `.secumon/runtime.sqlite`, 둘째의 `.secumon/state-journal`에 놓인다. `file-journal`을 선택해도 채널·세션 및 업무 근거 기억은 기존 SQLite를 사용한다. 개인 기억 `documents` 선택은 작업 상태 저장소와 독립이다.

기존 담당에 `init`을 다시 실행해도 ID나 저장소를 새로 만들지 않는다. `--state-backend`를 명시하면 기존 선택과 같아야 한다. 중단된 설정을 `repair --directory 경로`로 재개할 때는 저장된 최초 선택을 따른다. `repair --state-backend`는 그 선택을 확인하며 전환하지 않는다. 엔진 삭제·재설치와 담당 디렉터리 삭제는 별개 작업이다.

초기화는 업무를 접수하거나 모델을 호출하지 않는다. 목적 문구만으로 두 업무에 필요한 모델·도구·자료 권한이 생기지 않는다. 실제 배치 시작 프로그램은 기존 `AgentExecutionHost`의 정적 모델 등록표와 선택 도구 등록을 `openAgentTurnProfile`/`runAgentTurnCli`/`openAgentWeb`에 전달한다. 공통 엔진은 수정하지 않으며 실서비스 어댑터 구현은 이 예제에 포함하지 않는다. 각 담당 `config.json`의 `model.profile`에는 그 시작 프로그램이 등록한 이름을 선택한다.

선택 스킬은 담당별 `skills/catalog.json`과 해당 본문 파일로 배치한다. `skills.mode: "off"`이면 지침을 사용하지 않으며, `on-demand`도 등록된 파일만 조회한다. 기본 board/archive는 꺼져 있어 협업 설정 없이 한 담당으로 시작할 수 있다. 모델·도구와 스킬은 출처·허용 범위를 각각 설정해야 하며, 한 담당에 허용한 자료가 다른 담당에게 자동 공개되지는 않는다.
