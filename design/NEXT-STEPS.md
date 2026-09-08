# 다음 작업

2026-09-09 · checkpoint396 · 기준선 `eaddcca`. 새 목표에서 같은 관측 규칙 ID를 다시 사용할 수 있도록 현재 규칙 목록과 보존 이력을 분리했다. 과거 목표의 닫힌 mission 규칙은 현재 슬롯을 반환하고 원 사건·checkpoint·원 명령 영수증은 보존한다. 이전 source를 제거해도 새 목표 등록이 가능하며 현재 목표의 충돌·호스트 종료·자료 제한과 다른 provider의 슬롯은 유지한다.

memory/SQLite/file/PostgreSQL 원문 사건 페이지 조회를 연결했다. 제어 확인은 checkpoint 발행 뒤의 필요한 종류만 읽으며 완료 복구도 원 완료 뒤의 종료 기록을 제한해서 읽는다. 같은 증명 안의 발행 영수증은 재사용하지만 저장 직전에는 다시 확인한다. 파일 저널의 전체 원파일 읽기·해시 검사는 유지한다.

최종 코드에 대응하는 신규22개·관련121개, 고유143개가 통과했다. build2 최초21/22의 한 실패는 자료 제한이 먼저 업무를 차단하는 동작을 시험이 예상하지 못한 것이었다. 차단 거절과 실제 resume 후 세대 거절을 구분해 보완하고 build3에서 해당 파일6개를 다시 실행했다. 2,514개 컴파일 결과 중 해당 시험 JS/소스맵2개만 바뀌고 나머지2,512개는 같아 다른 시험을 반복하지 않았다. 원 실패 로그와 바이너리 대조를 보존한다.

최종 build3/core2 exit0, 계층202/위반0과 시험 후 소스 대조 일치다. 파일 페이지 시험의 반환은 410,032→8,548 bytes였고 두 조회 모두 원기록12개/422,489 bytes를 읽고 해시했다. 반환량 감소를 물리 디스크 I/O 감소나 모델 토큰 절감으로 표시하지 않는다.

[결과](chapters/C09-mission-history-result.md) · [사용법](chapters/C09-mission-history-usage.md) · [체크포인트](../runtime/evidence/checkpoint396.json) · [빌드 대조](../runtime/evidence/checkpoint396-build-comparison.json)

다음은 **C09 resident 제어의 안정된 명령 ID·예상 상태와 CLI/Web 입구**다. 다른 프로세스의 즉시 제어, 전체 세션 컨텍스트 비용과 동일 목표의 장기 사건 중복 확인/용량·보관도 남는다. C05 권한 재허용 완주, C06 기억 HTTP·권한·지연·브라우저, C10 초기 복원 중단·현재 Linux/native Windows·네이티브 설치·실제 PG·운영/최종통합 잔여를 유지한다.

이번 실행은 macOS arm64의 실제 임시 저장소·로컬 callback/결정적 대역이다. PostgreSQL은 SQL/바인딩을 기록하는 전송 대역 시험이며 실제 서버 연결이 아니다. 실제 모델/API 시험 중단·사내 서비스 연결0을 유지한다. 전체 C09/goal은 진행 중이고 모든 빌드·시험은 종료됐다. 완료 단위는 코드·문서·검증·남은 작업을 함께 커밋·푸시한다.

## 이전 기록 — checkpoint395

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint396을 따른다.

2026-09-09 · checkpoint395 · 기준선 `b783902`. 명령을 저장한 뒤 응답이 실패했을 때 원 영수증으로 중단 신호를 복구하도록 연결했다. 각 실행의 시작 상태 번호와 원 명령 게시 번호를 비교하므로 명시 재개 후 시작한 새 조회는 과거 명령 재전달로 중단되지 않는다. 현재 상태와 원 명령 상태를 분리하며 기존 세션 입력·원 사건·저널 원문·사용량을 보존한다.

같은 최종 build2에서 신규12개·임무 관련43개·실행/모델/세션/컴퓨터 대조 관련52개, 고유107개 모두 통과했다(실패·취소·건너뜀0). 실제 임시 파일 저널의 게시 전/후 오류, 첫 영수증 조회 실패와 원 입력 재개, 지연된 증명 확인 사이의 resume/new poll, 일반 프로필의 대상 namespace fsync EIO 주입·재열기를 확인했다. 실제 모델/API 호출은 없다.

build2/core2 exit0, 계층202/위반0, 최종2,505파일의 소스·컴파일 대조 일치다. 첫 코어 nullable 오류와 첫 빌드의 시험 helper 타입 오류를 교정했고 원 로그를 보존했다. 기능 시험은 처음 실행한 같은 최종 빌드에서 모두 통과했다. core2 이후 제품 소스·구조 검사 이후 import 관계가 같아 해당 검사를 재사용했다.

