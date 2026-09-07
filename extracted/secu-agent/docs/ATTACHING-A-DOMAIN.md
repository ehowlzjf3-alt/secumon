# 도메인 붙이기 가이드 (Attaching a Domain to the Clean Core)

> **이 문서는** 새 점검 도메인(SMB/web/GitHub/Confluence/Jenkins…)을 **코어 0줄 수정으로** 이 엔진에
> 붙이는 방법을 한곳에 정리한 온보딩 가이드다. 훅 전체 목록 · 붙이는 순서 · skill/contract/safety/schema ·
> SAFETY-KEEP 불변식 · worked example · 검증까지.
>
> **전제**: 코어(`secu-agent`)는 도메인을 모르는 **플러그인 호스트**다. 도메인 코드는 별도 레포
> `~/project/secu-agent-skill` 에 살고 `SA_PLUGINS`/`SA_SKILLS_DIRS` 로 재부착된다. 이 문서는 코어가
> **소유한 계약**(어떤 훅을 어떤 규칙으로 제공하는지)을 설명한다 — 실제 도메인 구현 예시는 skill 레포의
> `plugin/bootstrap.py` 다.
>
> 관련: `docs/STATE-PORT-CONTRACT.md`(state 스키마) · `src/secu_agent/agent/CONTRACTS.md`(턴/실행/egress 계약) ·
> `docs/design/v3.85-clean-plugin-host.md`(왜 이렇게) · `CLAUDE.md`(SAFETY-KEEP) ·
> skill 레포 `SAFETY-NOTES.md`(도메인 안전 계약 권위).

---

## 1. 정신 모델 (왜 이렇게)

- **코어 = 프로토콜 + 안전 게이트 + `register_*` 훅.** 코어에 도메인 이름(`smb`/`github`)을 하드코딩하지 않는다.
- **도메인 = 등록형 어댑터.** 코어와의 접점은 딱 셋:
  1. **`SA_PLUGINS` 부트스트랩 모듈** — 모든 `register_*` 호출을 한곳에 모은 파이썬 모듈(§3).
  2. **`SA_SKILLS_DIRS` skills 디렉토리** — 에이전트 playbook + `safety.md`(§5).
  3. **`register_schema` state 네임스페이스** — 도메인 테이블을 자기 Postgres SCHEMA 에(§6).
- **등록 계약(모든 훅 공통)**:
  - **순수 메모리** — 플러그인 import 시 DB/pool 무접근(등록만; 실제 DDL/실행은 lazy).
  - **중복 등록 = `ValueError`** — silent override 금지(도메인이 서로/코어를 덮어쓰지 못함).
  - 대부분 `unregister_*` 동반 — 테스트/재부착 멱등.
  - **fail-loud** — 부트스트랩 import 실패는 `PluginLoadError` 로 기동을 막는다(부분 로드 금지).

---

## 2. 붙이는 순서 (체크리스트)

새 도메인 `foo` 를 붙인다고 하자. 순서:

1. **skill 작성** — `secu-agent skill new foo --dir <skills_dir>` → `SKILL.md` + `safety.md`(§5).
2. **state DDL** — 도메인 테이블 baseline DDL 작성 → `register_schema("skill_foo", FOO_DDL, …)`(§6).
3. **실행계약 + 도구셋** — `register_task_contract(FOO_CONTRACT)` + `register_task_toolset("foo", provider)`(§7).
4. **분류/판정/증거 훅** — 필요한 것만(§4 표): finding category, evidence judge, sensitive term signal 등.
5. **부트스트랩 모듈** — 위 register 호출 전부를 `plugin/bootstrap.py` 의 `register_all()` 에 모아 모듈 스코프에서 호출(§3).
6. **`.env` 배선** — `SA_PLUGINS=<...>/plugin/bootstrap.py`, `SA_SKILLS_DIRS=<...>/skills`.
7. **검증**(§10) — `skill lint` + 실 `SA_PLUGINS` load 스모크 + 코어 회귀(`SA_PLUGINS=""` 스위트 green 유지).

