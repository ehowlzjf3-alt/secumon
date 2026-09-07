# StatePort 계약 (코어 persistence 포트&어댑터) — P1 핸드오프 스펙

> **목적**: 코어(secu-agent)가 구체 DB를 소유하는 대신 **persistence 포트**를 소유하고, 어댑터가 구현하며,
> 스킬(secu-agent-skill)이 **자기 state(테이블)를 자기 네임스페이스에 소유**하도록 하는 계약.
> 이 문서는 두 세션의 **계약서**다 — 코어 세션은 이 인터페이스를 구현(P1), 스킬 세션은 이 인터페이스에 코딩(P2).
> 변경 시 반드시 상대 세션에 통지(사용자 브리지).
>
> 근거: digisecu-employee `docs/CLEAN-AGENT-ARCHITECTURE.md`(전체 설계). 사용자 결정: 코어 개선 허용, DB는 스킬별
> 소유(스키마 네임스페이스), finding은 교차집계 위해 SSOT 유지, 물리 DB 1개.

> ### ✅ 구현 현황 (2026-07-13)
> **코어 몫(P1 + P2 platform + R2 하드닝)은 전부 구현·커밋·푸시 완료** — commit `43edd88`(P1: 코어 16테이블→`core`),
> `67b8bd5`(P2 platform: 횡단 5테이블→`platform`), `2b8080c`(R2 하드닝: provision 원자화·built-in `pg_catalog`
> 한정·풀 reset 콜백·read-only shape 검증). 코어 1,823 green + 실 SA_PLUGINS 스모크. 설계 상세=`design/v3.88-state-port-p1.md`
> §10, 배선 근거=`design/p2-platform-provision-CORE-ASK.md`.
> **현행 baseline search_path = `public, core, platform, pg_catalog, pg_temp`.** **남은 것 = P2 스킬 컷오버**
> (skill_* 테이블 이관 — 스킬 세션 담당, ★락스텝 필수: §6·design §10.1).

---

## 1. 핵심 결정 (요약)

1. 코어는 **`StatePort` 인터페이스**만 소유. 구체 Postgres 코드는 **`PostgresStateAdapter`**(어댑터)로 분리.
2. **네임스페이스 = Postgres SCHEMA**. 스킬은 `register_schema(namespace, ddl)`로 자기 테이블을 자기 스키마에 등록.
3. **물리 DB 1개**(threat_hunter 유지). 네임스페이스로 논리 분리:
   - `core` — finding SSOT(finding_lifecycle/finding_index) + 코어 프레임워크(state_meta/memory_rule/chat_*/schedule/token_usage). **코어 16테이블(구현 확정).**
   - `platform` — 횡단 운영테이블 **5개(구현 확정)**: `control_flag`·`pipeline_heartbeat`·`pipeline_run`·`service_reply_message`·`devops_target`.
     ※ 초안이 platform 에 뒀던 `scan`·`screenshot`·`asset_owner` 은 **`skill_smb` 재귀속**으로 정정(platform 에 있으면 부트스트랩 fail-closed).
   - `skill_<name>` — 각 스킬 소유(예: `skill_smb`.smb_share, `skill_github`.github_repo_target). **P2 스킬 세션 담당(미컷오버).**
4. **finding SSOT는 코어 소유**(포트 메서드 `finding_upsert/list/get`). 도메인은 자기 테이블만 소유하고 `finding_id`(opaque BIGINT)로 SSOT 참조.
5. **역호환**: 기존 `connect()`·`_core_connect()`·`register_idless_table()`·`finding_*` 호출자가 최소 변경으로 이관되게 shim 제공.

---

## 2. StatePort 인터페이스 (코어가 정의)