[결과](chapters/C09-command-recovery-result.md) · [사용법](chapters/C09-command-recovery-usage.md) · [체크포인트](../runtime/evidence/checkpoint395.json) · [최종 소스 대조](../runtime/evidence/checkpoint395-final-source.json)

다음은 **C09 긴 사건 이력/컨텍스트 조회 비용과 과거 규칙 관리**다. 다른 프로세스의 즉시 제어 전달과 resident CLI/Web/Knox 제어 입구의 명령 ID·예상 상태도 남는다. bare pause(workId)의 명령 ID 없는 호출은 새 의도로 처리하며, 다른 호출자의 resume 뒤 과거 요청임을 식별하는 계약은 후속이다. C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저, C10 초기 복원 중단·플랫폼·네이티브 설치·실제 PG·운영/최종통합 잔여를 유지한다.

이번 실행은 macOS arm64의 실제 임시 저장소·로컬 callback 시험이다. fsync 오류 주입을 하드웨어 고장·전원 차단·SIGKILL 시험으로 표시하지 않는다. 실제 모델/API 시험 중단과 사내/외부 서비스 연결0을 유지하며 모델 품질·현재 Linux/native Windows·실제 PostgreSQL·사내 연동은 미검증이다. C09와 전체 goal은 진행 중이고 빌드·시험은 모두 종료됐다. 완료 단위는 코드·문서·검증·남은 작업을 함께 커밋·푸시한다.

## 이전 기록 — checkpoint394

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint395를 따른다.

2026-09-09 · checkpoint394 · 기준선 `ff3e2d8`. 같은 프로세스에서 새로 저장된 업무 제어와 진행 중 원천 조회의 중단 신호를 연결했다. 업무 pause/cancel/목표·입력 변경은 관측 대기를 중단하고, resident 관측 pause/stop도 해당 controller의 조회만 멈춘다. 원 사건·커서·idle 횟수·영수증·지속 세션은 보존한다.

호출자 취소나 관측 드라이버 종료 때에는 원 호스트 권한이 살아 있는 경우에만 자기 작업 점유를 해제한다. 호스트 권한까지 종료되면 원 점유 기록을 남기고 임대 만료에 맡긴다. 원천 callback이 취소에 협조하지 않으면 callback 자체는 남아 있을 수 있으며, 그 종료·drain은 원천 소유 호스트가 담당한다.

같은 최종 build1에서 신규12개·직접 관련37개, 고유49개 모두 통과했다(실패·취소·건너뜀0). 실제 로컬 SQLite·일반 프로필, 원천 응답 미완료 상태의 중단, 늦은 성공/오류 폐기, 같은 런타임의 업무 격리, 재열기·명시 재개, 권한별 점유 정리를 확인했다. build/core exit0, 계층202/위반0, 최종2,499파일의 소스·컴파일 대조 일치다. 테스트 실행 전 소스 검토에서 찾은 점유 해제의 과거 명령 재사용 문제는 기존 controlRevision 증가로 수정했으며 신규 시험이 실제 해제를 확인했다.

[결과](chapters/C09-mission-poll-controls-result.md) · [사용법](chapters/C09-mission-poll-controls-usage.md) · [체크포인트](../runtime/evidence/checkpoint394.json) · [최종 소스 대조](../runtime/evidence/checkpoint394-final-source.json)

다음은 **C09 file-journal 저장 후 응답 불명과 제어 중단 복구**다. 원 명령 영수증을 확인하되 과거 명령 재전달로 새 작업을 잘못 취소하지 않도록 연결한다. 다른 프로세스의 명령 즉시 전달, 긴 이력/컨텍스트 비용·과거 규칙 관리, 새 CLI/Web/Knox resident 제어도 남는다. C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저, C10 초기 복원 중단·플랫폼·네이티브 설치·실제 PG·운영/최종통합 잔여를 유지한다.

메인 프롬프트는 현재 코드에서 구현과 모델 전송 어댑터 연결을 다시 확인했으며 재작성하지 않았다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지하므로 실제 추론·반론·대화 품질은 미검증이다. C09와 전체 goal은 진행 중이며 빌드·시험은 모두 종료됐다. 완료 단위는 코드·문서·검증 결과·남은 작업을 함께 커밋·푸시한다.

## 이전 기록 — checkpoint393

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint394를 따른다.

2026-09-08 · checkpoint393 · 기준선 `bf61a44`. C09의 관측 pause/resume, 사건 업무의 원 접수 귀속, 목표 변경 뒤 명시 재개, 개별 임무의 취소·목표 변경 마감과 일시정지 보존을 연결했다. 담당 신원·지속 세션·원 사건·영수증을 유지하며 관측 제어와 개별 업무 제어를 구분한다.

같은 최종 build2에서 신규11개·관련31개, 고유42개 모두 통과했다(실패·취소·건너뜀0). 실제 로컬 SQLite 담당, 명시 개인기억1개 보존과 다른 담당 조회 거절, 반복 pause/resume, 지연 poll 거절, 목표 변경 중단·명시 재개를 확인했다. 실제 모델은 호출하지 않았다. 최초 신규9/11의 두 실패는 재개 본문이 과거 checkpoint와 같아진 실제 제품 결함이며, 제어 변경 번호를 추가해 교정한 원로그를 보존했다.

