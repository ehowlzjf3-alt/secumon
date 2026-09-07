"""v3.89 Slice2 — 자율-능력(CapabilityGrant) 모델.

기본-거부 permits, operator-상한 교집합·floor, resolver 생성자 하드검증·감사·updated_input 미반영,
기본(빈 grant)=오늘 byte-for-byte(resolver None).
"""
from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path

import pytest

from secu_agent.agent.harness.audit import AuditLog
from secu_agent.agent.tools.approval import ApprovalRequest
from secu_agent.agent.tools.base import EmptyInput, Tool, ToolSuccess
from secu_agent.agent.tools.capability import (
    Capability,
    CapabilityGrant,
    CapabilityGrantResolver,
    build_effective_grants,
    is_floored,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _DestructiveTool(Tool[EmptyInput]):
    name = "browser_action"           # 실제 destructive 도구명 사용(resolver 검증 통과)
    description = "d"
    input_model = EmptyInput
    is_destructive = True

    async def execute(self, vi, ctx):
        return ToolSuccess("ok")


class _SafeTool(Tool[EmptyInput]):
    name = "browser_query"
    description = "s"
    input_model = EmptyInput
    is_destructive = False

    async def execute(self, vi, ctx):
        return ToolSuccess("ok")


class _TerminalTool(Tool[EmptyInput]):
    name = "terminal"                 # floor 상 never-auto — destructive·registry 존재해도 grant 거부
    description = "t"
    input_model = EmptyInput
    is_destructive = True

    async def execute(self, vi, ctx):
        return ToolSuccess("ok")


def _grant(caps, *, risk_optin=frozenset()) -> CapabilityGrant:
    return CapabilityGrant(
        grant_id="t:auto", capabilities=tuple(caps),
        operator_cap=frozenset(), risk_optin=risk_optin, scope={"task_id": "t"},
    )


def _audit() -> AuditLog:
    return AuditLog(Path(tempfile.mkdtemp()) / "a.jsonl")


def _req(tool, action=None, login_mode=None) -> ApprovalRequest:
    ti = {}
    if action is not None:
        ti["action"] = action
    if login_mode is not None:
        ti["login_mode"] = login_mode
    return ApprovalRequest(invocation_id=uuid.uuid4().hex, tool_name=tool, tool_input=ti, reason="ask")


# ── permits: 기본-거부 + action/floor/risk/login ──
def test_permits_default_deny():
    g = _grant([Capability("browser_action", frozenset({"navigate"}))])
    assert g.permits("browser_action", "navigate") is True
    assert g.permits("browser_action", "fill") is False        # cap.actions 밖
    assert g.permits("browser_action", None) is False          # action 없음
    assert g.permits("other_tool", "navigate") is False        # cap 없음


def test_permits_floored_action_denied():
    # fill 은 floor — grant 에 억지로 넣어도 permits 가 이긴다.
    g = _grant([Capability("browser_action", frozenset({"navigate", "fill"}))])
    assert is_floored("browser_action", "fill") is True
    assert g.permits("browser_action", "fill") is False
    assert g.permits("browser_action", "navigate") is True


def test_permits_risk_action_double_optin():
    cap = Capability("browser_action", frozenset({"navigate", "login"}),
                     risk_actions=frozenset({"login"}), login_modes=frozenset({"sso"}))
    g_no = _grant([cap])                                        # risk_optin 없음
    assert g_no.permits("browser_action", "login", login_mode="sso") is False
    g_yes = _grant([cap], risk_optin=frozenset({"browser_action:login"}))
    assert g_yes.permits("browser_action", "login", login_mode="sso") is True
    assert g_yes.permits("browser_action", "navigate") is True  # navigate 는 risk 아님 → 통과


def test_permits_login_mode_defaults_blocked():
    cap = Capability("browser_action", frozenset({"login"}),
                     risk_actions=frozenset({"login"}), login_modes=frozenset({"sso"}))
    g = _grant([cap], risk_optin=frozenset({"browser_action:login"}))
    assert g.permits("browser_action", "login", login_mode="sso") is True
    assert g.permits("browser_action", "login", login_mode="defaults") is False  # 브루트 금지
    assert g.permits("browser_action", "login", login_mode=None) is False


# ── build_effective_grants: operator 상한 ──
def test_build_none_when_no_operator_env(monkeypatch):
    monkeypatch.delenv("SA_AUTONOMOUS_TOOLS", raising=False)
    g = build_effective_grants(
        [Capability("browser_action", frozenset({"navigate"}))],
        scope={"task_id": "t"}, grant_id="t:auto")
    assert g is None                                            # env 미설정 → 하드 deny


def test_build_intersects_operator_cap(monkeypatch):
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action:navigate")  # login 미허가
    g = build_effective_grants(
        [Capability("browser_action", frozenset({"navigate", "login"}),
                    risk_actions=frozenset({"login"}), login_modes=frozenset({"sso"}))],
        scope={"task_id": "t"}, grant_id="t:auto")
    assert g is not None
    assert g.permits("browser_action", "navigate") is True
    # login 은 operator 상한 밖 → 축소됨
    assert g.permits("browser_action", "login", login_mode="sso") is False


def test_build_none_when_all_floored(monkeypatch):
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action")
    g = build_effective_grants(
        [Capability("browser_action", frozenset({"fill", "click"}))],  # 전부 floor
        scope={"task_id": "t"}, grant_id="t:auto")
    assert g is None


# ── resolver: 생성자 하드검증 + resolve + 감사 ──
def _reg() -> ToolRegistry:
    r = ToolRegistry()
    r.register(_DestructiveTool)
    r.register(_SafeTool)
    r.register(_TerminalTool)
    return r


def test_resolver_rejects_non_destructive():
    g = _grant([Capability("browser_query", frozenset({"snapshot"}))])
    with pytest.raises(ValueError, match="destructive"):
        CapabilityGrantResolver(g, _audit(), registry=_reg())


def test_resolver_rejects_unknown_tool():
    g = _grant([Capability("nonexistent", frozenset({"x"}))])
    with pytest.raises(ValueError, match="unknown tool"):
        CapabilityGrantResolver(g, _audit(), registry=_reg())


def test_resolver_rejects_floored_tool():
    g = _grant([Capability("terminal", frozenset({"run"}))])
    with pytest.raises(ValueError, match="never-auto|floored"):
        CapabilityGrantResolver(g, _audit(), registry=_reg())


def test_resolver_allow_and_deny(monkeypatch):
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")          # Slice3: 자율 브라우징 scope floor
    g = _grant([Capability("browser_action", frozenset({"navigate"}))])
    res = CapabilityGrantResolver(g, _audit(), registry=_reg())
    ok = asyncio.run(res.resolve(_req("browser_action", "navigate")))
    assert ok is not None and ok.behavior == "allow" and ok.updated_input is None
    deny = asyncio.run(res.resolve(_req("browser_action", "fill")))
    assert deny is None                                         # 미허가 → None(fail-closed)


def test_env_strict_no_wildcard_from_empty_action(monkeypatch):
    # ★ codex: `browser_action:`(빈 action) 은 whole-tool 로 오해석되면 안 됨(권한확대) → malformed skip.
    from secu_agent.agent.tools.autonomy import autonomous_allowed_capabilities
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action:, browser_session, x:y:z, :nope")
    caps = autonomous_allowed_capabilities()
    assert ("browser_session", "") in caps          # bare tool = 전체 OK
    assert ("browser_action", "") not in caps        # `browser_action:` → skip(전체 아님)
    assert not any(t == "x" for t, _ in caps)        # 다중 콜론 → skip
    assert not any(t == "" for t, _ in caps)         # 빈 tool → skip


def test_legacy_tool_gate_not_widened_by_action_suffix(monkeypatch):
    # ★ codex v2 [높음] 회귀: `SA_AUTONOMOUS_TOOLS=python_exec:x` 가 레거시 whole-tool opt-in 으로
    # 승격되면 안 됨(비-destructive python_exec 이 무인 즉시 allow 되던 회귀). bare 만 매칭.
    from secu_agent.agent.tools.autonomy import autonomous_allowed_tools, is_autonomous_tool_allowed
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "python_exec:anything, browser_session")
    assert is_autonomous_tool_allowed("python_exec") is False   # tool:action → 레거시 미승격
    assert is_autonomous_tool_allowed("browser_session") is True  # bare → 승격(구 동작)
    assert "python_exec" not in autonomous_allowed_tools()


