# C10 복원 회복 패키지 적용 · checkpoint392 결과

최종 정리: 추출한 시험 fixture의 마지막 빈 줄만 제거하고 build4를 생성했다. 2,487개 컴파일 파일의 전체 지문이 시험한 build3과 정확히 같아 시험을 반복하지 않았다. 실행한60개 시험은 build3 기록이며 최종 소스·동일 바이너리 대조는 checkpoint392-final-source.json에 구분해 저장했다.

2026-09-08 · 기준선 `955b1de`. **현재 담당 보존 이동 → 선택 백업 복원 → 신원 재등록 → 새 외부 대조 → 원 업무 재개**를 연결하고 로컬에서 확인했다. 최종 build3의 대상14개·회귀43개와 별도 실제 SIGKILL3개, 고유60개가 모두 통과했다. C10의 실제 플랫폼·설치 경계와 전체 goal은 미완료다.

준비 패키지를 만들었던 checkpoint391에서 이어지는 구현이다. 현재 담당을 삭제하거나 두 이력을 합치는 대신, 원 디렉터리를 같은 부모의 새 보존 위치로 이동하고 선택한 전체 백업으로 원경로를 복원한다. 적용 결과는 `stage: "restored"`, `reconciliationRequired: true`다. 기존 외부 대조를 통과해야 원 업무를 재개할 수 있다.

## 구현과 재사용

- 기존 준비 패키지 검사로 전체 원문과 준비 지문을 확인한다. 적용 직전 현재 담당의 자료·신원 head·디렉터리 객체가 준비 기준과 같은지도 확인한다.
- 준비 패키지 옆 `<패키지>.apply/`에 원 intent, 부분 복원 기록과 완료 영수증을 보관한다. 원 담당에는 적용 중 표식을 먼저 게시해 일반 실행을 차단하고, 경로에 묶인 유지보수 lease와 신원 claim을 닫은 후 보존 이동한다.
- 네이티브 helper가 같은 부모의 원 디렉터리 객체를 확인하고 목적지를 덮어쓰지 않는 이동을 수행한다. 호환 helper가 없는 경우 표식을 쓰기 전에 거절하며 일반 rename으로 대체하지 않는다.
- 기존 `restoreAgentBackup`과 `rebindRestoredAgentHostIdentity`를 호출한다. POSIX의 일부 복사 중단은 원 복원 UUID별 별도 위치에 보존한 뒤 새 복원을 시작한다. 완료된 복원과 같은 rebind는 기존 원문·신원 대조를 재사용한다.
- `restore-recovery-apply`와 `restore-recovery-apply-status`를 공개 CLI에 연결했다. 상태 조회는 역사 기록이며 현재 외부 효과의 일치 여부를 확인하는 호출은 아니다.

선택 백업이 더 최신인지, 이력이 다른 이력의 연속인지 자동으로 추론하지 않는다. 이번 구현은 명시한 전체 snapshot 교체이며 원 이력의 자동 병합은 없다. 원백업·준비 패키지·이동한 현재 담당·부분 복원 원문은 보존한다.

## 검증 결과