build2·코어 타입 검사 exit0, 2,493개 컴파일 파일 대조 일치. 계층202/위반0은 import 관계가 같은 build1 검사를 재사용했다. 이번 SIGKILL·실제 Linux/native Windows·PostgreSQL·사내 MCP/Knox/외부 A2A·설치형 인수는 실행하지 않았다. 관측 pause/resume은 기존 호스트 API에 연결했으며 새 CLI/Web/Knox 명령을 추가한 것은 아니다.

[결과](chapters/C09-mission-controls-result.md) · [사용법](chapters/C09-mission-controls-usage.md) · [체크포인트](../runtime/evidence/checkpoint393.json)

다음은 C09의 **진행 중인 원천 조회에 실제 업무 제어를 연결하는 것**이다. 취소를 무시하거나 늦게 응답하는 원천에서도 드라이버가 계속 묶이지 않고 원 관측을 보존하도록 한다. 이어 file-journal 저장 후 응답 불명, 장기 이력/컨텍스트 조회 비용과 목표 변경 누적 시 과거 규칙 관리를 확인한다. C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저, C10 초기 복원 중단·플랫폼·네이티브 설치·실제 PG·운영/최종통합 잔여도 유지한다.

C09와 전체 goal은 진행 중이다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지한다. 모든 빌드·시험은 종료됐으며 완료 단위를 코드·문서·검증 결과·남은 작업과 함께 커밋·푸시한다.

## 이전 기록 — checkpoint392

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint393을 따른다.

최종 정리: 추출한 시험 fixture의 마지막 빈 줄만 제거하고 build4를 생성했다. 2,487개 컴파일 파일의 전체 지문이 시험한 build3과 정확히 같아 시험을 반복하지 않았다. 실행한60개 시험은 build3 기록이며 최종 소스·동일 바이너리 대조는 checkpoint392-final-source.json에 구분해 저장했다.

2026-09-08 · checkpoint392 · 기준선 `955b1de`. 준비한 전체 회복 후보를 실제 담당 경로에 적용하는 API·CLI를 연결했다. 기존 담당은 같은 부모의 새 경로에 원 디렉터리 객체로 보존하고, 선택 백업 복원과 기존 신원 재등록을 이어간다. 적용 중 차단 표식과 별도 진행 기록을 유지하며 완료 후에도 새 외부 기록 대조가 필요하다.

최종 build3의 신규14개·관련43개, 합계57개와 별도 실제 SIGKILL 재개3개가 모두 통과했다(고유60개, 실패·취소·건너뜀0). 별도의 file-journal+문서 기억 배치 공개 CLI 적용·조회·재시도도 통과했으며 60개에 합산하지 않았다. 원 업무 완주에서 도구 쓰기1회·모델 호출2회가 유지됐다. 복원 적용 자체의 모델·도구 추가 호출은0이다.

build3·코어 타입 exit0, 계층202/위반0, 최종2,487파일 대조 일치. 네이티브 최종 macOS build2와 Windows 대상 check2가 통과했으나 Windows 실행 결과는 아니다. TypeScript 소스·빌드뿐 아니라 Rust 소스·실제 로드한 바이너리·별도 시나리오 코드 지문도 기록했다. 최초 타입 오류와 시험의 SQLite 임시 파일/CLI 비교 오류를 보존하고 교정 뒤 최종 결과로 구분했다.

[결과](chapters/C10-restore-recovery-apply-result.md) · [사용법](chapters/C10-restore-recovery-apply-usage.md) · [체크포인트](../runtime/evidence/checkpoint392.json) · [네이티브 기록](../runtime/evidence/checkpoint392-native-source.json)

## 바로 이어갈 일 — checkpoint392 이후

다음은 **C09의 취소·목표 변경·일시정지**를 기존 세션·상시 임무와 연결해 확인하는 일이다. 이어서 저널 응답 불명·이력 비용, C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저를 검증한다. C10에서는 신뢰할 적용 intent나 복원 표식이 생기기 전의 가장 초기 중단, 현재 Linux/native Windows·실제 PostgreSQL·설치형 네이티브 배포·효율·운영/최종통합 인수가 남는다. 확인할 수 없는 디렉터리는 보존하고 자동 채택하지 않는다. 이력 병합 없이 명시한 전체 백업을 교체 적용한다.

메인 프롬프트 구현·연결은 유지하며 실제 모델/API 시험 중단과 외부 서비스 연결0을 지킨다. 실제 사내 MCP·Knox·외부 A2A와 모델 품질은 미검증이다. 전체 C10/goal은 진행 중이며 활성 빌드·시험은 없다. 완료 단위는 코드·문서·결과·남은 작업을 함께 커밋·푸시하고 원격 일치를 확인한다.

