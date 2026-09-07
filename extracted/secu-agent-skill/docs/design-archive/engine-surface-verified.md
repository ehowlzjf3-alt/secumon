# 엔진 무수정 확장 표면 — 코드 검증 결과 (설계 입력용 메모)

검증: Explore 에이전트가 `~/project/secu-agent` 직접 정독. 코드 근거 인용 확인됨.

## 무수정 가능 (지금 됨)
- **SA_PLUGINS env → plugin/bootstrap.py**: import 시 register_* 호출 (plugins.py L88-106, bootstrap.py L50-103 이미 동작).
- **register_agent_type()** (agent_type_registry.py L18-25) — 새 task_type 런타임 등록. valid_agent_types() 가 schedule_create 검증(state.py L2137).
- **register_fanout_adapter(name, factory)** (fanout.py L263-269) — public. adapter 구현은 skill repo 에 **아직 없음**(구현하면 됨).
- **register_skill_unlock_tools / SA_SKILLS_DIRS** (skills/__init__.py L42, L52-61, L232-296) — 외부 skill dir env 로드 + unlock 등록.
- **schedule_create(agent_type='smb', deliver='silent')** (state.py L2100, L2124-2162) — headless silent 지원.
- **finding_upsert** (state.py L1434-1498) — task_type 검증 **없음**. 새 task_type finding 자유.
- **register_idless_table / register_timeline_source** (state.py L77-82, L55-64).

## 엔진 수정 필수 (C) — 병목 3
1. **build_registry_for_task(task_type)** (tools/__init__.py L88-196): 코어 3타입 외 → generic fallback(ScanText+SubmitFinding만, L191-196). **task_type별 tool 화이트리스트 주입 hook 없음.** → 3-에이전트 contract 분리 장애물.
2. **ralph_controller.py L132-134**: 도메인 batch phase 디스패치 자리만 비고 plugin hook 없음. → goal/adversarial 큐 점검 자동 루프 불가.
3. **load_agents** (agents/__init__.py L65-98): SA_AGENTS_DIRS env 없음, hardcoded. 단 bootstrap 에서 load_agents(agents_dir=...) 직접 호출 우회 가능성(미검증).

## scheduler 주의
- scheduler_loop 가 엔진 web/app.py lifespan 에 묶임(L40-99) → 엔진 web 프로세스 떠야 cron fire.
- 따라서 skill repo 는 **독립 cron runner** 가 정답(엔진 안 띄워도 smb.py+state_domain 직접 import).

## 결론 분류
- (A) standalone 무수정: 수집 cron·POP3·메일·DB·UI·재검증 walk (smb.py + state_domain 직접).
- (B) 엔진에 무수정 주입: agent_type/skill/fanout-adapter 등록, silent schedule, 새 task_type finding.
- (C) 엔진수정/reattach 선행: task_type별 tool 화이트리스트, ralph phase 디스패치, (agents dir env).

## ★ 런타임 사실 확정 (코드+venv 실측 2026-06-13)
- **`secu-agent/.venv` 의 `import secu_agent` 는 실제로 `secu-agent/src/secu_agent`(구 모놀리스)로 해석된다.** (`__file__` 확인.)
- 따라서 현재 **런타임 설치본 = 구 secu-agent 모놀리스**. de-domained `secu-agent/src` 트리는 설계 참조용이고 실행 대상이 아님.
- 모놀리스에는 `cli.run_smb_discovery_core` / `_walk_one_share` / `resolve_smb_targets` **전부 존재**, `secu_agent.agent_types.smb` **import 됨** → 비평이 우려한 "discovery core 부재/import seam 깨짐"은 **현재 런타임 기준 사실 아님**(모놀리스가 다 가짐).
- **함의**: 수집기는 구 모놀리스 `cli.run_smb_discovery_core` 를 **재구현(re-home) 없이 직접 호출 가능**. 단 "엔진 무수정" 의 대상이 (a) secu-agent de-domain 코어인지 (b) 실제 런타임인 secu-agent 모놀리스인지 **사용자 확인 필요** — 설계의 토대가 갈림.
- `knox/owner_mail.send_owner_mail` 반환 = `{... "knox_result": parsed}` — **서버 할당 Message-ID 를 명시 surface 안 함** → reply correlation 은 message-id 보다 subject 태그(IP)+수신자+시간창이 1차. (모놀리스 knox 도 동일한지 재확인 대상.)
