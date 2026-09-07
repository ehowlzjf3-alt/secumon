# state_split — P2 스키마 소유 분해 (register 배선됨·dormant)

state_domain.py 모놀리식 28테이블을 **네임스페이스별 DDL-as-data 모듈**로 추출.
**W2-a(2026-07-13) 배선됨**: `plugin/bootstrap.py`가 4 skill 네임스페이스를 `register_schema`로 **순수 메모리 등록**
(DB 무접근·**dormant**). 실제 apply(DDL)·런타임 `connection(ns)` 전환은 데이터 이동=컷오버 이벤트라 아직 미실행.
platform 5테이블은 **코어 소유**(secu-agent 67b8bd5+2b8080c provision) — 이 repo는 register 하지 않고 참조만.

## 파일 (P2 재귀속 반영 2026-07-12)
| 모듈 | 네임스페이스 | 테이블 | migrations | 소유·배선 |
|---|---|---|---|---|
| skill_smb.py | skill_smb | 13 (smb_*, mail_*, **+scan/asset_owner/screenshot**) | 44 | 스킬 `register_schema` |
| skill_dev_web.py | skill_dev_web | 4 (web_target_domain, dev_web_*) | 14 | 스킬 `register_schema` |
| skill_github.py | skill_github | 3 (github_*) | 18 | 스킬 `register_schema` |
| skill_confluence.py | skill_confluence | 3 (confluence_*) | 17 | 스킬 `register_schema` |
| platform.py | platform | 5 (control_flag/pipeline_heartbeat/pipeline_run/service_reply_message/devops_target) | 8 | **코어 소유** — 참조용, register 금지 |

**재귀속**: 자동추출은 도메인 접두 없는 8개를 platform 로 뭉갰으나 실사용 조사 결과 `scan`(네트워크 스윕)·
`screenshot`(share/file 증거)·`asset_owner`(owner enrichment)는 SMB 전용 → skill_smb 로 이동. platform 잔여
5개는 `component`/`domain` 키의 진짜 횡단(관측·제어·공용 답장·서비스 타깃).

각 모듈: `NAMESPACE`, `TABLES`, `IDLESS_TABLES`, `BASELINE_DDL`(CREATE), `MIGRATIONS`([(note, ddl)] 순서고정), `BACKFILLS`, `NOTES`.

## 검증 (결정적)
- ast로 원본 state_domain.py의 CREATE/ALTER/INDEX statement 집합 대조: **원본 173 = 모듈 173, 누락 0·창작 0**. (finding_lifecycle/finding_index 2는 코어 소유라 제외.)
- 재귀속 후: 총 28테이블 보존(skill_smb 13 + dev_web 4 + github 3 + confluence 3 + platform 5), 네임스페이스 간 중복 0.

## 컷오버 (P1 후) — 각 도메인 bootstrap에서 (skill 만; **platform 은 코어가 provision**)
```python
from service.state_split.skill_smb import NAMESPACE, BASELINE_DDL, MIGRATIONS, IDLESS_TABLES
# ⚠ orchestrator 는 migrations=[(version:int, ddl)] 를 기대 → (note,ddl) 를 enumerate 변환:
state_port.register_schema(
    NAMESPACE, BASELINE_DDL,
    migrations=[(i, ddl) for i, (_note, ddl) in enumerate(MIGRATIONS, start=1)],
    idless_tables=IDLESS_TABLES,
)
```
그 뒤 `state_domain.connect()` → `state_port.connection("skill_smb")`, 모놀리식 `_ensure_domain_schema` 제거.
**platform 은 register 하지 않는다**(코어 소유 — orchestrator 가 거부). 코어 세션 ASK:
`secu-agent/docs/design/p2-platform-provision-CORE-ASK.md`. 상위 설계: `digisecu-employee/docs/P2-STATE-CUTOVER-DESIGN.md`.

## 주의 (NOTES 요약)
- **백필 헬퍼가 네임스페이스를 걸침**: `_backfill_legacy_report_thread_cycles`(github/confluence/mail_thread 3도메인 UPDATE), `_backfill_dev_web_cycles`(dev_web). `_LEGACY_REPORT_CYCLE_KEY` 상수·`smb_current_cycle_key()` 의존 → 코드 이전 시 함께.
- **FK 순서**(smb): credential→share→dir/file→hit. mail_*/target류는 standalone.
- **cross-namespace 참조**는 전부 opaque BIGINT(SQL FK 없음) → 스키마 분리 안전, but orphan 탐지 별도(계약 §7).
- **컬럼은 baseline에 이미 포함**(신규 DB=CREATE, 기존 DB=ALTER 멱등 수렴). baseline 먼저, migrations 다음.
