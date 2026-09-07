# P2 — state 컷오버 설계 (skill/platform 테이블 public→소유 스키마)

> 상태: 설계(검증 완료·결정 대기). P1(v3.88 StatePort, secu-agent `docs/design/v3.88-state-port-p1.md`) 위에서 진행.
> 근거: 2 워크플로 — 이해 5-리더(wf_203deaa9) + 적대검증 6-refuter(wf_4048cd9b, 5 HOLDS·1 PARTIAL).
> 전제: 운영 중지 창(라이브 무중단 불요, 롤백 제약 완화 — P1과 동일). 물리 DB명 `threat_hunter` 유지.

---

## 0. 한 줄 요약
P1이 코어 16테이블을 `public→core`로 옮겼다. P2는 **스킬 23테이블을 `public→skill_<d>`, platform 5테이블을 `public→platform`으로** 옮기고, 등록(register_schema)·런타임 접근(connection)·게이트웨이 read를 새 스키마에 맞춘다. **platform은 코어 소유**(코어 부트스트랩이 relocate·provision)라 코어 세션 협업이 필수고, 실 데이터 이동(ALTER SET SCHEMA)은 **파괴적**이라 런북+리허설+사용자 확인 게이트를 둔다. **W1(코어)+W2(스킬)+이동은 한 정지 창의 원자적 컷오버**(rolling·부분배포 금지 — 3-codex + 코어 세션 확인).

## 1. P1이 P2에 남긴 계약 (정독 확인)
- `state.connection(ns)`(postgres_adapter): `SET LOCAL search_path TO <ns>, platform, core, pg_catalog, pg_temp` 를 **명시 트랜잭션 안**에서. **public fallback 없음** → 미이관 테이블 fail-fast.
- `state.register_schema(ns, baseline_ddl, *, migrations, idless_tables, concurrent_steps)`: 순수 메모리 등록, 첫 connection(ns)에서 lazy·멱등 적용. **ns ∈ {core, platform} 은 ValueError 로 거부**(코어 소유).
- orchestrator `migrations` 기대형 = `[(version:int, ddl:str)]`; drift는 `core.schema_version(namespace,phase,version,checksum)` 로 fail-closed.
- 코어 부트스트랩이 **빈** `platform` 스키마만 생성(테이블 0).

## 2. 검증된 사실 (적대검증 판정)
| # | 주장 | 판정 | 함의 |
|---|---|---|---|
| C1 | **게이트웨이는 P1으로 이미 파손** — RO 롤 search_path에 core 없음, `finding_lifecycle` unqualified→42P01 | **HOLDS** | P2와 무관하게 **즉시 수정** 필요(§6-W3). 결정적 축=search_path(USAGE 아님). |
| C2 | skill 커넥션에서 unqualified `finding_index/finding_lifecycle/memory_rule` → `core.<t>` resolve, reindex 2사이트 정상 | **HOLDS** | finding은 컷오버 무변경. 2 WRITE-WRITE reindex는 skill path에 core 있어 안전. |
| C3 | 도메인/platform 28 + core 16 = 44 이름 전부 disjoint | **HOLDS** | 전역 bare-name idless·cross-schema unqualified resolution 안전. |
| C4 | connection(ns) 단일-txn 래핑이 reindex/백필에 안전 | **HOLDS(단서)** | **claim-loop(smb_host_claim_next 등)은 autocommit 단일-UPDATE atomic 의존** → 단일 txn 래핑 부적합. 런타임 전환 전략 제약. |
| C5 | 한 커넥션에 여러 skill 스키마 섞는 함수 = `domain_entity_timeline` 1곳(유계) | **HOLDS** | cross-skill 런타임 표면 = 사실상 1함수. 나머지 *_overview는 단일 ns. |
| C6 | 실 데이터 `ALTER ... SET SCHEMA` 이동이 보존적 | **PARTIAL** | relocate 자체 보존적(identity 시퀀스 이동·cross-ns FK 0). 단 **skill_smb intra-ns FK 4개**(credential→share→dir/file→hit)는 같은 스키마로 함께 이동해야·split-brain 가드 필요. 런북 처리. |

