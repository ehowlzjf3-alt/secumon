# CORE-ASK — 도메인 goal-phase 디스패처 확장점 (`register_goal_phase_dispatcher`)

> ## ✅ RESOLVED (core v3.88 — 2026-07-13)
>
> 코어가 이 요청을 **`register_fanout_adapter`**(`src/secu_agent/agent/fanout.py:263`)로 랜딩했다.
> 제안한 `PhaseContext→PhaseDecision` 디스패처와 **형태는 다르나**(4-hook 배치 fan-out 어댑터:
> `claim_next`/`build_spec`/`release`/`summarize`) **같은 필요를 충족**한다 — 도메인 batch/subnet
> 드라이버를 **순수 등록형 어댑터**로 재부착하고, drive 루프(claim→spec→release→summarize·budget/
> cancel·이벤트·goal 전이)는 **코어가 소유**한다. 요청한 codex 안전요건이 그대로 반영됨:
> `self` 미전달(어댑터는 store/runtime 포트만)·중복 name `ValueError`·§6는 tool 계층 강제.
>
> **스킬 랜딩 완료**: `plugin/bootstrap.py` 가 도메인별 `fanout_adapter.register()` 로 **14 어댑터**
> 등록(smb_task·smb_report_mail·smb_reply_verify + dev_web×3 + github×4 + confluence×4). 구현은
> 클린아키텍처 레이어(`domains/smb/application/fanout.py`·`infrastructure/runtime.py`)로 이관됨.
> **검증**: v3.88 코어 상대 `plugin.bootstrap` import clean + `list_fanout_adapters()`=14.
> 참조: 코어 `docs/ATTACHING-A-DOMAIN.md` §4(오케스트레이션 표)·§9(worked example).
>
> **후속(드리프트)**: 고아 `engine_extracts/ralph_domain_phases.py` 삭제 + 폐기된 phase 테스트
> (`test_smb_subnet_phase`·`test_smb_batch_driver` — 제거된 `RalphController._smb_subnet_phase`
> 직접 호출) 제거 → 신 메커니즘(fanout 어댑터/application 레이어) 테스트로 대체.
>
> _아래는 원(原) 요청 기록 — 이력 보존용._
> ---

> 대상: secu-agent 코어 세션. digisecu-employee 스킬의 도메인 batch/subnet/depth-first
> 드라이버 재부착을 위한 코어 확장점 요청. (브라우저 승인 CORE-ASK 와 병렬 · 독립.)
> 설계는 codex 적대적 리뷰 반영본.

## 배경 / 갭

코어 `7922a64`(v3.80 de-domain)가 `RalphController.run()` 의 도메인 batch-driver 디스패치
(web/smb/subnet/github/confluence/devops)를 제거하고 `ralph_controller.py:258-260` 에 **주석만**
남김("디스패치는 secu-agent-skill 로 적출됨 — **재부착 plugin hook 이 재공급**"). 그러나 그 훅은
**미구현**. 코어엔 `register_agent_type`·`register_finding_category`·`register_schema`·
`register_tool_policy` 는 있으나 **goal-phase 디스패처 훅은 없음**.

결과: agent-driven 도메인 배치 루프(pending 항목을 결정론적 continuation 으로 하나씩 처리 —
매 턴 judge 비용/오판 제거)가 **끊겨 있음**. 스킬은 적출본을 `engine_extracts/ralph_domain_phases.py`
에 원형 보존만 하고 배선 못 함(고아). de-domain 이전 모놀리스 대비 **기능 회귀**.

## 요청: `register_goal_phase_dispatcher` (codex 리뷰 반영)

코어가 `RalphController.run()` 의 258-260 지점(goal active 확인 후, `_goal_decompose_phase` 전)에
**등록된 도메인 phase 디스패처**를 호출하는 확장점을 제공. **`self`(RalphController) 를 넘기지
않는다** — 대신 불변 `PhaseContext` 와 닫힌 결정형(`PhaseDecision`)으로 경계를 좁힌다.