> 대부분의 도메인은 §7(실행계약+도구셋) + §5(skill+safety) + §6(state) 만으로 최소 동작한다.
> §4 의 판정/증거/타임라인 훅은 **필요할 때만** 추가(안 하면 코어 기본 동작).

---

## 3. 접점 1 — 플러그인 부트스트랩 (`SA_PLUGINS`)

**로더**: `src/secu_agent/plugins.py`.
- `SA_PLUGINS` = 콤마 또는 `os.pathsep` 구분. 각 entry = **importable 모듈**(`pkg.mod`) 또는 **`.py` 파일 경로**.
- **import 부작용으로 등록** — 모듈을 import 하면 그 안의 `register_*` 가 실행된다. 프로세스당 1회 멱등.
- 실패 = `PluginLoadError`(fail-loud). 모든 진입점(cli.main / agent 워커 / web `create_app`)에 배선됨.
- `.env.example`: `SA_PLUGINS="${HOME}/project/secu-agent-skill/plugin/bootstrap.py"` — **임의 코드 실행**이므로 신뢰된 경로만.

**부트스트랩 모듈 shape** (skill 레포 `plugin/bootstrap.py` 패턴):
```python
# 1) 코어 훅 import (각 훅의 출처 모듈은 §4 표 참조)
from secu_agent.state import register_schema, register_idless_table, register_timeline_source
from secu_agent.agent_type_registry import register_agent_type, register_task_type_alias
from secu_agent.agent.task_contract import register_task_contract
from secu_agent.agent.tools import register_task_toolset
from secu_agent.finding_taxonomy import register_finding_category
# … 필요한 훅만

def register_all() -> None:
    # 2) 의존 순서: state schema → agent_type → 실행계약 → 도구셋 → 분류/판정/…
    register_schema("skill_foo", FOO_DDL, idless_tables=["foo_flag"])
    register_agent_type("foo")
    register_task_contract(FOO_CONTRACT)
    register_task_toolset("foo", foo_toolset_provider)
    register_finding_category("foo_exposure", label="Foo 노출", priority=70)
    # …

register_all()   # 3) 모듈 스코프에서 호출 (import 시 등록)
```

---

## 4. 접점 2 — `register_*` 훅 전체 표 (코어가 제공)

정의는 전부 `src/secu_agent/` 아래. **필수**=최소 동작에 보통 필요, **선택**=필요할 때만(안 하면 코어 기본).

### 오케스트레이션 / 라우팅
| 훅 | 위치 | 등록하는 것 | 등급 |
|---|---|---|---|
| `register_task_toolset` | `agent/tools/__init__.py:102` | task_type 별 워커 도구셋 provider. `build_registry_for_task` 가 안전 파이프라인으로 조립(capability/MCP 게이트 우회 불가). | 필수 |
| `register_task_contract` | `agent/task_contract.py:66` | 워커 실행계약(`TaskContract`: user_msg/budget/metadata/terminal). **등록된 계약 = 허용된 task_type.** | 필수 |
| `register_agent_type` | `agent_type_registry.py:18` | 새 agent_type 이름. 코어 시드 = `agent`/`operator` 뿐. | 필수 |
| `register_task_type_alias` | `agent_type_registry.py:60` | agent_type 라벨 → 다른 task_type 라우팅(예: `foo`→`operator`). | 선택 |
| `register_task_plan` | `agent/task_plan.py:304` | 이름 있는 오케스트레이션 플랜(`TaskPlan`). | 선택 |
| `register_fanout_adapter` | `agent/fanout.py:263` | 배치 fan-out 어댑터(4-hook: claim_next/build_spec/release/summarize). | 선택 |