## 이전 기록 — checkpoint391

아래의 다음 행동과 상태는 당시 기록이다. 현재 순서는 위 checkpoint392를 따른다.

2026-09-08 · checkpoint391 · 기준선 `644c7f2`. 실패 복원본과 선택한 동일 담당·원경로의 전체 백업을 새 회복 폴더에 보존하는 준비·검사 API와 관리 CLI를 구현했다. 원 시도·영수증·결과·세션·사용량을 포함한 원백업을 복사하며, 기존 담당이나 원백업을 변경하지 않는다. 준비만으로 실행 차단이 해제되지는 않는다.

최종 build2에서 신규11개·관련26개, 고유37개 모두 통과(실패·취소·건너뜀0). 별도의 file-journal+문서 기억 배치 CLI 시나리오도 통과했으며 37개에 합산하지 않았다. 문서 기억은 배치 원문 보존 확인이며 기억 조회 품질 검증은 아니다. build2·코어 타입 exit0, 계층201/위반0, 최종2,466파일 대조 일치. build1의 테스트 타입 좁히기 오류와 수정 기록도 보존했다.

[결과](chapters/C10-restore-recovery-result.md) · [사용법](chapters/C10-restore-recovery-usage.md) · [체크포인트](../runtime/evidence/checkpoint391.json) · [최종 소스 대조](../runtime/evidence/checkpoint391-final-source.json)

## 바로 이어갈 일 — checkpoint391 이후

다음 필수 작업은 **준비 묶음의 실제 적용과 중단 복구**다. 현재 원자료 대조 → 호스트에 맞는 기존 담당 폴더 보존 이동 → 원경로에 선택 백업 복원 → 신원 재등록 → 새 외부 대조 → 일반 재개를 연결한다. 이력 자동 병합이나 준비 완료를 회복 완료로 취급하지 않는다. C09 취소·목표 변경·일시정지·저널/이력 비용, C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·설치/효율·운영 배포·최종통합도 남는다.

공통 메인 프롬프트는 구현돼 모델 전송 어댑터에 연결되어 있다. 이번에는 현재 소스를 확인했으며 재작성하지 않았다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지한다. 실제 모델의 추론·반론·요약·응답 품질은 미검증이며 전체 C10/goal은 진행 중이다. 활성 빌드·시험은 없다.

## 이전 기록 — checkpoint390

아래 상태와 다음 행동은 당시 기록이다. 현재 순서는 위 checkpoint391을 따른다.

2026-09-08 · checkpoint390 · 기준선 `158b82b`. 복원한 담당은 신원 재등록만으로 일반 실행을 재개하지 않는다. 호스트에 등록한 읽기 전용 소스의 외부 기록 대조가 끝나야 재개한다. 복원마다 고유 번호를 유지하고, 영수증 게시 중단은 원 기준·보고서를 다시 확인해 마무리한다. 미확인 외부 효과와 변경된 임시 게시의 원자료는 보존한다.

같은 최종 build1에서 대상26개(신규17개·기존 신원 복구9개)와 회귀46개, 고유72개 모두 통과했다. 실패·취소·건너뜀0, build1·코어 타입 검사 exit0, 계층200/위반0, 최종2,454파일 대조 일치다. sourceDigest `4dd367deb7d15c07123f67629c901b5cfa790fdb88dddf9f8fb2cf6517043721`. [결과](chapters/C10-restore-reconciliation-result.md) · [사용법](chapters/C10-restore-reconciliation-usage.md) · [체크포인트](../runtime/evidence/checkpoint390.json).

## 바로 이어갈 일 — checkpoint390 이후

C10에서 `unresolved` 또는 `agent_restore_reconciliation_recovery_required`로 남는 **누락 외부 원기록 가져오기·충돌 회복**을 다룬다. 실제 보존한 자료나 더 최신 원기록을 기존 외부 효과 복구와 연결해, 원 시도·권한·영수증·사용량을 보존하면서 회복할 수 있는 범위를 먼저 정한다. 임시 표식 삭제나 성공·정산 추정으로 불일치를 숨기지 않는다. 완료한 복원 대조·설치 준비·저장 형식 이행을 반복하지 않는다.

그다음 C09 취소·목표 변경·일시정지·저널 응답 불명·이력 비용, C05 권한 재허용 후 완주, C06 기억 HTTP·권한·브라우저 인수를 이어간다. 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·패키지 효율·운영 배포·최종통합은 남아 있다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지하며 전체 C10/goal은 미완료다. 활성 빌드·시험은 없다.

이 기록 시점에서 checkpoint390 커밋·푸시는 미완료다. 완료 단위의 코드·문서·결과·남은 작업을 함께 커밋하고 origin에 푸시한 뒤 원격 일치를 확인한다.

## 이전 기록 — checkpoint389

