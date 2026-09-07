# C04 등록 모델 사용 가이드

2026-09-07 · 현재 저장된 코드의 사용법이다. 이 문서를 작성하면서 명령을 실행하거나 설정을 바꾸지는 않았다. 첫 공통 빌드는 통과했지만 신규 시험은 41개 중 39개 통과, 2개 실패 후 교정·진단 중이므로 이번 단위의 검증 완료를 뜻하지 않는다. 실제 모델/API 시험은 계속 중단한 상태다.

담당 폴더에는 **등록 이름**을 저장하고, 실행 프로그램인 **호스트**가 그 이름에 해당하는 모델 객체를 제공한다. 현재 기본 예제 `local-contract-v1`은 정해진 시험 문구에만 응답한다. 실제 모델과 같은 구조화 요청·응답 경계를 거치지만 외부 모델에 연결하지 않는다.

## 1. 담당 설정과 CLI

예제는 지원하는 Node 24.20 이상, 25 미만과 현재 소스를 빌드한 `runtime/dist`를 전제로 한다. `/absolute/path/to/...`는 자신의 경로로 바꾼다. `runtime` 디렉터리에서 실행할 명령이다.

```sh
node dist/presentation/agent-cli.js init --directory /absolute/path/to/agent
```

담당 폴더의 `config.json`에서 기존 `model` 값만 다음과 같이 바꾼다. 아래는 **전체 설정 파일이 아니라 해당 필드의 예시**다. 기존 담당 ID, 설정 버전, 저장소와 기억 설정은 유지한다. 현재 `init --model-profile` 같은 설정 옵션은 없다.

```json
"model": { "profile": "local-contract-v1" }
```

`profile`은 등록표에서 찾을 정확한 이름이다. 경로·URL·가져올 모듈 이름으로 해석하지 않는다. `model: null`이거나 이름이 등록되어 있지 않으면 `registered` 실행은 `agent_turn_provider_unavailable`로 거절하며 다른 모델로 대체하지 않는다.

```sh
node dist/presentation/agent-cli.js chat session --directory /absolute/path/to/agent --provider registered

node dist/presentation/agent-cli.js chat ask --directory /absolute/path/to/agent --provider registered --message-id request-001 --text '[합성 주턴] 이 문장을 교정해 줘: 오늘 회의는 세시에 시작됍니다.'

node dist/presentation/agent-cli.js chat history --directory /absolute/path/to/agent --provider registered
```

`message-id`는 같은 입력의 재전송을 구분하는 번호다. 같은 요청의 재시도에는 같은 값을, 새 요청에는 새 값을 쓴다. 기본 대화 이름은 `terminal`이며 같은 담당·사용자·대화 이름으로 다음 작업을 이어간다. 반환된 `sessionId`를 `--session`에 주면 특정 대화를 다시 연다. `--new-session`은 새 대화를 만들며 `--session`과 함께 쓰지 않는다.

읽기 도구까지 포함한 고정 시험 문구는 `[합성 주턴] fixture.read로 doc-current를 읽고 보존기간을 알려줘.`다. 긴 대화에서 근거가 문맥에서 생략되면, 현재 적용된 이 요청에 한해 허용된 `core.evidence.get`으로 저장된 `doc-current` 근거를 다시 읽는 계획을 만들 수 있다. 과거 대화에 인용된 요청만으로 이 규칙이 동작하지 않으며, 조회 도구를 사용할 권한이 생기는 것도 아니다. 실제 조회와 결과 검증은 기존 실행기가 맡는다. 전체 고정 문구는 `chat help`에서 확인할 수 있고, 임의의 자연어는 이 로컬 예제의 지원 범위가 아니다.

| 선택 | 실제 동작 |
|---|---|
| `--provider registered` | `config.json`의 등록 이름을 호스트에서 찾는다. compact도 해당 등록 객체가 제공한다. |
| `--provider synthetic` | 기존 합성 주턴을 명시적으로 사용한다. 저장된 모델 이름을 선택하지 않는다. |
| `--provider synthetic --compact-provider synthetic` | 기존 합성 주턴에 합성 compact를 명시적으로 붙인다. |
| `--provider registered --compact-provider synthetic` | 서로 다른 선택을 혼합하므로 거절한다. |

한 실행에서는 제공자를 하나만 선택한다. `status --work <workId>`와 `history`는 모델 호출을 시작하지 않는다. `ask`, `followup`, `resume`은 실행 경로다. 접수 안내와 최종 답변·현재 상태를 구분해 표시하며, `--json`으로 구조화된 결과를 받을 수 있다. 이미 로컬 설치 경로에 등록한 `secumon-agent`가 있다면 위의 `node dist/presentation/agent-cli.js` 대신 그 명령을 사용할 수 있다.