## 3. 결정 분기 — **확정**(2026-07-12 사용자: "A로 진행, 코어 수정은 타 세션에")

### ★ 귀속 정정 (사용자 지적 반영 — 자동추출 catch-all 교정)
자동추출은 "도메인 접두 없는 것"을 전부 platform(8)로 뭉갰으나, **실사용 조사** 결과 절반은 SMB 전용이었다:
- **skill_smb로 재귀속**(3): `scan`(subnets/alive_total=네트워크 스윕, SMB만 write), `screenshot`(share_id/file_id=SMB 증거), `asset_owner`(SMB owner enrichment 단일 consumer; ip PK=idless).
- **platform 유지**(5, 진짜 횡단): `control_flag`·`pipeline_heartbeat`(component PK, dev_web·confluence·smb 공용), `pipeline_run`(component 관측 로그), `service_reply_message`(domain 컬럼 다도메인), `devops_target`(confluence·github·devops 공용).
근거: SMB의 **상태 계층만 미분해**(dev_web/github/confluence는 `domains/<d>/` 폴더 보유, SMB는 `state_domain.py` 모놀리식 상주) → 공용 뭉치는 도메인 동질성이 아니라 SMB 모놀리식 잔재였다.

### D1 — platform 소유권 = **Option A(확정)**
register_schema가 platform 거부(코어 소유) → platform.py의 `register_schema("platform")` 전제 **무효**. **코어가 부트스트랩에서 위 5테이블 relocate-or-create**(코어 16테이블 FULL-MOVE와 동일 패턴) + idless(control_flag·pipeline_heartbeat) + `_grant_readonly('platform')` + read-only validate-only. → **코어 세션 ASK**(브리프: `secu-agent/docs/design/p2-platform-provision-CORE-ASK.md`). (B/C/D 기각.)

### D2 — 런타임 전환 = **per-domain connection(ns)** (재귀속으로 실현)
정정 귀속 후 각 도메인 함수는 **자기 skill 스키마 + platform + core만** 건드린다 → P1 기존 `connection(ns)`로 충분, **`domain_connection()` 마스터키 seam 불요**(코어 변경 0). 처리 항목:
- `state_domain.connect()`(SMB 상태) → `connection('skill_smb')` 위임. `_ensure_domain_schema`·`_SCHEMA_READY`·`_split_sql_statements` 제거(dead).
- **cross-skill 함수 1곳**(`domain_entity_timeline`, C5): off-namespace 테이블(`skill_dev_web.web_target_domain`)만 schema-qualify.
- **claim-loop(C4 단서)**: 재시도 루프가 단일 txn 안에 갇히면 stale snapshot → 각 시도를 **독립 connection(ns)**(=독립 txn)로 열어 autocommit 등가 유지. (skill 측 처리, 코어 무관.)
- (SMB 상태 계층의 도메인 모듈 분해 = **P2b** 연기; 이번엔 소유 스키마로의 데이터 귀속 + connection 전환까지.)

### D3 — 실 데이터 파괴적 마이그레이션 go/no-go
skill/platform 테이블 `ALTER TABLE public.<t> SET SCHEMA <ns>` (§7 런북). **백업 + _test DB 리허설 + orphan/건수 검증 + 사용자 명시 go** 없이는 실행 안 함(안전 불변식). platform 5개는 코어 부트스트랩이 relocate하고, skill 테이블은 운영 런북이 relocate.