아래 다음 행동·미실행 표현은 당시 기록이다. 현재 작업 순서는 위 checkpoint390을 따른다.

2026-09-08 · checkpoint389 · 기준선 `53019cf`. 쓰기 가능한 저장소를 열기 전에 공통 읽기 전용 형식 검사를 연결했다. 정확한 버전 기록과 compact 저장 형식을 확인하고, 기존 SQLite 상태 1/2→3·지식 1→2 이행을 재사용한다. 신규 경계9개·실제 설치 A/B의 구형 저장 구조 통합 시나리오2개·관련 회귀109개가 통과했다. Node 집계에는 통합 묶음 상위 항목1개가 추가되며, 전체121개를 최종 소스에서 재실행한 것은 아니다.

최종 build3에서 선검사9개·문서 기억8개, 합계17개가 통과했다. 설치 통합은 build2의 상위 항목 포함3개이고, 관련109개는 build2의101개와 최종 build3의 문서 기억8개다. build3 exit0·2,433파일 대조 일치, 코어 타입 exit0·계층199/위반0은 안쪽 코어가 바뀌지 않은 build1 기록이다.

[결과](chapters/C10-storage-upgrade-result.md) · [사용법](chapters/C10-storage-upgrade-usage.md) · [체크포인트](../runtime/evidence/checkpoint389.json)

## 바로 이어갈 일

백업 복원 후 새 외부 실행에 앞서 필요한 확인이 빠졌는지, 기존 `agent-lifecycle`·`agent-host-identity-recovery`·`workflow`·`computer-reconciliation`의 복원 업무와 외부 효과 대조 경로부터 읽는다. 확인된 연결 공백만 다음 구현 단위로 정하며 완료된 설치 준비·저장 형식 이행을 반복하지 않는다.

그다음 C09 취소·목표 변경·일시정지·저널 응답 불명·이력 비용, C05 권한 재허용 후 완주, C06 기억 HTTP·권한·브라우저 인수를 이어간다. 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·패키지 효율·운영 배포·최종통합은 남아 있다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지하며 전체 C10/goal은 미완료다. 활성 빌드·시험은 없다.

완료 단위의 코드·문서·결과·남은 작업을 함께 커밋하고 origin에 푸시한 뒤 원격 일치를 확인한다.

## 이전 기록 — checkpoint388

아래 다음 행동·미실행 표현은 당시 기록이다.

2026-09-08 · checkpoint388. npm/개발 패키지에서 호스트 소유 설치본을 준비하고 그 실제 CLI로 새 담당의 첫 엔진 고정을 연결했다. 같은 원본의 두 담당은 설치본을 재사용하고 각자의 자료를 유지한다. 신규16개는 최종 build3, 관련·확장 기존32개는 build2에서 통과했다. 고유48개를 최종 소스에서 모두 재실행한 것은 아니다. 최종 build3 exit0·2,421파일 대조 일치, 코어 타입 exit0·계층199/위반0은 build2 기록이다.

[결과](chapters/C10-engine-preparation-result.md) · [사용법](chapters/C10-engine-preparation-usage.md) · [체크포인트](../runtime/evidence/checkpoint388.json)

## 바로 이어갈 일

다음은 기존 저장 형식 이행과 읽기 전용 호환 확인 코드를 확인한 뒤 백업→엔진 변경→최초 저장소 열기의 연결에서 빠진 부분을 정하는 일이다. SQLite 상태·지식 저장소의 기존 이행 코드를 재사용하며 완료된 설치 준비를 반복하지 않는다.

미확정 외부 효과·C09 종료/저널/이력 비용·C05 권한 재허용 완주·C06 기억 HTTP/권한/브라우저·현재 Linux/native Windows/실제PG/사내 연동·패키지 효율·운영/최종통합은 남는다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지하며 전체 C10/goal은 미완료다. 활성 build/test는 없다.

완료 단위의 코드·문서·결과·남은 작업을 함께 커밋하고 origin에 푸시한 뒤 원격 일치를 확인한다.

## 이전 기록 — checkpoint387

아래 다음 행동·미실행 표현은 당시 기록이다.

2026-09-08 · checkpoint387. 검증된 설치 release에서 새 담당의 최초 엔진을 자동 고정하고, 원 operation·ID·pin을 유지하는 중단 복구를 연결했다. 신규20개·관련79개, 합계99개가 같은 최종 build2에서 통과했다. 빌드·코어 타입 exit0, 계층199/위반0, 최종2,403파일 대조 일치다.

[결과](chapters/C10-initial-pin-result.md) · [사용법](chapters/C10-initial-pin-usage.md) · [체크포인트](../runtime/evidence/checkpoint387.json)

## 바로 이어갈 일