```python
# secu_agent/persistence/port.py (신규) — 순수 인터페이스, DB 무지
from typing import Protocol, Any, Iterator, ContextManager, Sequence

class Conn(Protocol):
    """네임스페이스 스코프 커넥션(어댑터 구현). SELECT/DML 실행."""
    def execute(self, sql: str, params: Sequence[Any] = ()) -> "Cursor": ...
    # 기존 sqlite-호환 래퍼(?→%s)와 fetchall/fetchone 유지 권장(호출자 호환)

class StatePort(Protocol):
    # ── 네임스페이스 스코프 커넥션 ──
    def connection(self, namespace: str = "core") -> ContextManager[Conn]:
        """지정 네임스페이스(스키마)로 search_path 스코프된 커넥션. with 블록.
        namespace 미지정=core. 어댑터는 커넥션 풀에서 빌려 ns 스코프 search_path 세팅
        (현행 정확값=§3 어댑터·design §10.3, pg_temp 마지막·public fallback 없음)."""

    # ── 스킬 state 소유 등록(신규 핵심 seam) — codex 반영: baseline과 마이그레이션 분리 ──
    def register_schema(
        self, namespace: str, baseline_ddl: str, *,
        migrations: Sequence[tuple[int, str]] = (),   # [(version, ddl), …] 순서 고정
        idless_tables: Sequence[str] = (),
        concurrent_steps: Sequence[str] = (),          # CREATE INDEX CONCURRENTLY 등 트랜잭션 밖 실행
    ) -> None:
        """스킬이 자기 네임스페이스(스키마)에 baseline DDL + 순서있는 마이그레이션을 등록.
        - **스킬은 자기 스키마만 소유** — 선행 스키마(core/platform)를 생성하지 않는다. 누락 시 명확히 실패.
        - baseline_ddl = 최초 CREATE TABLE/INDEX(멱등 IF NOT EXISTS). migrations = 버전별 ALTER 등(중앙 러너가
          schema_version 테이블에 기록, 이미 적용분 skip). concurrent_steps = INDEX CONCURRENTLY(트랜잭션 밖).
        - 등록만 하고 실제 실행은 중앙 오케스트레이터(아래)가 core→platform→skill_* 위상정렬 + advisory lock 하에.
        - 스키마명은 고정 allowlist(외부입력 금지). read-only 롤에선 DDL 미실행(기존 스키마 전제)."""

    # ── finding SSOT (코어 소유·불변 시그니처) ──
    def finding_upsert(self, *, task_type: str, asset: str, asset_kind: str, severity: str,
                       summary: str, fingerprint: str | None = None, owner: str | None = None,
                       ticket_ref: str | None = None, sla_due: float | None = None,
                       evidence_ref: str | None = None, extra: dict | None = None) -> tuple[int, bool]:
        """core 스키마 finding_lifecycle에 upsert(fingerprint UNIQUE dedup + per-fp advisory xact lock).
        **반환 = (finding_id, created)** — 구현 확정 시그니처(초안의 `-> int` 대체). fingerprint 미지정 시
        (task_type,asset,asset_kind)로 파생."""
    def finding_list(self, *, status: str | None = None, task_type: str | None = None,
                     since: float | None = None, limit: int = 50) -> list[dict]: ...
    def finding_get(self, finding_id: int) -> dict | None: ...
    # finding_index(FTS/pg_trgm) 관련 재색인 메서드도 core 소유로 유지.
```

**주의**: 시그니처는 현재 `secu_agent.state`의 `finding_upsert/finding_list`와 **동일하게** 두어 기존 호출자(도메인 submit_finding 래퍼)가 안 깨지게. 새로 생기는 것은 `connection(namespace)` + `register_schema`뿐.

---

## 3. PostgresStateAdapter (어댑터가 구현)

