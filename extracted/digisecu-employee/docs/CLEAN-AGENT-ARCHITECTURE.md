# 클린 에이전트 아키텍처 — 설계 (draft v0)

> ⚠️ **2026-07-13 설계 기록이다. 현재 상태가 아니다.**
> 지금 무엇이 어떻게 도는지는 **`~/project/secu-agent-skill/CLAUDE.md`**(러너/리드/워커
> 3층 지도 + 실측 현황)를 보라. 이 문서는 그때의 결정 근거로만 쓴다.
>
> 이 설계 이후에 생긴 것 — 여기 §7 phasing 에 **없다**:
> - **리드/검토원 2단 층**(`_shared/lead_*.py`, 어댑터 5개). 등록 완료, **기동 러너 없음**.
> - 4도메인 팬아웃 워커 실기동(smb·dev_web·github·confluence).
>
> 그리고 §7 이 "✅ 완료" 로 적은 **P4 role 스킬(hr·orchestrator·strategy)** 은 저작만
> 끝났고 **런타임 배선이 없다**(`plugin/bootstrap.py` 에 등록 0). 리드 층과 같은 상태다.

> 목표: **진짜 깔끔한 구조의 디지털 임직원 플랫폼**. 코어는 최소(프로토콜+안전게이트+포트), 인프라는 어댑터,
> 스킬은 자기완결(자기 state 소유), 조직 역할(HR·orchestrator·strategy)도 스킬. digisecu가 이 위에서 거버넌스·표현.
>
> 상태: **논의용 초안** — 확정 전 사용자 검토·수정. 사용자 승인: 스킬 리비전 허용 + **필요 시 코어 개선 허용**.
> 근거: 이 저장소의 M1~M5 작업 + secu-agent(코어)/secu-agent-skill(도메인) 정찰(결합도·state·빌드·실행·메일).

---

## 0. 왜 리팩터하나 (문제 정의)

정찰로 확인된 현재 구조의 clean 저해 지점:

1. **코어가 구체 DB를 품음** — `secu_agent.state`가 Postgres 풀·`executescript(_SCHEMA)`·DDL을 직접 소유(state.py). 코어가 persistence 인프라에 강결합.
2. **도메인 state가 공유 모놀리식** — `service/state_domain.py`(6734줄)가 4도메인 28테이블을 한 모듈에 정의·일괄 생성(`_ensure_domain_schema`). 스킬별 소유가 아님.
3. **단일 bootstrap이 전 도메인 무조건 등록** — `plugin/bootstrap.py register_all()`이 6 agent_type을 조건 없이 전부 등록. 도메인 스코프 스위치 없음.
4. **공유 런타임** — `service/agents/`에 전 도메인 워커 루프가 섞임. `runtime.py:_skill_search_dirs()`가 4도메인 경로 하드코딩(분할 blocker).
5. **조직 역할이 스킬이 아님** — HR·orchestrator·strategy는 엔진 스킬로 존재하지 않음(digisecu 조직트리·A2A 개념으로만). "모든 임직원=엔진+스킬" 통일성이 깨짐.

이 5개를 푸는 것이 목표. 코어 무수정이 아니라 **코어도 최소화·포트화**하는 방향(사용자 허용).

---

## 1. 3층 아키텍처 (헥사고날)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 코어 (secu-agent) — 도메인 무지·인프라 무지                              │
│  · 프로토콜: chat_session → ralph_controller → engine, register_* 확장점 │
│  · 안전 게이트(§6): egress/masking-seal/tool-policy/done-critic/F5      │
│  · finding SSOT: finding 개념 + 라이프사이클(포트 경유, 구체 DB 아님)     │
│  · 포트(인터페이스): StatePort · LlmPort · DeliveryPort · McpPort        │
└──────────────────────────────────────────────────────────────────────┘
        ▲ 포트 구현 주입                    ▲ SA_PLUGINS attach
┌─────────────────────────────┐   ┌──────────────────────────────────────┐
│ 인프라 어댑터 (별도)          │   │ 스킬 (각자 자기완결 패키지)              │
│  · PostgresStateAdapter      │   │  work: smb · dev_web · github · confl. │
│    (풀·스키마/네임스페이스 할당)│   │  role: hr · orchestrator · strategy    │
│  · LlmGatewayAdapter(codex…) │   │  각 스킬 = agent_type + SKILL.md +      │
│  · KnoxMcpAdapter            │   │           tools + task_plans +          │
│  · (delivery sinks)          │   │           repositories(자기 state 소유)  │
└─────────────────────────────┘   │  + 얇은 공유 플랫폼(횡단 테이블·delivery)│
                                   └──────────────────────────────────────┘
        ▲