| 실행 | 확인된 결과 | 기록 |
| --- | --- | --- |
| 최초 TypeScript build1 | exit2. 네이티브 디렉터리 context 생성자의 reference 초기화 타입 오류 | [원로그](../../runtime/evidence/C10-restore-recovery-apply-build1.log) |
| build2·첫 대상 실행 | 빌드 exit0. 대상12/14, 시험 기대값 문제2개 | [빌드](../../runtime/evidence/C10-restore-recovery-apply-build2.log) · [첫 시험](../../runtime/evidence/C10-restore-recovery-apply-target1.log) |
| 최종 build3·target2 | 빌드 exit0. **14/14**, API8개·CLI3개·네이티브3개, 실패·취소·skip0 | [빌드](../../runtime/evidence/C10-restore-recovery-apply-build3.log) · [최종 대상](../../runtime/evidence/C10-restore-recovery-apply-target2.log) |
| 최종 build3·regression1 | 실제 매치한8개 파일의 **43/43**, 준비11개·기존 복원 대조/신원26개·저장소6개, 실패·취소·skip0 | [원로그](../../runtime/evidence/C10-restore-recovery-apply-regression1.log) |
| 실제 프로세스 강제 종료 crash1 | **3/3**, 원 담당 보존 후·복원 후·rebind 후 SIGKILL와 동일 작업 재개, 실패·취소·skip0 | [원로그](../../runtime/evidence/C10-restore-recovery-apply-crash1.log) · [시험](../../runtime/evidence/C10-restore-recovery-apply-crash.test.mjs) · [worker](../../runtime/evidence/C10-restore-recovery-apply-crash-worker.mjs) |
| 코어 타입 core1 | exit0. 최종 application 코드와 동일하며 이후 교정은 infrastructure 생성자와 시험에 한정 | [원로그](../../runtime/evidence/C10-restore-recovery-apply-core1.log) |
| 계층 architecture1 | 검사202개·위반0 | [원로그](../../runtime/evidence/C10-restore-recovery-apply-architecture1.log) |
| Rust native build2 | macOS addon 빌드 exit0. POSIX `.node` 실제 이동·부모 디렉터리 fsync는 위 네이티브 시험에서 확인 | [빌드](../../runtime/evidence/C10-restore-recovery-apply-native-build2.log) |
| Windows check2 | target 컴파일 검사 exit0. Windows runtime 실행이나 DLL 실행 검증은 아님 | [원로그](../../runtime/evidence/C10-restore-recovery-apply-windows-check2.log) |
| 별도 file-journal·documents 공개 CLI | apply·status·retry 통과. 원문 보존·새 복원 번호·같은 적용 재사용·새 대조 필요 상태 확인 | [결과](../../runtime/evidence/C10-restore-recovery-apply-journal-cli3.log) · [실행 코드](../../runtime/evidence/C10-restore-recovery-apply-journal-cli.mjs) |

고유 시험 수는 **14+43+3=60**이다. 별도 공개 CLI 흐름을 이 숫자에 더하지 않는다. 최종 build3의2,487파일은 [최종 소스 대조](../../runtime/evidence/checkpoint392-final-source.json), 네이티브 원문·바이너리는 [native 대조](../../runtime/evidence/checkpoint392-native-source.json), 별도 강제 종료·CLI 실행 스크립트는 [시나리오 원문 대조](../../runtime/evidence/checkpoint392-scenario-source.json)에 묶었다. 전체 실행 기록은 [체크포인트](../../runtime/evidence/checkpoint392.json)를 따른다. 회귀 명령에 포함된 존재하지 않는 `agent-lifecycle.test.js` 패턴은 매치0개였으며 해당 파일의 검증을 주장하지 않는다.

## 실제 확인한 동작과 한계

원 업무의 완료 흐름에서는 적용 후 기존 외부 대조가 새 복원 번호·현재 신원으로 확인될 때까지 일반 실행을 차단했다. 대조 후 원 업무는 원문·영수증·사용량을 유지하며 답변·완료로 진행했고 전체 도구1회·합성 모델2회였다. 적용과 rebind 자체의 추가 모델·도구 호출은0회였다. 이것은 실제 로컬 파일 효과와 합성 제공자의 동작이며 실제 LLM의 판단 품질 증거가 아니다.

대상 시험의 phase callback 예외3개는 같은 프로세스에서 단계 직후 오류를 주입한 검사다. 별도의 SIGKILL3개는 실제 자식 프로세스를 원 담당 보존 후·복원 후·신원 재등록 후 종료하고 다른 프로세스에서 이어갔다. 원 intent, 해당 단계에서 이미 발급된 복원 nonce와 rebind head를 유지했으며, 확인 가능한 죽은 로컬 소유 lease만 복구했다. 적용 중 차단과 복원 후 새 대조 요구를 직접 확인하고, 대조 뒤 원 state를 열었다. callback 예외를 실제 강제 종료 증거로 바꿔 표시하지 않는다.

