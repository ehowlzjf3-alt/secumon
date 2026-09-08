# C09 상시 임무 제어 사용 안내

2026-09-09 · checkpoint397. 이 문서는 현재 호출 계약과 사용 범위를 설명한다. 실행한 검증과 결과는 별도 결과 문서에 기록한다.

## 무엇을 제어하는가

상시 임무는 새 사건을 관측하고, 접수한 사건마다 별도의 일반 업무를 만든다. 여기의 `workId`는 **상시 임무 제어 업무 ID**다. 이미 접수한 사건의 업무 ID와 구분한다.

| 명령·상태 | 의미 |
|---|---|
| `status` | 저장된 관측 상태와 현재 버전을 조회한다. |
| `pause` / `paused` | 상시 임무의 관측을 일시정지한다. |
| `resume` / `active` | 이후 관측을 다시 허용한다. `active`는 관측 루프가 실제 실행 중이라는 증거가 아니다. |
| `stop` / `closed` | 이 상시 임무를 종료한다. 종료된 임무에 새 재개 명령을 적용하지 않는다. |

조회·제어 명령은 임무 등록, source의 `poll`(새 관측 조회), 사건 업무 실행, 모델 호출을 자동으로 시작하지 않는다. 관측 실행은 호스트의 `tick` 또는 `drive` 호출이 담당한다. 이미 접수한 사건 업무의 일시정지·재개·취소는 해당 사건 업무의 일반 제어 입구를 사용한다.

## CLI

담당의 `missions` 기능과 신뢰할 호스트의 관측 source·모델 등록이 연결되어 있어야 한다. 기본 CLI에 명령을 입력하는 것만으로 이 등록이 생기지는 않는다. `--provider`는 `synthetic` 또는 `registered`를 명시한다. 모델 제공자를 열더라도 이 제어 명령에서 추론을 요청하지는 않는다.

다음의 `AGENT_DIRECTORY`, `CONTROLLER_ID`, `SESSION_ID`는 실제 담당 경로, 임무 등록 결과의 제어 업무 ID, 등록 당시 사용자 대화 ID로 바꾼다. `--conversation`도 등록 당시 대화명을 사용한다. 기본 대화명은 `terminal`이다.

```sh
secumon-agent mission status --directory "AGENT_DIRECTORY" --provider registered --work CONTROLLER_ID --session SESSION_ID --conversation terminal --json
```

응답의 `controlRevision`(현재 제어 버전)을 확인한다. 예를 들어 실제 조회값이 `0`이면 다음과 같이 일시정지한다.

```sh
secumon-agent mission pause --directory "AGENT_DIRECTORY" --provider registered --work CONTROLLER_ID --session SESSION_ID --conversation terminal --command-id pause-20260909-01 --control-revision 0 --json
```

응답이 끊겼으면 **위 명령 전체를 그대로 재전송**한다. 재시도하면서 요청 ID나 기준 버전을 새로 만들지 않는다. 이후 새로운 재개 의도에는 상태를 다시 조회하고, 새 `--command-id`와 그때 확인한 버전을 사용해 `pause`를 `resume`으로 바꿔 호출한다. 종료는 `stop`을 사용한다. `status`에는 `--command-id`·`--control-revision`을 넣지 않는다.

`controlRevision`은 0부터 시작하는 현재 버전이다. 내부 관측 claim(현재 처리권) 정리에서도 증가할 수 있으므로 사용자 명령 횟수로 해석하지 않는다. `stateRevision`은 제어 업무 전체 저장 상태의 버전이다.

## 원 명령의 적용과 현재 상태

제어 응답은 다음을 구분한다.

| 필드 | 의미 |
|---|---|
| `commandId` | 같은 제어 의도를 다시 찾는 요청 ID |
| `replayed` | 이미 저장된 동일 명령을 확인했는지 여부 |
| `appliedControlRevision` | 그 원 명령이 적용된 제어 버전 |
| `appliedStateRevision` | 그 원 명령이 저장된 전체 상태 버전 |
| `current` | 응답 시 다시 확인한 현재 상태 |

