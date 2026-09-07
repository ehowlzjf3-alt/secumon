# C03 D2 — MCP 단일 파일 관측 결과

2026-09-07 · 수거된 파일만 읽은 해석 · 제품 수정·추가 실행 없음

**이번 실행에서는 앞선 정체가 재현되지 않았다. 현재 증거로 MCP 코드를 수정할 근거는 없으며, 같은 build3의 전체 시험을 유한한 한 번의 실행으로 확인하는 것이 적절하다.** 단일 실행 통과를 앞선 정체의 원인 규명이나 수정 완료로 표시하지 않는다. 별도로 기록된 macOS 초기화 경합의 미확정 원인과도 합치지 않는다.

## 확인한 결과

- [result.json](C03-drafts-linux-nas-20260907/mcp-diagnostic1/result.json): Linux Node `v24.20.0`, 시작 `02:12:34.039Z`, 종료 `02:12:42.214Z`. `exit.code=0`, signal 없음, 강제 종료 사유·보낸 signal·runner 오류 없음.
- [원 TAP](C03-drafts-linux-nas-20260907/mcp-diagnostic1/mcp-read-tools.log): **28/28 pass**, fail/cancelled/skipped 모두 0, `duration_ms=8123.603573`. 앞선 로그에서 마지막 자연 완료 다음에 정의된 `file-journal: MCP error retains no result evidence`도 이번에는 자연 완료했다.
- 전후 pin은 동일하다: source `6ba26f7b1f070e6429c16644b5af2a196582613125bdcc71dba8fb529d9f2f92`, build files `b35876061e1db51fe1d97a6525db03c8d27cbfdfc2bb9acd3a98f9da483b5e53`, **1377파일**. 코드 수정으로 결과가 바뀐 실행이 아니다.
- 진단 명령은 한 파일, `--test-concurrency=1`, 명령행 `--test-timeout=30000`, 외부 deadline 120초였다. 원 시험 소스의 개별 timeout은 바꾸지 않았다. deadline은 발동하지 않았다.

## trace가 실제로 보여 주는 것

[328127.jsonl](C03-drafts-linux-nas-20260907/mcp-diagnostic1/328127.jsonl)의 설치 기록은 MCP `discover/call/close/shutdown`, artifact `put/get/exists`, 비동기 FS `rm/open` 관측이 활성화됐음을 보여 준다. FileHandle.close 단계도 기록됐다. 인자·본문·환경을 기록하지 않았다.

마지막 이벤트는 약 **8059.604ms의 정상 exit**다.

```json
{
  "exitCode": 0,
  "activeResources": ["PipeWrap", "PipeWrap", "PipeWrap"],
  "phases": [],
  "pendingFs": [],
  "omittedPhases": 0,
  "omittedFs": 0,
  "suppressedEvents": 2063
}
```

따라서 **이 종료 시점에 관측 대상의 미완료 phase/FS 요청은 없었다.** 남은 세 PipeWrap은 종류만 기록했으므로 각각 어떤 FD인지 단정하지 않는다. 이 프로세스는 실제 exit 0으로 끝났으므로 이번 실행의 종료를 막은 자원은 아니다. 이 결과를 미관측 자원까지 영구 누수가 없다는 일반 보장으로 확장하지 않는다.

로그는 **1997행**이다. 보통 이벤트 1996개 한도는 약 **3277.785ms**에 도달했고, 이후 2063개 이벤트는 의도적으로 기록하지 않았다. 최종 상태용 여유를 사용해 exit를 보존했다. phase/FS의 현재 상태 추적은 로그 한도 뒤에도 계속됐고, 해당 추적의 64개 상한에서 빠진 항목은 0이다. 후반 모든 호출의 상세 이력이나 최대 지연은 이 trace에서 복원할 수 없지만, 마지막 빈 상태는 실제 종료 관측이다.

20초 단회 snapshot은 실행이 먼저 종료되어 발동하지 않았다. 이 진단의 자기 `/proc` TID wchan/syscall/children 표본은 **없다**. 표본이 없다는 사실을 커널 대기가 없었다는 증거로 해석하지 않는다.

기록된 `ENOENT`, artifact get의 오류 code null, `mcp_authorization_denied`는 곧바로 정체의 원인 증거가 되지 않는다. 기존 시험에는 생성 전 존재 확인, 고의 원본 손상, 권한 변경 거절이 포함돼 있으며 해당 시험도 통과했다. trace가 인자를 생략했으므로 각 오류를 경로나 입력까지 특정하지 않는다. 이 실행에서 그 오류가 지속 대기나 비정상 종료를 만들었다는 기록은 없다.

## 앞선 실패와 비교한 한계

[앞선 all-tests 로그](C03-drafts-linux-nas-20260907/attempt-2/all-tests.log)는 해당 파일의 17개 자연 완료 이후, 약 336초에서 진단 목적으로 보낸 SIGTERM을 파일 실패로 기록했다. [개입 기록](C03-drafts-linux-nas-20260907/test-intervention-attempt2.json)은 이를 자연 assertion 결과와 구분한다. 이번에는 남은 11개까지 완료됐지만 두 실행 사이에 원인 변수를 분리한 실험은 없었다.

이번은 단독 실행이며 앞선 전체 실행의 다른 시험과 부하를 재현하지 않았다. preload도 Promise 관측용 microtask, 제한된 동기 로그 I/O와 async_hooks를 추가한다. 따라서 관측이 타이밍에 영향을 주지 않았다고 주장할 수 없다. 부하·Node 내부·FS·SDK·시험 gate 중 어느 하나를 원인으로 선택할 증거는 현재 없다.

전후 프로세스 관측에서 전용 root로 식별된 남은 프로세스는 없고 `directChildGroupAlive=false`다. 단, 같은 UID의 두 프로세스는 exe/cwd 읽기가 `EACCES`여서 범위가 unresolved로 남아 있다. 이는 NAS 전체의 모든 프로세스 부재를 입증한 결과가 아니다. [실행 전 기록](C03-drafts-linux-nas-20260907/mcp-diagnostic1/before.json)과 최종 result가 이 제한을 보존한다.

## 다음 판단

같은 build3의 **전체 시험 한 번**은 미완료 통합 검증을 마치고 원래의 병행 실행 조건을 다시 관측하기 위해 타당하다. source·의존성·시험 의미를 바꾸지 않고, 실행 전후 pin, 원 TAP, 유한한 전체 deadline 및 정체 시점의 자기 소유 프로세스 진단/정리 결과를 보존한다. MCP preload를 연결한다면 대상 파일에만 활성화하고 상세 로그가 초반에 제한된다는 점을 유지한다. 실제로 정체가 되면 20초 snapshot의 현재 phase/FS 목록이 다음 분기 근거가 된다.

다시 정체되면 저장한 phase/자원과 실패 지점을 바탕으로 다음 수정 단위를 정한다. 성공할 때까지 전체 시험을 반복하거나 강제 종료를 정상 pass로 만들지 않는다. 현재는 구체적 실패 경로가 없으므로 timeout 확대, 안전 검사 완화, MCP close/SDK 변경을 해결책으로 적용하지 않는다.
