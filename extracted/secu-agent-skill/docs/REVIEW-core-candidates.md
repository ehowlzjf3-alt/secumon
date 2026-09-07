# (C) 코어 환원 후보 — 기록 (이동 안 함)

재배치 명령문 §1·§4·§5 의 (C) 축: **실은 도메인 무관 제네릭인데 도메인 색만 입은 것**.
이번 재배치에선 **이동하지 않고 표시만** 한다. 코어로 되돌리는 결정/이동은 **엔진 트랙
T4**(`~/project/secu-agent`)가 한다(KEEP #5). 셋 다 루트 `tools/` 에 그대로 둔다.

판정 기준(§4): import 와 본문을 읽고 "도메인 테이블/도구에 묶이나, 아니면 generic
finding/state 위에 도나" — 묶이면 `_shared`, 안 묶이면 (C) 기록.

검증: 분류 워크플로 + 어드버서리얼 재검 + **메인 세션이 세 파일 본문 직접 정독**으로 확정.

---

## 1. `tools/domain_report_tool.py` — ✅ (C) 코어 환원 후보 (강한 확신)

- **domain 필드**: `domain = "core"` (line 143) — 이미 코어 선언.
- **import**: `state.finding_get/finding_list/finding_upsert/finding_update`(generic finding
  lifecycle), `finding_followup.append_finding_signal`, `finding_provenance.with_agent_provenance`,
  `schema.finding.Severity`. **도메인 테이블(smb_share/web_target/github_repo) 접근 0.**
- **본문**: `task_type` 은 `Literal["smb","web","github","jenkins","confluence"]` **문자열 enum**
  (v3.81 결정 #3 "코어는 string 만" 선례와 정합) — 특정 도메인에 묶이지 않고 normalized
  finding row 의 라벨로만 쓰인다. asset/severity/summary/status 전부 generic 필드.
- **판정**: generic finding/state 위에 돈다 → **(C). 코어 finding 도구로 환원 후보.**
  finding 리포팅은 코어 성격(§4)이 본문으로 확인됨. **이동 안 함, T4 가 코어 복귀 판단.**

## 2. `tools/entity_tools.py` — ✅ (C) 코어 환원 후보 (확신)

- **domain 필드**: 두 도구 모두 `domain = "core"` (line 42, 91).
- **import**: `report_writer.summarize_entity` / `generate_entity_report`, `llm.base.LLMClient`,
  `state`. **이 파일 자체엔 도메인 테이블 SQL 0** — 얇은 도구 래퍼.
- **본문**: `entity_type ∈ {host, domain, url}` — generic 엔티티 축. `summarize_entity`/
  `generate_entity_report` 는 **엔진 잔류 모듈**(`secu_agent.agent.report_writer`)이고,
  v3.81 통일원리상 코어가 generic finding/timeline 생산자다. 엔티티 타임라인·HTML 리포트는
  코어 성격(§4)이다.
- **분류 중 이견 메모**: 어드버서리얼 검자가 "report_writer 가 내부에서 smb_share/
  web_target/devops_target 를 엔티티별로 branch 조회하니 도메인-bound → `_shared` 이동"을
  주장. 그러나 (a) 그 branch 는 **엔진 잔류 모듈 내부**(이 repo 파일 아님)이고, (b) v3.81
  결정 #4 가 "코어 = generic finding 생산자, 엔티티 표현도 코어가 generic 으로" 라 본 도구는
  코어 환원이 **방향에 맞다**. entity_tools.py 자체는 도메인 테이블에 직접 안 묶임.
- **판정**: **(C). 이동 안 함**(`_shared` 아님 — 도메인 횡단 *유틸*이 아니라 코어 성격).
  T4 가 코어 복귀 + report_writer 의 도메인 branch de-domain 여부를 함께 판단.

## 3. `tools/operator_tools.py` — ⚠️ (C) 후보였으나 **SMB-도메인 바운드로 확정** (false (C))

- **domain 필드**: 5개 도구 전부 `domain = "smb"` (line 59, 113, 193, 268, 328).
- **import/본문**: `ListPendingSharesTool`/`ListRecentFindingsTool`/`QueryShareTool`/
  `ListSharesTool` 가 **raw SQL 로 `smb_share`/`smb_file` 직접 조회**
  (`SELECT ... FROM smb_share`, `JOIN smb_file f ... ON s.id=f.share_id`). `RunSmbDiscoveryTool`
  은 `cli.run_smb_discovery_core`/`resolve_smb_targets` 호출 → **impacket SMB 프로토콜 전이 의존**.
- **판정**: generic 이 아니라 **SMB 도메인 테이블/프로토콜에 묶임**. §4 의 "operator 는 엔진
  코어 task_type → 과추출 의심" 가설은 본문 확인 결과 **기각** — 이 파일은 operator task_type 의
  *SMB 전용 orchestrator 도구*다. 즉 진짜 (C)가 아니라 **(P)-성격의 SMB 도메인 파일**.
- **그러나 KEEP #5 / DoD 준수**: §4 가 이 파일을 (C) 후보로 **명시 나열**했고, 규칙은
  "(C) 후보 = 이동 금지, 기록만, T4 가 처리". 따라서 **이동하지 않고** 여기 판정만 남긴다.
  T4 가 두 갈래 중 택1:
  - (a) operator 의 SMB-바운드 도구를 `domains/smb/plugin/tools/` 로 이관(이 repo 의 smb 도메인
    소유로) — 가장 일관적. 단 operator task_type 자체는 코어라 엔진 registry branch 와의
    경계 설계 필요.
  - (b) operator 를 코어 task_type 으로 두되 SMB 도구는 plugin 재공급(registry branch)으로.

### operator 동반 자료 (이동 안 함, 참고)
- `tools/operator_tools.py` + `tests/test_operator_tools.py` — 루트 `tools/`·`tests/` 잔류.
- `tests/test_ralph_controller_domain_orig.py` — ralph_controller 도메인 phase **원형 회귀 참조**.
  `engine_extracts/ralph_domain_phases.py` 의 테스트 짝. 도메인 phase 재부착 검증용이라
  engine_extracts 트랙과 함께 다룬다 — 이동 안 함(루트 `tests/` 잔류).

---

## 요약 표

| 파일 | domain= | rides on | 판정 | 처리 |
|---|---|---|---|---|
| `tools/domain_report_tool.py` | core | generic finding/state | **(C) 코어 환원** | 기록만, T4 |
| `tools/entity_tools.py` | core | generic entity/finding | **(C) 코어 환원** | 기록만, T4 |
| `tools/operator_tools.py` | smb | smb_share/smb_file + impacket | **SMB-바운드(false (C))** | 기록만, T4 가 이관/재공급 결정 |

> 셋 다 **이번 재배치에서 물리 이동 없음**. 루트 `tools/`(+ 해당 `tests/`) 에 잔류.
> 코어 복귀/도메인 이관은 엔진 트랙 T4 소관.