┌──────────────────────────────────────────────────────────────────────┐
│ digisecu (플랫폼 — 스킬 아님)                                            │
│  · control-plane: 거버넌스(승인 게이트·라이프사이클·예산·감사)            │
│  · gateway(M4): state read-only                                        │
│  · web: HR + 매니저 콘솔 + 임직원 책상                                    │
│  · persona → skill 오케스트레이션 (어느 임직원이 어느 스킬로 뜨나)         │
└──────────────────────────────────────────────────────────────────────┘
```

**계층 규칙**: 스킬 → 코어 포트(구체 어댑터 모름). 코어 → 아무 것도 import 안 함(순수 프로토콜+포트). 어댑터 → 코어 포트 구현.
digisecu → 코어/스킬 코드 import 안 함(M4 게이트웨이·control-plane 경계 유지), persona→skill 매핑으로 오케스트레이션.

---

## 2. persistence 아키텍처 (DB 질문의 답)

**결정: 코어는 구체 DB를 소유하지 않는다. `StatePort` 인터페이스만 소유하고, `PostgresStateAdapter`(별도 인프라)가 구현하며, 스킬별 스키마/네임스페이스를 할당한다.**

```
StatePort (코어 인터페이스)
  · connection(namespace) -> Conn         # 네임스페이스(스키마) 스코프 커넥션
  · register_schema(namespace, ddl)        # 스킬이 자기 테이블 DDL 등록
  · finding_upsert(...) / finding_list(...) # finding SSOT (공유 네임스페이스)

PostgresStateAdapter (인프라)
  · 단일 Postgres 인스턴스 + 커넥션 풀
  · 네임스페이스 = Postgres SCHEMA (search_path 스코프)
  · 스킬별 스키마 할당: skill_smb / skill_github / … + 공유: core(finding) / platform(횡단)
  · read-only role(M4 게이트웨이용)도 이 어댑터가 관리
```

- **물리 DB는 1개**(threat_hunter 유지) — finding 교차 집계(통합 트리아지·대시보드)가 한 쿼리가능 저장소를 요구.
- **"스킬이 자기 DB 소유" = 스키마(네임스페이스) 소유권**. `skill.smb`는 `skill_smb` 스키마에 자기 테이블(smb_share…)을 소유·등록. 물리 분리가 아니라 논리 소유.
- **finding SSOT**는 코어 소유(공유 `core` 스키마) — 전 도메인이 여기 제출. 도메인은 자기 큐/스레드 테이블만 소유하고 finding_id로 SSOT 참조(현재도 opaque BIGINT 참조라 정합).
- **횡단 운영테이블**(scan·pipeline_run/heartbeat·control_flag·asset_owner·screenshot·devops_target) = 공유 `platform` 스키마.
- **M4 게이트웨이**는 이 스키마 구조에 정확히 얹힘 — read-only role에 스킬별 스키마 SELECT만 부여(최소권한 유지).

이렇게 하면: (1) 스킬 독립성(자기 스키마 소유), (2) finding 교차집계 유지, (3) 코어 DB-무지(포트), (4) M4/M5 경계 보존.

---

## 3. 스킬 taxonomy

모든 디지털 임직원 = 코어 엔진 + 스킬 1개. 스킬 두 갈래 + 얇은 공유:

### work 스킬 (도메인 — 무슨 일)
| 스킬 | agent_type | 소유 state(스키마) | task_plans |
|---|---|---|---|
| smb | smb | skill_smb (smb_share/file/hit/target_subnet/credential) | smb_task·smb_report_mail·smb_reply_verify |
| dev_web | dev_web | skill_dev_web (dev_web_target/report_thread/recheck) | dev_web_task·_report·_reply_verify |
| github | github | skill_github (github_repo_target/report_thread/recheck) | github_task·_report·_recheck·_scan |
| confluence | confluence | skill_confluence (confluence_*) | confluence_task·_report·_recheck |

(web=베이스 웹점검 툴킷은 dev_web에 흡수(M4 결정). jenkins=미완 → 보류/별도.)

### role 스킬 (조직 역할 — 어떻게 일하나) — **신규**
| 스킬 | agent_type | 역할 | tools |
|---|---|---|---|
| hr | hr | 채용/배치/해고 **제안** | control-plane 승인 게이트 호출(hire/terminate 요청 생성). 실 실행은 사람 승인 뒤. |
| orchestrator | orchestrator | 도메인 매니저 | 워커 위임·모니터·전략 결정(A2A/큐). 도메인별 인스턴스(smb 매니저 등). |
| strategy | strategy | 타깃 열거·수집 전략 | collector 잡 운영(어느 subnet/repo/space를 언제 훑나). |

각 role 스킬도 `agent_type + SKILL.md + tools + task_plans` 구조. state는 대부분 platform/도메인 스키마를 read하거나 control-plane을 호출(자기 테이블 최소).

### 얇은 공유 플랫폼 스킬
횡단 테이블(scan/pipeline/control_flag/asset_owner/screenshot) + delivery/knox 배선 + 스키마-등록 collector. 모든 스킬이 의존하는 최소 공통.

---

## 4. 스킬 해부 (자기완결 패키지 구조)

```
skills/<skill>/                      # 예: skills/smb/
  SKILL.md                           # 에이전트 지식/지침 (SA_SKILLS_DIRS 노출)
  pyproject.toml                     # 자기 deps (smb=impacket/pymupdf; role=경량)
  src/<skill>/
    agent_type.py                    # register_agent_type("smb")
    bootstrap.py                     # 자기 스킬만 등록(도메인 스코프 SA_PLUGINS 타깃)
    schema.py                        # register_schema("skill_smb", SMB_DDL) — 자기 state 소유
    repositories.py                  # 자기 테이블 read/write(포트 경유)
    tools/                           # 자기 도구
    task_plans.py                    # task/report/verify plan
    runner.py                        # 실행 엔트리포인트(collector/task/…)
