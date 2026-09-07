# S3 — SMB discovery 툴 배선 갭 + 도메인 phase 재부착 갭

> ## ✅ CLOSED (core v3.88 — 2026-07-13)
> - **S3a**(discovery 툴 → `sweep_core` repoint): 완료·커밋(#56, `46b7d26`).
> - **S3b**(도메인 phase 재부착): 코어가 **`register_fanout_adapter`**(v3.88)로 확장점 제공 →
>   스킬이 14 fanout 어댑터 배선(`plugin/bootstrap.py`, 클린아키텍처 application/infrastructure 레이어).
>   `docs/CORE-ASK-goal-phase-dispatcher.md` RESOLVED 참조. **후속**: 고아 `ralph_domain_phases.py`
>   삭제 + 폐기 phase 테스트(`test_smb_subnet_phase`·`test_smb_batch_driver`) → fanout 어댑터 테스트로 대체.
>
> _아래는 v3.80 시점 원(原) 진단 — 이력 보존용._
> ---

> de-domain(코어 v3.80 `7922a64`) 이후 남은 SMB 실패/에러 9+7건의 근본원인 진단과 수정 설계.
> 결론: **두 갈래 갭** — S3a(스킬 단독 수정 가능) + S3b(코어 확장점 필요, CORE-ASK).

---

## 근본원인

코어 `7922a64`(v3.80 "엔진 표면 de-domain + ralph/goal_manager 도메인 적출")가 SMB 도메인
오케스트레이션을 코어에서 제거:

1. `secu_agent.cli.{resolve_smb_targets, run_smb_discovery_core, _smb_discovery_raw, load_targets}` 제거.
2. `RalphController.{_smb_subnet_phase, _smb_batch_phase, _web_batch_phase, ...}` (도메인 batch 드라이버) 제거
   — `ralph_controller.py:258-260`에 **주석만** 남김: "디스패치는 secu-agent-skill 로 적출됨 — 재부착 plugin hook 이 재공급."

스킬은 로직을 재구성했으나 **일부만 배선**:
- `service/collector/sweep_core.py::sweep_subnet()` + `runner.py` — collector cron 경로(LLM-0)로 재구성됨. ✅
- `engine_extracts/ralph_domain_phases.py` — 도메인 phase 6종 **원형 보존만**(배선 안 됨). ❌
- `RunSmbDiscoveryTool`(operator "스캔해줘" 트리거)은 **repoint 안 됨** — 여전히 삭제된 `cli.*` 호출. ❌

---

## S3a — RunSmbDiscoveryTool 배선 갭 (스킬 단독, 지금 수정)

### 증상
`tools/operator_tools.py:352,362`가 `cli.resolve_smb_targets`·`cli.run_smb_discovery_core`(둘 다 제거됨)
호출 → 런타임 `AttributeError`. 툴 자체가 깨져 있음(테스트만의 문제 아님). 실패: `test_run_smb_discovery_tool.py` 9 ERROR
(autouse fixture 가 `cli.load_targets` monkeypatch 시도 → AttributeError).

### 수정 (3부)

**(1) `service/collector/sweep_core.py`에 오케스트레이션 재구성** — `sweep_subnet` 재사용(재구현 아님):

```python
def resolve_smb_targets(subnets: list[str] | None) -> list[str]:
    """input 명시 → 그것만. 비면 DB enabled 풀(smb_target_list enabled_only)."""
    if subnets:
        return list(subnets)
    return [r["subnet"] for r in state.smb_target_list(enabled_only=True)]

async def run_smb_discovery_core(
    targets: list[str], *, is_aborted=None,
) -> dict[str, Any]:
    """scan_start → 각 subnet sweep_subnet → scan_finish. 집계 dict 반환.
    KEEP 불변식: reset_auth_lockout_flag()는 pass 오너(=이 함수)가 시작에 1회.
    """
    scan_id = state.scan_start("smb", list(targets))
    smb.reset_auth_lockout_flag()               # pass 오너 1회 (AD lockout 안전)
    agg = {"alive_total": 0, "accessible_total": 0, "new_count": 0, "closed_count": 0}
    cancelled = False
    for subnet in targets:
        if is_aborted and is_aborted():
            cancelled = True
            break
        counts = await asyncio.to_thread(sweep_subnet, subnet, scan_id=scan_id)
        agg["alive_total"]      += counts["alive_hosts"]
        agg["accessible_total"] += counts["accessible_hosts"]
        agg["new_count"]        += counts["new_shares"]
        agg["closed_count"]     += counts["closed_shares"]
    state.scan_finish(scan_id, alive_total=agg["alive_total"],
                      accessible_total=agg["accessible_total"],
                      new_count=agg["new_count"], closed_count=agg["closed_count"])
    return {"scan_id": scan_id, **agg, "login_stats": {}, "cancelled": cancelled}
```

**(2) `tools/operator_tools.py::RunSmbDiscoveryTool.execute` repoint**:
- `from secu_agent import cli` → `from service.collector import sweep_core`
- `cli.resolve_smb_targets(...)` → `sweep_core.resolve_smb_targets(...)`
- `await cli.run_smb_discovery_core(targets, log_stream=None, is_aborted=...)` →
  `await sweep_core.run_smb_discovery_core(targets, is_aborted=...)`
- 요약 렌더링(scan_id/alive_total/accessible_total/new/closed/login_stats/cancelled)은 그대로 호환.

**(3) `test_run_smb_discovery_tool.py` 재작성** — 새 seam mock:
- `_no_yaml_targets` fixture 제거(yaml 경로 없음 — DB 풀 전용).
- `cli._smb_discovery_raw` monkeypatch 제거 → **네트워크 경계** mock:
  `smb.enumerate_hosts(subnet)`(→ host IP 리스트) + `smb.list_shares_modes(host)`(→ `SmbHostMultiMode`).
  이러면 `sweep_subnet`이 실제 DB upsert 를 하므로 upsert/scan_finish DB assertion 이 그대로 유효.
- 대상 툴 import(`from tools.operator_tools import RunSmbDiscoveryTool`)·DB assertion 유지.

### 안전 검토
- `reset_auth_lockout_flag()` 1회 호출은 러너와 동일한 "pass 오너 1회" 패턴 — AD lockout 회로차단 불변식 준수
  (중간 재-reset 아님).
- read-only 여부: discovery 는 `is_read_only=False`(share upsert 는 DB write, 네트워크는 enumerate/list_shares
  = read-only probe). 기존과 동일.
- 명시 subnet 이 DB 풀에 없어도 `subnet_mark_swept`/`smb_unseen_since_scan_apply`는 no-op(0 rows) — 안전.

---

## S3b — 도메인 phase batch-driver 재부착 갭 (CORE-ASK)

### 증상
`test_smb_subnet_phase.py`(4)·`test_smb_batch_driver.py`(3)·`test_ralph_controller_domain_orig.py`가
`RalphController(cs)._smb_subnet_phase(goal)` / `._smb_batch_phase(goal)` 호출 — 코어에서 제거됨, 재부착 훅 없음.

### 아키텍처 실태
- 코어 `RalphController.run()`(228-326)은 제네릭 phase(`_goal_decompose_phase`/`_goal_evaluate_phase`)만.
  도메인 batch/subnet 디스패치 자리(258-260)는 **주석**뿐 — 실행코드 0.
- 코어 확장점: `register_agent_type`·`register_finding_category`·`register_skill_unlock_tools`·`register_schema`·
  `register_tool_policy` 는 있으나 **도메인 goal-phase 디스패처 훅은 없음**.
- 스킬 `engine_extracts/ralph_domain_phases.py`: phase 6종 + run() 디스패치 블록을 **원형 보존**만.
  아무 런타임 경로에서 import/배선 안 됨(=고아).

### 결론: 실제 기능 갭
agent-driven 도메인 batch/subnet/depth-first 드라이버(web/smb/github/confluence/devops)가 현재 **끊겨 있음**.
collector cron 이 SMB sweep/walk(LLM-0)는 대체하지만, **goal-driven LLM 리뷰 배치 루프**(pending 항목을
결정론적 continuation 으로 하나씩 처리)는 재공급 안 됨 → de-domain 이전 모놀리스 대비 기능 회귀.

### 제안: 코어 확장점 `register_goal_phase_dispatcher`
코어가 `RalphController.run()`의 258-260 지점(goal active 확인 후, decompose 전)에 **등록된 도메인
phase 디스패처**를 호출하는 훅 제공. 디스패처 규약:

```python
# core: agent/goal_phase_registry.py (신규) — register_agent_type 패턴 동형
Dispatcher = Callable[[RalphController, dict], AsyncIterator[LoopEvent] | None]
def register_goal_phase_dispatcher(fn: Dispatcher) -> None: ...

# run() 내부 258 지점:
for dispatch in iter_goal_phase_dispatchers():
    handled = dispatch(self, goal)          # 이 goal 을 처리하면 async-iter 반환, 아니면 None
    if handled is not None:
        async for ev in handled:
            yield ev
            if isinstance(ev, (GoalDone, GoalPaused)): return
        break  # continue-loop 의미 — 다음 run iteration
else:
    ... 기존 decompose/evaluate ...
```

- 스킬은 부트스트랩에서 `register_goal_phase_dispatcher(smb_web_service_dispatch)` 등록.
  `smb_web_service_dispatch` 는 `ralph_domain_phases`의 is_*_goal 라우팅 + phase 함수를 감싼다
  (phase 함수는 `RalphController`의 private state 접근 필요 → 코어가 `self`를 넘겨주는 규약으로 해결).
- **안전**: 디스패처는 goal-phase(agent 루프 내부)만 담당. §6 불변식(마스킹 seal·egress allowlist·
  read-only hunting)은 tool/permission 계층에서 그대로 강제 — 디스패처가 우회할 수 없음.
- **대안(더 얇게)**: phase 함수가 `RalphController` private(`self._s`, `_run_engine_pass`)에 깊게 의존하므로,
  코어가 `self`를 넘기는 대신 **필요한 표면만 protected 계약(예: `PhaseContext`)으로 노출**하는 편이 캡슐화상 안전.
  codex 검토 포인트.

### 처리
- 코어 세션에 CORE-ASK 전달(브라우저 승인 CORE-ASK 와 병렬). 착수 전까지 `test_smb_subnet_phase`·
  `test_smb_batch_driver`·`test_ralph_controller_domain_orig`는 **xfail(reason=core hook 미구현)** 로 표기
  → 스위트 그린 유지 + 갭 가시화(silent skip 금지).

---

## 검증 계획
- S3a: `test_run_smb_discovery_tool.py` 재작성분 그린 + 스모크(실제 함수 시그니처 호환). 회귀 없음.
- S3b: CORE-ASK 문서화 + xfail 표기. 코어 훅 랜딩 후 테스트를 훅 API 로 재작성(후속).

---

## S3c — register_task_toolset 미배선 (조사 중 추가 발견 → S2 로 이관)

`RunSmbDiscoveryTool`(및 `tools/operator_tools.py` 전체)은 **런타임 어느 레지스트리에도 배선 안 됨**
(테스트만 참조 — orphan). 근본: 스킬 부트스트랩이 도메인/operator task_type 에 대해
`register_task_toolset` 을 **호출하지 않음**(de-domain 잔재). 그래서
`build_registry_for_task("smb_agent_type"|"operator"|"smb_share_master"|"smb_file_inspect")` 가
generic fallback(`scan_text`+`submit_finding`)으로 떨어짐. `roles/`(hr·strategy·orchestrator)는
이미 `register_task_toolset` 패턴을 씀 — 도메인도 동형 배선 필요.
**주의**: 런타임 `_tool_classes()`(예: task_agent = fetch/scan/probe/submit)와 테스트의
`smb_agent_type` 기대치(run_smb_discovery/owner_lookup/subnets)가 **불일치** → 단순 배선이 아니라
task_type **택소노미 재정합** 필요. codex 협업 대상. → **S2 에서 처리**.

관련 실패: test_run_smb_discovery_registered / test_subnet_tools / test_master_tools(9) /
test_inspect_tools(2) / test_smb_owner_lookup / test_image_inspect(operator).

## 부수 수정 (조사 중 발견)

- **checkpoint 픽스처 승격 누락**: 엔진 `tests/conftest.py::_tool_checkpoint_test_mode`
  (`set_checkpoint_enforced(False)`)가 conftest 루트 승격 시 누락 → cold-call `tool.execute()`
  테스트가 `ToolCheckpointBypass` 로 실패. 루트 `conftest.py` 에 autouse 로 재공급 → discovery
  cold-call 8건 복구. (다른 실패엔 영향 없음 — 그들은 execute 도달 전 registration/logic 에서 실패.)

## 최종 처리 결과
- **S3a 완료**: discovery 오케스트레이션 재구성(sweep_core.resolve_smb_targets + run_smb_discovery_core)
  + 툴 repoint + 테스트 재작성 + codex 하드닝(중복제거·finally scan_finish·status/errors). **8 passed**.
- **S3b 완료(진단·문서)**: 실제 기능 갭 확정 → `docs/CORE-ASK-goal-phase-dispatcher.md` 작성.
  phase 테스트 7건 xfail(CORE-ASK 참조). 코어 훅 착수 대기.
- **S3c → S2 이관**: register_task_toolset 택소노미 재정합(6 실패). checkpoint 픽스처는 이번에 수정.
- **R3(리네임/로직 8건) → S2**.