다음은 [자동 최초 pin 계획](chapters/C10-initial-pin-plan.md)의 npm/개발 패키지에서 검증 가능한 호스트 소유 release를 만들고 그 설치본을 실제 실행하는 연결이다. 기존 bundle/install/register와 고정 CLI 전달을 재사용한다. lock 파일 부재와 의존성의 실제 설치 위치를 구분하고, 원 tgz·상위 의존성·링크형 배치를 자동 지원한다고 가정하지 않는다. 기존 무핀 담당·clone·restore는 새 담당으로 재분류하지 않는다.

저장 schema 이행·미확정 외부 효과·C09 종료/저널/이력 비용·C05 권한 재허용 완주·C06 기억 HTTP/권한/브라우저·현재 Linux/native Windows/실제PG/사내 연동·운영/최종통합은 남는다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지하며 전체 C10/goal은 미완료다. 활성 build/test는 없다.

완료 단위의 코드·문서·결과·남은 작업을 함께 커밋하고 origin에 푸시한 뒤 원격 일치를 확인한다.

## 이전 기록 — checkpoint386

아래의 다음 행동·미실행 표현은 당시 기록이다.

2026-09-08 · checkpoint386. 고정 CLI 전달 형식과 실제 compact 세션의 설치 엔진 전환을 구현·로컬 검증했다. 신규4개·관련55개, 합계59개 통과다. 큰 A/B 및 회귀는 build1, 시험 격리만 보완한3개 재시험은 build2이므로 최종 소스 전체59개 재실행으로 표시하지 않는다. build2 exit0·최종2388파일 일치, core exit0·계층199/위반0은 제품 동일 build1 기록이다.

[결과](chapters/C10-launch-envelope-result.md) · [사용법](chapters/C10-launch-envelope-usage.md) · [체크포인트](../runtime/evidence/checkpoint386.json)

## 바로 이어갈 일

[자동 최초 pin 계획](chapters/C10-initial-pin-plan.md)에 따라 검증된 설치 release의 신규 setup→첫 pin→ready부터 구현한다. 이후 npm/개발 패키지를 호스트 소유 release로 준비하는 연결을 붙인다. 기존 무핀 담당·clone·restore는 자동으로 새 담당 취급하지 않는다.

저장 schema 이행·미확정 외부 효과·C09 종료/저널/이력 비용·C05 권한 재허용 완주·C06 기억 HTTP/권한/브라우저·현재 Linux/native Windows/실제PG/사내 연동·운영/최종통합은 남는다. 실제 모델/API 시험 중단과 외부 연결0을 유지하며 전체 C10/goal은 미완료다. 활성 build/test는 없다.

완료 단위의 코드·문서·결과·남은 작업을 함께 커밋하고 origin에 푸시한 뒤 원격 일치를 확인한다.

## 이전 기록 — checkpoint385 이하

아래의 다음 행동·미실행 표현은 당시 기록이며 위 현재 계획을 우선한다.

2026-09-08 · checkpoint385. 동일 전역 입구에서 담당별 등록 엔진을 선택하고 공통 확장 호환을 검사하도록 연결했다. 같은 build2 소스에서 신규26개·관련161개, 총187개 통과·코어 타입 exit0·계층199개/위반0. 실제 설치 B로 기존 업무를 재개했고 도구 호출은1회로 유지했다.

[결과](chapters/C10-launcher-extensions-result.md) · [사용법](chapters/C10-launcher-extensions-usage.md) · [체크포인트](../runtime/evidence/checkpoint385.json). 실행 중인 빌드·시험은 없다. 완료 단위를 문서/결과/미완료 항목과 함께 커밋하고 origin에 푸시한다.

## 바로 이어갈 일

1. [C10 고정 전달 형식과 compact 세션의 버전 전환](chapters/C10-launch-envelope-plan.md). 구 입구는 담당을 선택하는 외곽 형식만 읽고 새 옵션은 선택 엔진이 해석하게 한다. 같은 실제 A/B로 compact된 세션·원 이력·기억·후속 업무 연속성을 확인한다.
2. 신규 setup 완료 전에 최초 pin을 고정한다. npm/개발 경로는 원본을 수정하지 않고 호스트 소유 release를 준비한다. 중단/동시성을 다루고 기존 무핀 담당·clone·restore와 구분한다.
3. C10 저장 schema 이행·미확정 외부 효과·복원/패키지 효율·현재 Linux/native Windows·실제PG·운영 및 최종통합.
4. C09 취소/목표변경/일시정지·저널 응답 불명·이력 비용, C05 권한 재허용 이후 완주, C06 기억 HTTP/권한/브라우저 인수를 유지한다.

실제 모델/API 중단을 유지한다. 사내 MCP/Knox/외부 A2A·실제 PostgreSQL과 운영 배포는 로컬 대역/선언 검사와 구분한다. 자동 최초 pin과 구 입구가 모르는 옵션 전달은 이번 구현에 포함되지 않았다. 전체 C10/goal은 미완료다.

## 이전 기록 — checkpoint384 이하

아래의 다음 행동·미실행 표현은 해당 시점의 기록이며 위 현재 계획을 우선한다.

