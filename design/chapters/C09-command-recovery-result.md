# C09 원 명령 복구 결과

2026-09-09 · checkpoint395 · 기준선 b783902. **구현·로컬 검증 완료.** 신규12개·관련95개, 고유107개가 같은 최종 build2에서 모두 통과했다(실패·취소·건너뜀0). C09 전체와 goal은 진행 중이다. [계획](C09-command-recovery-plan.md) · [사용 흐름](C09-command-recovery-usage.md).

## 구현한 행동

- 취소 등록에 실행이 시작한 상태 번호를 보유하고, 원 명령 게시 번호보다 이전 상태에서 시작한 실행만 중단한다. 모델·도구·컴퓨터 대조·임무 조회가 같은 기준을 사용한다.
- transact의 commandRevision은 중복에서도 원 명령의 번호다. 함께 반환되는 현재 업무 상태의 번호와 구분하므로, 과거 명령 재전달이 명시 재개 후 새 실행을 취소하지 않는다.
- 저장 호출 실패 때 정확한 명령 ID·입력 digest와 원 영수증을 확인해 중단 신호를 복구한다. 원 오류는 그대로 전달하고 원 세션 입력의 적용 정리는 기존 재개 경로가 담당한다. 영수증이 없거나 읽을 수 없으면 성공으로 바꾸지 않는다.
- Resident 관측 제어도 예정 checkpoint·원문·영수증·담당/세션/권한을 대조한다. 원 증명 조회 실패는 원 저장 오류와 함께 AggregateError의 원인으로 보존한다. 이미 일시정지된 상태의 재시도는 원 영수증 번호로 누락 신호를 복구하며 원 기록을 재작성하지 않는다.
- 정상·중복 처리에는 기존 거래에서 얻은 번호를 사용한다. 전체 이력 검색이나 명령별 영구 취소 목록을 추가하지 않으며 종료된 취소 등록은 해제한다.

## 실행한 검증

| 묶음 | 같은 build2 결과 |
| --- | --- |
| 신규 파일 저널 복구 | 12/12, 19,514.845375ms |
| 임무·관측·원 사건/ACK·지속 세션 회귀 | 43/43, 41,721.332209ms |
| 실행·모델 취소·세션 명령·컴퓨터 대조 권한 회귀 | 52/52, 19,544.938834ms |
| 합계 | 고유107개, 실패·취소·건너뜀0 |
| 빌드·코어 타입·구조 | build2/core2 exit0, 구조202개/위반0 |
| 최종 소스 대조 | source와 컴파일2,505파일 지문이 시험한 build2와 일치 |

실제 임시 파일 저널에 원 기록을 게시한 뒤 오류를 주입했다. pause/cancel/goal/input은 원 오류·pending 입력·원 이벤트·저널 원문을 보존하고, sessions.resume과 재열기 뒤에도 한 번만 적용됐다. 첫 영수증 조회 실패와 게시 전 실패에서는 신호를 임의로 보내지 않았고, 원 입력 재개 뒤 확정된 번호로 중단했다.

이미 적용된 inbox 재호출만으로 검증을 대신하지 않았다. 명시 재개와 새 조회 뒤 원 runtime.command 계약을 직접 재전달하고, 같은 ID에 다른 payload를 넣은 충돌도 새 조회를 중단하지 않는지 확인했다. Resident에서는 원 영수증 조회를 지연시킨 사이 별도 resume과 새 poll을 시작한 뒤, 이전 poll만 중단되고 새 claim·상태가 유지되는 것을 확인했다.

일반 프로필 시험은 실제 대상 record의 link 완료 뒤 같은 업무 디렉터리 fsync에 EIO를 한 번 주입했다. 이는 POSIX namespace 경계 시험이며 Windows에서는 해당 사례를 건너뛰도록 명시했다. 다른 신규 stage-hook 시험은 플랫폼 공통 경로를 사용하지만 이번 실행은 macOS arm64다. 실제 전원 차단·하드웨어 고장·SIGKILL 결과로 해석하지 않는다.

## 최초 오류와 교정

첫 core1은 resident read의 receipt nullable 타입 오류1개로 실패했다. 누락 영수증의 명시적 예외 분기로 기존 행동을 유지하며 교정했고 core2가 통과했다. 첫 build1은 pause/stop의 서로 다른 반환 타입에 대한 시험 helper 추론 오류1개로 실패했다. outcome의 unknown 타입을 명시했으며 시험 단언은 바꾸지 않았다. 첫 실행한 기능 시험은 모두 통과했다. 원 실패 로그를 보존한다.

core2 이후 제품 소스는 바뀌지 않았다. 구조 검사는 null 분기와 시험 타입 명시 이전 기록이며 import 관계가 같아 재사용했다. 메모리·SQLite·파일·PostgreSQL adapter의 중복 반환이 원 receipt.state라는 점은 현재 소스에서 확인했으며 실제 PostgreSQL 연결 성공을 뜻하지 않는다.

[신규12](../../runtime/evidence/C09-command-recovery-target1.log) · [임무43](../../runtime/evidence/C09-command-recovery-missions1.log) · [코어 관련52](../../runtime/evidence/C09-command-recovery-core-regression1.log) · [build2](../../runtime/evidence/C09-command-recovery-build2.log) · [core2](../../runtime/evidence/C09-command-recovery-core2.log) · [구조](../../runtime/evidence/C09-command-recovery-architecture1.log) · [최초 코어 오류](../../runtime/evidence/C09-command-recovery-core1.log) · [최초 빌드 오류](../../runtime/evidence/C09-command-recovery-build1.log) · [최종 소스](../../runtime/evidence/checkpoint395-final-source.json) · [체크포인트](../../runtime/evidence/checkpoint395.json).

## 남은 범위

다음은 C09 긴 이력/컨텍스트 조회 비용과 목표 변경 누적 시 과거 규칙 관리다. 다른 프로세스의 즉시 제어 전달과 resident 제어 UI도 남는다. 현재 bare pause(workId)는 새 의도이므로, 다른 호출자가 resume한 뒤 과거 요청임을 식별하는 명령 ID·예상 상태 API는 후속이다. 취소에 협조하지 않는 원천 callback의 강제 종료 기능은 추가하지 않았다.

C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저, C10 초기 복원 중단·플랫폼·설치·실제 PG·운영/최종통합 잔여를 유지한다. 실제 모델/API 시험 중단과 사내 서비스 연결0을 유지했으므로 실제 모델 품질·사내 MCP/Knox·외부 A2A·현재 Linux/native Windows·운영 배포는 미검증이다. 모든 빌드·시험은 종료됐다.
