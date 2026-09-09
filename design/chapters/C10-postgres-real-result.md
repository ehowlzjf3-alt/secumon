# 실제 PostgreSQL 이행·복원 결과

2026-09-09 · checkpoint405 · 기준 커밋 `6291525625ef34e87bdf664f73308c20c5cfb33b`.

**NAS PostgreSQL 15.18에서 두 원본 저장소의 정상 이행·엔진 관리·백업·복원·재접속 흐름이 통과했다.** 제품 소스와 core 의존성은 변경하지 않았다. 기존 관리 API와 합성 업무를 실제 DB에 연결하는 시험 실행기, 결과 및 사용 문서를 추가했다. V10-06/07/08/18 전체와 운영 인수 완료를 뜻하지 않는다.

| 실행 | 원본 구성 | 확인한 기록 | 결과 |
| --- | --- | --- | --- |
| SQLite run3 | 상태 SQLite + 개인기억 documents | 업무 2, 영수증 21, 세션/compact head, PG 전달 18페이지·67행 | exit 0 |
| journal run2 | 상태 file-journal + 개인기억 SQLite | 업무 2, 영수증 21, 세션/compact head, PG 전달 18페이지·71행 | exit 0 |

표의 두 구성은 각각 독립 DB 쌍과 담당 디렉터리에서 실행했다. 행 수 차이는 개인기억의 문서/SQLite 저장 방식 차이를 포함하며 같은 fixture의 동일 행 수를 요구하지 않는다. 검사문 개수를 독립 시험 개수로 부풀리지 않는다.

## 확인한 동작

- 원문·추가 입력·개인기억·compact 기록과 완료 업무를 만든 뒤 prepare/apply migration을 실행했다. 준비 중 열기 거절, 같은 operation의 준비/적용 재호출, 과거 저장소 쓰기 차단과 PG 재열기를 확인했다.
- 원본 페이지 지문과 전체 원행, 공개 업무 상태·사건·영수증·기억·세션·대화 및 로컬 원문을 대조했다. 같은 실행 요청 재전달은 새 업무 실행이나 원자료 변경을 만들지 않았다.
- 기존 전체 엔진 fixture로 A/B를 실제 bundle/install/register했다. 최초 pin, 같은 pin 재호출, 현재 결합 백업을 사용한 B 변경, 잘못된 이전 pin과 오래된 백업의 거절, B 새 백업을 확인했다. pin은 담당이 사용할 엔진 버전을 고정하는 기록이다.
- 별도의 빈 DB에 같은 binding을 준비하고 원 디렉터리를 보존 이동한 뒤 원 경로로 복원했다. 독립된 호스트의 허용 백업 지문, 복원 발생 식별자와 같은 완료 operation 재확인, 명시 신원 재연결, 대사 전 열기 거절과 대사 후 반복 재접속을 확인했다.
- 원문/백업 전체 트리와 PG 자료가 보존됐고 재접속이 과거 업무를 재실행하지 않았다. 대사는 실제 PG 원자료와 등록된 합성 읽기·로컬 채널 효과만 대조했다. 실서비스 효과 대사는 아니다.

## 실패와 교정

| 관측 | 원인과 처리 |
| --- | --- |
| 첫 initdb 실패 | NAS 홈 경로가 0777로 관측돼 PostgreSQL이 거절했다. 새 0700 임시 경로를 사용하고 원 실패 로그를 보존했다. |
| SQLite run1 `ENOENT` | 시험용 runtime 복사본에서 필수 guidance 파일이 빠졌다. 두 원파일을 보충하고 로컬/NAS SHA256 일치를 확인했다. |
| SQLite run2 `lifecycle_directory_unsafe` | 정상 이행과 원자료 대조 후 engine bundle이 홈 runtime 권한을 거절했다. 실행본과 node_modules를 비공개 임시 경로의 실제 파일로 복사했다. 이전 복사본과 실패 담당/DB는 보존했다. |
| journal run1 페이지 지문 불일치 | 파일 기록은 commit 순서, SQL 조회는 테이블 키 순서였다. 실제 18개 테이블·71행을 중복까지 보존해 대조한 결과 모두 같았다. 각 원본 페이지 지문을 검사하고 테이블/열/원행을 비교하도록 시험 가정을 교정했다. 제품 이행 코드는 변경하지 않았다. |

SQLite run3의 전체 성공을 다시 실행하지 않았다. 교정한 비교 helper를 이미 보존된 실제 SQLite 자료에도 적용해 18개 테이블·67행과 원본 페이지 지문을 확인했다. journal은 실패한 흐름만 새 독립 DB 쌍에서 실행했다. 초기 실패를 없애거나 성공 횟수에 더하지 않는다.

## 실행본과 종료

Node 24.20.0 Linux x64, 선택 호스트 driver `pg@8.23.0`을 별도 package/lockfile에 고정했다. 기존 core package/lockfile은 유지했다. PostgreSQL은 비공개 Unix socket만 사용했으며 TCP listen address는 빈 문자열이었다. 모델/API 호출과 운영 시스템 변경은 0이다.

최종 macOS/NAS 소스 지문은 `34d86285b32363dd4d4c498885820725e43cf54b7705bfbca3c0c0883ac0f6a2`, 컴파일 지문은 `7e55006e4b89076e3492649aa1234f0ec51ed07492acbd011ef47378a39055d3`, 파일 수는 2,616개로 일치했다. 소스·컴파일·시험 실행기·guidance를 대조했다. 이번에는 제품 변경이 없어 build/core/type/전체 회귀를 반복하지 않았고 checkpoint404의 결과를 재사용했다. 신규 실행기 구문 확인과 실제 실행은 별도다.

실제 설치 fixture는 3,288개 항목의 엔진 A와 B를 사용했다. B의 `0.1.1-fixture-update.2`는 검증용 변경이며 출시한 새 제품 버전이 아니다. NAS native는 기존 checkpoint403 파일을 재사용했다.

두 실행은 종료했고 전용 PostgreSQL을 `pg_ctl -m fast -w stop`으로 종료했다. 뒤의 status는 exit 3 / `no server running`, PID 1931931과 postmaster.pid 부재를 확인했다. 전용 SSH master도 종료했다. 실패/성공 담당·원문·백업·DB는 `/tmp/secumon-postgres-405.sJ1Huq`에 보존했으며 임시 경로이므로 영구 보관을 보장하지 않는다. Git에는 합성 결과·지문·실행기만 저장한다.

## 남은 범위

기존 실PG 조건 중 **중간 이행/복원·pin 게시 중단, 동시 writer/관리 잠금, COMMIT 결과 불명, 스키마/호환 불일치, 동시 변경 백업과 운영 용량**은 이번 두 정상 흐름이 입증하지 않는다. [요구 대조](C10-postgres-real-audit.md)의 원래 조건으로 남긴다. 이미 통과한 로컬 전체 시험이나 이번 정상 흐름을 새 이유 없이 반복하지 않는다.

native Windows, 사내 MCP/Knox/A2A·실제 앱, 운영 규모/복원 목표와 선택 시범 운영도 미완료다. 실제 모델/API 시험 중단을 유지한다. 전체 C10/goal 완료를 선언하지 않는다.

근거: [체크포인트](../../runtime/evidence/checkpoint405.json), [SQLite 원 로그](../../runtime/evidence/C10-postgres-sqlite-run3.log), [journal 원 로그](../../runtime/evidence/C10-postgres-journal-run2.log), [원행 진단](../../runtime/evidence/C10-postgres-originals-diagnostic.log), [진행/실패 기록](C10-postgres-real-progress.md), [사용법](C10-postgres-real-usage.md).