예를 들어 일시정지가 제어 버전 1에 적용되고 다른 명령이 버전 2에서 재개했다면, 옛 일시정지의 재전송 결과는 `replayed: true`, `appliedControlRevision: 1`, `current.controlRevision: 2`, `current.status: "active"`일 수 있다. 이 응답을 새 일시정지로 해석하지 않는다. 원 영수증은 보존하고 같은 프로세스의 취소 신호도 원 명령보다 전에 시작한 관측에만 적용한다.

새 요청의 기준 버전이 현재와 다르면 `resident_control_stale`, 같은 ID로 다른 내용을 보내면 `resident_control_conflict`다. 각각 최신 상태와 기존 요청 내용을 확인한다. `resident_mission_changed`, `journal_commit_unknown`, 통신 오류는 요청이 미적용됐다는 증거가 아니다. 같은 요청으로 원 기록을 다시 확인해야 한다. 단순 `status` 조회만으로 응답이 유실된 특정 명령의 처리를 확정하지 않는다.

## Web 화면과 API

일반 요청용 Web에서 호스트의 missions 기능이 연결되면 **상시 임무** 패널을 사용한다. 제어 업무 ID를 입력해 상태를 조회한 뒤 일시정지·재개·종료한다. 화면은 요청 접수 안내와 현재 상태를 표시한다.

인증된 로컬 Web 연결에서 사용하는 API는 다음과 같다. POST에는 기존 세션 쿠키·Origin·CSRF 헤더와 JSON Content-Type이 필요하다.

```http
GET /api/resident-missions/CONTROLLER_ID/status

POST /api/resident-missions/CONTROLLER_ID/commands
Content-Type: application/json
X-Work-CSRF: 현재 연결의 CSRF 값

{"commandId":"pause-20260909-01","expectedControlRevision":0,"kind":"pause"}
```

POST의 `expectedControlRevision`도 실제 직전 상태 조회값을 사용한다. body로 actor·policy·임의 session을 선택하지 않는다. 서버가 선택한 사용자 대화와 등록 당시의 **sessionId 및 binding 전체**를 비교한다. binding은 채널, 대화명, 수신자, 목적지, 담당 사용자의 연결 정보다. 현재 권한과 화면 공개 조건도 확인한다. 같은 담당이어도 다른 사용자 대화나 다른 채널의 등록을 자동으로 가져오지 않는다. CLI 연결로 등록한 임무를 Web 연결에서 쓰려면 별도 연결 설계가 필요하며, 현재 검사를 우회하지 않는다.

브라우저는 결과가 불명인 명령의 ID와 최초 기준 버전을 같은 탭의 메모리에 보관한다. **같은 요청 다시 확인**은 그 요청을 재전송한다. 상태 새로고침은 이 pending(처리 결과 확인 대기) 요청을 완료 처리하지 않는다. 현재 pending 보관은 탭·연결 수명 안에서만 제공되며, 새로고침·탭 종료·연결 초기화 뒤 복원은 구현되어 있지 않다. 서버의 원 명령 영수증은 별도로 남는다.

## 호스트 API와 남은 범위

선택된 사용자 연결을 전달하는 호스트 호출은 `driver.status(workId, sessionId)`와 `driver.control(workId, { commandId, expectedControlRevision, kind }, sessionId)`다. wrapper 생성 때 지정한 binding도 함께 검사한다. 기존 신뢰할 호스트용 `pause`·`resume`·`stop`은 유지되지만, 요청 ID가 없는 호출을 여러 프로세스의 재시도 계약으로 사용하지 않는다. wrapper의 `close()`는 실행 중 호출을 정리하는 수명 종료이며 저장된 임무에 대한 `stop`과 다르다.

다른 프로세스에서 받은 제어를 현재 진행 중인 poll에 즉시 전달하는 기능, 브라우저 pending 요청의 새로고침 후 복원, 실제 Knox 화면·전송 연결은 남아 있다. 저장 상태의 변경과 실제 source 실행·취소·사건 처리 완료를 구분해서 확인한다.