### 분류 / 증거 / 안전 판정
| 훅 | 위치 | 등록하는 것 | 등급 |
|---|---|---|---|
| `register_finding_category` | `finding_taxonomy.py:95` | finding 분류(key/label/priority; `requires_content_evidence=True` 면 콘텐츠-증거 게이트 합류). | 선택 |
| `register_task_type_canonicalizer` | `finding_taxonomy.py:37` | `fn(task_type, asset)->str|None` — asset 기준 task_type 정규화 휴리스틱. | 선택 |
| `register_evidence_judge` | `agent/evidence_judgment.py:282` | task_type 별 hit 판정기(증거 심층 판정). | 선택 |
| `register_category_evidence_judge` | `agent/evidence_judgment.py:330` | category 별 증거 판정기(코어 하드코딩 분기 前 소비). | 선택 |
| `register_browser_verified_task_type` | `agent/evidence_judgment.py:296` | 브라우저 검증 필요 task_type 표시(submit_finding 게이트). | 선택 |
| `register_pii_exclusion_policy` | `agent/evidence_judgment.py:348` | `fn(kind)->bool` 저가치 PII 제외. **코어 민감-PII 가드가 먼저 이김(SAFETY-KEEP).** | 선택 |
| `register_sensitive_term_signal` | `agent/semantic_validation.py:39` | 민감어휘 시그널(category/kind/terms). | 선택 |
| `register_text_signal_scanner` | `detectors/text_scan.py:33` | `fn(text,label)->Iterable[signal]` 문서/텍스트 스캐너. | 선택 |
| `register_tool_policy` | `agent/tool_policy.py:87` | `invoke_tool` 초크포인트의 추가 차단 게이트(`ToolPolicy`). **hardening-only.** | 선택 |

### finding 수명 / 전달
| 훅 | 위치 | 등록하는 것 | 등급 |
|---|---|---|---|
| `register_finding_enricher` | `agent/finding_enrichment.py:38` | `fn(...)->dict|None` finding 보강(예: pivot). | 선택 |
| `register_followup_hint` | `agent/finding_enrichment.py:45` | `fn(signals)->list[str]` 후속 넛지 공급(코어는 없음). | 선택 |
| `register_delivery_sink` | `agent/delivery.py:95` | egress 대상(`DeliverySink`, 예: Knox mail). **egress 게이트 통과 필수(§8).** | 선택 |

### state / 타임라인 / 검색 / web UI
| 훅 | 위치 | 등록하는 것 | 등급 |
|---|---|---|---|
| `register_schema` | `state.py:977` (→ `persistence/schema_orchestrator.py:55`) | StatePort 네임스페이스 `skill_<name>` + baseline DDL + migrations(§6). | 필수 |
| `register_idless_table` | `state.py:74` | id 컬럼 없는 테이블(자동 `RETURNING id` 억제). | 선택 |
| `register_memory_scope` | `state.py:2245` | 도메인 메모리 스코프 key(코어 base = global/operator). | 선택 |
| `register_entity_type` | `state.py:2622` | 타임라인 엔티티 축(`match ∈ {prefix,substring}`). | 선택 |
| `register_timeline_source` | `state.py:2668` | `fn(entity_type,entity_id)->list[event]` 타임라인 소스(도메인 테이블 조인). | 선택 |
| `register_index_renderer` | `state.py:2201` | `fn(row)->str` finding_index `kind` 렌더러(위치 표기 등). | 선택 |
| `register_web_router` | `web/app.py:36` | read-only GET 라우터. `create_app` 이 **`require_token` 의존성**과 함께 마운트(SAFETY-KEEP). | 선택 |
| `register_target_extractor` | `web/routes/chat.py:452` | `fn(name,tool_input)->str|None` UI 라벨용 "target" 추출(도메인 필드 우선). | 선택 |

### skills / LLM
| 훅 | 위치 | 등록하는 것 | 등급 |
|---|---|---|---|
| `register_skill_unlock_tools` | `agent/skills/__init__.py:52` | skill 선택 시 언락할 기본 도구. | 선택 |
| `register_instruction_preamble` | `agent/llm/instruction_preamble.py:23` | `fn()->str|None` LLM instruction 앞에 붙는 preamble(요청별). | 선택 |

> 전체 정의 재확인: `grep -rnE "^def register_[a-z_]+\(" src/secu_agent/ | grep -v unregister`.

