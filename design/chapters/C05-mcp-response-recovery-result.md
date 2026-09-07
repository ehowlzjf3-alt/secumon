# C05 단순 MCP 원응답 복구 — 구현과 검증 기록

<!-- C05-MCP-RECOVERY-NARRATIVE-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->

2026-09-07 · **지원 POSIX의 단순 MCP 저장 응답 복구를 검증했다. macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과.** 같은 소스·빌드에서 필수 8단계와 원로그 회수·정리를 완료했다. [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json). C05 전체와 C01–C10 목표는 미완료다. 실제 모델/API 시험은 중단 상태이며 합성 모델·로컬 MCP peer의 계약 인수를 실제 모델 품질이나 사내 서비스 운영 검증으로 해석하지 않는다. native Windows runtime/file 연결·검증, PostgreSQL 및 설치·운영도 남아 있다.

MCP 응답을 원문 저장소에 기록한 직후 프로그램이 종료되는 경우를 처리했다. 재개한 실행기는 같은 업무의 원응답과 영수증을 확인하고, 원래 시도의 결과로 수신·정산한다. 이 복구 경로에서 새 `tools/call`을 보내거나 시도의 소유자·기한을 바꾸지 않는다.

## 바뀐 흐름

```text
원래 실행: 예약 → 전송 기록 → MCP 호출 → 원응답과 영수증 저장 → 결과 수신 → 채택·정산
                                                ↓ 여기서 종료
재개 실행: 원 시도 확인 → 원응답·영수증·현재 권한 검증 → 결과 수신 → 채택·정산
                                                              ↓
                                          필요한 컴팩트 → 문맥 복원 → 다음 작업
```

이미 사용한 논리 도구 호출 수는 전송 때 기록한 1회를 유지한다. 복구 수신은 기존 사용량 기록을 완성하는 단계이며 새 호출을 배정하는 단계가 아니다. `received`는 결과를 받았다는 상태, `adopted`는 그 결과를 현재 업무의 근거로 채택했다는 상태다. 원응답이 저장되었다고 업무가 완료되는 것은 아니다.

## 재사용한 부분과 추가한 부분

| 구성 | 이번 변경 |
|---|---|
| MCP 원응답 저장 | 기존 envelope v1과 계약 지문을 유지했다. 원문을 선택·검증·가공하는 코드를 복원과 기존 결과 검증이 공유한다. |
| 도구 계약 | 선택적인 `restoreResult` 콜백을 추가했다. MCP가 아닌 도구도 같은 계약을 구현할 수 있다. |
| 복구 확인 객체 | `StoredToolResults`가 원 시도·원문·영수증·현재 상태를 검증한다. 발행한 실행기 안에서만 사용할 수 있고, 상태가 바뀌면 다시 검증한다. |
| 결과 수신과 정산 | 기존 `receive`와 `adopt`를 재사용한다. 일반 수신의 소유자 검사를 유지하며, 검증한 저장 응답에만 내부 복구 경로를 허용한다. |
| 진척 기록 | 과거 기한 만료의 실패 이력을 남기고, 복원된 근거가 실제 채택되면 별도 진척을 한 번 기록한다. |
| 재개와 컴팩트 | 첫 문맥 체크포인트를 만들기 전에 저장 결과만 수신·정산한다. 더 작은 컨텍스트 한도로 재접속해도 이 처리가 컴팩트보다 먼저 진행된다. |

구현: [코어 복구 검증](../../runtime/src/application/stored-tool-results.ts), [MCP 원문 검증](../../runtime/src/infrastructure/mcp-read-tools.ts), [실행기](../../runtime/src/application/execution-runtime.ts), [워크플로](../../runtime/src/application/workflow-runtime.ts).

## 실패와 동시 실행

- 원응답 영수증이 없으면 `stored_result_unavailable`, 증명 검증에 실패하면 `stored_result_recovery_failed`로 차단한다. 파일이 있다는 사실만으로 응답의 귀속을 추정하지 않는다.
- 이미 차단된 업무는 차단 사유를 유지한다. 명시적으로 재개한 뒤 저장 응답을 검증할 수 있다.
- 다른 실행기가 먼저 결과를 저장하면 같은 수신 영수증을 재사용한다. 원 호출과 정산을 중복하지 않는다.
- 복구 중 권한이나 상태가 바뀌면 오래된 확인 객체로 수신하지 않는다. 마지막 검증 콜백 뒤에도 실행 권한을 다시 확인한다.
- 이미 수신된 결과는 기존의 채택·거절 규칙으로 정산한다. 권한이 취소되었다고 측정된 사용량을 없애지 않는다.