def test_build_duplicate_no_cross_action_login_synthesis(monkeypatch):
    # ★ codex v2 [중간]: C1(login,{auto}) + C2(navigate,{sso}) 병합이 login+sso 를 합성하면 안 됨.
    # login_modes 는 login 선언 cap 에서만 취합 → login 은 auto(allowlist 밖)뿐이라 zombie 제거, navigate 만.
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action")
    monkeypatch.setenv("SA_AUTONOMOUS_RISK_ACTIONS", "browser_action:login")
    g = build_effective_grants([
        Capability("browser_action", frozenset({"login"}), risk_actions=frozenset({"login"}),
                   login_modes=frozenset({"auto"})),
        Capability("browser_action", frozenset({"navigate"}), login_modes=frozenset({"sso"})),
    ], scope={"task_id": "t"}, grant_id="t:auto")
    assert g is not None
    assert g.permits("browser_action", "navigate") is True
    assert g.permits("browser_action", "login", login_mode="sso") is False   # 합성 안 됨


def test_login_mode_allowlist_rejects_unknown(monkeypatch):
    # ★ codex v2 [중간]: sso allowlist — 미지/미래 mode(password)는 denylist 였다면 fail-open, allowlist 라 거부.
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action")
    monkeypatch.setenv("SA_AUTONOMOUS_RISK_ACTIONS", "browser_action:login")
    g = build_effective_grants([
        Capability("browser_action", frozenset({"login"}), risk_actions=frozenset({"login"}),
                   login_modes=frozenset({"password"})),   # 미지 mode 만
    ], scope={"task_id": "t"}, grant_id="t:auto")
    assert g is None                                         # login_modes ∩ {sso} = ∅ → zombie drop → None