## 2. Web 실행

```sh
node dist/presentation/web.js --directory /absolute/path/to/agent --provider registered --conversation web --port 0
```

서버는 `127.0.0.1`에서만 수신한다. `--port 0`은 사용 가능한 포트를 고른다는 뜻이다. 출력된 최초 연결 URL로 접속한다. 이 URL은 해당 로컬 작업실에 접근할 일회 권한이므로 공개 링크가 아니다.

등록 이름은 **서버를 시작할 때** 선택한다. 브라우저 요청 본문으로 모델 이름·코드 경로·권한을 주입할 수 없다. 화면을 닫는 것은 업무 취소가 아니며, 서버를 재시작한 뒤 저장된 업무를 진행하려면 명시적으로 다시 실행한다. CLI의 기본 대화 이름은 `terminal`, Web은 `web`이므로 같은 담당 폴더를 쓴다는 이유만으로 두 화면의 대화가 자동 합쳐지지는 않는다.

## 3. 호스트 프로그램에 연결하기

아래 TypeScript 예제는 **현재 `runtime/src` 아래에 호스트 진입 파일을 둔다고 가정한 소스 경로 예제**다. 배포된 SDK의 공개 import 경로를 약속하는 예제가 아니다. 패키지 공개·안정적인 exports·배포 계약은 C10에서 다룬다. 현재 `runtime/package.json`은 `private: true`다.

`AgentTurnHost`는 이름과 생성 함수를 묶는 등록표다. `open()`에 들어오는 정보는 담당 ID·목적·스킬 사용 방식이고, 생성 함수에 원문·저장소·실행 권한을 직접 넘기지 않는다. 실제 요청 전달은 이후 기존 런타임이 맡는다.

```ts
import type { AgentTurnHost } from './presentation/host-models.js';
import { createLocalContractHost } from './presentation/local-contract-model.js';
import { openAgentTurnProfile } from './presentation/agent-turn-profile.js';
import { runAgentTurnCli } from './presentation/agent-turn-cli.js';
import { openAgentWeb } from './presentation/agent-web.js';
import { closeAgentTurnResources } from './presentation/host-models.js';

// 정적으로 가져온 호스트 코드만 등록한다. config 값으로 import()하지 않는다.
const local = createLocalContractHost().models.get('local-contract-v1')!;
const host: AgentTurnHost = {
  models: new Map([['local-contract-v1', {
    execution: 'deterministic_fixture',
    async open(profile) {
      const opened = await local.open(profile);
      return {
        planner: opened.planner,
        inputLimits: opened.inputLimits,
        close: () => opened.close(),
      };
    },
  }]]),
};

async function inspectRegisteredModel(directory: string) {
  const opened = await openAgentTurnProfile(directory, { provider: 'registered' }, host);
  let failure: { error: unknown } | undefined;
  try {
    // 저장소와 모델 객체를 연 결과이며 모델 호출이나 연결 시험은 아니다.
    return opened.modelInfo;
  } catch (error) { failure = { error }; throw error; }
  finally { await closeAgentTurnResources([opened.close], failure); }
}

async function cli(directory: string) {
  // 함수 인수에는 바깥 명령인 'chat'을 넣지 않는다. 함수가 종료 자원을 정리한다.
  await runAgentTurnCli(['session', '--directory', directory, '--provider', 'registered'], host);
}

async function web(directory: string) {
  const opened = await openAgentWeb(['--directory', directory, '--provider', 'registered'], host);
  // 서버를 사용하는 동안 반환 객체를 보관하고, 호스트 종료 시 opened.close()를 호출한다.
  return opened;
}
```

호스트가 자체 연결을 제공할 때도 반환 계약은 `planner`, `inputLimits`, `close()` 세 부분이다. 모델 어댑터는 `StructuredAgentTurnAdapter`와 `StructuredSessionCompactAdapter`를 `StructuredAgentModel`로 묶어 재사용할 수 있다. 외부 transport를 실제로 호출하는 등록이라면 `execution: 'host_transport'`로 선언한다. 이름만 바꾸어 합성 실행을 실제 연결로 표시해서는 안 된다.