```python
# secu_agent/persistence/postgres_adapter.py (신규) — 지금 state.py의 Postgres 로직이 여기로 이동
class PostgresStateAdapter:  # implements StatePort
    · 커넥션 풀(현 _connect_postgres) 소유. DSN=SECU_AGENT_PG_DSN.
    · connection(namespace): 풀에서 빌려 **트랜잭션마다** `SET LOCAL search_path`(ns 스코프, 세션 아닌 SET LOCAL·
      따옴표 없이. 풀 누수/shadowing/prepared-stmt OID 방지). 반환 시 세션상태 리셋(풀 reset 콜백).
      **현행 정확값(어댑터 `_search_path_for`, design §10.3)**: core→`core, platform, pg_catalog, pg_temp` ·
      platform→`platform, core, pg_catalog, pg_temp` · skill_*→`<ns>, platform, core, pg_catalog, pg_temp`
      (전부 pg_temp 마지막·public fallback 없음=미이관 fail-fast).
      ※ 운영 SQL은 정규화(`skill_smb.smb_share`·`core.finding_lifecycle`) 권장, search_path는 레거시 호환용.
    · register_schema: 등록만 저장. 실제 실행은 아래 중앙 오케스트레이터.
    · finding_upsert/list/get: core.finding_lifecycle에 대해 현 로직 그대로.
    · 코어 프레임워크 테이블(state_meta/chat_*/schedule 등)은 core 스키마.

# 중앙 스키마 오케스트레이터(어댑터 소유) — codex #3,#5 반영
class SchemaOrchestrator:
    · 위상정렬 등록 실행: core → platform → skill_* 순서(선행 스키마 먼저).
    · pg_advisory_lock 으로 다중 워커 동시 실행 직렬화. schema_version 테이블에 (namespace, version) 기록·skip.
    · 각 ns: CREATE SCHEMA IF NOT EXISTS + baseline_ddl → 미적용 migrations 순서대로 → concurrent_steps(트랜잭션 밖).
    · 스키마별 권한(USAGE/CREATE) + default privileges 세팅(게이트웨이 read-only 롤 SELECT 포함).
```

**부트스트랩 안전(중요, digisecu M4 게이트웨이 정합)**: 오케스트레이터 DDL은 IF NOT EXISTS 멱등 + **read-only 롤에선 미실행**
(기존 스키마 전제) — digisecu 게이트웨이가 이 DB를 read-only로 읽으므로. finding_id는 SQL FK 없음 → **orphan 탐지/정리 별도 검증**.

---

## 4. 기존 코드 → 포트 이관 매핑 (역호환 shim)

| 현재(state.py / state_domain.py) | 신규 |
|---|---|
| `secu_agent.state.connect()` | `StatePort.connection("core")` (또는 default) |
| skill `state_domain.connect()` | `StatePort.connection("skill_<domain>")` |
| skill `state_domain._core_connect()` | `StatePort.connection(...)` |
| `register_idless_table(name)` | `register_schema(ns, ddl, idless_tables=[name])`의 idless 인자 |
| `state.finding_upsert/finding_list` | `StatePort.finding_*` (시그니처 동일) |
| skill `_DOMAIN_SCHEMA`(28테이블 한 덩어리) | 스킬별로 쪼개 각 도메인이 `register_schema("skill_<d>", <d>_DDL)` (P2, 스킬 세션 담당) |

코어 세션은 **shim**을 제공해 `secu_agent.state.connect()`/`finding_*` 기존 임포트가 계속 동작하게(내부적으로 어댑터 위임).
그래야 스킬/도메인 코드가 한 번에 안 바뀌어도 점진 이관 가능.

---

## 5. 코어 세션(P1) 산출물 체크리스트 — **전부 완료(43edd88·67b8bd5·2b8080c)**

- [x] `StatePort` 프로토콜(위 §2) — 순수 인터페이스. → `secu_agent/persistence/port.py`
- [x] `PostgresStateAdapter`(위 §3) — 현 Postgres 로직 위임 + `connection(namespace)` + `register_schema`. → `persistence/postgres_adapter.py`·`schema_orchestrator.py`
- [x] `core`/`platform` 스키마 부트스트랩(코어 프레임워크 + finding SSOT는 core, 횡단 5테이블은 platform). → `state._bootstrap_core_schema`·`_provision_platform_schema`
- [x] 역호환 shim(§4): 기존 `connect()`/`finding_*`/`register_idless_table` 유지(제거·리네임 0건).
- [x] read-only 롤 안전(validate-only·IF NOT EXISTS·platform 재귀속/6컬럼 shape fail-closed) — digisecu M4 게이트웨이 정합.
- [x] `register_agent_type`가 role 타입(hr/orchestrator/strategy)도 허용 — 회귀테스트 추가.
- [x] 단위검증: `test_state_port_{p1,seam,platform}.py`(포트 finding upsert/list, register_schema→connection→테이블 존재) + 실 SA_PLUGINS 스모크.

