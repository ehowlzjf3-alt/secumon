# 실제 PostgreSQL 인수 계획

2026-09-09 · checkpoint405 진행 중. 기준 커밋 `6291525625ef34e87bdf664f73308c20c5cfb33b`. 직전 checkpoint404는 마지막 로컬 세 흐름을 완료·푸시했고, 이번에는 기존 PostgreSQL 실환경 잔여를 진행한다. 새로운 경계 요구를 추가하지 않는다.

## 실행 가능성 확인

현재 macOS에는 Docker CLI가 있으나 선택된 Desktop daemon socket이 없어 사용할 수 없다. NAS에서 PostgreSQL 15.18 서버의 `initdb`를 확인했다. 이전에 허용된 NAS 개발 시험 범위에서 별도의 사용자 소유 cluster·데이터/백업/담당/호스트 등록 디렉터리를 만든다. 운영 PostgreSQL이나 Docker 컨테이너에는 연결하지 않는다. PostgreSQL은 전용 비공개 Unix socket을 사용하고 TCP listener는 열지 않는다.

Node는 기존 격리 Node 24.20.0, runtime은 checkpoint404의 검증한 소스·컴파일 복사본을 사용한다. native는 checkpoint403 NAS Linux 빌드의 동일 파일을 새 runtime에 복사한다. `pg`는 npm registry에서 확인한 8.23.0을 별도 호스트 manifest/lockfile에 고정하고 runtime core 의존성에는 추가하지 않는다. [공식 호환 안내](https://node-postgres.com/)와 [Pool의 연결·반환 계약](https://node-postgres.com/apis/pool)을 따른다.

현재 SQL은 `secumon_pg.*`를 명시한다. `search_path` 변경을 격리 수단으로 사용하지 않고 새 cluster 안의 전용 DB를 구성별로 분리한다. source·restore DB를 구분하고, 복원 대상은 같은 binding을 준비한 빈 DB여야 한다. 연결 비밀이나 임의 운영 DSN을 수집하지 않는다.

## 기존 명명된 인수 순서

1. **V10-06:** SQLite/file-journal 담당의 실제 로컬 원문·업무/기억/대화 영수증·session/task head를 기존 fixture로 준비한다. prepare/apply migration 뒤 PostgreSQL 재열기에서 원자료를 대조하고 같은 operation 재호출과 원 저장소 retirement/activation을 확인한다.
2. **V10-07:** PostgreSQL snapshot과 로컬 원문을 기존 결합 backup API로 보관한다. 실제 DB 페이지·manifest 지문과 원문을 검사한다.
3. **V10-08:** 원 폴더를 삭제하지 않고 보존 이동한다. 미리 준비한 빈 복원 DB와 독립 host floor로 원 경로에 복원하고 원문·영수증·재시도를 확인한다. 복원 후 rebind/recovery는 기존 API의 실제 요구를 따른다.
4. **V10-18:** 기존 실제 engine bundle/install fixture로 check→최초 pin/같은 pin→현재 결합 backup 기반 update를 확인하고 PG 원자료가 바뀌지 않는지 대조한다.

위는 전체 명명된 요구의 실행 순서다. 한 흐름의 정상 통과를 모든 중단점·불명 COMMIT·동시성·TLS/권한·운영 규모 인수로 확대하지 않는다. 실제로 실행한 분기, 실패 단계와 코드 수정, 남은 분기를 별도로 기록한다. 기존 [V10 상세 조건](C06-C10-verification-plan.md#c10)은 유지한다.

기존 관리 API·원자료 fixture를 재사용하고 실제 DB에 연결하는 evidence fixture만 추가한다. 제품 소스는 실제 실패가 확인될 때 해당 원인을 수정한다. root가 source 동결·빌드·실행·증거·종료를 관리한다. 임시 DB와 원자료는 실패 원인 조사에 필요하면 보존하되 시험 서버는 명시 종료한다. 실제 모델/API 호출 중단을 유지하며 모델 응답은 기존 고정 합성 제공자만 사용한다.

다음 행동: NAS 격리 cluster/호스트 driver 준비 → 현재 build 지문·서버 연결 확인 → 기존 API 실제 DB 흐름 실행 → 결과·실패·미실행 분기 저장 → 완료 단위 커밋·푸시.