2026-09-08 · checkpoint384. C10의 실제 코드가 다른 두 호환 시험 release 설치/전환과 기존 업무 재개를 확인했다. 신규3개·관련11개, 합계14개가 통과했다. build1 통합1/관련11, build2 교정2의 소스별 기록이며 전체14개를 최종 소스에서 재실행한 것은 아니다. 제품 코드는 재사용했고 신규 시험과 문서를 추가했다.

완료 단위의 코드·문서·검증 결과·남은 작업을 함께 커밋하고 origin에 푸시한다. [저장소 규칙](../AGENTS.md).

## 바로 이어갈 일

1. **C10 전역 실행기와 확장 호환 연결**: [전환 계획의 후속 절](chapters/C10-version-transition-plan.md)을 따른다. npm 전역 입구에서 담당별 pin으로 엔진을 선택하는 연결, 공유 확장 API 호환 선언과 기동/check/pin/update 검사를 구현한다. 설치 B를 명시 실행한 이번 시험을 이 두 기능의 완료로 세지 않는다. 기존 등록 캡처·권한·부분 정리·wire/data 버전 계약을 재사용한다.
2. C10의 저장 schema 이행·compact된 세션 전환·미확정 외부 효과 대조, 현재 Linux/native Windows·실제 PostgreSQL·운영 설치/registry·최종 통합을 [별도 인수](chapters/C06-C10-verification-plan.md)로 이어간다. 오프라인 묶음의 개발용 의존성 복사 비용도 검토한다.
3. C09 완료 복구34개 범위 이후의 취소·목표 변경·일시정지 의미, 파일 저널 응답 불명 주입, 장기 사건 조회 비용을 확인한다.
4. C05 정책 재허용→명시 resume→저장 수집 결과 소비의 완주를 확인한다.
5. C06 개인 기억 HTTP 지연·권한/기억 전용 허용 사용성과 실제 브라우저 렌더링을 확인한다. 실제 사내 MCP/Knox/외부 A2A는 로컬 대역과 구분한다. 실제 모델/API 중단을 유지한다.

## 이번 확인 범위

설치 A의 원 사용자 입력·명시 개인 기억·미완료 조회를 보존하고 check→pin→backup→B update→동일 신원/세션/기억 재열기→B CLI 원 업무 resume을 실행했다. 실제 B formatter 표시를 확인했고 모델1→2회·도구1→1회로 조회를 반복하지 않았다. SQLite와 file-journal+documents의 백업/lease/호환 거절, 현재 자료 백업을 요구하는 엔진 되돌리기와 자료 보존도 확인했다.

최종 build2 exit0·Node v24.20.0 darwin arm64·2,343파일 대조 일치, sourceDigest ceb819314182bc90259dab9a79c636fc31a6dff2ab276068c3af57e70702cd2a다. core1 exit0·구조198개/위반0은 build1 기록이며 이후 제품 변경 없이 경계 시험 한 파일만 교정했다. [결과](chapters/C10-version-transition-result.md) · [체크포인트](../runtime/evidence/checkpoint384.json) · [소스 대조](../runtime/evidence/checkpoint384-final-source.json).

최초 신규 실행은 통합1통과/경계2실패였다. 후자의 SQLite SHM/빈WAL 비교를 교정한 build2에서2/2를 확인했다. DB본문·내용 있는WAL·원문·pin 비교는 유지한다. 현재 제품 코드와 실제 통합 fixture는 build1 뒤 바꾸지 않았다.

C10과 전체 goal은 진행 중이며 활성 빌드·시험은 없다. 메인 프롬프트는 구현·연결돼 있으나 실제 모델 품질은 미검증이다.

직전 checkpoint383의 완료 복구34개는 [결과](chapters/C09-mission-terminal-recovery-result.md), checkpoint382의 독립 담당 비교/결합115개는 [해당 결과](chapters/C09-integrated-trials-result.md)에 보존한다. 이번14개와 합쳐 최종 전체 재실행으로 표시하지 않는다.

아래는 앞선 checkpoint381 사건/상시 담당 단위의 기록이다. [결과](chapters/C09-missions-ordered-result.md) · [체크포인트](../runtime/evidence/checkpoint381.json).