## 4. 확정 설계 (D1=A · D2=per-domain connection(ns))
1. **스킬 등록**(각 도메인 플러그인 import, 순수 메모리): state_split 모듈을 `register_schema(NAMESPACE, BASELINE_DDL, migrations=[(i,ddl) for i,(_n,ddl) in enumerate(MIGRATIONS,1)], idless_tables=IDLESS_TABLES)`. **(note,ddl)→(version,ddl) enumerate 변환** 필수(orchestrator가 int(v)). skill_smb는 scan/screenshot/asset_owner 흡수(+idless `asset_owner`).
2. **platform**(코어): D1-A(5테이블). skill은 platform 미등록.
3. **런타임**: D2. `state_domain.connect()` → `connection('skill_smb')`; cross-skill 1곳 qualify; claim-loop 독립 connection.
4. **finding**: 무변경(C2). 2 reindex 사이트는 새 path에서도 core resolve.
5. **BACKFILLS**(C4·이해리더): register/apply 경로 밖. **fresh DB는 전부 guarded no-op → skip**. 라이브 이관 시에만 apply_schema 후 per-namespace 1회 실행(`_LEGACY_REPORT_CYCLE_KEY='2026-W25'`·`smb_current_cycle_key()` 동반, cross-ns 루프는 네임스페이스별로 분할).
6. **게이트웨이**(§6-W3): RO 롤 search_path+USAGE+qualify. **P1 파손이라 선행 — 완료(2026-07-12)**.

## 5. 불변식 (append-only·fail-fast)
- **MIGRATIONS append-only**: drift checksum이 (ns,'migration',version) 키라, 중간 삽입/재정렬은 version→ddl 매핑을 밀어 **거짓 drift**. state_split 재생성은 원본 순서 보존+append만.
- **이름 disjoint 유지**(C3): 신규 스킬/platform 테이블은 core 16 + 타 스킬과 이름 충돌 금지.
- **finding은 core 소유·불이동**: skill_<d>/platform에 finding_index/finding_lifecycle 동명 테이블 생성 금지(shadow 방지).
- **no public fallback**: 이관 안 된 테이블은 즉시 실패 — 컷오버 전 28테이블 전부 목표 스키마 매핑 확인.

## 6. 워크스트림 (개발 병렬 · **배포 lockstep**)
- **W1 (코어 세션)**: platform 5테이블 relocate-or-create provision (Option A). **완료**(코어 세션 응답 — green + 그쪽 codex 리뷰). 브리프+응답 = `secu-agent/docs/design/p2-platform-provision-CORE-ASK.md`. **추가 코어 요청(codex A/C)**: ①범용 풀 `reset=`(baseline search_path+lock_timeout=0 복원, configure/reset 실패 시 커넥션 폐기) ②apply_schema의 lock_timeout 복원·advisory unlock 실패 미삼킴 ③platform 6 ALTER를 코어 소유 idempotent migration으로 보존(brief 정정) ④validate-only에 컬럼/인덱스 shape 검사 ⑤core `pyproject`에 psycopg 의존 선언.
- **W2 (skill repo·나)**: (a) state_split 재귀속 **완료**. → (b) **W2-a 완료(2026-07-13)**: 4 스킬 register_schema 배선(bootstrap `_register_state_schemas`, enumerate·dormant) + `state_domain._DOMAIN_SCHEMA`·`_ensure_domain_schema`에서 **platform 5 CREATE/8 ALTER/2 idless 제거**(코어 67b8bd5+2b8080c와 락스텝) + conftest schema-aware truncate + register 검증 테스트. **검증**: platform split-brain 18 errors→green(devops/entity/report 55 pass), register 5 pass. → (c·컷오버 시) **런타임 = per-domain `connection(ns)` 라우팅**(codex A): state_domain에 `connect(namespace)` 도입, 섹션별 전환(SMB→skill_smb·dev_web→skill_dev_web·github→skill_github·confluence→skill_confluence·공용→platform), claim-loop=시도별 새 connection, `domain_entity_timeline`=entity_type별 ns, reindex=connection(ns) 원자성 → `_ensure_domain_schema` 제거 → (d) BACKFILLS per-ns. **[c/d는 데이터 이동=컷오버 이벤트라 D3 게이트]**
- **W3 (gateway·나)**: RO 롤 search_path/USAGE/qualify. 1차 완료했으나 **codex B 결함 수정 필요**: `:gw_password`가 DO블록서 미치환(→\gexec)·P1구간 public 미부여·과도 GRANT·screenshot REVOKE 위치·RO롤 assert.
- **W4 (런북·D3 게이트)**: §7. skill 23테이블 relocate + 백업/_test 리허설/검증. [사용자 go]

