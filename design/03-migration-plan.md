# 통합 구현 순서와 검증 플랜

2026-09-09 · checkpoint399 · 기준선 `c295c611`. 웹 미확정 제어 요청을 같은 탭에서 새로고침한 뒤 복원하도록 연결했다. 담당·사용자 세션·대화별로 최초 요청 ID·기준 버전과 대상/명령 종류만 저장한다. 새 명령 전 저장하고, 원 응답이나 확정 거절을 확인한 뒤 제거한다. 상태 조회·연결 종료는 미확정 기록을 삭제하지 않는다.

복원 요청은 기존 접이식 패널에서 선택한다. 새로고침은 자동 POST나 과거 상태 복원을 하지 않는다. 저장 실패·손상·최대16건/32KiB 초과를 조용히 버리지 않으며 대화·증거·인증정보를 저장하지 않는다. 같은 탭/origin의 새로고침 범위이고 탭 종료 이후의 영구 복구는 보장하지 않는다.

최종 build2에서 신규13개·기존16개, 고유29개가 모두 통과했다. 실제 내장 브라우저와 임시 SQLite에서 응답 손실→새로고침→동일 요청 재확인→재개·종료를 확인했다. 새로고침 POST0, 재확인 원 영수증 불변, 명령 처리4회/고유 제어3개, 최종 모델·source poll0회다. build2 exit0, 코어/구조203개·위반0은 helper만 교정된 이후 재사용했고 최종 소스·컴파일2,571개 대조가 일치한다.

첫 화면 실행은 검증 helper의 사건 payload 경로 오류와 스크립트 밖의 일반 업무 관찰 때문에 최종 인수로 쓰지 않았다. helper 교정과 진단·원 화면을 보존하고 새 서버에서 완결했다. 현재 모든 시험·서버·임시 탭은 종료됐다.

[결과](chapters/C09-browser-command-recovery-result.md) · [사용법](chapters/C09-browser-command-recovery-usage.md) · [체크포인트](../runtime/evidence/checkpoint399.json) · [브라우저 기록](../runtime/evidence/checkpoint399-browser.json) · [남은 확인 목록](REMAINING-ACCEPTANCE.md)

다음은 **C09 전체 세션 조회 비용과 같은 목표의 사건 중복 확인·용량·보관**이다. C05/C06 잔여, C10 초기 복원·Linux/Windows·설치, PostgreSQL·사내 연동·최종통합은 남은 목록에 유지한다. 기존 명명된 시나리오와 발견한 실제 결함에 집중하며, 새 가정만으로 검증 범위를 계속 늘리거나 이미 통과한 검증을 반복하지 않는다. 실제 모델/API 시험 중단을 유지하고 전체 C09/goal은 진행 중이다.

## 이전 기록 — checkpoint398

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint399를 따른다.

2026-09-09 · checkpoint398 · 기준선 `c0a14e9`. 다른 프로세스에서 저장한 제어를 활성 resident·mission 원천 조회에 전달했다. 실제 CLI 자식 프로세스의 pause/stop, 빠른 pause→resume 뒤 과거 조회 중단, 과거 요청 재전달의 새 조회 보호와 다른 담당·대화 격리를 확인했다. 기존 원 명령 영수증·checkpoint·원문·세션·예산은 보존한다.

source.poll 대기 중에만 기본250ms 주기로 저장 버전 후보를 확인한다. 변화가 있거나5초가 지나면 현재 권한·전체 상태를 다시 검사하고 그 조회만 중단한다. 후보 자체는 명령 적용·권한·무결성의 증거가 아니다. SQLite/PG는 기존 revision 컬럼, 파일은 기존 디렉터리 경계와 기록명을 사용하며 별도 알림 쓰기나 DB 구조를 추가하지 않았다. 선택 hint 포트가 없으면 정식 검사로 동작한다.

같은 최종 build1에서 신규23개·기존55개, 고유78개 모두 통과했다. 실패·취소·건너뜀0이며 시험을 재실행하지 않았다. build/core exit0, 구조203개/위반0, 시험 전후2,559개 컴파일 파일과 소스 대조 일치다. 실제 프로세스8개 시험과 기존 관측·제어·복구 회귀를 포함한다.

파일 감지6회에서 원 기록 읽기0회·원문 해시0bytes, 헤더 읽기12회·메타데이터 확인60회였다. 정식 조회는 같은 파일명 아래 변조된 원문을 거절했다. 파일명 열거와 정기 원문 검사의 비용은 남으며 이를 물리 디스크 I/O나 모델 토큰 측정으로 표시하지 않는다. 한 로컬 실행의 CLI 종료 기준 중단 신호는 약-31.8~213.7ms였고 최대 지연 보장이 아니다.

[결과](chapters/C09-cross-process-controls-result.md) · [사용법](chapters/C09-cross-process-controls-usage.md) · [체크포인트](../runtime/evidence/checkpoint398.json) · [원 측정](../runtime/evidence/checkpoint398-measurements.json)

다음은 **C09 브라우저 미확정 제어 요청의 새로고침 뒤 복원과 실제 화면 조작 검증**이다. 전체 세션 컨텍스트 비용, 동일 목표의 장기 사건 중복 확인·용량·보관, C05 권한 재허용 완주, C06 기억 HTTP·권한·지연·브라우저, C10 초기 복원 중단·현재 Linux/native Windows·실제 PG·네이티브 설치·운영/최종통합을 유지한다.

이번 기능은 활성 관측의 대기를 중단한다. 취소에 협조하지 않는 원 source와 이미 시작한 저장소 읽기는 나중에 끝날 수 있으며 소유 호스트의 종료·drain 책임은 유지한다. 다른 모델·도구 전체의 프로세스 간 취소 버스까지 구현한 것은 아니다. 실제 모델/API 시험 중단·사내 연결0을 유지한다. macOS 로컬 검증과 PG 기록 전송 시험을 실제 Linux/native Windows·PG·사내 연동·브라우저 검증으로 바꾸지 않는다. 전체 C09/goal은 진행 중이고 모든 빌드·시험은 종료됐다.

## 이전 기록 — checkpoint397

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint398을 따른다.

2026-09-09 · checkpoint397 · 기준선 `c741ffa`. 상시 임무의 관측 일시정지·재개·종료에 명령 ID와 예상 제어 버전을 연결했다. 같은 요청은 원 영수증으로 확인하며, 이후 재개한 새 관측을 과거 요청으로 다시 멈추지 않는다. 현재 상태와 원 명령 적용 번호를 구분하고 원 checkpoint·사건·대화·영수증을 보존한다.

CLI `mission status/pause/resume/stop`, Web 별도 상태/명령 API와 접이식 패널을 연결했다. 실제 선택 사용자 세션·binding 전체·화면 공개 조건을 확인하며 일반 업무의 경계는 유지한다. 조회·제어가 새 임무·세션·관측·모델 실행을 자동 시작하지 않는다. active는 ‘관측 허용’이고 현재 제어 버전은 명령 횟수가 아니다. 같은 탭의 미확정 요청은 최초 ID·기준을 유지한다.

최종 코드에 대응하는 신규16개·관련46개, 고유62개가 통과했다. 최초 CLI10/11과 resident20/21의 두 실패는 음수 옵션 전달 방식과 새로 조회 가능한 제어 버전의 기대값을 보완했다. 제품 수정 없이 두 시험 파일9개를 build4에서 다시 실행했다. 컴파일2,538개 중 그 시험 JS·소스맵4개만 달라 나머지2,534개의 기존 결과를 재사용했다. 원 실패 로그와 파일 대조를 보존한다.

최종 build4/core3 exit0, 구조202/위반0, 시험 후 소스·컴파일 대조 일치다. 최초 nullable 타입 오류는 명시 검사와 never 함수 선언으로 교정했으며 실패 빌드에서 기능 시험을 실행하지 않았다. 구현은 실제 임시 SQLite/file-journal, CLI 자식 프로세스, localhost HTTP로 확인했다. Web helper 시험을 실제 브라우저 렌더링 검증으로 표시하지 않는다.

[결과](chapters/C09-resident-command-result.md) · [사용법](chapters/C09-resident-command-usage.md) · [체크포인트](../runtime/evidence/checkpoint397.json) · [빌드 대조](../runtime/evidence/checkpoint397-build-comparison.json)

다음은 **C09 다른 프로세스의 resident 제어를 진행 중 관측 호스트에 즉시 전달하는 연결**이다. 브라우저 새로고침 뒤 pending 요청 복원, 전체 세션 컨텍스트 비용, 동일 목표의 장기 사건 중복 확인·용량·보관도 남는다. C05 권한 재허용 완주, C06 기억 HTTP·권한·지연·브라우저, C10 초기 복원 중단·현재 Linux/native Windows·실제 PG·네이티브 설치·운영/최종통합 잔여를 유지한다.

메인 프롬프트는 현재 코드에서 구현과 모델 전송 경로 연결을 재확인했으며 재작성하지 않았다. 실제 모델/API 시험 중단과 사내 서비스 연결0을 유지하므로 실제 추론·반론·대화 품질은 미검증이다. C09/전체 goal은 진행 중이고 모든 빌드·시험은 종료됐다. 완료 단위는 코드·문서·검증·남은 작업을 함께 커밋·푸시한다.

## 이전 기록 — checkpoint396

아래 상태와 다음 순서는 당시 기록이다. 현재 순서는 위 checkpoint397을 따른다.

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

다음은 **C09의 취소·목표 변경·일시정지**를 기존 세션·상시 임무와 연결해 확인하는 일이다. 이어서 저널 응답 불명·이력 비용, C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저를 검증한다. C10에서는 신뢰할 적용 intent나 복원 표식이 생기기 전의 가장 초기 중단, 현재 Linux/native Windows·실제 PostgreSQL·설치형 네이티브 배포·효율·운영/최종통합 인수가 남는다. 확인할 수 없는 디렉터리는 보존하고 자동 채택하지 않는다. 이력 병합 없이 명시한 전체 백업을 교체 적용한다.

메인 프롬프트 구현·연결은 유지하며 실제 모델/API 시험 중단과 외부 서비스 연결0을 지킨다. 실제 사내 MCP·Knox·외부 A2A와 모델 품질은 미검증이다. 전체 C10/goal은 진행 중이며 활성 빌드·시험은 없다. 완료 단위는 코드·문서·결과·남은 작업을 함께 커밋·푸시하고 원격 일치를 확인한다.