## 6. 스킬 세션(P2, 이 계약에 코딩) 예정 작업 — 참고 (코어 P1/P2platform/R2 완료 → 이제 착수 가능)
- state_domain의 `_DOMAIN_SCHEMA`를 도메인별 DDL 모듈로 분해(smb/dev_web/github/confluence).
- 각 도메인 bootstrap에서 `register_schema("skill_<d>", <d>_DDL)` 호출.
- 도메인 repository를 `connection("skill_<d>")` 경유로.
- **★ 횡단 5테이블(platform)은 코어가 이미 provision — 스킬은 `state_domain`에서 그 5개 `CREATE TABLE`을 제거**해야 함.
  `CREATE TABLE IF NOT EXISTS`(unqualified)는 **첫 스키마(public)만** 검사하므로(실측 확인), baseline에 platform이
  있어도 스킬이 5 CREATE를 유지하면 relocate 후 `public` 복제본을 재생성 → split-brain(코어 부트스트랩 fail-closed).
  → **코어와 lockstep 배포 필수**("독립 배포" 전제 거짓). scan/screenshot/asset_owner는 skill_smb 소유.
- **정규화 INSERT(`INSERT INTO skill_x.y`) 도입 전 코어가 `_PG_INSERT_RE`를 optional schema-prefix로 선행 패치** 필요.
- **런타임 컷오버·검증**: P1/P2/R2 코어가 완료됐으므로 이제 additive → 컷오버 진행 가능(백업·리허설·건수/orphan 검증).

---

## 7. 결정 (codex 협의 반영, 2026-07-12)

1. **네임스페이스 스코프**: 운영 SQL은 **정규화 테이블명**(`skill_smb.smb_share`, `core.finding_lifecycle`)이 안전(멀티워커 shadowing/OID/풀누수 회피). `search_path`는 레거시 호환용으로만, 쓰면 **트랜잭션마다 `SET LOCAL search_path`**(ns 스코프, 세션 아님, 따옴표 없음 — 현행 정확값=§3·design §10.3). → P2 컷오버는 점진: 우선 SET LOCAL로 무변경 동작 확보 후 hot-path부터 정규화.
2. **데이터 이관**: 클린 재시작 아님 → **검증된 `ALTER TABLE ... SET SCHEMA`**(백업·리허설·점검창·잠금 후 테이블/시퀀스/뷰/권한/건수/orphan 검증). finding_lifecycle→core, 도메인→skill_*, 횡단→platform.
3. **finding_index/pg_trgm·advisory lock**: core 스키마 고정. cross-schema 조인은 `core.finding_lifecycle` 명시 + finding_id 인덱스/통계가 관건. orphan(정본 없는 finding_id) 탐지 별도.
4. **오케스트레이션**: 중앙 러너가 core→platform→skill_* 위상정렬 + advisory lock + schema_version 기록. 스킬은 자기 스키마만 소유, 선행 스키마 생성 금지·누락 시 명확 실패.
5. **baseline vs migration 분리**: 각 도메인 = baseline DDL + 순서있는 migrations. CREATE INDEX CONCURRENTLY는 트랜잭션 밖 단계.
6. **잔여 점검(codex #6)**: 스키마별 USAGE/CREATE·default privileges, 풀반환 세션리셋, sequences/views/functions/triggers 내부 `public` 참조, raw SQL·테스트 fixture·백업/복구·prepared stmt·동시 마이그레이션. 스키마명 고정 allowlist.