## 현재 확인한 증거

| 검증 | 확정 결과 |
|---|---|
| 로컬 Node24 빌드·코어 타입·계층 검사 | 원 종료코드 0, [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json)의 원 로그·종료 기록과 동일 소스 확인 |
| 로컬 신규 5개 파일 | [55/55 통과 원로그](../../runtime/evidence/C05-mcp-recovery-new1.log) |
| 로컬 기존 관련 30개 파일 | [421/421 통과 원로그](../../runtime/evidence/C05-mcp-recovery-related1.log) |
| NAS Linux 신규 / 관련 | [55/55 신규](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/final/new-mcp-stored-result-tests.log) · [421/421 관련](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/final/related-existing-tests.log) |
| NAS Linux 전체 | [3,423/3,423 통과 원로그](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/final/all-tests.log) |
| NAS 필수 8단계 / 원로그 회수 | [모두 종료코드 0](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/final/result.json) · [9개 결과·로그 회수](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/final-collection.json) |

로컬과 Linux의 소스는 `7c5cd5006af1585384976447f317eb9ce49f2f1fe9683bb0d593ed62dc011a4b`, 빌드는 `1d8f4845eb2aacf325e2aff6245b36273f6e5b728fc4dd071c7dde33cac882e0`로 일치했다. 빌드 출력은 1,692개 파일이다. Linux 종료 관측은 `2026-09-07T12:02:55.086Z`이며 로컬 종료 관측의 의미는 원 stage 기록을 따른다. 이번 최종 소스의 전체 회귀는 Linux에서 수행했으며 macOS 전체 회귀를 추가 통과로 표시하지 않는다.

[정리 기록](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/cleanup.json)에서 관측 가능한 전용 경로의 소유 프로세스 0개와 SSH 종료를 확인했다. 접근 불가 peer·소유를 확정할 수 없는 관측은 기록대로 남으며 시스템 전체 프로세스 부재를 증명한 것은 아니다. SIGKILL·주입 I/O 경계 인수는 전원 장애 내구성 시험이 아니다.

새 인수 시험은 SQLite/file-journal 저장소, 실제 stdio MCP 프로세스의 강제 종료와 새 소유자 재개를 포함한다. 컴팩트 순서 시험은 실제 SQLite 세션 원문을 사용하며, 전송 응답과 컴팩트 답변은 정해진 값을 반환하는 시험용 구현이다. 실제 모델의 추론 품질이나 실제 사내 MCP 연결을 검증한 결과가 아니다.

MCP 최초 입구 연결 당시의 로컬 신규 30/30·관련 572/572·Linux 전체 3,368/3,368는 [이전 확정 기록](../../runtime/evidence/C05-mcp-linux-nas-20260907/verification.json)으로 보존한다. 이 수치를 이번 복구 시험 수에 합산하지 않는다.

## 남은 범위

이번 단위는 단순 읽기 응답의 복구다. 전송 뒤 권한이 바뀐 경우의 원응답·측정 사용량 보존 확대, MCP 서버 없이 일반 입구를 다시 여는 흐름, 일반 입구의 페이지·대기 복구는 후속 구현으로 남긴다. Windows, PostgreSQL, Knox와 실제 모델·사내 서비스의 운영 검증도 별도다.

현재 복구 확인 객체는 검증 시 원문과 영수증을 반복해서 확인한다. 이 비용을 없앴다고 주장하지 않는다. 다음 호출 효율 검토에서 현재성 검사를 유지할 수 있는 범위의 중복 읽기 감소를 측정한다. 원응답 시각과 상태의 `updatedAt`은 캡처·트랜잭션 준비 시각이며, 물리 저장장치의 기록 완료 시각을 증명하지 않는다.

실행·회수 절차는 [Linux 검증 준비 문서](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/README.md), 설계 선택은 [복구 계획](C05-mcp-response-recovery-plan.md)에 기록했다.

다음 제품 단위는 [전송 뒤 권한 변경과 원응답 보존](C05-mcp-sent-authority-plan.md)이며 아직 구현에 착수하지 않았다.