## 이전 기록 — checkpoint391

아래의 다음 행동과 상태는 당시 기록이다. 현재 순서는 위 checkpoint392를 따른다.

2026-09-08 · checkpoint391 · 기준선 `644c7f2`. 실패 복원본과 선택한 동일 담당·원경로의 전체 백업을 새 회복 폴더에 보존하는 준비·검사 API와 관리 CLI를 구현했다. 원 시도·영수증·결과·세션·사용량을 포함한 원백업을 복사하며, 기존 담당이나 원백업을 변경하지 않는다. 준비만으로 실행 차단이 해제되지는 않는다.

최종 build2에서 신규11개·관련26개, 고유37개 모두 통과(실패·취소·건너뜀0). 별도의 file-journal+문서 기억 배치 CLI 시나리오도 통과했으며 37개에 합산하지 않았다. 문서 기억은 배치 원문 보존 확인이며 기억 조회 품질 검증은 아니다. build2·코어 타입 exit0, 계층201/위반0, 최종2,466파일 대조 일치. build1의 테스트 타입 좁히기 오류와 수정 기록도 보존했다.

[결과](chapters/C10-restore-recovery-result.md) · [사용법](chapters/C10-restore-recovery-usage.md) · [체크포인트](../runtime/evidence/checkpoint391.json) · [최종 소스 대조](../runtime/evidence/checkpoint391-final-source.json)

다음 필수 작업은 **준비 묶음의 실제 적용과 중단 복구**다. 현재 원자료 대조 → 호스트에 맞는 기존 담당 폴더 보존 이동 → 원경로에 선택 백업 복원 → 신원 재등록 → 새 외부 대조 → 일반 재개를 연결한다. 이력 자동 병합이나 준비 완료를 회복 완료로 취급하지 않는다. C09 취소·목표 변경·일시정지·저널/이력 비용, C05 권한 재허용 완주, C06 기억 HTTP·권한·브라우저, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·설치/효율·운영 배포·최종통합도 남는다.

공통 메인 프롬프트는 구현돼 모델 전송 어댑터에 연결되어 있다. 이번에는 현재 소스를 확인했으며 재작성하지 않았다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지한다. 실제 모델의 추론·반론·요약·응답 품질은 미검증이며 전체 C10/goal은 진행 중이다. 활성 빌드·시험은 없다.

## 이전 기록 — checkpoint390

아래 상태와 다음 행동은 당시 기록이다. 현재 순서는 위 checkpoint391을 따른다.

2026-09-08 · checkpoint390 · 기준선 `158b82b`. 복원마다 새 고유 번호를 붙이고 호스트 조회 source의 외부 이력 대조를 일반 저장소 입구에 연결했다. 대조 전/미해결 복원은 새 실행을 막고, 일치한 복원은 같은 세션·원 업무로 이어간다. provisional 게시 실패도 재개를 막으며 동일 원 증명의 재시도는 영수증을 보존한다. 같은 build1 신규17개·기존 신원 복원9개·관련 회귀46개, 고유72/72 통과(실패·취소·건너뜀0). build/core exit0·계층200/위반0·최종2,454파일 대조 일치. [결과](chapters/C10-restore-reconciliation-result.md) · [사용법](chapters/C10-restore-reconciliation-usage.md) · [체크포인트](../runtime/evidence/checkpoint390.json).

다음은 C10에서 외부 이력보다 오래된 복원본의 누락 원기록 가져오기와 provisional 자료변경 회복을 기존 증거/복구 코드에 연결하는 일이다. C09 취소·목표 변경·일시정지/저널/이력 비용, C05/C06 후속, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·설치 입구/운영 배포·최종 통합도 유지한다. 전체 C10/goal은 미완료이며 실제 모델/API 시험 중단·사내/외부 서비스 연결0을 유지한다. 활성 빌드·시험은 없다.

이전 checkpoint389의 기록(아래 다음 행동과 미실행 표시는 당시 기준이다):

2026-09-08 · checkpoint389 · 기준선 `53019cf`. 쓰기 가능한 저장소를 열기 전에 공통 읽기 전용 형식 검사를 연결하고, 정확한 버전·compact 지원 확인과 기존 SQLite 상태 1/2→3·지식 1→2 이행을 재사용했다. 신규 경계9개·실제 설치 A/B의 구형 저장 구조 통합 시나리오2개·관련 회귀109개가 통과했다. Node 집계는 통합 묶음 상위 항목1개를 포함한121개이며 전체 최종 소스 재실행이 아니다. 최종 build3의 선검사9개·문서 기억8개는17/17, 설치 통합은 build2의 상위 항목 포함3개다. 관련109개는 build2의101개와 build3의 문서 기억8개다. build3 exit0·2,433파일 대조 일치, 코어 타입 exit0·계층199/위반0은 안쪽 코어가 바뀌지 않은 build1 기록이다. [결과](chapters/C10-storage-upgrade-result.md) · [사용법](chapters/C10-storage-upgrade-usage.md) · [체크포인트](../runtime/evidence/checkpoint389.json).

다음은 `agent-lifecycle`·`agent-host-identity-recovery`·`workflow`·`computer-reconciliation`의 기존 복원 업무·외부 효과 대조 경로를 읽고 백업 복원 후 새 외부 실행 전의 연결 공백을 좁히는 일이다. 이후 C09 취소·목표 변경·일시정지·저널 응답 불명·이력 비용, C05/C06 후속, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·패키지 효율·운영 배포·최종통합을 이어간다. 전체 C10/goal은 미완료이며 실제 모델/API 시험 중단·외부 서비스 연결0을 유지한다. 활성 빌드·시험은 없다.

이전 checkpoint388의 기록(아래 다음 행동·미실행 표현은 당시 기준이다):

2026-09-08 · checkpoint388. npm/개발 패키지에서 호스트 소유 설치본을 준비하고 그 실제 CLI로 새 담당의 첫 엔진 고정을 연결했다. 같은 원본의 두 담당은 설치본을 재사용하고 각자의 자료를 유지한다. 신규16개는 최종 build3, 관련·확장 기존32개는 build2에서 통과했다. 고유48개를 최종 소스에서 모두 재실행한 것은 아니다. 최종 build3 exit0·2,421파일 대조 일치, 코어 타입 exit0·계층199/위반0은 build2 기록이다. [결과](chapters/C10-engine-preparation-result.md) · [사용법](chapters/C10-engine-preparation-usage.md) · [체크포인트](../runtime/evidence/checkpoint388.json)

다음은 기존 저장 형식 이행과 읽기 전용 호환 확인 코드를 확인한 뒤 백업→엔진 변경→최초 저장소 열기의 연결에서 빠진 부분을 정하는 일이다. SQLite 상태·지식 저장소의 기존 이행 코드를 재사용하며 완료된 설치 준비를 반복하지 않는다. 전체 C10/goal은 미완료이며 실제 모델/API 시험 중단을 유지한다.

이전 기록 — 2026-09-08 · checkpoint387. 검증된 설치 release에서 새 담당의 최초 엔진을 자동 고정하고, 원 operation·ID·pin을 유지하는 중단 복구를 연결했다. 신규20개·관련79개, 합계99개가 같은 최종 build2에서 통과했다. 빌드·코어 타입 exit0, 계층199/위반0, 최종2,403파일 대조 일치다. [결과](chapters/C10-initial-pin-result.md) · [다음 npm/개발 release 준비](chapters/C10-initial-pin-plan.md). 전체 C10/goal은 미완료이며 실제 모델/API 시험 중단을 유지한다.

이전 기록 — 2026-09-08 checkpoint385: 전역 엔진 선택·공통 확장 호환 연결, 최종 같은 소스187개 로컬 통과. [결과](chapters/C10-launcher-extensions-result.md) · [다음 소단위](chapters/C10-launch-envelope-plan.md). 자동 최초 pin·저장 이행·플랫폼/실제 연동/최종통합과 전체 goal은 미완료다.

## 현재 실행 방침 — 2026-09-08

이전 checkpoint384의 기록(아래 다음 행동·미실행 표현은 당시 기준이며 현재는 위 checkpoint388과 NEXT-STEPS를 따른다): C10의 실제 코드가 다른 두 호환 시험 release 설치/전환과 기존 업무 재개를 확인했다. 신규3개·관련11개, 합계14개가 통과했다. build1 통합1/관련11, build2 교정2의 소스별 기록이며 전체14개를 최종 소스에서 재실행한 것은 아니다. 제품 코드는 재사용했고 신규 시험과 문서를 추가했다. 설치 A의 원 사용자 입력·명시 개인 기억·미완료 조회를 보존하고 check→pin→backup→B update→동일 신원/세션/기억 재열기→B CLI 원 업무 resume을 실행했다. 실제 B formatter 표시를 확인했고 모델1→2회·도구1→1회로 조회를 반복하지 않았다. SQLite와 file-journal+documents의 백업/lease/호환 거절, 현재 자료 백업을 요구하는 엔진 되돌리기와 자료 보존도 확인했다. 최종 build2 exit0·Node v24.20.0 darwin arm64·2,343파일 대조 일치, sourceDigest ceb819314182bc90259dab9a79c636fc31a6dff2ab276068c3af57e70702cd2a다. core1 exit0·구조198개/위반0은 build1 기록이며 이후 제품 변경 없이 경계 시험 한 파일만 교정했다. [결과](chapters/C10-version-transition-result.md) · [체크포인트](../runtime/evidence/checkpoint384.json) · [소스 대조](../runtime/evidence/checkpoint384-final-source.json). 다음은 **전역 명령의 담당별 고정 엔진 선택과 공통 확장 호환 선언/기동·check/pin/update 검사 연결**이다. 현재 설치 CLI 직접 실행을 전역 자동 선택의 완료로 보지 않는다. 저장 schema 이행·compact 세션의 버전 전환·미확정 외부 효과 복구·현재 Linux/native Windows·실제 PostgreSQL/사내 서비스·운영 배포·최종 통합은 남아 있다. C09/C05/C06 후속도 보존하며 C10과 전체 goal은 미완료다. 실제 모델/API 중단과 외부 서비스 연결0회를 유지한다. [인수인계](IMPLEMENTATION-RESUME.md) · [다음 작업](NEXT-STEPS.md). checkpoint383 이하 결과는 해당 문서의 당시 이력이다.

