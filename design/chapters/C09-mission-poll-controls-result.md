# C09 진행 중 관측의 제어 연결 결과 기록

2026-09-09 · checkpoint394 · 기준선 `ff3e2d8`. **현재 상태: 구현·로컬 검증 완료. 신규12개와 직접 관련37개, 고유49개 모두 통과했다.** 빌드・코어 타입 exit0, 구조 202개/위반0을 확인했다. 49개 결과는 모두 같은 최종 build1이며 실패·취소·건너뜀은 0이다. 직전 turn은 읽기 검토와 세 문서 초안 작성 뒤 사용량 한도로 중단했으며 소스 구현은 없었다. 이번에 구현을 재개했고, 앞선 checkpoint393의 구현·42개 통과·푸시 결과와 구분한다. C09 전체와 전체 goal은 미완료다. [계획](C09-mission-poll-controls-plan.md) · [사용 흐름](C09-mission-poll-controls-usage.md).

## 구현한 연결

- 선택적 `RuntimeServices.workCancellation`의 register/interrupt를 `composeRuntime`에서 기존 `ExecutionRuntime` 취소 등록에 연결한다. 같은 프로세스에서 코어 제어 명령이 실제로 새로 저장된 뒤 `MissionRuntime`의 진행 중 관측 대기를 `AbortError`로 중단시킨다.
- `MissionRuntime.refresh` 전체에 결합 신호를 전달하고 `finally`에서 등록을 해제한다. `beginClose` 이후 등록은 즉시 중단한다.
- resident 관측 pause/stop과 pending poll 중단을 연결했다. 명시 pause/stop은 기존 `resident_mission_changed` 오류 계약을 유지하며, 일반 업무의 refresh/tick은 `AbortError`, 호출자 취소는 기존 취소 경로를 따른다. 관측 중단 신호와 원 호스트 수명의 `cleanupSignal`을 분리했다. 원 권한이 유효할 때만 `finally`에서 자기 점유를 해제하며, 프로필 권한도 종료된 경우 원 점유와 영수증을 보존하고 임대 만료에 맡긴다. 이후 일반 tick의 paused/closed 반환 의미는 유지한다.
- 중단 뒤 늦은 성공·늦은 오류는 채택하지 않고 커서·원 사건·idle 횟수·원 기록을 보존한다.
- 관측 대기 종료와 실제 원천 callback 종료를 분리한다. 여전히 실행 중인 callback의 정리·drain은 원천 소유자의 수명으로 다루며 외부 프로세스 강제 종료로 표시하지 않는다.

위 연결과 신규 인수·직접 회귀는 같은 최종 build1에서 확인했다. 모든 빌드·시험은 종료됐으며 C09 전체와 전체 goal은 진행 중이다.

## 검증 상태

| 항목 | 현재 기록 |
| --- | --- |
| 현재 빌드·코어 타입·구조 검사 | build1/core1 exit0, architecture1 202개/위반0 |
| 신규 관측 중단 인수 | target1 12/12, 실패·취소·건너뜀0, 4,609.956167ms |
| 직접 영향 회귀 | regression1 37/37, 6개 파일, 실패·취소·건너뜀0, 32,144.989917ms |
| 같은 최종 빌드의 합계 | 신규12 + 관련37 = 고유49개 모두 통과 |
| 실패·교정·재실행 | 신규 시험 실패 없음. claim 해제 보완은 실행 전 소스 검토에서 발견·수정 |
| 현재 소스·산출물 | 같은 build1, 소스와 2,499개 컴파일 파일의 최종 지문 대조 일치 |

로컬 callback이 아직 실행 중인지, 관측 대기만 끝났는지, 원천 소유자의 drain까지 끝났는지를 나누어 관측한다. 로컬 응답 제어·예외 주입·fake clock·실제 프로세스 중단을 서로 대신하는 검증으로 쓰지 않는다. 실제 모델/API 시험 중단을 유지하며 이번 계획에 실제 사내/외부 서비스 호출은 포함하지 않는다.

[빌드](../../runtime/evidence/C09-mission-poll-controls-build1.log) · [코어 타입](../../runtime/evidence/C09-mission-poll-controls-core1.log) · [구조 검사](../../runtime/evidence/C09-mission-poll-controls-architecture1.log) · [신규 12개](../../runtime/evidence/C09-mission-poll-controls-target1.log) · [관련 37개](../../runtime/evidence/C09-mission-poll-controls-regression1.log) · [build1 소스](../../runtime/evidence/checkpoint394-build1-source.json) · [최종 대조](../../runtime/evidence/checkpoint394-final-source.json) · [체크포인트](../../runtime/evidence/checkpoint394.json).

build1 sourceDigest는 `dde99088d9c969910417c6eaa852ed11753efabe6a367d41bd8cd50d2679ded0`, filesDigest는 `c026b7eaaca325892ce509a36e96e30a51ebefc8b9d411f5a4855741947ce366`, 파일 수는 2,499다. 최종 대조에서 같은 소스·산출물임을 확인했다. 이번 고유49개에 이전 소스의 통과 수를 합산하지 않았다.

## 실행 전 소스 검토에서 확인한 보완

담당 종료·호출자 취소 시 자기 claim을 해제한 체크포인트 본문이 이전 본문과 같아질 수 있었다. 그러면 본문 기반 명령 ID도 같아 과거 명령의 중복으로 처리되고 현재 claim 해제가 반영되지 않을 수 있다. 시험 전에 실제 자기 claim을 해제할 때 기존 `controlRevision`을 증가시키도록 최소 보완했으며 새 필드는 추가하지 않았다. 신규 caller/driver-close 시험에서 실제 `claim: null`을 확인했다. 수정 전 실행 실패를 재현한 기록은 아니며 이번 신규 시험 실패는 없다.

## 확정한 범위 제한

즉시 신호 전달은 같은 프로세스의 실제 새 명령 저장 완료를 기준으로 한다. 제어 명령 저장 응답 불명과 다른 프로세스의 저장을 즉시 신호로 전달하는 기능은 미구현 후속이다. 프로세스 내 취소 등록을 재시작 후 유지되는 구독으로 취급하지 않는다. 이후 일반 tick의 기존 paused/closed 반환과 진행 중 일반 업무 관측의 `AbortError`, resident 명시 제어의 `resident_mission_changed`는 구분한다.

## 재사용하는 이전 결과와 남은 일

[checkpoint393](C09-mission-controls-result.md)의 42개는 당시 같은 최종 build2에서 실행한 업무/관측 제어 결과다. 과거 active 체크포인트 명령 ID를 재사용한 resume 결함과 `controlRevision` 수정 이력을 유지한다. 그 42개를 이번 소스의 검증으로 합산하거나 진행 중 poll의 즉시 중단 검증으로 바꾸어 표시하지 않는다.

파일 저널 `journal_commit_unknown` 오류 주입, 긴 사건 이력 조회 비용·과거 규칙 ID 재사용, 새 CLI/Web/Knox 제어와 기존 C05/C06/C10 잔여는 각각의 현재 상태를 유지한다. 현재 Linux/native Windows·실제 PostgreSQL·사내 MCP/Knox·외부 A2A·설치/운영·최종 통합은 이 단위의 완료로 표시하지 않는다.