def test_maybe_inject_grant_default_byte_for_byte(monkeypatch):
    # ★ codex v3 [중간]: 실제 cli 배선 헬퍼로 기본경로 검증 — 3케이스.
    from secu_agent.agent.tools.base import ToolContext
    from secu_agent.agent.tools.capability import maybe_inject_autonomous_grant

    def _fresh_ctx():
        d = Path(tempfile.mkdtemp())
        au = AuditLog(d / "au.jsonl")
        return ToolContext(evidence_dir=d, audit_log=AuditLog(d / "a.jsonl"), registry=_reg()), au

    def _configured(au) -> bool:  # configured 이벤트가 기록됐나(파일 존재 아닌 내용으로 판정)
        p = au.path
        return p.exists() and "autonomous_grant_configured" in p.read_text(encoding="utf-8")

    # (1) 빈 선언 → 미주입(resolver None, configured 감사 없음).
    ctx, au = _fresh_ctx()
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action")
    assert maybe_inject_autonomous_grant(ctx, au, _reg(), declared=(), scope={"task_id": "t"}) is None
    assert ctx.approval_resolver is None and not _configured(au)

    # (2) 선언 있지만 env 미설정 → grant None → **내부 가드**로 미주입(resolver None, 감사 없음).
    ctx, au = _fresh_ctx()
    monkeypatch.delenv("SA_AUTONOMOUS_TOOLS", raising=False)
    g = maybe_inject_autonomous_grant(
        ctx, au, _reg(),
        declared=[Capability("browser_action", frozenset({"navigate"}))], scope={"task_id": "t"})
    assert g is None and ctx.approval_resolver is None and not _configured(au)

    # (3) 선언 + env → resolver 주입 + configured 감사.
    ctx, au = _fresh_ctx()
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action:navigate")
    g = maybe_inject_autonomous_grant(
        ctx, au, _reg(),
        declared=[Capability("browser_action", frozenset({"navigate"}))], scope={"task_id": "t"})
    assert g is not None and ctx.approval_resolver is not None and _configured(au)


def test_operator_cap_snapshot_preserves_action(monkeypatch):
    # ★ codex v3 [중간]: operator_cap 스냅샷이 action 을 보존(browser_action:navigate ≠ bare browser_action).
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action:navigate")
    g = build_effective_grants(
        [Capability("browser_action", frozenset({"navigate"}))],
        scope={"task_id": "t"}, grant_id="t:auto")
    assert g is not None and "browser_action:navigate" in g.operator_cap


def test_login_is_core_required_risk_even_if_plugin_omits():
    # ★ codex: login 을 plugin 이 risk_actions 에 안 넣어도 코어가 강제 위험-단위(risk_optin 필요).
    cap = Capability("browser_action", frozenset({"login"}),
                     risk_actions=frozenset(),        # ← plugin 이 login 을 risk 로 표시 안 함
                     login_modes=frozenset({"sso"}))
    g_no = _grant([cap])                              # risk_optin 없음
    assert g_no.permits("browser_action", "login", login_mode="sso") is False  # 그래도 차단
    g_yes = _grant([cap], risk_optin=frozenset({"browser_action:login"}))
    assert g_yes.permits("browser_action", "login", login_mode="sso") is True


