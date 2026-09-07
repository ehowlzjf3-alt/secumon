# 담당별 저장을 유지하는 협업

설정의 `features.peers: true`는 직접 동료 도구를 켠다. `board`와 `archive`는 별도 선택이다. 켠 기능에 해당하는 호스트 등록이 없으면 담당을 열 때 설정 오류를 반환한다. 설정 파일이 임의 코드를 불러오지는 않는다.

신뢰된 시작 프로그램에서 먼저 수신자 프로필을 연 뒤 다음처럼 동일 엔진의 동료로 등록한다. 각 프로필은 서로 다른 담당 디렉터리를 사용한다. 아래 코드는 호스트 조립 예제이며 실제 모델 접속 시험을 실행한 기록이 아니다.

```ts
import { createRuntimePeerAgent } from '../dist/presentation/host-peers.js';
import { openAgentTurnProfile } from '../dist/presentation/agent-turn-profile.js';

// receiver는 별도 디렉터리에서 연 프로필이다. 모델 등록은 각 담당마다 다를 수 있다.
const peer = createRuntimePeerAgent({
  agentId: receiver.agentId, revision: '1', role: 'resident',
  scope: receiver.scope, policy: { ...receiver.policy, allowWrites: false },
  limits: receiver.limits, sessions: receiver.sessions, workflow: receiver.workflow,
});
const sender = await openAgentTurnProfile(senderDirectory, { provider: 'registered' }, {
  ...senderHost,
  peers: { async open() {
    return { peers: new Map([['reviewer', peer]]),
      allowedTools: ['core.peer.consult', 'core.peer.resume'],
      async close() {} }; // receiver 수명은 이 시작 프로그램이 관리한다.
  } },
});
```

일반 질문은 수신자 쪽의 발신 담당별 세션을 이어간다. 반론 요청과 임시 역할은 요청별 세션을 사용한다. 내부 응답은 `peer` 채널과 `local` 목적지로 저장한다. 사람에게 보내는 Knox 채널은 자동으로 선택하지 않는다. 모델이 사용할 도구·자료·쓰기 권한은 각 수신자 정책에서 별도로 정한다.

`core.peer.consult`의 review 요청은 현재 가설 ID를 받는다. 결과의 대안·판별 질문은 다음 가설 평가와 계획 수정을 위한 의견이며 독립 증거가 아니다. `core.peer.resume`은 같은 요청을 이어가며 새 담당이나 자원 배정을 만들지 않는다.

`core.budget.status/allocate/run/request/increase/return/revoke/reconcile`은 기존 작업 자원 장부를 사용한다. 명시 배정은 임시 업무에 사용할 몫을 예약한다. 수행자가 return으로 반환을 요청하거나 후원자가 revoke로 회수한다. 이미 실행한 호출의 사용량과 효과가 확인돼야 미사용 몫을 돌려준다. 담당 세션의 종료와는 무관하다. 추가 요청은 허가가 아니며 증액도 후원 작업의 원래 한도 안에서만 가능하다.

공유 게시판의 원자료 조회에는 `BoardWorkSourceRegistry`를 사용한다. 시작 프로그램이 각 프로필의 `boardWorkSource`를 소유자와 함께 등록하고 공통 `createLocalHostBoard({ ..., workSources: registry })`에 전달한다. 게시판 접근 범위와 읽을 담당 업무 범위를 호스트에서 명시 허용해야 한다. 등록 해제 후에는 해당 원자료를 새로 읽을 수 없다. 일반 개인 메모리 저장소와 대화 저장소는 합치지 않는다.

검증 항목과 아직 연결되지 않은 범위는 프로젝트의 `design/chapters/C06-C10-verification-plan.md` 및 구현 재개 기록을 따른다.