이전 Checkpoint375: C03의 명시 복구 중단·실제 로컬 도구 기록5개를 추가해 선택 고유243개, C05의 원문 조회 재사용·수집 권한 차단·CLI 안내20개를 추가해 선택 고유682개를 확인했다. 각 실행의 소스 지문과 실패 후 교정을 구분하며 전체를 최종 소스에서 재실행한 것으로 표시하지 않는다. [현재 인수인계](IMPLEMENTATION-RESUME.md)와 [다음 작업](NEXT-STEPS.md)을 따른다. C06 직접 입구·설치·두 담당 배치부터 이어가며, 정책 재허용 후 전체 재개·최종 통합·현재 Linux/native Windows 및 실제 환경 인수는 별도다. 아래 checkpoint374 이전의 상태·다음 작업은 이력이다.

최신 checkpoint371: `872fa50` 게시 뒤 로컬 검증을 재개했다. 초안 종료 hook 실패를 교정·재확인했고 C03의 선택 고유216개를 확인했다. [현재 결과](chapters/C03-ordered-verification-result.md) · [체크포인트](../runtime/evidence/C03-ordered-checkpoint.json). 복구 게시 단계의 실제 중단/재개4개도 통과했다. 준비 단계 중단·시도 상한과 남은 경계·환경 인수는 미완료다. 아래 게시 우선 정지와156개 중1실패 표시는 이전 checkpoint370의 기록이다.

사용자 최신 지시로 GitHub 게시를 우선한다. C03 마지막 집계는 156개 중155통과·1실패이며 build1은 통과했다. 실패 수정과 미실행 검증은 [남은 작업](NEXT-STEPS.md)에 저장했다. 다음 기록의 120/120은 뒤36개 실행 전의 부분 결과다.

최신 checkpoint370: C03 개인 기억·문서·이관 기반의 기존 12파일 120/120을 확인하고 나머지 입구·문맥·복구를 검증 중이다. [C03 결과](chapters/C03-ordered-verification-result.md)와 [실행 체크포인트](../runtime/evidence/C03-ordered-checkpoint.json)에 후속 빌드·실패·수정·미실행 범위를 계속 기록한다. C01·C02의 아래 결과와 C06~C10 구현 우선/별도 검증 정책을 유지한다. C03 전체와 전체 goal은 미완료다.

이전 checkpoint369: **C01 로컬 80/80**과 별도 **동시 CLI 8개씩 20회**, build5 exit0·구조188개/위반0을 유지한다. **C02는 기존4파일 30/30 + CLI·Web 1파일 5/5 = 고유35개 통과**이며 C02 build1도 exit0이다. 첫30개와 뒤5개는 서로 다른 소스 지문에서 실행했으며 [C02 결과](chapters/C02-ordered-verification-result.md)와 [실행 증거](../runtime/evidence/C02-ordered-checkpoint.json)에 각각 기록했다. C02 변경은 시험용 임시 등록표와 trusted work host 옵션 전달에 한정된다. 다음 실행 챕터는 **C03, 검증 진행 중**이다. C01 checkpoint368과 실패 원로그, C06~C10 지원 경로 구현·상세 검증 별도 정책을 보존한다. 현재 Linux/native Windows·최종 통합·C03~C10 후속 검증과 전체 goal은 미완료며 실제 모델/API·외부 서비스 연결 중단을 유지한다.

이전 checkpoint368: **C01 macOS 로컬 대상 80/80**, 별도 동시 CLI 8개씩 20회, 최종 build5 exit0과 구조188개·위반0을 확인했다. CLI 반복 확인을 고유 시험 수에 합산하지 않는다. [C01 결과](chapters/C01-ordered-verification-result.md) · [최종 증거](../runtime/evidence/C01-ordered-checkpoint.json). 다음 실행 챕터는 **C02**이며 지속 세션·compact 관련4파일 target1 TAP **30/30**은 통과했다. [C02 원로그](../runtime/evidence/C02-ordered-target1.log). presentation 후속은 준비 단계로 남기며 C01 현재 Linux/native Windows·최종 통합과 C02~C10 후속 검증·전체 goal은 미완료다. 아래 구현 우선 정책과 과거 결과를 유지한다.

이전 checkpoint367:  C06~C10의 지원 경로 구현을 정리하고 PG 담당의 엔진 check/pin/update 누락을 보완했다. [구현 결과](chapters/C06-C10-implementation-result.md) · [PG 엔진 전환](chapters/C10-postgres-engine-implementation.md). 최종 통합 build2와 예제 syntax check는 exit0이다. 상세 검증은 [별도 V06~V10 목록](chapters/C06-C10-verification-plan.md)에 두고 실제 실행하지 않았다. 준비한 C01 시험을 보존했으며 후속은 [C01~C10 순차 검증·수정](chapters/C01-C10-ordered-verification.md)이다. 실제 DB/엔진 전환·모델/API·사내 연결·native Windows 인수와 전체 goal은 미완료다.

현재 위치: C06~C10의 지원 범위 내 실행 경로를 연결했고 통합 build2가 exit0으로 종료했다. 공유 게시판 원출처·아카이브 영수증, 동료/반론과 분리 DB의 자원 후원, A2A/상시 사건 driver, 로컬 설치/버전/복원을 포함한다. [구현 결과](chapters/C06-C10-implementation-result.md). 상세 시험·실제 연동은 실행하지 않았다. C01~C05의 미구현 저장소/플랫폼 기반은 보존하며 전체 구현 후 순차 검증·수정 방침을 유지한다.

**전체 기능 구현을 먼저 마치고, 이후 C01~C10 순서로 검증·수정한다.** 구현 우선순위는 **C06 → C07 → C08 → C09 → C10**이다. 검증 항목은 [별도 검증 계획](chapters/C06-C10-verification-plan.md)에 기록한다. C01~C05 잔여 범위는 기존 목록에 유지한다. 기존 기반을 재사용하고 실제로 막는 선행 기능만 먼저 보완한다. 구현 중에는 빌드·타입 오류 등 진행을 막는 문제를 확인하며 상세 회귀·장애 복구·플랫폼 검증은 뒤로 모은다. [구현 우선 계획](chapters/implementation-first-plan.md)이 아래 과거 결과의 “다음 작업”과 단위별 상세 검증 순서보다 우선한다.

C05 보관·정산 A/B는 로컬 신규 54/54·관련 113/113과 빌드·타입·아키텍처 검사를 통과했다. C 시험 후보는 미통합·미실행 상태로 보존한다. [현재 결과](chapters/C05-mcp-collections-custody-AB-result.md). 아래 v0.67 및 이전 결과는 각 당시 소스의 이력이다.