def test_login_mode_auto_blocked():
    # ★ codex: auto 는 non-SSO 에서 defaults 로 흘러 브루트 위험 → 자율에서 sso-only.
    cap = Capability("browser_action", frozenset({"login"}),
                     risk_actions=frozenset({"login"}), login_modes=frozenset({"sso", "auto"}))
    g = _grant([cap], risk_optin=frozenset({"browser_action:login"}))
    assert g.permits("browser_action", "login", login_mode="sso") is True
    assert g.permits("browser_action", "login", login_mode="auto") is False


def test_resolver_rejects_duplicate_tool():
    # ★ codex: 같은 tool 중복 Capability 는 오설정 → fail-loud.
    g = _grant([Capability("browser_action", frozenset({"navigate"})),
                Capability("browser_action", frozenset({"login"}))])
    with pytest.raises(ValueError, match="duplicate"):
        CapabilityGrantResolver(g, _audit(), registry=_reg())


def test_build_drops_zombie_login_without_risk_optin(monkeypatch):
    # login-only 선언인데 operator risk opt-in 없으면 permit 불가 → 유효 grant None(zombie 미주입).
    monkeypatch.setenv("SA_AUTONOMOUS_TOOLS", "browser_action")
    monkeypatch.delenv("SA_AUTONOMOUS_RISK_ACTIONS", raising=False)
    g = build_effective_grants(
        [Capability("browser_action", frozenset({"login"}),
                    risk_actions=frozenset({"login"}), login_modes=frozenset({"sso"}))],
        scope={"task_id": "t"}, grant_id="t:auto")
    assert g is None


def test_resolver_audits_approval(monkeypatch):
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")  # Slice3: 자율 브라우징 scope floor
    g = _grant([Capability("browser_action", frozenset({"navigate"}))])
    audit = _audit()
    res = CapabilityGrantResolver(g, audit, registry=_reg())
    asyncio.run(res.resolve(_req("browser_action", "navigate")))
    lines = audit.path.read_text(encoding="utf-8").strip().splitlines()
    assert any("autonomous_approval" in ln and "navigate" in ln for ln in lines)


# ── 통합: 실 invoke_tool 경로(pydantic action → ask → resolver → execute) ──
class _ActionInput(EmptyInput):
    action: str = "navigate"


class _ActionTool(Tool[_ActionInput]):
    name = "browser_action"
    description = "d"
    input_model = _ActionInput
    is_destructive = True

    async def execute(self, vi, ctx):
        return ToolSuccess(f"did:{vi.action}")


def test_integration_grant_allows_and_denies_via_invoke_tool(monkeypatch):
    from secu_agent.agent.tools.base import ToolContext, ToolError, ToolInvocation
    from secu_agent.agent.tools.invoker import invoke_tool

    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")  # Slice3: 자율 브라우징 scope floor
    reg = ToolRegistry()
    reg.register(_ActionTool)
    d = Path(tempfile.mkdtemp())
    grant = _grant([Capability("browser_action", frozenset({"navigate"}))])
    ctx = ToolContext(
        evidence_dir=d, audit_log=AuditLog(d / "a.jsonl"), registry=reg,
        approval_resolver=CapabilityGrantResolver(grant, AuditLog(d / "au.jsonl"), registry=reg),
    )

    def _inv(action):
        return asyncio.run(invoke_tool(
            ToolInvocation(id=uuid.uuid4().hex, name="browser_action", input={"action": action}),
            reg, ctx))

    ok = _inv("navigate")                              # granted → destructive ask → resolver allow → 실행
    assert isinstance(ok, ToolSuccess) and ok.content == "did:navigate"
    deny = _inv("fill")                                # floored·미허가 → resolver None → fail-closed
    assert isinstance(deny, ToolError) and deny.kind == "permission"


def test_integration_no_resolver_is_fail_closed():
    # resolver 미주입(기본) → destructive 는 오늘처럼 approval required (byte-for-byte).
    from secu_agent.agent.tools.base import ToolContext, ToolError, ToolInvocation
    from secu_agent.agent.tools.invoker import invoke_tool

    reg = ToolRegistry()
    reg.register(_ActionTool)
    d = Path(tempfile.mkdtemp())
    ctx = ToolContext(evidence_dir=d, audit_log=AuditLog(d / "a.jsonl"), registry=reg)  # resolver None
    res = asyncio.run(invoke_tool(
        ToolInvocation(id=uuid.uuid4().hex, name="browser_action", input={"action": "navigate"}),
        reg, ctx))
    assert isinstance(res, ToolError) and res.kind == "permission"