```

- **자기 bootstrap** → `SA_PLUGINS=skills/smb/src/smb/bootstrap.py`로 그 스킬만 attach(현재 all-in-one 문제 해결).
- **자기 schema** → `register_schema`로 자기 스키마에 자기 테이블만 등록(state_domain 모놀리식 해체).
- **자기 pyproject** → 도메인별 이미지가 자기 deps만(smb만 무거운 impacket).

---

## 5. 코어 개선 범위 (사용자 허용 하에)

현재 코어에서 손대야 할 것 (최소·역호환 우선):

1. **`state.py` → 포트+어댑터 분리**: `StatePort` 인터페이스 추출 + `PostgresStateAdapter` 구현. `finding_lifecycle`는 코어 `core` 스키마로. `register_schema(namespace, ddl)` 추가(스킬이 자기 테이블 등록).
2. **`register_idless_table` 확장** → `register_schema`로 일반화(테이블명뿐 아니라 DDL·네임스페이스).
3. **bootstrap 스코프**: `register_all()`을 스킬별 서브-bootstrap로 분해(또는 env allowlist 파라미터화). 이건 사실 스킬쪽(secu-agent-skill) 작업.
4. **`register_agent_type`에 role 타입 허용**: orchestrator/hr/strategy를 agent_type으로(현재 도메인만 상정하는지 확인 필요).

**원칙**: 코어 개선도 "프로토콜+포트+안전게이트"를 벗어나지 않음. 도메인·인프라 지식은 코어에 안 들어감.

---

## 6. digisecu 매핑 (변경 최소)

이미 M1~M5로 깔린 것이 이 구조와 정합:
- **persona → skill**: `contracts/runtime-mapping.ts`가 persona→agent_type를 이미 매핑. 여기에 role 스킬(hr/orchestrator/strategy)을 추가하면 됨. people_ops→hr, smb_sentinel→orchestrator(smb), smb_agent→smb work.
- **control-plane**: 거버넌스(승인/라이프사이클/예산/감사·M5 enable_send) — 어느 스킬도 아님. HR 스킬의 tools가 이 승인 게이트를 호출.
- **gateway(M4)**: 스킬별 스키마를 read-only로 읽음(스키마 구조와 정확히 정합, 최소권한 role).
- **web**: HR 콘솔(hr 스킬 관측)·매니저 콘솔(orchestrator 관측)·책상(worker 관측).

---

## 7. 단계별 phasing — 진행 현황 (코어 v3.88 기준, 2026-07-13)

> 코어가 **v3.80(de-domain) → v3.88**로 전진하며 이 phasing 대부분이 **랜딩**됨. 코어 온보딩
> 계약은 `secu-agent/docs/ATTACHING-A-DOMAIN.md`, state 계약은 `docs/STATE-PORT-CONTRACT.md`.

- **P0 설계 확정** (이 문서) — ✅ DB 포트화·스킬 taxonomy·코어 개선 범위 합의.
- **P1 코어 persistence 포트화** — ✅ **랜딩(v3.88, 코어 `43edd88`)**. `StatePort`+`PostgresStateAdapter`+
  `register_schema` + finding SSOT `core` 스키마 FULL-MOVE + platform 네임스페이스 provision(`67b8bd5`/
  `2b8080c`). idless INSERT 판정 하드닝(`ead000b`).
- **P2 도메인 state 소유 이관** — 🟢 **W2 완료(#55)** + **컷오버 설계 완료**(`docs/P2-STATE-CUTOVER-DESIGN.md`).
  스킬이 4 네임스페이스 `register_schema` **dormant** 등록, platform 5테이블은 코어 소유로 재귀속.
  잔여 = **실 데이터 relocate 컷오버**(D3 게이트, 라이브 DB 독립 마일스톤).
- **P3 스킬 자기완결화** — 🟡 부분. de-domain 으로 `plugin/bootstrap.py`가 등록형 어댑터
  (register_schema×4·agent_type×6·**fanout 어댑터 14종**·skill_unlock·canonicalizer·instruction_preamble·
  memory_scope)를 SA_PLUGINS 로 재부착. 스킬별 서브-bootstrap 분해는 미완.
- **P4 role 스킬 신설** — ✅ **완료(#52, `docs/P4-ROLE-SKILLS-DESIGN.md`)**. hr/orchestrator/strategy 저작.
- **P5 실행 검증** — 🕒 진행 중(M5 안전-발송 활성화 완료). 단계적(finding→dry-run→실발송).
- 각 단계 후 적대적 검증(이 세션의 패턴 계승 — de-domain 드리프트 정리도 19파일 병렬 분석+적대검증으로 수행).

> **de-domain 도메인 오케스트레이션 재부착**: 구 `RalphController._smb_subnet_phase` 등 도메인 batch
> 드라이버는 코어에서 적출되고 **`register_fanout_adapter`(v3.88)** + 독립 collector 로 재공급됨
> (스킬 `domains/*/application/fanout.py`). 이로써 P1~P2 시점의 두 CORE-ASK(goal-phase-dispatcher·
> task-toolset-extension)는 **랜딩된 seam(fanout·skill_unlock)으로 해소**, 별도 코어 확장점 불요.

---

## 8. 리스크·열린 질문

- **코어 포트화 범위**: state.py는 6700줄급 아님(코어는 더 작음)이나 finding/chat/schedule 등 다수 테이블 소유. 포트화가 코어 전반 리팩터로 번질 위험 → P1을 finding+state에 국한.
- **네임스페이스=스키마 스코프**가 엔진의 finding_index FTS(pg_trgm)·advisory lock과 양립하는지 확인 필요.
- **role 스킬의 실체**: orchestrator/hr가 "LLM 에이전트"로서 무엇을 자율 결정하나 vs digisecu control-plane이 결정론적으로 하나 — 경계 설계 필요(안전: 위험행동은 여전히 승인 게이트).
- **jenkins/web** 도메인 처리(web→dev_web 흡수 확정, jenkins 미완 보류).
- **실행 인프라 전제**: codex LLM 토큰·Knox MCP 서버(127.0.0.1:8005)·control_flag enabled — 실행검증(P5) 전 사용자 환경 확인.
- **마이그레이션**: 기존 threat_hunter 데이터(1696 findings 등)를 새 스키마 구조로 옮길지, 스키마만 재배치할지(public→네임스페이스) — 데이터 이관 계획 필요.

---

## 9. 다음 액션 (v3.88 랜딩 반영)

P0~P1 확정·랜딩, P2 W2·P4 완료. 남은 결정/작업:
- **P2 컷오버 실행**: persistence = **스키마 네임스페이스**(권장·확정). 실 데이터 relocate 는
  `docs/P2-STATE-CUTOVER-DESIGN.md` D3 게이트(백업+_test 리허설+사용자 go) 뒤 — 라이브 DB 독립 마일스톤.
- **role 스킬 자율성 범위**: orchestrator/hr 가 LLM 자율 결정 vs control-plane 결정론 — 위험행동은
  여전히 승인 게이트(#53 requester≠approver 강제).
- **데이터 이관 vs 클린 재시작**: 기존 `threat_hunter` 데이터는 스키마 재배치(public→네임스페이스),
  구조 재작성 아님 — P2 런북 §7.
