# 일반 요청 흐름 사용과 현재 범위

2026-09-07 · 신규 100/100·관련 636/636, NAS Linux 전체 3,138/3,138 검증 완료. 실제 모델/API 시험은 중단 상태다. [결과](C04-general-turn-result.md).

이 진입점은 시나리오를 고르지 않고 원문을 받는다. 현재 제공자는 명시적으로 고르는 **합성 규칙 제공자**다. 정해 둔 시험 문구만 처리하며 자유로운 질문에 답하는 실제 모델이 연결된 것은 아니다. 제공자를 지정하지 않았다고 외부 모델이나 대역으로 자동 전환하지 않는다.

## CLI

현재 런타임의 지원 Node 24.20.0으로 빌드한 뒤 `runtime` 디렉터리에서 실행한다. 설치 명령 `secumon-agent`를 등록한 환경에서는 `node dist/presentation/agent-cli.js` 대신 그 명령을 쓸 수 있다. 담당 디렉터리는 엔진 소스 폴더 밖에 둔다.

```sh
node dist/presentation/agent-cli.js chat ask \
  --directory /path/to/my-agent --provider synthetic \
  --message-id request-1 \
  --text '[합성 주턴] 이 문장을 교정해 줘: 오늘 회의는 세시에 시작됍니다.'
```

같은 담당 디렉터리와 대화에서 다음 요청을 보낸다. 첫 업무의 사용량은 첫 업무에 남고, 다음 업무는 이전 대화 내용을 이어받는다.

```sh
node dist/presentation/agent-cli.js chat ask \
  --directory /path/to/my-agent --provider synthetic \
  --message-id request-2 \
  --text '[합성 주턴] 앞서 교정한 문장을 같은 형식으로 다시 보여줘.'
```

자료 읽기 시험 문구는 `[합성 주턴] fixture.read로 doc-current를 읽고 보존기간을 알려줘.`다. 기존 읽기 도구 한 번과 모델 주턴 두 번을 사용한다. 단순 교정은 도구나 가설을 만들지 않고 주턴 한 번으로 끝난다.

`chat help`에서 전체 시험 문구와 옵션을 볼 수 있다. `--mode auto|fast|deep`는 해당 업무의 진행 방식이며, 지속 대화를 지우는 옵션이 아니다. `--compact-provider synthetic`를 명시하면 검증된 기존 컴팩트 경로에 알려진 요청과 정확한 인용을 보존하는 규칙 제공자를 연결한다.

질문을 받으면 `chat followup --work 업무ID --goal-revision 1 --message-id 새입력ID --obligation 질문ID --text 원문`으로 답한다. `--obligation` 없이 추가한 입력은 질문을 자동 해결한 것으로 보지 않는다. 공통 `--directory`, `--provider`, 필요시 `--session`을 함께 지정한다. `resume`, `status`, `history`는 중단한 업무의 실행, 상태 조회, 원문 대화 조회다.

`message-id`는 접수 식별자다. 통신이 끊겨 같은 요청을 다시 보낼 때는 같은 ID와 같은 내용을 사용한다. 내용을 바꿀 때는 새 ID를 사용한다. 대화 ID는 문맥의 단위이고 업무 ID는 목표·계획·정산의 단위다.

## Web

```sh
node dist/presentation/web.js --directory /path/to/my-agent --provider synthetic --port 0
```

표시된 일회 접속 주소로 들어간다. 로컬 `127.0.0.1`만 수신하며, 합성 제공자 연결에서는 예제 선택 대신 원문 입력란을 사용한다. 접수 사실이 먼저 저장되고, 실행하면 질문이나 최종 답변을 보여 준다. 질문에 답을 저장하면 같은 업무를 이어 실행한다. 새 요청은 새 업무로 만들되 같은 대화 문맥을 사용한다.

HTTP 흐름은 실제 로컬 서버로 검증했다. 직접 브라우저 렌더링과 클릭 검증은 개발 Mac이 잠겨 있어 수행하지 못했다. HTTP 시험 통과를 화면 검증 통과로 표시하지 않는다.

## 저장과 확인

원문은 기존 세션 저장소에 먼저 접수된다. 업무의 `responseRequirement`는 최초 요청의 식별자와 본문 지문을 기록하고, `conversation.session`은 가장 최근에 적용한 입력을 가리킨다. 질문에 답하거나 컴팩트해도 최초 요청과 최신 입력을 각각 확인한다.

모델은 답변·질문·계획 중 하나를 제안한다. 계획은 기존 검사와 도구 실행을 거친다. 답변은 별도 본문과 평가로 기록한다. 자체 검토의 `missing`은 아직 부족한 요구, `counterarguments`는 검토한 반론이다. 부족한 초안은 다음 턴의 참고 자료로 유지하되 결과로 전달하지 않는다. 이전 초안 원본이 사라지거나 바뀌면 재사용을 거절한다.

답변이 있어도 미완료 작업, 필요한 사실 근거, 검토해야 할 입력·기억, 미해결 의무가 남으면 완료하지 않는다. 최종 전달 직전과 화면 조회에서도 원문·자료 범위와 현재 답변을 다시 확인한다. 자체 검토가 통과했다고 별도의 사실 관측을 만든 것으로 계산하지 않는다.

PostgreSQL, Windows 런타임 연결·실기 검증, 실제 모델 품질, 사내 MCP/Knox 연결, 독립 반론 에이전트 및 호출 비용 최적화는 해당 챕터에 남아 있다.
