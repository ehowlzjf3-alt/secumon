# 이전 실행기에서 새 엔진에 명령 전달

전역 `secumon-agent`가 가리키는 설치보다 담당이 고정한 엔진이 새 옵션을 지원할 때 다음 형태를 사용한다.

```sh
secumon-agent dispatch --directory ./agent1 -- chat ask --provider registered --message-id request-1 --text '요청 원문'
secumon-agent dispatch --directory ./agent1 -- status --json
```

첫 `--` 전은 담당을 선택하는 외곽 형식이고, 뒤는 선택된 엔진의 명령이다. 이전 실행기는 내부 옵션을 해석하거나 다시 조합하지 않는다. 위 registered 예시는 해당 담당에 모델 전송 구현이 호스트 등록돼 있어야 실행할 수 있으며 실제 모델 연결 시험 결과가 아니다.

- 외곽 `--directory`를 생략하면 현재 디렉터리가 담당이다. 내부 `--directory`를 생략하면 외곽 담당을 쓴다. 내부에 명시하면 같은 정규화 경로여야 한다. 같은 담당 ID를 가진 다른 복사 경로를 대신 허용하지 않는다.
- 실제 현재 디렉터리는 변경하지 않는다. 따라서 내부 입력 파일의 상대 경로와 사용자 원문은 원래 호출 위치/내용을 유지한다. `--` 자체나 옵션처럼 보이는 문자열을 text 값으로 넣을 때는 일반 CLI처럼 `--text=--help` 또는 셸 인용을 사용한다.
- `open/init/status`, `chat`, 담당에 연결된 `work`, `memory-migrate`는 지원한다. `lifecycle/repair/clone`, 중첩 `dispatch`, 독립 `work --data-dir/--state-backend`는 외곽 밖에서 기존 명령으로 실행한다. 명시 담당과 독립 저장 옵션을 함께 쓰면 기존 CLI의 충돌 오류가 적용된다.
- 내부 도움말과 version은 선택된 엔진이 처리한다. 선택 과정에서 담당의 profile/pin/등록과 필요한 fence를 검사한다. 없는 엔진·등록되지 않은 설치·바뀐 release는 다른 엔진으로 조용히 대체하지 않는다.
- 이 전달 방식은 새 `dispatch` 입구를 아는 실행기가 전제다. 그 입구 자체가 없는 과거 배포본에는 적용되지 않는다. 이후 내부 옵션 추가에는 외곽 입구 변경이 필요하지 않다.

선택 엔진은 현재의 유효한 pin을 다시 검사하며 다른 엔진으로 연쇄 전달하지 않는다. 같은 B를 가리키는 pin 이력이 두 프로세스 사이에 변경된 것 자체까지 거절하는 별도 원 head 증명은 없다. 엔진 검사와 OS의 파일 실행 사이를 같은 사용자로부터 원자적으로 보호하는 샌드박스가 아니다.

호스트 객체를 주입하는 프로그램용 `runAgentCli(args, hostOptions)`는 기존의 같은 프로세스 실행을 유지한다. `dispatch`는 설치된 CLI 입구의 기능이며 호스트 콜백을 다른 프로세스로 자동 복사하는 API가 아니다.

자동 최초 pin과 npm의 로컬 release 준비는 [다음 별도 계획](C10-initial-pin-plan.md)을 따른다. 기존의 등록·pin·백업·업데이트는 [사용법](C10-launcher-extensions-usage.md)을 재사용한다.
