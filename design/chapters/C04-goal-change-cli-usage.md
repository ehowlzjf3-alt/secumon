# C04 CLI에서 같은 업무의 목표 바꾸기

2026-09-07 · CLI 연결과 시험을 작성한 단계이며 통합 빌드·시험 결과는 아직 반영하지 않았다. 실제 모델/API 시험은 중단 상태다. 아래 명령은 사용 예시이며 이 문서 작성 중 실행하지 않았다.

`chat goal`은 현재 업무의 목표를 사용자가 명시적으로 교체하는 명령이다. 같은 담당·대화·업무를 유지하고 이전 원문, 근거, 시도와 사용량을 보존한다. 추가 설명은 `chat followup`, 같은 대화의 새 업무는 `chat ask`를 쓴다. 목표 변경은 남은 자원이나 마감 시간을 초기화하지 않는다.

## 상태 확인 후 변경

현재 저장소 최상위에서 실행하는 예시다. `node`는 Node 24를 가리켜야 한다. 전역 설치 명령의 배포는 C10의 별도 범위다. 실행 경로와 ID는 자신의 값으로 바꾼다.

```sh
SECUMON_AGENT="/path/to/agent"
SECUMON_SESSION="session-id"
SECUMON_WORK="work-id"

node runtime/dist/presentation/agent-cli.js chat status \
  --directory "$SECUMON_AGENT" --provider synthetic \
  --session "$SECUMON_SESSION" --work "$SECUMON_WORK"
```

출력의 **목표 버전**과 **제어 버전**을 다음 명령에 넣는다. 버전은 내용이 바뀌었는지 확인하는 번호다. 제어 버전은 실행 모드 등 실행 방침의 변경도 구분한다. `--json` 출력에서는 각각 `snapshot.goalRevision`, `snapshot.execution.revision`이다. 업무 저장 전체의 `snapshot.revision`과 혼동하지 않는다.

```sh
node runtime/dist/presentation/agent-cli.js chat goal \
  --directory "$SECUMON_AGENT" --provider synthetic \
  --session "$SECUMON_SESSION" --work "$SECUMON_WORK" \
  --message-id "goal-change-001" \
  --goal-revision 1 --control-revision 1 \
  --text '[합성 주턴] 이 문장을 교정해 줘: 오늘 회의는 세시에 시작됍니다.'
```

위 버전 `1`은 예시다. `synthetic`은 문서에 나온 고정 시험 문구만 처리하며 실제 모델의 자유 문장 이해를 뜻하지 않는다. 이미 등록된 모델을 쓰는 담당은 `--provider registered`로 선택할 수 있다. 기본 등록 `local-contract-v1`도 네트워크 없는 합성 전송이다. 모델 등록 설정은 [등록 모델 사용법](C04-registered-model-usage.md)을 따른다.

처음 접수한 변경은 “목표 변경을 접수했습니다”를 먼저 표시하고, 요청한 목표 버전의 다음 버전으로 기존 실행 흐름을 진행한다. 이후 실제 답변이나 질문, 완료·대기 상태를 표시한다. 접수 사실과 업무 완료는 별개다. `--steps N`은 이번 실행의 단계 수를 제한하며 기본 100, 최대 1,000이다. JSON 모드는 접수·실행·현재 상태를 한 결과로 반환한다.

## 모드·재전송·중단

- `--mode auto|fast|deep`은 선택 사항이다. 생략하면 최초 접수 당시의 모드를 유지한다. 생략을 `auto`로 바꾸어 전달하지 않는다. 현재 적용된 사용자 입력의 기준도 접수 서비스가 처음 저장하고 재전송에 재사용한다.
- `--message-id`는 한 번의 변경 요청을 식별하는 ID다. 같은 변경을 다시 보낼 때는 ID·원문·목표 버전·제어 버전과 명시했던 모드를 그대로 유지한다. 같은 ID에 다른 내용을 보내면 충돌로 거절한다.
- 이미 저장한 요청의 재전송은 `created: false`이며 업무를 다시 실행하지 않는다. 이미 더 새로운 목표로 넘어갔어도 옛 목표를 실행하지 않고 현재 상태를 보여준다. JSON에 `run`도 새로 넣지 않는다.
- 원문 저장 뒤 중단된 요청은 같은 ID로 재전송해 적용을 복구할 수 있다. 이 경우에도 기존 요청이므로 자동 실행하지 않는다. 상태를 확인한 뒤 아래 `resume`으로 현재 목표를 명시 실행한다. 목표 변경 후 실행만 중단되었을 때도 같은 방법을 쓴다.

현재 `fast`의 모델 호출 상한 2회는 같은 업무 전체에 적용된다. 예를 들어 합성 자료 읽기는 계획과 답변에 2회를 쓰므로, 그 뒤 목표를 바꿔도 빠른 모드에서는 추가 호출이 차단된다(`fast_model_budget_exhausted`). 새 목표에 `--mode auto`를 명시하면 실행 방식의 제한은 바뀌지만 이미 쓴 호출 수·원래 업무 자원 한도·마감 시간은 그대로다. 원래 한도에서 남은 만큼만 계속 사용할 수 있다.

```sh
node runtime/dist/presentation/agent-cli.js chat resume \
  --directory "$SECUMON_AGENT" --provider synthetic \
  --session "$SECUMON_SESSION" --work "$SECUMON_WORK" \
  --goal-revision 2
```

이 `2`도 상태 조회에서 확인한 현재 목표 버전으로 바꾼다. 최초 목표 변경 전 확인한 버전이 오래되었으면 새 변경은 거절될 수 있다. CLI는 긴 편집 화면의 시작 시점을 따로 저장하지 않으며, 명령을 처음 접수할 때의 최신 적용 입력을 기준으로 삼는다. Web 편집의 오래된 입력 기준 검사는 별도 입구에서 처리한다.

## 유지되는 경계

완료된 업무는 새 목표에 따라 다시 준비 상태가 될 수 있지만 취소·실패 업무를 임의로 되살리지 않는다. 이전 목표가 만든 모델 질문은 해당 질문의 원호출을 확인해 대체하며, 다른 자료 수집·효과 확인·정산 의무까지 면제하지 않는다. 기존 답변과 전달 이력은 남지만 새 목표의 답변으로 표시하지 않는다.

다른 담당·선택 대화·CLI 대화 경로의 업무는 조회·변경할 수 없다. 요청에 임의 권한이나 내부 목표 객체를 넣는 옵션도 없다. `goal`에는 `--goal-revision`과 `--control-revision`이 모두 필요하며 `--obligation`은 질문 답변용 `followup`에서만 쓴다.

현재 지원 경계는 기존 로컬 POSIX 실행기다. native Windows 실행, 실제 모델의 의미 판단·답변 품질, 사내 인증·도구·Knox 연결은 이 CLI 연결로 검증되지 않는다. 원 설계와 전체 인수 범위는 [명시 목표 변경 계획](C04-goal-change-plan.md), 앞선 근거는 [복합 조사 결과](C04-complex-turn-result.md)를 따른다.