- C09 신규44개: 원천5개는 build2, 협업 집계6개·임무 진전6개·접수 직후 실제 SIGKILL 복구1개는 build3, 호스트 등록6개는 build4, 임무 runtime9개·일반/상시 입구6개·읽기 확인/완료5개는 build6에서 통과했다. 직접 관련91개는 build3 기록이다.
- 최종 build6·core3 exit0, 구조196개/위반0·target5 20/20이다. sourceDigest 5b49e467fc9dd617a01d5f6d005524aa7e6f6c974e21148d33a4706e8ebfd064, [대조 기록](../runtime/evidence/checkpoint381-final-source.json) 2,295파일 일치다. 전체135개를 최종 소스에서 다시 실행한 것은 아니다.
- 일반 목록→원문→답변이 기본 무진전 한도3에서 도구2회·로컬 시험 모델3회로 완료됐다. 실제 채택한 원문 조회의 알림만 확인 처리하고 원문·다른 알림을 보존한다. 실제 완료 영수증→종료 체크포인트/점유 해제→reopen과 오염 영수증 거절을 확인했다. 읽은 내용을 독립 근거나 개인 기억으로 자동 승격하지 않는다.
- 같은 세션의 사건별 업무·담당별 저장소 분리, 재전달·compact/reopen과 접수 직후 실제 SIGKILL 복구를 확인했다. 현재 협업 비교는 기록된 fixture 원장의 집계만 검증했고 실제 모델의 협업 품질을 평가하지 않았다.

아래는 앞선 checkpoint380 A2A 단위의 기록이다. [결과](chapters/C09-a2a-ordered-result.md) · [체크포인트](../runtime/evidence/checkpoint380.json).

- A2A 신규39개: 전송18개는 build3, 일반 입구5개·호스트 등록10개는 build4, 준비 진전6개는 build5에서 통과했다. 첫 접수에서 모델 실행0→명시 실행→원 결과 조회, 재전달·caller 격리·후속 질문·취소를 확인했다.
- 직접 관련59개: 예산 도구 입구6개는 build3, 공통 진전53개는 build5다. 최종 build5 exit0, sourceDigest `37894d96703ada4ff913021bb32d165cfc1b35fa21f34814550631d9ae9bc325`, [대조 기록](../runtime/evidence/checkpoint380-final-source.json) 2,256파일 일치다. 코어 타입 exit0·구조195개/위반0이며 전체98개를 최종 소스에서 다시 실행한 것은 아니다.
- 엄격한 A2A 입력 계약, 등록/전송 수명과 늦은 응답, 조회/취소의 원 task ID 검사를 교정했다. native A2A 준비 진전으로 실제 send→plan→get을 연결하되 동일 요청·응답 반복은 기본 무진전 한도3을 초기화하지 않는다. 준비 진전은 독립 근거나 목표 완료가 아니다. 앞선 실패·진단과 시험 교정은 보존했다.

아래는 앞선 checkpoint379에서 마친 경계다. 당시 게시 전 기준선은 3d75c031이다. [결과](chapters/C08-remaining-boundaries-result.md) · [체크포인트](../runtime/evidence/checkpoint379.json).

- 후속 신규5개: 명시 반환 전/부분 실행 뒤 정산·새 배정2개, 실제 세션 요약·활성 요청 재접속2개, 접수 후 실제 SIGKILL과 원 ticket의 명시 재개1개. 제품 변경 없이 시험 기대값과 시험용 모델의 자원 배정 계산을 교정했다.
- 공유 fixture 직접 영향11개도 통과했다. 신규4개는 build3, SIGKILL1개와 영향11개는 build2 기록이다. 소스별 결과를 최종 한 소스의 전체 재실행으로 합치지 않는다.

아래는 앞선 checkpoint378에서 마친 연결이다.

- 동료: 독립 담당의 양방향 상담, 사용자별 상주 세션과 요청별 임시/검토 세션, 반론 후 자체 판별 관측·재평가, compact/reopen 뒤 원 ticket·예산 재사용.
- 내부 전달: peer/local의 원 세션 답변, 같은 전달 ID의 세션·담당 변조 거절과 원문·대화 불변. 새 ID까지 재발급하는 신뢰된 호스트의 모든 오용을 검증한 것은 아니다.
- 분리 원장: 정확한 담당/작업 주소, 실제 SQLite 배정·실행·증액·정산, 모르는 사용량의 보류, 하드 한도 거절. 개인 기억과 수신자 원문을 합치지 않는다.
- 효율과 권한: 스키마/응답 계약과 자원 준비 진전을 교정했다. 반복 조회·자체 비용은 진전이 아니며, 승인 거절은 원 계획에 선언한 제한 재시도로만 이어진다. 같은 task의 재개에 새 planner 호출이나 카운터 초기화가 필요하지 않다.

메인 프롬프트는 [공통 범용 지침 파일](../runtime/src/infrastructure/agent-turn-prompt.ts)로 구현돼 [등록 모델 어댑터](../runtime/src/infrastructure/structured-agent-turn.ts)에 연결돼 있다. [현재 설명](chapters/prompt-generality-review.md)과 같이 실제 모델 응답 품질은 미검증이다. C01~C06 이전 결과는 각 실행 소스의 기록이며 이번에 반복 실행하지 않았다.

실제 PostgreSQL·사내 MCP/Knox·A2A 상호운용·registry 게시·버전 간 업그레이드·운영 설치는 미실행 범위를 유지한다. 활성 빌드·시험은 없다. 세션은 이어가되 목표·근거·실행 영수증·자원 장부는 작업별로, 신원·설정·기억·대화는 담당별로 분리한다.