---

## 5. 접점 3 — skill + `safety.md` 작성

**로더**: `src/secu_agent/agent/skills/__init__.py`.
- **형태 2종**: 단일파일 `<name>.md` 또는 디렉토리 `<name>/SKILL.md` + resource `.md`.
- frontmatter YAML: `name`(파일/디렉토리명과 **정확히 일치** — 불일치 시 **조용히 skip**, 최대 함정), `description`, `domain`, `when_to_use`, `triggers`.
- **`SA_SKILLS_DIRS`**: 코어 skill 디렉토리가 **항상 first-wins** — 외부가 코어 보안 skill 을 override 못 함(fail-safe).

**scaffold + lint CLI** (`src/secu_agent/cli.py`, `agent/skills/scaffold.py`):
```bash
# name==디렉토리명 보장(가장 흔한 "만들었는데 안 보임" 함정 회피) + api/schema/snippets/safety stub 생성
secu-agent skill new foo --dir <skills_dir> --domain foo --description "..." --triggers "..."

# 로더가 조용히 skip 할 모든 경우를 loud 하게: name 불일치·32KB cap·trigger 정규식·중복 충돌·SKILL.md 누락
secu-agent skill lint --dirs <skills_dir>
```

**`safety.md`(도메인 안전 계약 — 핵심)**:
- skill body 가 주입될 때 `### <name> 안전 계약 (safety.md — 위반 금지)` 헤더로 **함께** 주입된다.
- 도메인 고유 안전규칙(예: "우리 호스트가 아닌 대상에 수정 명령 금지")을 **코드/문서로 동봉** — 무관 도메인 safety 는 로드 안 됨(토큰 무낭비).
- 이게 "안전을 skill 과 함께 · 업무별로" 원칙의 구현체다.

---

## 6. 접점 4 — state 붙이기 (`register_schema` / StatePort)

```python
register_schema("skill_foo", FOO_BASELINE_DDL,
                migrations=[(1, "ALTER TABLE ... ADD COLUMN ...")],
                idless_tables=["foo_flag"],
                concurrent_steps=["CREATE INDEX CONCURRENTLY ..."])
```
- **네임스페이스 allowlist**: `^(core|platform|skill_[a-z0-9_]+)$` (`fullmatch` + 63자). **`core`/`platform` 는 코어 소유라 거부** — 도메인은 `skill_<name>` 만.
- **순수 메모리 등록** → 첫 `connection("skill_foo")` 에서 **lazy·멱등·원자** 적용(advisory lock 직렬화, `core.schema_version` checksum 추적, read-only 롤 = validate-only). 같은 checksum 재등록=no-op, 상이=conflict.
- **`connection("skill_foo")`**: search_path = `skill_foo, platform, core, pg_catalog, pg_temp` — 자기 스키마 격리 + platform/core 읽기. **public fallback 없음**(미이관 테이블 fail-fast).
- **idless**: `idless_tables=` 또는 `register_idless_table` — INSERT 시 자동 `RETURNING id` 억제(id 컬럼 없는 테이블).
- 전체 계약: **`docs/STATE-PORT-CONTRACT.md`**. platform(횡단) 5테이블은 코어가 provision(§ ASK 문서) — 도메인은 만들지 말 것.

---

## 7. 접점 5 — 실행계약 + 워커 도구셋 (최소 동작의 핵심)

새 task_type 이 워커로 돌려면 **둘 다** 필요:
- **`register_task_contract(TaskContract)`** — 워커 실행계약(user_msg 조립·budget·metadata·terminal 판정·errored artifact). **등록된 계약 = 허용된 task_type**(미등록 task_type 은 실행 거부).
- **`register_task_toolset(task_type, provider)`** — 워커 도구셋 provider. 코어 `build_registry_for_task` 가 **안전 파이프라인**으로 조립하므로 provider 가 capability/MCP 게이트를 우회할 수 없다(만능도구 주입 불가).
- 라우팅: `register_agent_type("foo")` + 필요시 `register_task_type_alias("foo","operator")`(예: chat 은 operator registry/prompt 재사용).