부분 복원 시험은 실제 파일의 일부 바이트를 쓴 뒤 실패시켰다. 실패 바이트와 원 pending 번호를 별도 디렉터리에 그대로 보존하고, 선택 백업에서 새 원경로를 복원했다. 네이티브 시험은 원 객체만 이동하는지, 이동한 원본 대신 새로 복원된 source를 다시 이동하지 않는지, 기존 목적지·잘못된 source/parent identity·금지 경로·다른 부모를 거절하는지 확인했다.

별도 공개 CLI는 file-journal 상태와 documents 개인 기억 저장방식의 전체 저장 구조를 적용·조회·재호출했다. 실제 로컬 외부 파일 쓰기1회·합성 모델1회를 유지하고 추가 실행은 없었다. `ordinaryExecution: "fresh_reconciliation_required"`로 새 대조가 필요함을 확인했다. 문서 기억은 파일과 저장 구조 보존 범위이며 실제 검색·회상 품질을 검증하지 않았다. 현재 빌드의 공개 `runAgentCli` 호출이며 설치된 별도 binary를 실행한 결과는 아니다.

## 실패와 교정 기록

최초 build1은 `HostDirectoryRetirement` context의 오류 경로가 생성자 reference 초기화 완료로 분석되지 않은 TypeScript 오류였다. 해당 경로를 명시적인 throw로 정리해 build2가 통과했다.

첫 대상 시험의2개 실패는 fixture의 `stored()` 조회가 생성한 SQLite SHM 파일을 선택 백업의 파일 목록과 비교한 기대값 문제였다. 제품의 기존 rebind는 이미 알려진 SHM 파일을 제외하고 원자료를 검사한다. 시험의 저장 자료 비교에서 같은3개 SHM 경로만 제외했으며 제품의 원문·DB 검사 범위를 줄이지 않았다. 시험 교정 뒤 build3과14개·회귀43개가 통과했다.

별도 CLI 첫 시도는 중복 변수 선언으로 실행 전에 SyntaxError가 났다. 둘째 시도는 복원 완료 표식의 파일명을 잘못 쓴 시험 비교가 실패했다. 실행 스크립트만 고쳐 셋째 흐름이 통과했다. [CLI1 원로그](../../runtime/evidence/C10-restore-recovery-apply-journal-cli1.log), [CLI2 원로그](../../runtime/evidence/C10-restore-recovery-apply-journal-cli2.log)를 보존한다. 이전 실패와 재실행을 최종 고유 시험 수에 중복 합산하지 않는다.

## 남은 범위와 다음 작업

재구성할 원자료가 없거나 `.apply` intent가 만들어지기 전의 불완전한 경로, 복원 nonce가 없는 부분 root는 자동 채택하지 않고 보존·거절한다. 가장 초기 표식 게시 전 중단의 회복과 설치 경계는 C10 후속이다. 같은 플랫폼의 namespace fsync·프로세스 강제 종료 검증을 실제 정전(power loss) 복구 보장으로 확대하지 않는다.

실제 Linux/native Windows 실행, PostgreSQL, 실제 모델/API·사내 서비스, 설치된 binary와 운영 배포는 이번에 검증하지 않았다. 플랫폼에 맞는 `.node` 바이너리 빌드·배치가 필요하며 기존 패키지 경로를 사용한다. 네이티브 모듈 없이 덮어쓰기 가능한 이동으로 대체하지 않는다.

다음 주 작업은 **C09 취소·목표 변경·일시정지·저널 응답 불명·이력 비용의 후속 검증**이다. C10의 실제 플랫폼·최초 중단·설치 경계, C05/C06 후속, 사내 연동·운영 배포·최종통합을 유지한다. 실제 모델/API 시험 중단과 전체 goal 미완료를 유지한다. [사용법](C10-restore-recovery-apply-usage.md) · [계획과 경계](C10-restore-recovery-apply-plan.md).