`close()`는 모델이 사용하는 자원을 정리하는 함수다. 상위 조립은 모델과 저장소, Web 서버의 정리를 이어서 시도한다. 실패 중 정리도 실패하면 최초 오류와 정리 오류를 함께 보존한다. 서버를 직접 연 호스트는 반환된 `close()`를 자기 종료 절차에 연결해야 한다.

## 4. compact와 입력 한도

**compact**는 오래된 대화 구간에서 필요한 내용을 요약하고 최근 원문과 이어 쓰는 과정이다. 원문 이력을 지우거나 개인 장기기억으로 자동 등록하는 기능이 아니다. `local-contract-v1`에는 주턴과 compact가 모두 들어 있다. 다른 등록은 `compact`와 `estimateCompactInput`을 둘 다 제공하거나 둘 다 생략할 수 있다. 생략하면 다른 합성 요약기로 자동 대체하지 않으며, 문맥이 한도에 도달하면 실행이 제한될 수 있다.

현재 `StructuredAgentModel` 조립은 두 어댑터의 **모델 신원**(provider/model/revision), 목적지와 실제 적용 능력값이 같아야 한다. `local-contract-v1`의 신원은 `synthetic / local-agent-turn-rules / registered-1`이고 목적지는 `local`이다. `registered-1`은 근거 재조회 규칙이 추가된 등록 예제를 기존 합성 규칙 버전 `1`과 구분한다. 등록 이름과 모델 신원은 서로 다른 값이다.

| 현재 로컬 등록 값 | 의미 |
|---|---|
| `maxInputBytes: 65_536` | 정규화한 전체 요청의 UTF-8 크기 상한. 원문뿐 아니라 고정 지침·스키마·도구 정의도 포함한다. |
| `maxInputTokens: 100_000` | 입력 추정값의 별도 상한. 현재 예제는 실제 tokenizer 없이 UTF-8 바이트 수로 보수적으로 추정한다. |
| `maxOutputTokens: 2048` | 호출 전에 확보하는 출력 공간. 주턴과 compact 양쪽에 적용하며 자동으로 줄이지 않는다. |
| `inputProfileDigest` | 호출 예약 당시 모델 능력·입력 추정·포장 버전을 고정하는 지문. 두 어댑터의 추정 메타데이터와 고정 프롬프트 변경을 반영한다. |

**지문**은 같은 설정인지 비교하기 위한 해시값이다. 모델이 정말 연결됐다는 인증서는 아니다. **preview**는 실제 호출 전에 넣을 문맥의 크기를 가늠하는 단계이며, 실제 전송 요청에 대한 최종 검사도 별도로 거친다. 입력 창 한도는 작업에 배정한 호출 수·토큰 자원 장부와 구분한다. 합성 전송의 사용량 0은 모델을 호출하지 않았다는 뜻이며, 입력 크기 검사까지 생략한다는 뜻은 아니다.

## 현재 범위와 아직 남은 부분

- `modelInfo`는 선택 방식·등록 이름·호스트가 선언한 신원·compact 제공 여부·실행 종류를 표시한다. 접속 성공, 실제 모델 성능 또는 사내 모델 호환성의 증거가 아니다.
- 현재 일반 입구의 정책은 로컬 사용자·목적지와 `fixture.read` 합성 자료, 기존 코어 자원·기억 도구를 중심으로 고정되어 있다. 등록 모델을 주입한다고 사내 권한·SIEM/EDR/MCP·Knox 도구 배치까지 연결되지는 않는다. 쓰기 허용도 자동으로 생기지 않는다.
- 구조화 파서와 기존 출처·현재성·사용량 장부를 이용하지만, 자유 문장 판단·요약 품질·실제 tokenizer 정확도는 검증하지 않았다. 실제 모델/API 시험을 재개한 상태가 아니다.
- 이번 문서는 native Windows 지원을 추가하지 않는다. 현재 파일 경계의 Windows 미연결 상태와 PostgreSQL 미구현 상태도 그대로다. 이번 등록 단위의 최종 로컬·Linux 검증 결과는 별도 확정 기록을 따른다.

현재 구현 위치: [호스트 계약](../../runtime/src/presentation/host-models.ts), [공통 조립](../../runtime/src/presentation/agent-turn-profile.ts), [로컬 등록 예제](../../runtime/src/presentation/local-contract-model.ts), [주턴·compact 묶음](../../runtime/src/infrastructure/structured-agent-model.ts), [CLI](../../runtime/src/presentation/agent-turn-cli.ts), [Web](../../runtime/src/presentation/agent-web.ts). 다음 범위와 검증 기준은 [등록 단위 계획](C04-registered-model-plan.md)을 참고한다.