---

## 8. SAFETY-KEEP — 도메인이 **못 하는** 것 (완화 금지)

플러그인 표면은 넓지만 **안전 경계는 코어가 쥔다**. 아래는 도메인이 등록으로도 뚫지 못한다:

- **`register_schema` 는 `core`/`platform` 거부** — 공용 네임스페이스 탈취 방지.
- **`register_tool_policy`·`register_pii_exclusion_policy` = hardening-only** — 추가 차단만 가능, 코어 게이트가 먼저 이긴다. **진짜 민감 PII(주민번호/카드/계좌/전화/여권)는 코어 가드가 우선** — 어떤 등록 정책도 노출 못 함.
- **`register_web_router` = `require_token` 강제 주입** — 무인증 라우트 등록 불가. read-only GET 만.
- **skills first-wins** — 외부 skills 디렉토리가 코어 보안 skill 을 override 못 함.
- **egress**: `register_delivery_sink` 로 sink 를 붙여도 자율 발송은 4조건(sink opt-in·charter·수신자 allowlist·마스킹 후 잔존 0) 전부 충족 시에만. 기본 dry-run.
- **코어 불변식**은 도메인이 우회 못 함: 읽기전용 · `url_safety` 하드블록(file://·loopback·metadata·`.local`) · scope 한정 웹 탐색 · PII/secret 마스킹 · outbound dry-run · 인증 lockout-safe.
- 도메인 고유 규칙은 `safety.md`(§5)로 **코드/문서 동봉** — 우회가 아니라 강화 방향으로만.

상세 근거: `CLAUDE.md` "SAFETY-KEEP" · `src/secu_agent/agent/CONTRACTS.md`(egress/실행 계약) · skill 레포 `SAFETY-NOTES.md`.

---

## 9. Worked example (실제 참조)

**모든 `register_*` 를 한자리에서 의존 순서로 보려면**: skill 레포 `~/project/secu-agent-skill/plugin/bootstrap.py` 의
`register_all()` — SMB/dev_web/github/confluence 4도메인을 register_schema × 4 → detectors → agent_type × 6 →
memory_scope → finding_category → sensitive_term_signal → evidence_judge → browser_verified × 5 →
skill_unlock_tools → canonicalizer → instruction_preamble → fanout register() 순으로 등록한다. import 블록
자체가 "각 훅이 어느 코어 모듈에서 오는지" 목록이다.

최소 스켈레톤은 §3 참조.

---

## 10. 검증 (붙인 뒤 — 반드시)

1. **skill lint**: `secu-agent skill lint --dirs <skills_dir>` — 로더가 조용히 skip 할 모든 경우(name 불일치·32KB·trigger·중복)를 loud 하게.
2. **실 `SA_PLUGINS` load 스모크**(코어 단위 스위트는 `SA_PLUGINS=""` 라 **못 잡는다**):
   실제 `SA_PLUGINS` 로 `load_plugins()` 성공(등록 표면 온전) + finding 이 `core.finding_lifecycle` 에 안착하는지 fresh DB 로 확인.
   (예시 스크립트 패턴: `_ensure_dotenv()` → DSN 을 `<db>_smoke_test` 로 치환 → `load_plugins()` → `connect()` 부트스트랩 → finding_upsert 왕복.)
3. **코어 회귀**: `SA_PLUGINS="" SA_SKILLS_DIRS="" .venv/bin/python -m pytest -p no:randomly -q tests/` — 도메인 없이도 코어 단독 green 유지(코어가 도메인에 오염 안 됨을 보증).
4. **public 심볼 안전**: 코어의 `register_*`/기타 public 심볼을 제거·리네임했다면 **실 `SA_PLUGINS` 로 `load_plugins()` 스모크**로 검증 — skill 이 코어 심볼을 import/construct 하므로, 제거하면 부트스트랩이 죽는다(v3.85 회귀 교훈). 제거 시 back-compat alias 또는 skill lockstep.