### 계약 (제안)

```python
# core: agent/goal_phase_registry.py (신규)
@dataclass(frozen=True)
class PhaseContext:
    session_id: str
    goal: Mapping[str, Any]           # 읽기전용 뷰
    is_cancelled: Callable[[], bool]  # 취소 뷰 (설정 불가)
    # continuation 주입/이벤트/goal 전이/budget 은 코어가 소유 — 디스패처는 '무엇을 할지'만 반환

class PhaseDecision:  # 닫힌 합 — NoMatch | Continue | Done | Pause
    ...

Dispatcher = Callable[[PhaseContext], "PhaseDecision | Awaitable[PhaseDecision]"]

def register_goal_phase_dispatcher(stable_id: str, fn: Dispatcher) -> None:
    """stable_id 로 고정 등록. 중복 id / 한 goal 에 복수 매치 → 거부(fail-closed)."""
```

### run() 통합 (258 지점)

```python
decision = await dispatch_goal_phases(PhaseContext(...))   # 등록 디스패처 순회
if decision.kind == "match":
    # 코어가 phase 를 구동: engine pass 반복 + continuation 주입 + 이벤트/goal 전이 소유.
    async for ev in self._drive_domain_phase(decision):     # 코어 소유 루프
        yield ev
        if isinstance(ev, (GoalDone, GoalPaused)): return
    continue   # 다음 run iteration
# NoMatch → 기존 decompose/evaluate 로 폴백
```

### codex 안전 요건 (반드시 반영)

1. **`self` 미전달**: SMB phase 는 session/state + 메시지 continuation 만 필요, `_run_engine_pass`
   불필요(`ralph_domain_phases.py:188-240` 근거). private 엔진 호출/state 변이/이벤트 위조 경로를
   원천 차단.
2. **코어가 소유**: budget/cancel 재점검, continuation 영속, goal 전이, canonical 이벤트 생성은
   코어만. 디스패처는 `PhaseDecision` 만 반환(무엇을 할지) — 어떻게/부작용은 코어가 집행.
3. **§6 우회 차단**: in-process 디스패처 코드는 tool policy 밖이다. 디스패처가 scanner/egress/
   terminal 을 직접 만지지 못하도록, PhaseDecision 은 **데이터**(다음 continuation 텍스트/완료·중단
   사유)만 담고 실행 부작용은 코어 경유. (마스킹 seal·egress allowlist 는 tool 계층에서 강제되나,
   디스패처가 tool 을 우회해 직접 I/O 하면 뚫린다 — 그래서 디스패처는 순수 결정 함수여야 함.)
4. **stable-ID 레지스트리 + 중복/복수매치 거부**: first-match 순서 의존은 핸들러를 조용히 가림 →
   한 goal 에 2개 이상 매치 시 에러. 예외/유효하지 않은 decision → fail-closed(폴백 아닌 pause).

## 스킬 측 (코어 훅 착수 후)

- 부트스트랩에서 `register_goal_phase_dispatcher("smb_web_service", dispatch)` 등록.
  dispatch 는 `goal_manager_domain.is_*_goal` 라우팅 → `PhaseDecision` 반환(순수 함수).
- `ralph_domain_phases.py` 의 phase 로직을 PhaseContext/PhaseDecision 규약으로 재작성.
- 테스트 `test_smb_subnet_phase`·`test_smb_batch_driver`·`test_ralph_controller_domain_orig` 를
  훅 API 로 재작성(현재는 `RalphController._smb_subnet_phase` 직접 호출 — 훅 랜딩 전까지 xfail).

## 착수 전 스킬 임시조치
위 3 테스트는 **xfail(reason="core goal-phase hook 미구현 — CORE-ASK")** 로 표기 → 스위트 그린
유지 + 갭 가시화(silent skip 금지).