# ============================================================
# Slice3 Part C: 자율 login floor — IdP allowlist 필수 + one-shot latch
# ============================================================
def _login_grant(risk_optin=frozenset({"browser_action:login"})) -> CapabilityGrant:
    cap = Capability("browser_action", frozenset({"login"}),
                     risk_actions=frozenset({"login"}), login_modes=frozenset({"sso"}))
    return CapabilityGrant(
        grant_id="t:auto", capabilities=(cap,),
        operator_cap=frozenset(), risk_optin=risk_optin, scope={"task_id": "t"},
    )


def _audit_has(au: AuditLog, needle: str) -> bool:
    return au.path.exists() and needle in au.path.read_text(encoding="utf-8")


def test_autonomous_login_denied_without_idp_allowlist(monkeypatch):
    # permits 는 통과하나(risk opt-in·sso), Part C 가 SA_WEB_SSO_IDP_ORIGINS 미설정이면 fail-closed.
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")          # scope floor 통과 → login floor 도달
    monkeypatch.delenv("SA_WEB_SSO_IDP_ORIGINS", raising=False)
    au = _audit()
    res = CapabilityGrantResolver(_login_grant(), au, registry=_reg())
    out = asyncio.run(res.resolve(_req("browser_action", "login", login_mode="sso")))
    assert out is None
    assert _audit_has(au, "autonomous_login_denied")
    assert not _audit_has(au, "autonomous_approval")


def test_autonomous_login_one_shot_latch(monkeypatch):
    # allowlist 설정 → 1회 allow, 2회차는 process-global latch 로 deny(lockout 방지).
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "https://secsso.example.com")
    au = _audit()
    res = CapabilityGrantResolver(_login_grant(), au, registry=_reg())
    first = asyncio.run(res.resolve(_req("browser_action", "login", login_mode="sso")))
    assert first is not None and first.behavior == "allow"
    second = asyncio.run(res.resolve(_req("browser_action", "login", login_mode="sso")))
    assert second is None
    assert _audit_has(au, "autonomous_login_denied")


def test_autonomous_login_no_public_reset_api():
    # ★ codex: 프로덕션 reset API 없음 — _reset_autonomous_login_latch 함수 미제공.
    from secu_agent.agent.tools import capability
    assert not hasattr(capability, "_reset_autonomous_login_latch")


def test_autonomous_login_latch_direct_reset_for_tests(monkeypatch):
    from secu_agent.agent.tools import capability
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "https://secsso.example.com")
    res = CapabilityGrantResolver(_login_grant(), _audit(), registry=_reg())
    assert asyncio.run(res.resolve(_req("browser_action", "login", login_mode="sso"))) is not None
    assert asyncio.run(res.resolve(_req("browser_action", "login", login_mode="sso"))) is None
    capability._AUTONOMOUS_LOGIN_LATCH["consumed"] = False  # 테스트 전용 직접 초기화
    assert asyncio.run(res.resolve(_req("browser_action", "login", login_mode="sso"))) is not None


def test_autonomous_navigate_unaffected_by_login_floor(monkeypatch):
    # login floor 는 login 액션만 — navigate 는 allowlist/latch 무관(byte-for-byte).
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")
    monkeypatch.delenv("SA_WEB_SSO_IDP_ORIGINS", raising=False)
    g = _grant([Capability("browser_action", frozenset({"navigate"}))])
    res = CapabilityGrantResolver(g, _audit(), registry=_reg())
    assert asyncio.run(res.resolve(_req("browser_action", "navigate"))) is not None
    assert asyncio.run(res.resolve(_req("browser_action", "navigate"))) is not None  # latch 무영향


def test_autonomous_browser_denied_without_scope(monkeypatch):
    # ★ Slice3 활성화 floor: web scope 미설정이면 자율 browser_action 거부(off-scope egress 방지).
    monkeypatch.delenv("SA_WEB_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("SA_WEB_ALLOWED_CIDRS", raising=False)
    monkeypatch.delenv("WEB_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("WEB_ALLOWED_CIDRS", raising=False)
    monkeypatch.delenv("SA_WEB_REQUIRE_SCOPE", raising=False)
    au = _audit()
    g = _grant([Capability("browser_action", frozenset({"navigate"}))])
    res = CapabilityGrantResolver(g, au, registry=_reg())
    assert asyncio.run(res.resolve(_req("browser_action", "navigate"))) is None
    assert _audit_has(au, "autonomous_browser_denied")
    # scope 설정하면 허용
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "allowed.example")
    assert asyncio.run(res.resolve(_req("browser_action", "navigate"))) is not None