## 7. 라이브 마이그레이션 런북 (D3 승인 후, _test 리허설 선행)
> ★ **순서 불변식(codex A)**: `apply_schema()`는 데이터 이동을 **안 함**(CREATE만) → 반드시 **relocate 먼저, apply_schema 나중**. 반대로 하면 빈 target + public 원본 split-brain.
> ★ **W1(코어)+W2(스킬)+데이터 이동 = 한 정지 창의 원자적 컷오버**(rolling 금지, codex A·C + 코어 세션). platform은 코어 부트스트랩이 relocate하고, **이 런북은 skill 23테이블**을 옮긴다.

1. **전 writer 정지 + 백업**: `pg_dump threat_hunter` 전체 + 대상 **skill 23테이블** 건수 스냅샷.
2. **register(순수 메모리)**: 4 skill 네임스페이스 `register_schema`(enumerate 변환). 아직 apply 안 함.
3. **relocate(FK 체인 함께, 한 명시 트랜잭션)**: public→skill_<d>. per-table 4-상태 split-brain 가드(public-only→이동, target-only→skip, 둘다→hard fail).
   - **skill_smb(13)**: smb_credential→smb_share→smb_directory/smb_file→smb_file_hit(intra-ns FK 4개 함께·C6), +smb_target_subnet, mail_*, **+scan·asset_owner·screenshot**(SMB 재귀속).
   - skill_dev_web(4): web_target_domain, dev_web_*. skill_github(3): github_*. skill_confluence(3): confluence_*.
   - **platform(5) 은 여기서 옮기지 않는다** — 코어 부트스트랩이 control_flag/pipeline_heartbeat/pipeline_run/service_reply_message/devops_target 를 relocate. (scan/asset_owner/screenshot 를 platform 으로 옮기면 코어 금지-잔재 가드가 즉시 실패 — 과거 런북 오류 정정.)
4. **apply_schema(relocate 뒤)** + BACKFILLS per-ns(fresh는 no-op skip).
5. **검증**: 건수=스냅샷, PK/identity·SMB FK·opaque orphan 비교, `to_regclass` 전수(각 테이블 정확히 한 스키마·public 잔여 0).
6. **connector 배선 + old 제거**: state_domain을 per-domain `connect(namespace)`로 전환, `_DOMAIN_SCHEMA`·`_ensure_domain_schema` 제거(platform 5 CREATE 포함 제거 — 락스텝 필수).
7. **GRANT**: `_grant_readonly` skill_*/platform + 게이트웨이 최소권한. screenshot(→skill_smb)/finding_index/smb_credential 제외 유지.
8. **롤백**: 실패 시 역방향 `SET SCHEMA public` 또는 백업 복원(운영 중지라 여유).

## 8. 코어 세션 ASK — **1건**(브리프: `secu-agent/docs/design/p2-platform-provision-CORE-ASK.md`)
코어가 할 일은 **platform 5테이블 provision 하나**. 브리프에 `_PLATFORM_SCHEMA` 리터럴·삽입지점·relocate-or-create·idless(control_flag·pipeline_heartbeat)·`_grant_readonly('platform')`·validate-only·불변식 전부 포함.
- 정정: platform=**5**테이블(scan/screenshot/asset_owner는 skill_smb로 재귀속), idless=**2**개.
- **`domain_connection()` seam 삭제** — 재귀속으로 per-domain connection(ns) 충분(코어 변경 0).
- `register_schema`의 core/platform 거부 **유지**(보안 경계·완화 금지).
- 게이트웨이 RO SQL은 §6-W3(나·완료).

## 9. 회수/수정 대상
- `secu-agent-skill/service/state_split/README.md`·`platform.py`의 `register_schema("platform", …)` 컷오버 스니펫 = **무효**. platform은 코어 소유로 정정.
- MIGRATIONS 형식 `(note,ddl)` — 배선 시 `(version,ddl)` 변환(위 §4-1).