<!-- C05-MCP-COLLECTIONS-FINAL-PROOF: 1ef802e5b3473c96de38f364f62815584f8f1206d441a473be8666c1ecb61fd9 -->
**MCP 수집의 일반 입구 재개와 저장 근거 조회**를 연결했다. 같은 담당의 여러 항목 수집을 일반 CLI·Web에 연결했다. 저장된 원응답을 먼저 정산하고 필요한 대화 요약과 문맥 복원을 거친 뒤, 모델이 명시한 완전한 저장 결과의 후속 시도를 로컬에서 소비한다. 새 페이지가 필요하면 연결을 기다리고 명시 온라인 재열기에서 다음 페이지나 실패 항목만 요청한다. **macOS Node24 신규 183/183·관련 519/519, NAS Linux Node24 신규 183/183·관련 519/519·전체 3,691/3,691 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-usage.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json). 완전한 저장 결과 안내는 실행 허가가 아니다. 원 부모·원문·영수증·현재 계약과 권한을 다시 검사하며 부모의 실패를 성공으로 바꾸지 않는다. 로컬 후속 소비는 논리 도구 호출 한 번이고 원격 전송은 0회다. 필요한 근거 조회와 새 모델 호출은 기존 예산을 따른다. 문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다. 다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다. [필수 후속](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.66 단순 읽기의 서버 없는 재개 결과와 당시 다음 계획(아래 미착수 표시는 당시 기록):

<!-- C05-MCP-OFFLINE-FINAL-PROOF: 28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9 -->
**MCP 서버 없는 일반 재개와 명시 온라인 재열기**를 연결했다. 신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다. **macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [저장 전용 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-usage.md) · [MCP 호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json). 저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다. 다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [전체 MCP 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.65 보관·정산의 확정 결과와 서버 없는 재개 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):

<!-- C05-MCP-CUSTODY-FINAL-PROOF: 3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c -->
**MCP 전송 후 권한 변경의 원응답 보관·사용량 정산**을 연결했다. 허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다. **macOS Node24 신규 121/121·관련 775/775, NAS Linux Node24 신규 121/121·관련 775/775·전체 3,544/3,544 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [MCP 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json). 보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다. 서버를 다시 발견(tools/list)하는 현재 시작 경로는 유지되므로 서버 없는 재개는 아직 아니다. 다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다. [다음 구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-notes.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.64 저장 응답 복구의 확정 결과와 권한 경계 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):

<!-- C05-MCP-RECOVERY-FINAL-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->
**단순 MCP 원응답 수신 뒤 중단 복구**를 기존 C01 담당·실행기·정산에 연결했다. 검증된 원응답과 귀속 영수증이 있으면 같은 실행 시도의 수신·채택 또는 거절/정산 → 필요한 compact → 문맥 체크포인트 복원 → 이후 작업 순서로 진행한다. receive는 수신 기록, adopt는 현재 근거 채택이며 compact는 긴 대화를 정리하는 과정이다. 문맥 체크포인트는 다음 추론에 쓸 확인된 문맥의 저장본이며 미수신 결과를 대신 만들지 않는다. **macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과**. [복구 결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-response-recovery-result.md) · [MCP 연결 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json). 원 실행자와 lease(호출 유효 시간)를 바꾸지 않고 당시 응답 기록과 현재 목표·권한·출처를 검증한다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 복원 불가로 멈추며 자동 재조회하지 않는다. 응답 시각·트랜잭션 준비 시각은 물리 commit 완료 시각이나 재시작 간 단조 시계의 증명이 아니다. 복원에는 추가 tools/call이나 논리 도구 예산을 쓰지 않고 새 답변·compact는 기존 모델 예산을 따른다. 프로필을 다시 열 때 서버 발견(tools/list)은 필요하므로 offline은 아니다. 다음 단위는 도구 요청을 보낸 뒤 권한이 바뀐 경우 원응답·보고된 사용량을 보존하는 경계이며 아직 제품 구현에 착수하지 않았다. 이후 서버 없는 재개, 일반 입구의 페이지·대기 복구를 연결한다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도로 측정·인수한다. [다음 전송 후 권한 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [전체 MCP 후속 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결과 PostgreSQL의 잔여 구현·검증도 남아 있다.

이전 v0.63 MCP 연결의 확정 결과와 복구 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):
<!-- C05-MCP-FINAL-PROOF: c04e4cb45e98716b5c5f003c2609c627711100a4e018cb501c5811708f0e2226 -->
기존 MCP 읽기를 **같은 C01 담당의 보관 포트와 일반 CLI/Web**에 연결했다. 호스트 시작 프로그램이 승인한 실행 설정·도구 계약을 등록하고 기존 계획·도구 실행·원응답·영수증·증거·정산을 사용한다. **macOS Node24 신규 30/30·관련 572/572, NAS Linux Node24 신규 30/30·관련 572/572·전체 3,368/3,368 통과**. [MCP 연결 결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-linux-nas-20260907/verification.json). 저장된 received/완료 결과는 tools/call을 중복하지 않지만, 프로필 재열기에는 서버 발견(tools/list)이 필요하므로 offline 재개는 아니다. 다음 단위는 원응답과 MCP 영수증을 저장한 뒤 실행기의 received 전에 중단된 단순 읽기의 복구로, 착수 예정이며 실행 권한(lease)과 수신 시각 등 세부조건은 검토 중이다. 그 뒤 전송 후 권한 변경·known usage 보존, 서버 없는 재개, 페이지·대기의 일반 입구 연결을 이어간다. 문맥 조회 비용 개선도 남아 있다. [다음 원응답 복구 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-response-recovery-plan.md) · [문맥 조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows runtime/file 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.

이전 v0.62 C05 호스트 연결의 확정 결과와 MCP 착수 당시 기록(아래 “다음”·진행 중 표시는 당시 상태):
<!-- C05-HOST-FINAL-PROOF: 6ff54f755b983c007ab7a541496f64500294086f86b0ac9a21f1445b8ee3ac5f -->
신뢰된 시작 프로그램이 담당별 **읽기 도구·사용자 권한·새 업무 한도**를 일반 CLI/Web에 전달하도록 연결했다. 호스트는 실행 프로그램이며 리드 에이전트를 뜻하지 않는다. 기존 도구 계약·목록·실행·원문·세션·정산을 재사용하고, 정책 축소·종료 시 낡은 결과의 사용과 이미 소비한 자원 기록을 구분한다. **macOS Node24 신규 54/54·관련 356/356, NAS Linux Node24 신규 54/54·관련 356/356·전체 3,338/3,338 통과**. [C05 결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-host-tools-result.md) · [호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-host-tools-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-host-linux-nas-20260907/verification.json). 다음은 기존 MCP 읽기 어댑터를 같은 담당의 보관 포트와 일반 CLI/Web에 연결하는 일이다. 다음 MCP 연결과 문맥 조회 비용 최적화는 아직 구현 완료가 아니다. [MCP 연결 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [문맥 조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md) · [후속 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-after-host-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.

이전 v0.61 C04 목표 변경의 확정 결과와 C05 착수 당시 기록(아래 “다음”·진행 중 표시는 당시 상태):
<!-- C04-GOAL-FINAL-PROOF: 77c47342f9fd89f5593a8eb791d58f3d7eb2d9651c5b90a3610217caf23d19be -->
같은 담당·대화·업무의 **명시 목표 변경**을 일반 CLI/Web에 연결했다. 원문·근거·시도·사용량과 원래 한도를 유지하고, 같은 요청 재전송·새 입력 경합·옛 답변 무효화·compact 뒤 원문 재확인을 검증했다. **macOS Node24 신규 57/57·관련 249/249, NAS Linux Node24 신규 57/57·관련 249/249·전체 3,284/3,284 통과**. 앞선 복합 조사 시험도 이번 Linux 신규·전체 묶음에 포함했다. [목표 변경 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-goal-change-result.md) · [CLI 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-goal-change-cli-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-goal-linux-nas-20260907/verification.json). 실제 브라우저는 호스트 잠금으로 렌더링·클릭을 확인하지 못했고 임시 서버와 담당은 정리했다. [브라우저 시도 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-goal-browser-attempt.json). 다음은 C05에서 호스트가 준비한 읽기 도구와 사용자·정책을 일반 담당 프로필에 연결하는 일이다. 호스트 연결은 구현·검증 중이다. 현재 진행과 첫 시험 교정은 [재개 기록](IMPLEMENTATION-RESUME.md)을 따른다. [다음 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-host-tools-plan.md). 실제 모델/API 시험은 중단 상태다. 실제 모델의 의미 판단·usage·취소·tokenizer 적합성과 native Windows runtime/file 연결·PostgreSQL·사내 연동·C08 독립 반론 협업은 남아 있다. C04 전체와 전체 goal은 미완료다.

이전 v0.60 복합 조사 로컬 인수 당시의 기록(아래 “미실행”과 “다음”도 당시 상태): 일반 요청의 복합 조사 인수에서 macOS Node24 신규 **2/2**·관련 **43/43**을 통과했다. 초기 자료에 반증이 들어오면 가설을 다시 평가하고 필요한 판별 자료만 추가 조회했다. 판별 자료가 실패하면 원본·충돌·사용량을 보존한 채 질문 대기로 남는다. 기존 등록 모델·계획 검사·도구 실행·정산을 재사용했으며 이번 단위는 제품 코어 변경 없이 통합 시험을 추가했다. [복합 조사 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-complex-turn-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-complex-verification.json). 새 복합 시험의 Linux 검증은 **미실행**이며 다음 목표 변경 제품 연결 후 필수 통합에 포함한다. 아래 등록 모델의 NAS 3,253개 통과는 당시 소스의 기록이다. 다음은 [명시 목표 변경](/Users/seunghanee/Documents/secumon/design/chapters/C04-goal-change-plan.md)이다. 합성 전송으로 계약을 확인했으며 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

이전 C04 등록 모델 연결 당시의 검증 기록(아래의 “다음”도 당시 계획): 담당 설정에 저장한 모델 등록 이름을 CLI·Web의 같은 일반 요청 입구에 연결했다. 주턴과 compact는 기존 호출 예약·정산·복구를 사용하며, 기본 등록 예제는 네트워크 없는 구조화 전송 대역이다. macOS Node24 신규 **44/44**·관련 **245/245**, NAS Linux Node24 신규 **44/44**·관련 **245/245**·전체 **3,253/3,253**을 같은 소스로 통과했다. [등록 모델 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-registered-model-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-registered-model-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-registered-linux-nas-20260907/verification.json). 다음은 [일반 입구의 복합 가설·반증·부분 재계획](/Users/seunghanee/Documents/secumon/design/chapters/C04-complex-turn-plan.md)이며 [잔여 검토](/Users/seunghanee/Documents/secumon/design/chapters/C04-after-registration-review.md)의 명시 목표 변경도 남는다. 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

이전 C04 문맥 창 검증 기록: 모델 입력·출력·총 문맥 창을 구분하고, 필수 상태와 현재 원문이 들어가는지 먼저 확인한 뒤 과거 대화 compact를 연결했다. 같은 준비 결과를 재사용하며 실제 요청은 게시 후 다시 측정한다. macOS Node24 신규 **71/71**·관련 **704/704**, NAS Linux Node24 전체 **3,209/3,209**을 같은 소스로 통과했다. [C04 문맥 창 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-window-linux-nas-20260907/verification.json). 다음은 [등록된 모델 프로필과 일반 입구 연결 검토](/Users/seunghanee/Documents/secumon/design/chapters/C04-after-window-review.md)다. 실제 모델/API 시험은 중단 상태이며 C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

2026-09-06 배포 대상 정정: **실제 사용 대상은 Linux와 네이티브 Windows다. macOS는 현재 개발·로컬 검증 환경이다.** 경로·권한/ACL·원자 저장·파일 잠금·프로세스 종료·설치/서비스·컴퓨터 유즈를 OS별로 구현/검증하고, macOS/WSL 결과로 Linux/Windows 지원 완료를 대신 표시하지 않는다. [운영체제 지원 계획](/Users/seunghanee/Documents/secumon/design/chapters/platform-support-plan.md).

2026-09-07 · v0.67 · C05 수집 재개·문맥 수렴·저장 근거 조회 검증과 페이지별 보관 후속

**담당별 격리와 지속 문맥을 먼저 완성하고, 단일 에이전트의 추론·실행·대화를 연결한 뒤 협업과 운영까지 구현한다.** 사용자는 챕터와 범위를 늘려도 되며 지금까지 논의한 내용을 모두 반영하라고 확인했다. 기능을 줄이지 않고 순서를 조정한다. “선택 기능”은 구현 대상이면서 배치할 때 켜고 끌 수 있는 기능을 뜻한다.

이전 C04 첫 흐름의 검증 기록: 2026-09-07 일반 요청 → 주 모델 턴 → 직접 답변·질문·검증된 계획 → 기존 도구 실행 → 응답 검토·전달을 연결했다. 작업이 끝나도 같은 세션의 원문·요약을 다음 요청에 사용한다. 같은 소스에서 macOS 신규 **100/100**·관련 **636/636**, NAS 실제 Linux/Node24 전체 **3,138/3,138**을 통과했다. [C04 첫 흐름 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-turn-linux-nas-20260907/verification.json) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-usage.md). 다음은 [모델 입력 한도와 compact 조정](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-plan.md)이다. 합성 모델로 계약을 확인했으며 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동 및 전체 goal의 남은 범위는 유지한다.

이전 검증 단위: 2026-09-07 반복 compact를 기존 모델 호출·정산·복구와 연결했다. 같은 세션의 원문을 보존하며 앞부분 요약과 최근 입력을 조합하고, 작업 완료 뒤에도 문맥을 이어간다. NAS 실제 Linux/Node24에서 **전체 2,836/2,836**, 신규 compact **46/46**을 통과했다. [반복 compact 결과](/Users/seunghanee/Documents/secumon/design/chapters/C02-session-compact-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C02-compact-verification.json). 첫 Linux 초기화 경합 실패는 고정 재현·최소 수정하고 원로그를 보존했다. 이 검증 이후 C03 개인 기억 흐름을 진행했다. 실제 모델/API 시험은 재개하지 않았으며 C01/C02 전체 및 전체 goal은 진행 상태를 유지한다.

이 문서와 [구현 작업 목록](/Users/seunghanee/Documents/secumon/design/implementation-backlog.json)의 execution_chapters가 현재 순서의 기준이다. 기존 P0~P6·31개 작업은 기능별 구현/검증 이력으로 유지하고 새 C01~C10과 연결한다. 작은 단위별 계획→구현→진행 기록을 이어 전체 기능을 연결한 뒤 C01~C10 검증·수정 단계를 수행한다.

## 1. 확인된 기반과 남은 차이

- TypeScript 코어의 작업 실행·검증·근거·복구·도구/MCP·기억/컨텍스트·자원 장부·협업 연결 기반을 재사용한다. 과거 시큐몬 전체 코드와의 비교나 재작성은 필수가 아니다.
- 담당별 저장 소유권과 원문 기반 지속 세션을 연결했다. **반복 compact의 원문·출처·정산 연결은 합성 provider로 검증했고 실제 모델 품질과 Windows/호스트 실행 격리는 남아 있다.** 현재 도구 내용 선택·축출과 원문 대화의 의미 요약을 구분한다.
- 주 모델 턴은 일반 요청에서 답변·질문·계획을 제안하도록 확장했다. 합성 제공자로 연결을 검증했으며 실제 범용 대화·독립 반론·기억 선별·최종 응답 품질을 완성했다고 보지 않는다. [프롬프트 검토](/Users/seunghanee/Documents/secumon/design/chapters/prompt-generality-review.md).
- 기존 전체 검증은 2026-09-06 19:43 KST 종료 기록상 2,460개 통과·실패/취소 0이다. 이번에는 [종료 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-funding-verify1-exit.json)과 로그를 읽었고 시험을 새로 실행하지 않았다. 로컬/합성 검증을 실제 모델·사내 서비스·운영 검증으로 승격하지 않는다.
- 이전 순서와 당시 상태는 [v0.50 계획](/Users/seunghanee/Documents/secumon/design/history/03-migration-plan-v0.50.md)과 [작업 목록 사본](/Users/seunghanee/Documents/secumon/design/history/implementation-backlog-v0.50.json)에 보존한다. 당시의 “다음 작업”은 현재 착수 지시가 아니다.

## 2. 합의한 기본 설계

| 항목 | 반영한 기준 |
| --- | --- |
| 범용 본체 | Python 없는 TypeScript 공통 엔진. 보안 업무나 리드–워커 역할을 고정하지 않는다. planner/validator/executor는 한 에이전트의 내부 책임이다. Rust는 실제 필요에 따라 선택한다. |
| 담당 배치 | 공통 실행기를 외부에 설치하고 담당 디렉터리에 설정·스킬·기억·상태를 둔다. 경로는 위치이며 지속 ID는 안에 저장한다. |
| 첫 호출 | 신규 setup·정상 이어가기·부분 복구·버전 불일치를 구분하고 기존 파일과 ID를 보존한다. 모델 연결은 나중에 설정할 수 있다. |
| 지속 문맥 | 같은 담당·같은 대화는 작업 X 완료 뒤 Y에서도 문맥을 유지한다. compact는 현재 창을 관리하는 과정이며 새 작업/담당 초기화가 아니다. |
| 단기/장기/이력 | 단기 문맥, 담당의 장기기억, 대화 기록, 실행 복구 상태를 분리한다. 같은 DB·사용자·모델이어도 담당과 별도 대화의 경계를 유지한다. |
| 저장 방식 | 담당별 SQLite 상태/개인 기억 + 설정/스킬/큰 원문 파일이 기본. 문서 기억·파일 저널·PostgreSQL을 용도별 어댑터로 지원한다. PostgreSQL은 명시 등록 후 사용하며 장애 시 임의 정본 분기를 만들지 않는다. |
| 게시판/아카이브 | 게시판은 경험 질문/답변, 아카이브는 사례/대화 또는 기존 시스템 조회/등록. 기본 비활성이며 배치별 선택한다. 조회 자료를 개인 장기기억에 자동 등록하지 않는다. |
| 추론 순환 | 목표/상태 → 필요한 가설 → 계획 → 실행 전 검사 → 작업 그래프/실행 → 결과/근거 검증 → 상태 갱신 → 계속/재계획/대기/완료. 단순 요청에는 필요한 단계만 적용한다. |
| 반론 | 자체 검토 + 필요 시 별도 문맥의 검토 역할. 반론을 판별 질문과 후속 관측으로 연결하며 반론 자체나 다수결을 증거로 취급하지 않는다. |
| 프롬프트 | 공통 원칙 + 담당 설정 + 현재 세션/작업 + 선택 지침/도구 명세. 도메인 역할, 특정 모델, 전체 스킬 목록을 공통 본문에 고정하지 않는다. |
| 도구/스킬 | 재사용 가능한 도구는 유지하고 효율 개선이 필요한 부분만 수정한다. 도구 목록·기억 조회·스킬 호출·미사용 정리를 함께 설계한다. 스킬 없이도 기본 에이전트는 동작한다. |
| 실행 강도 | 자동/빠르게/깊게 등으로 무거운 장기 추론의 적용 정도를 선택한다. 빠른 처리도 실행 상태·효과 확인·필요 기록을 보존한다. |
| 자원 | 배정·추가 요청·회수/재배정은 에이전트가 판단하고 런타임이 검사·기록·정산·반환한다. 작업의 자원과 질문/채팅 턴 수·상주 담당 수명을 구분한다. |
| 협업/접근 | 협업 관계·비용 부담·자료 접근·모델 위치를 각각 정한다. 모든 역할이 사내 모델을 사용할 수 있고 동료 응답에 새 자식 작업/배정을 강제하지 않는다. |
| 채팅/사람 역할 | CLI·Web·Knox에 접수·필요 질문·의미 있는 변화·결과를 표시하고 세부 호출은 펼쳐서 본다. “영업 에이전트”는 사람과 소통하는 대화 담당이다. |
| 설치/버전 | 최소 CLI 설치부터 시작해 담당별 버전 고정·호환 검사·이행·복원·업데이트로 확장한다. 공통 엔진 업데이트와 사용자 자료 삭제를 연결하지 않는다. |
| 학습/기록 | 챕터별 개념·작은 구현·관련 검증·결과 기록을 남긴다. 실제 구현/대역 검증/실제 연동/계획을 구분한다. |

상세 근거: [담당·저장 기본값](/Users/seunghanee/Documents/secumon/design/chapters/workspace-agent-defaults.md), [기억 경계](/Users/seunghanee/Documents/secumon/design/chapters/agent-lifecycle-and-memory-boundaries.md), [협업 수정표](/Users/seunghanee/Documents/secumon/design/chapters/P4-design-reconciliation.md), [반론 검토](/Users/seunghanee/Documents/secumon/design/chapters/reasoning-critique-proposal.md), [설치/버전](/Users/seunghanee/Documents/secumon/design/chapters/installation-and-versioning.md).

## 3. 구현 순서 한눈에 보기

선행 관계는 새 챕터의 계약/로컬 결과 기준이다. 외부 조건이 막아도 독립적인 로컬 구현은 진행할 수 있다. 해당 실제 연결/품질 결과는 계속 미완료로 남긴다.

2026-09-07 실행 기준 보완: [호스트 파일 변경 계획](/Users/seunghanee/Documents/secumon/design/chapters/C01-host-file-mutations-plan.md)의 A(프로필 생성·게시·중단 재개)를 지원되는 POSIX에서 검증하면 C02를 진행한다. C01의 담당/저장 계약을 선행으로 쓰며 Windows 실제 실행 대기로 독립 세션 구현을 막지 않는다. B(Windows native setup)와 C(나머지 저장소 연결)는 해당 플랫폼 배치의 필수 인수 조건으로 병행하고, C01 전체는 잔여 조건 완료 전까지 진행 중으로 유지한다.

| 챕터 | 결과 | 선행 | 작은 단위 수 |
| --- | --- | --- | --- |
| C01 | 담당 디렉터리·식별·최초 설정 | 없음 | 3 |
| C02 | 작업을 가로지르는 지속 대화와 compact | C01 | 3 |
| C03 | 개인 기억·이력 분리와 저장 어댑터 | C01, C02 | 4 |
| C04 | 범용 메인 프롬프트·모델 연결·단일 실행 루프 | C02, C03 | 4 |
| C05 | 도구·메모리·스킬 호출과 컴퓨터 유즈 효율 | C04 | 5 |
| C06 | CLI·Web·Knox 대화와 최소 설치·업무 배치 | C04, C05 | 4 |
| C07 | 선택 게시판·아카이브와 저장소 연결 | C03, C06 | 4 |
| C08 | 동료·임시 서브에이전트·독립 반론·자원 | C04, C06 | 4 |
| C09 | A2A·사건 재개·상시 임무와 협업 평가 | C07, C08 | 4 |
| C10 | 설치·버전 이행·운영 복원·시범과 선택 이관 | C06 (협업 배치는 C07~C09 추가) | 4 |

현재는 기존 기반 위에서 C06~C10을 순서대로 우선 구현한다. 실제로 필요한 선행 계약만 보완하고 C10의 단일 담당 배포 준비는 협업 전체 검증을 기다리지 않는다.

### C01 — 담당 디렉터리·식별·최초 설정

작은 구현 단위: 실행 진입점과 identity → setup 및 복구 → 쓰기 경계와 격리 검증.

범위:

- 공통 TypeScript 실행기와 담당 디렉터리를 분리하고 최소 CLI 진입점·설정 탐색·버전 표시를 만든다.
- 지속 담당 ID, 설정·스킬·기억·작업 영역, 기본 SQLite/파일 구성을 연결한다. 경로 이동과 새 담당 복제를 구분한다.
- 신규 setup·정상 이어가기·부분 설정 복구·버전 불일치를 처리하고 모델 연결은 나중에 설정할 수 있게 한다.

통과 기준:

- 서로 다른 두 디렉터리의 담당 생성·재호출·이동·복제 등록에서 ID와 기록이 의도대로 유지/분리된다.
- 동시 초기화·깨진/누락된 설정을 복구하고 기존 자료를 덮어쓰지 않는다.
- 일반 담당 실행이 공통 엔진이나 다른 담당의 저장 공간을 수정하지 못하는 실제 경계를 확인한다. 전역 명령 등록만으로 보호를 주장하지 않는다.

기존 기반: P1-01, P2-01, P2-02, P3-02, P5-01, P0-02, P0-03, P1-02.

### C02 — 작업을 가로지르는 지속 대화와 compact

작은 구현 단위: 세션과 작업 연결 → 증분 문맥 및 compact → 동시 입력·취소·복구.

[지속 세션 결과](/Users/seunghanee/Documents/secumon/design/chapters/C02-persistent-session-result.md)에 이어 [반복 compact 결과](/Users/seunghanee/Documents/secumon/design/chapters/C02-session-compact-result.md)를 검증했다. 자동·수동 요약, 최근 원문, 현재 입력 검사, 사용량 정산, 게시/채택 중단 복구와 같은 세션의 다음 업무 문맥을 연결했다. 현재 소스 Linux 전체 2,836개·compact 46개를 통과했다. 임의 모델의 의미 보존 품질과 장기간 조회 비용·플랫폼 잔여는 별도로 남긴다. 다음 [개인 기억 흐름](/Users/seunghanee/Documents/secumon/design/chapters/C03-personal-memory-plan.md)은 이 구조를 재사용한다.

범위:

- 담당 ID·세션 ID·작업 ID의 책임을 구분하고 세션이 여러 작업의 문맥을 이어받도록 한다.
- 작업별 목표·계획·자원 장부를 유지하면서 X 완료 뒤 Y 요청에도 같은 대화 문맥을 사용한다.
- 가벼운 문맥 정리·compact·체크포인트·재시작·사건 재개를 연결하고, 같은 세션의 동시 갱신과 새 지시/취소를 처리한다.

통과 기준:

- X 완료→Y 후속 요청·반복 compact·프로세스 재시작에서 필요한 문맥과 참조가 이어진다. 새 작업을 문맥 초기화 조건으로 쓰지 않는다.
- 명시적 새 대화와 별도 사용자의 대화가 분리되고 중복 접수·동시 입력은 한 번씩 반영된다.
- compact/모델/도구 실행 도중 수정·취소가 도착해도 낡은 결과가 최신 목표를 덮어쓰지 않는다. 소비한 자원은 compact로 초기화되지 않는다.
- 미완료 의무·반증·원본 참조·미확정 외부 효과를 복구하며 세션을 유지하기 위해 모델을 계속 호출하지 않는다.

기존 기반: P1-05, P1-07, P2-03, P2-05.

### C03 — 개인 기억·이력 분리와 저장 어댑터

기본 SQLite·D1 문서 저장·D2 초안 적용에 이어 [D3 명시 이관](chapters/C03-personal-memory-migration-result.md)을 지원 POSIX에서 검증했다. C03 전체는 진행 중이며 PostgreSQL과 Windows 연결·실기 검증을 남긴다. 문서 반복 읽기 개선은 C05에서 다룬다.

작은 구현 단위: 담당 범위와 기본 SQLite → 문서/파일 어댑터 → PostgreSQL 등록과 적합성 → 기억 선별·정정·격리.

범위:

- 단기 문맥·개인 장기기억·대화 기록·실행 복구 상태를 분리하고 담당의 지속 ID를 저장/검색/캐시 경계에 연결한다.
- SQLite를 기본값으로 두고 문서 디렉터리 기반 기억·파일 저널·PostgreSQL을 같은 용도별 저장 계약의 어댑터로 지원한다.
- 파일 경로나 DB 주소에 직접 결합되지 않은 논리 참조, 직접 조회/검색, 선별 등록·정정·삭제, 출처/버전/신선도를 구현한다.

통과 기준:

- 같은 사용자·모델·공유 DB에서도 담당 A의 문맥·검색·요약·캐시·체크포인트가 B와 섞이지 않는다. 같은 담당 안의 별도 대화 범위도 보존한다.
- 같은 담당의 후속 작업은 허용된 기억을 공유하고, 아카이브 자료를 읽었다는 이유만으로 개인 기억에 자동 등록하지 않는다.
- SQLite·파일·설정된 PostgreSQL의 지원 계약을 시험한다. PostgreSQL 미등록 때 서버를 요구하지 않고, 등록된 정본의 장애 때 임의 로컬 정본을 만들지 않는다.
- 기억 정정/삭제가 관련 검색·요약에 반영되고 사라진 참조는 부재로 표시한다. DB와 편집 문서를 각각 독립 정본으로 운영하지 않는다.

기존 기반: P2-01, P2-02, P2-03, P2-06.

### C04 — 범용 메인 프롬프트·모델 연결·단일 실행 루프

[명시 목표 변경 결과](chapters/C04-goal-change-result.md)에서 macOS Node24 신규 57/57·관련 249/249, NAS Linux Node24 신규 57/57·관련 249/249·전체 3,284/3,284 통과. 복합 조사도 같은 Linux 검증에 포함했다. 원문·세션·사용량과 원래 한도를 보존하며 기존 세션 명령·영수증·현재성·응답 완료 검사를 재사용한다. 이후 C05 호스트 읽기 도구 연결을 검증했다. 현재 후속은 아래 C05의 MCP 연결이며 C04 전체 완료를 뜻하지 않는다. 실제 모델/API 시험은 중단 상태다. 실제 모델의 의미 판단·usage·취소·tokenizer 적합성과 native Windows runtime/file 연결·PostgreSQL·사내 연동·C08 독립 반론 협업은 남아 있다. C04 전체와 전체 goal은 미완료다.

이전 v0.60 C04 연결 상태와 당시 다음 계획: [첫 일반 요청 연결 결과](chapters/C04-general-turn-result.md)와 [사용법](chapters/C04-general-turn-usage.md)을 확인했다. 이어서 [문맥 창 연결](chapters/C04-context-window-result.md)을 검증했다. 이어서 [등록 모델 입구와 구조화 compact](chapters/C04-registered-model-result.md)를 검증했다. [복합 가설·반증·부분 재계획의 로컬 인수](chapters/C04-complex-turn-result.md)는 신규 2/2·관련 43/43을 통과했다. 새 복합 시험의 Linux 실행은 다음 제품 변경 통합에 포함할 미실행 항목이다. 다음은 [명시 목표 변경](chapters/C04-goal-change-plan.md)을 일반 CLI/Web에 연결하는 일이다. [이전 잔여 검토](chapters/C04-after-registration-review.md)는 당시 범위 판단의 근거로 보존한다. 기존 호출 예약·정산·복구와 계획 검사기를 재사용한다. C04 전체 및 PostgreSQL·Windows의 남은 범위는 유지한다.

[최소 실행 연결 메모](chapters/C04-next-implementation-notes.md)는 착수 전 공백의 역사 기록이다. 현재 원문 접수·답변·질문·완료 판정의 첫 연결은 위 결과 문서를 따른다. 실제 모델/API 시험은 재개하지 않는다.

작은 구현 단위: 프롬프트 조합과 입력 해석 → 기존 루프 연결 → 자체 반론·완료 판단·응답 → 모델별 적합성 및 품질 평가.

범위:

- 공통 행동 원칙·담당 설정·현재 세션/작업·필요한 지침을 조합하고 사용자 요청을 새 작업/기존 작업 변경/대화 응답으로 연결한다.
- goal/state→필요한 가설→계획→계획 검사→작업 그래프→실행→근거/결과 평가→상태 갱신→계속/재계획/대기/완료를 기존 코어와 연결한다.
- 직접 답변·자동/빠르게/깊게, 자체 반론 검토, 실패/무진전/불확실성 처리, 자연스러운 최종 응답을 설계·구현한다.
- 모델별 구조화 출력·도구 호출·취소·입출력 한도·usage 차이를 어댑터로 흡수한다. 사내 모델 사용과 역할 배치는 독립시킨다.

통과 기준:

- 단순 질문, 글 작성/수정, 자료 변환·비교, 모순 조사, 도구 실패 후 회복을 같은 본체로 표현한다. 모든 업무에 가설/스킬/긴 계획을 강제하지 않는다.
- 가설·반론을 판별 작업과 관측으로 연결하고 필요한 부분만 재계획한다. 반론 그 자체나 다수결을 증거로 취급하지 않는다.
- 계획자의 목표 무단 변경 금지와 사용자의 목표 변경을 구분한다. 도구 성공·산출물 완성·목표 완료를 구분하고 의미 평가가 필요한 업무를 사실 키 비교로 제한하지 않는다.
- 대역의 계약/오류 검증과 실제 모델의 판단/응답 품질을 따로 기록한다. 중단된 API/모델 시험을 자동 재개하지 않는다.

기존 기반: P1-03, P1-04, P1-06, P1-07, P2-05, P0-01.

### C05 — 도구·메모리·스킬 호출과 컴퓨터 유즈 효율

[MCP 수집 일반 입구 결과](chapters/C05-mcp-collections-entry-result.md)에서 macOS Node24 신규 183/183·관련 519/519, NAS Linux Node24 신규 183/183·관련 519/519·전체 3,691/3,691 통과. 같은 담당의 여러 항목 수집을 일반 CLI·Web에 연결했다. 저장된 원응답을 먼저 정산하고 필요한 대화 요약과 문맥 복원을 거친 뒤, 모델이 명시한 완전한 저장 결과의 후속 시도를 로컬에서 소비한다. 새 페이지가 필요하면 연결을 기다리고 명시 온라인 재열기에서 다음 페이지나 실패 항목만 요청한다. 문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다. 다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다. [사용법](chapters/C05-mcp-collections-entry-usage.md) · [필수 후속](chapters/C05-mcp-collections-entry-plan.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.66 결과와 당시 다음 계획: [MCP 서버 없는 일반 재개 결과](chapters/C05-mcp-offline-resume-result.md)에서 macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과. 신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다. 저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다. 다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [현재 사용법](chapters/C05-mcp-offline-resume-usage.md) · [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [MCP 전체 순서](chapters/C05-mcp-host-plan.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.65 보관·정산 결과와 당시 다음 계획: [MCP 전송 후 보관·정산 결과](chapters/C05-mcp-sent-authority-result.md)에서 macOS Node24 신규 121/121·관련 775/775, NAS Linux Node24 신규 121/121·관련 775/775·전체 3,544/3,544 통과. 허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다. 보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다. 공개된 원 사용자 요청을 그대로 읽을 수 있는 재개는 보호 raw를 문맥에서 제외한 유효한 blocked 체크포인트를 반환할 수 있다. 이는 업무 완료나 보호 본문 채택이 아니다. 원 사용자 요청 자체를 읽을 수 없으면 사용량 정산 뒤에도 session_current_input_unavailable로 거절한다. GET·상태 조회·SSE는 읽기만 하며 정산은 명시 실행·명령에 연결한다. 같은 실행 측정값과 일치하는 기존 정산 이벤트·영수증을 확인한 시도는 정산 선별에서 raw 재조회를 생략한다. 정상 null 필드가 남았다는 이유로 반복 정산하지 않는다. 이 생략은 본문·문맥의 별도 원문 검증을 없애지 않으며 성능 개선 수치는 측정하지 않았다. 다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다. [다음 구현 계획](chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](chapters/C05-mcp-offline-resume-notes.md) · [전체 후속 순서](chapters/C05-mcp-host-plan.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.64 복구 결과와 당시 다음 계획: [단순 MCP 저장 응답 복구 결과](chapters/C05-mcp-response-recovery-result.md)에서 macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과. 검증된 원응답과 귀속 영수증이 있으면 같은 실행 시도의 수신·채택 또는 거절/정산 → 필요한 compact → 문맥 체크포인트 복원 → 이후 작업 순서로 진행한다. receive는 수신 기록, adopt는 현재 근거 채택이며 compact는 긴 대화를 정리하는 과정이다. 문맥 체크포인트는 다음 추론에 쓸 확인된 문맥의 저장본이며 미수신 결과를 대신 만들지 않는다. 원 실행자와 lease(호출 유효 시간)를 바꾸지 않고 당시 응답 기록과 현재 목표·권한·출처를 검증한다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 복원 불가로 멈추며 자동 재조회하지 않는다. 응답 시각·트랜잭션 준비 시각은 물리 commit 완료 시각이나 재시작 간 단조 시계의 증명이 아니다. 동일 시도의 tools/call·정산·대화를 중복하지 않으며 도구 예산이 소진된 상태에서도 저장 수신부터 처리한다. 현재 프로필 재열기는 서버 발견이 필요하다. 다음 단위는 도구 요청을 보낸 뒤 권한이 바뀐 경우 원응답·보고된 사용량을 보존하는 경계이며 아직 제품 구현에 착수하지 않았다. 이후 서버 없는 재개, 일반 입구의 페이지·대기 복구를 연결한다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도로 측정·인수한다. [다음 계획](chapters/C05-mcp-sent-authority-plan.md) · [전체 후속 순서](chapters/C05-mcp-host-plan.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결과 PostgreSQL의 잔여 구현·검증도 남아 있다.

이전 v0.63 MCP 일반 입구 연결 결과와 당시 다음 계획: [MCP 일반 입구 연결 결과](chapters/C05-mcp-host-result.md)에서 macOS Node24 신규 30/30·관련 572/572, NAS Linux Node24 신규 30/30·관련 572/572·전체 3,368/3,368 통과. 같은 담당의 기존 보관 포트·계약 목록·원응답·영수증·정산을 재사용하며 received/완료 뒤 재접속에서 tools/call 중복을 막았다. 새 프로필은 서버 발견을 수행하므로 offline은 아니다. [사용법](chapters/C05-mcp-host-usage.md)에 따라 신뢰된 호스트가 실행 설정·도구와 권한을 전달한다. 다음은 [단순 원응답 수신 뒤 중단 복구](chapters/C05-mcp-response-recovery-plan.md)다. 다음 단위는 원응답과 MCP 영수증을 저장한 뒤 실행기의 received 전에 중단된 단순 읽기의 복구로, 착수 예정이며 실행 권한(lease)과 수신 시각 등 세부조건은 검토 중이다. 그 뒤 전송 후 권한 변경·known usage 보존, 서버 없는 재개, 페이지·대기의 일반 입구 연결을 이어간다. 문맥 조회 비용 개선도 남아 있다. C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows runtime/file 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.

이전 v0.62 호스트 연결 결과와 당시 다음 계획: [호스트 읽기 도구·실행 권한 결과](chapters/C05-host-tools-result.md)에서 macOS Node24 신규 54/54·관련 356/356, NAS Linux Node24 신규 54/54·관련 356/356·전체 3,338/3,338 통과. 기존 세션·원문·도구 계약·정산을 재사용하고 권한 축소·종료·늦은 결과와 사용량 보존을 연결했다. [사용법](chapters/C05-host-tools-usage.md)에 따라 신뢰된 시작 프로그램이 도구와 권한을 명시한다. 다음은 [기존 MCP 읽기의 일반 입구 연결](chapters/C05-mcp-host-plan.md)이다. [문맥 조회 비용 검토](chapters/C05-context-cost-review.md)는 현재성 경계를 유지한 중복 읽기 개선 후보이며 아직 최적화 완료가 아니다. C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.

작은 구현 단위: 카탈로그·MCP 재사용 → 기억/스킬 선택 로딩 → 컨텍스트 정리 → 컴퓨터 유즈 환경별 검증 → 동일 업무 효율 비교.

범위:

- 기존 catalog·정확한 계약 조회·호출 장부·결과 재사용·진행 중 중복 합류·batch/page/증분 조회를 재사용하고 필요한 개선을 연결한다.
- 스킬의 비활성/명시 호출/필요 시 선택 정책과 업무 방법 선택을 지원한다. 전체 목록/본문 상시 로딩과 반복 재로딩을 피한다.
- 장기 미사용 도구/내용을 의존성·재조회 가능성에 따라 활성 문맥에서 정리하고 필요 시 다시 읽는다.
- 컴퓨터 유즈는 가능한 구조화 도구/API와 UI 작업을 선택하고 관찰→행동 묶음→결과 확인·대기·복구로 실행한다.

통과 기준:

- 직접 참조와 검색 선택, 이미 확보한 자료 재사용, 최신성이 필요한 재조회, 권한/버전 변경과 캐시 폐기를 확인한다.
- 스킬이 꺼져 있거나 하나도 없어도 기본 업무가 진행되고, 필요한 지침만 선택 로딩·해제·복원한다.
- 선택한 UI 환경에서 화면 재사용·영역/요약·행동 묶음의 효과와 부분 성공·응답 유실·중복 행동 방지를 확인한다. 지원하지 않은 OS/앱까지 확장해 주장하지 않는다.
- 같은 업무의 결과 품질과 입력량·모델/도구/기억/스킬 호출·이미지·재시도·지연을 비교한다. 측정하지 않은 절감률을 약속하지 않는다.

기존 기반: P0-04, P2-03, P2-04, P3-01, P3-04.

### C06 — CLI·Web·Knox 대화와 최소 설치·업무 배치

작은 구현 단위: 공통 대화 표시 → CLI/Web → Knox 연결 → 최소 설치와 두 업무 배치.

범위:

- 접수 사실·필요 질문·의미 있는 진행 변화·최종 결과 중심의 지속 대화를 CLI/Web/Knox에 연결한다. 세부 실행 기록은 펼쳐서 본다.
- 채널 재접속·전달 중복 방지·상태/취소·사용자/세션 라우팅을 구현하고 Knox MCP의 실제 지원 능력에 맞춘다.
- 최소 전역 명령 설치·버전 표시·담당 디렉터리 연결을 제공하고, 문서 업무와 관측 분석 업무를 설정/도구/스킬로 배치한다.

통과 기준:

- 도구 호출마다 말풍선이 늘지 않고 응답 유실·재접속에서도 접수/결과가 중복 전달되지 않는다. 대기 중 상태 조회·취소가 가능하다.
- 두 업무 배치를 위해 공통 루프·저장소·프롬프트 본체에 보안 전용 분기를 추가하지 않는다. 사람 대화 역할은 어느 업무에도 쓸 수 있다.
- 게시판·아카이브·협업 없이 단일 담당을 설치/호출할 수 있다. 실제 Knox 연결과 가짜 채널 시험을 구분한다.
- 패키지 생성·격리 설치와 공개 배포를 구분하고, 제거/재설치가 담당 자료를 삭제하지 않게 한다.

기존 기반: P3-02, P3-03, P3-05, P5-01.

### C07 — 선택 게시판·아카이브와 저장소 연결

작은 구현 단위: 게시판 정상 읽기/답변 → 응답 의무와 알림 → 아카이브 포트와 공급자 → 선택 활성화 검증.

범위:

- 게시판을 경험 질문/답변 공간으로 구현하고 관측글의 선택 반응과 명시 질문의 응답 책임을 나눈다.
- 아카이브는 성공/실패/대화 사례 저장소나 기존 시스템의 조회 기능을 연결한다. 조회 전용/조회·등록 등 공급자 능력을 반영한다.
- 기본 비활성이고 배치별로 켤 수 있게 한다. 공유 글의 접근 범위와 연결 원문의 접근 범위를 분리한다.

통과 기준:

- 허용된 참여자가 게시글을 읽고 답하며 일반 글마다 숨김/사람 승인/가공 절차를 강제하지 않는다.
- 질문은 수락/거절/답변/추가 정보/근거 부족/미응답 상태로 이어지고 모든 글을 모든 담당에게 방송하지 않는다.
- 아카이브 조회와 개인 기억 등록을 분리하고 중복 사례·출처 버전·정정/삭제·조회 전용 공급자를 처리한다.
- 두 기능이 꺼져 있어도 세션·개인 기억·실행 복구 상태가 정상 동작한다.

기존 기반: P4-01, P2-02, P2-06.

### C08 — 동료·임시 서브에이전트·독립 반론·자원

작은 구현 단위: 직접 동료/임시 역할 → 독립 반론 연결 → 에이전트 자원 도구 → 위임·정산·복구 검증.

범위:

- 같은 범용 본체를 상주 담당과 임시 검토/실행 역할로 사용하고 업무별 동적 역할을 지원한다. 협업 경로는 게시판에 종속시키지 않는다.
- 중요한 불확실성·충돌·진전 정체 등에 선택적으로 별도 문맥의 반론 검토자를 호출한다. 검토 결과는 판별 작업과 근거 평가로 연결한다.
- 에이전트가 자원 배정·추가 요청·회수/재배정을 판단하고 런타임이 예약·사용량 정산·미사용 반환을 집행한다. 수락 판단용 자원과 실제 수행 자원을 구분한다.

통과 기준:

- A→B와 B→A 요청, 독립 자원으로 응답, 명시 위임 자원으로 수행을 모두 확인한다. 모든 질문에 새 자식 작업/배정을 강제하지 않는다.
- 협업 관계·비용 부담·자료 접근·모델 위치를 각각 설정하고 모든 역할이 사내 모델을 사용할 수 있는 계약을 유지한다.
- 반론의 대상·대안·근거/근거 없음·판별 질문·영향·버전을 남긴다. 같은 모델의 여러 답변을 독립 증거로 세지 않는다.
- 반환/정산은 한 번만 반영하고 늦은 사용량·취소·권한 철회·compact 후에도 장부를 유지한다. 작업 완료나 임시 역할 종료가 상주 담당의 세션을 종료하지 않는다.

기존 기반: P4-01, P4-04, P2-05, P2-06.

### C09 — A2A·사건 재개·상시 임무와 협업 평가

작은 구현 단위: A2A 어댑터 → 예약·관측·알림 재개 → 상시 실행 복구 → 단독/협업 비교.

범위:

- 외부 에이전트와 업무/상태/산출물·오류·취소를 교환하는 A2A 어댑터를 구현한다.
- 예약·변화 관측·게시판 구독·회신 대기를 영속 사건/커서와 연결하고 필요한 시점에만 담당을 깨운다.
- 단일 에이전트와 협업의 품질·지연·비용을 같은 문제에서 비교한다.

통과 기준:

- 중복/늦은 알림·부분 답변·취소·재전달·상대 장애에서 상태와 의무를 유지한다.
- 상주 담당의 identity/세션 수명과 프로세스/모델 호출 수명을 구분하며 대기 중 추론을 반복하지 않는다.
- 원인 없이 늘어나는 대화/재계획/호출을 감지하고 무진전·중복 fan-out을 제어한다.
- A2A 실제 상호운용과 fake clock/합성 협업 시험을 구분하고 협업이 필요한 경우의 추가 가치를 평가한다.

기존 기반: P4-02, P4-03, P4-04.

### C10 — 설치·버전 이행·운영 복원·시범과 선택 이관

작은 구현 단위: 설치·배포 패키지 → 버전 고정·호환·이행 → 복원·용량·자료 경계 → 시범·선택 운영 이관.

범위:

- 공통 엔진의 설치형 배포, 사내/오프라인 배포 경로, 엔진/설정/저장/확장 버전 호환, 담당별 버전 고정과 명시 업데이트를 구현한다.
- 체크포인트·진행 효과 대조 후 버전을 전환하고 데이터 이행·지원되는 되돌리기·제거/재설치 보존을 검증한다.
- 등록된 저장소/모델/도구/채널 배치의 복원·용량·오류·자료 정책을 확인하고 제한된 시범을 수행한다. 기존 운영 이관은 선택한 경우 수행한다.

통과 기준:

- 업데이트 후 같은 담당·세션·기억이 이어지고 지원하지 않는 저장 버전은 명확히 처리한다. 엔진 되돌리기와 과거 DB 복원의 데이터 손실/외부 효과 차이를 구분한다.
- 로컬 기본·PostgreSQL·파일 저장의 지원 범위에서 복원/정합성/삭제·철회 반영과 재실행 중복 방지를 확인한다.
- 실제 사용하는 구성의 검증을 통과한 경우만 배포 범위에 포함한다. 단일 담당 배포는 C07~C09 전체 완료를 기다릴 필요가 없다.
- 시범의 자료/주체/모델/전달 범위·용량·복원 목표를 확정하고 결과를 기록한다. P6-03 운영 이관은 별도 선택이며 자동 실행하지 않는다.

기존 기반: P5-02, P6-01, P6-02, P6-03.

## 4. 추가 점검 항목

새 기능을 빠뜨리지 않으면서 구현 중 혼동될 수 있는 조건을 각 챕터에 포함했다.

| 점검할 부분 | 구체적인 상황 | 챕터 |
| --- | --- | --- |
| 세션 경로·동시성 | 한 담당의 여러 사용자/채널, 같은 세션의 동시 입력, 이동/복제 디렉터리의 ID 충돌 | C01~C03, C06 |
| 중간 지시·취소 | 모델/도구/compact 중 수정이 도착하고 이전 결과가 늦게 도착함 | C02, C04 |
| 의미상 완료 | 글쓰기·수정·자료 변환처럼 사실 키 하나로 판정할 수 없는 업무 | C04 |
| 기억의 신뢰 | 외부 문서 지시문, 오래된 기억, 정정/삭제, 사라진 원문 참조 | C03, C05 |
| 토큰 증가 원인 | 스킬 목록/본문, JSON schema, 도구 원응답, 중복 조회, 반복 검증 출력 각각의 비용 | C04, C05 |
| 선택 기능의 독립성 | 게시판·아카이브·Knox·PostgreSQL 없이 기본 담당이 작동함 | C03, C06, C07 |
| 협업과 자원 결합 | 수락 판단 자체가 막히지 않는지, 동료 관계를 부모/자식 장부로 강제하지 않는지 | C08 |
| 버전/자료 변경 | 스킬·도구·모델·자료가 바뀐 뒤 현재 계약과 진행 중 작업을 맞추는지 | C03~C05, C10 |
| 실제 품질 증거 | 대역 통과와 실제 모델의 가설·도구 선택·응답 품질을 별도로 기록하는지 | 전체 |

사내 자료의 구체적인 접근 정책, 실제 MCP/Knox 능력, 모델과 UI 환경, 운영 용량/복원 목표는 해당 연결 직전에 확인한다. 이 선택을 지금 가상의 고정값으로 채워 넣지 않는다. 실제 모델/API 시험 중단은 계속 유지한다.

## 5. 챕터별 학습·구현 방법

1. 그 단위의 사용자 경험·개념·현재 기반·완료 기준을 짧게 설명하고 작은 계획을 저장한다. 기존 전체 코드 비교를 필수 절차로 두지 않는다.
2. 입력에서 결과/복구까지 이어지는 작은 경로를 구현한다. 프롬프트만 추가하고 세션/실행 연결이 된 것으로 기록하지 않는다.
3. 구현 단계에는 빌드·타입 오류 등 진행을 막는 문제를 확인한다. 전체 기능 연결 뒤 C01~C10 순서로 핵심 경로·복구/격리·플랫폼 검증과 수정을 수행한다. 전체 회귀는 통합 지점에 모으고 변화나 미해결 실패 없이 반복하지 않는다. 문서 수정만으로 제품 시험을 실행하지 않는다.
4. 결과·실패·미확인 범위·다음 단위를 파일에 저장하고 개념/변수의 뜻을 붙여 설명한다. 시험 개수나 문서 분량을 기능 완성도로 취급하지 않는다.
5. 계획·구현·검증은 공통 스킬 호출 없이도 수행한다. 전문 스킬은 구체적으로 필요한 경우에만 관련 부분을 읽는다. 실제 프로젝트 고유 절차가 필요한지는 확인한다.

이 흐름은 제품 코드에 특정 Codex 스킬을 의존성으로 넣는다는 뜻이 아니다. 이번 사용자 요청에 따른 Codex 공통 스킬의 호출 설정 변경도 Secumon 자체의 스킬 기능과 별도로 관리한다.

## 6. 요구 누락과 상태 혼동을 막는 기록

기존 R01~R22를 모두 새 챕터에 연결했고 R23 담당 디렉터리/setup, R24 작업 간 지속 세션/격리, R25 범용 프롬프트/반론, R26 선택 게시판/아카이브를 추가했다. 각 요구와 이전 31개 작업의 연결은 JSON에 보존한다. C01과 C02는 진행 중이며 나머지는 각 작업 목록의 상태를 따른다. 첫 단위의 검증을 챕터 전체 완료로 확대하지 않고, 기존 작업의 검증 상태도 계획 수정만으로 바꾸지 않는다.

P0~P6의 번호와 과거 선행 관계는 기능별 이력을 설명한다. 현재 구현은 C06~C10을 순서대로 우선하며 선행 기반의 잔여 기능은 기존 목록에 유지한다. 이후 검증·수정 순서는 C01~C10을 따른다. 특히 단일 담당 배치/릴리스의 선행 조건에서 협업 전체 완성을 분리했다. 게시판·아카이브·A2A·상시 임무·PostgreSQL·버전 관리의 구현 범위는 계속 포함된다.

[HTML 안내서](/Users/seunghanee/Documents/secumon/design/secumon-review.html)는 이번 논의 전의 구현 검토 화면이다. 현재 순서는 이 문서와 JSON을 우선하며 HTML 전체 갱신은 별도 사용자 검토 산출물에 반영한다. 계획 개정 당시에는 HTML이나 제품을 수정하지 않았으며, 이후 제품 변경과 검증은 챕터 결과 문서에 따로 기록한다.

## 7. 용어

- 담당 ID: 디렉터리를 이동해도 같은 에이전트임을 식별하는 값.
- 세션: 같은 담당과 이어가는 하나의 대화 문맥.
- 작업: 목표·완료 조건·계획·자원을 갖는 실행 단위. 한 세션에서 여러 작업을 진행할 수 있다.
- compact: 현재 문맥에서 덜 필요한 내용을 덜고 핵심 상태와 재조회 참조를 유지하는 과정.
- 어댑터: 같은 코어 계약을 파일·DB·모델·메신저 등 실제 연결 방식에 맞추는 바깥 구현.
- 선택 기능: 프레임워크에서 구현하되 각 배치에서 활성 여부를 선택하는 기능.
- 대역: 미리 정한 응답을 돌려주는 시험용 구현. 실제 모델의 판단 품질을 대신 입증하지 않는다.
