"""v3.89 Slice2: 자율-능력(autonomous capability) grant 모델 (코어, 순수·결정론·DB 무접근).

무인 워커가 **명시·operator 상한·감사되는** 소수 destructive 툴(브라우저 navigate/login)을 쓸 수 있게,
기존 `ApprovalResolver` seam(`ToolContext.approval_resolver`)에 scoped `CapabilityGrantResolver` 를
워커 전용 주입한다. 기본(빈 grant)은 **resolver 미생성 → approval_resolver None → 오늘과 byte-for-byte
동일(fail-closed)**. 권한 파이프라인(invoker/base)은 0줄 변경 — resolver 는 ask 게이트만 해소한다.

3층 방어 중 belt(resolver) + floor(NEVER_AUTO_FLOOR). veto 는 기존 register_tool_policy(block-only)로
승인 뒤에도 독립 실행. floor = 코어 소유 하한: operator env·계약이 뭐라 해도 절대 auto-approve 불가한
위험-단위(egress/host변조/임의실행/self-grant/browser 변조 action). 상세=docs/design/v3.89-autonomous-capability.md.
"""
from __future__ import annotations

import threading
import types
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from secu_agent.agent.tools.approval import ApprovalDecision, ApprovalRequest

if TYPE_CHECKING:
    from secu_agent.agent.harness.audit import AuditLog
    from secu_agent.agent.tools.registry import ToolRegistry


# ⚠️ Slice3(활성화됨, 2026-07-13 사용자 결정): 이 모델은 grant **메커니즘**이다. `browser_action`
# navigate/login 의 자율 auto-grant 는 Slice3 브라우저 하드닝과 함께 **활성화 지원**된다. 구현된 하드닝:
#  · navigate: CDP Fetch 게이트가 매 top-frame redirect hop 을 요청 前 url_safety 로 차단(page.route 는
#    redirect 재발화 안 함을 실측 확인 → CDP 로 전환). subresource 하드블록·팝업 게이트 포함.
#    ※ 사내 기본값(overkill 방지): SW 차단·subresource DNS·TLS 강제는 opt-in(SA_BROWSER_BLOCK_
#    SERVICE_WORKERS / SA_WEB_SUBRESOURCE_DNS_CHECK / SA_BROWSER_VERIFY_TLS) — 외부 미신뢰 대상용.
#  · login: SSO 클릭(redirect) 후 자격 fill 前 + fill/submit 직전 **landing origin 이 operator 가
#    allowlist 한 IdP origin 인지** 재검증(피싱-리다이렉트 방어) + 프로세스당 one-shot. **위협모델**:
#    allowlist 된 IdP origin 은 신뢰한다 — 그 origin 페이지가 자격을 유출(=IdP 침해)하는 것은
#    in-browser 로 못 막고 범위 밖(더 강한 보장은 네트워크 egress proxy·SA_BROWSER_VERIFY_TLS).
#  · 활성화 floor: 자율 browser_action 은 **web scope 설정 필수**(off-scope Document/redirect egress 차단).
# ★★ 알려진 잔여 위험(codex 라운드2~4, in-browser 로 완전차단 불가 — **운영상 수용, 사용자 결정**):
#    worker/OOPIF 별도 target·팝업 최초 요청(auto-attach 前)·연결시점 DNS rebinding(TOCTOU); login 은
#    신뢰 IdP origin 전제(그 origin 이 악성이면 GET/fetch/beacon 등 임의 채널로 자격 유출 가능 — 범위 밖).
#    **완전한 egress 경계(browser-level Target auto-attach[pause-on-start] 또는 네트워크 egress proxy/
#    firewall)를 병행 권장** — 특히 신뢰 못 하는 점검 대상을 자율 브라우징하거나 실계정 SSO 를 켤 때.
#    web scope floor 가 off-scope 노출을 크게 줄이나 subresource/worker off-scope 는 하드블록만 적용됨.
# ★ 운영 불변식(codex 라운드3 #4): 안전 관련 env(SA_WEB_ALLOWED_*/SA_WEB_REQUIRE_SCOPE/
#   SA_WEB_SSO_IDP_ORIGINS/SA_BROWSER_VERIFY_TLS)는 **런타임 중 불변**이어야 한다 — 승인 시점과 실행
#   시점 사이 변경 시 floor 판정과 실제 검증이 어긋날 수 있음(ignore_https_errors 는 context 생성 시 고정).
#   변경은 프로세스/브라우저 세션 재시작으로만.
# ── 코어 소유 하한 (NEVER_AUTO_FLOOR) — grant 로 절대 auto-approve 불가 ────────────
# 범위: 이 하한은 **CapabilityGrant resolver 의 auto-approval** 을 지배한다(destructive=ask 툴에만
# 관계). 비-destructive 툴은 애초에 ask 가 안 나 resolver 를 안 타고, resolver 생성자의 is_destructive
# 검사가 grant 자체를 거부한다 → 여기 이름은 이중 안전(오설정 fail-loud). 레거시 SA_AUTONOMOUS_TOOLS
# deny-정련(schedule_origin) 경로는 별개 메커니즘으로 이 floor 를 안 탄다(그건 operator 기존 권한).
# self-grant 축(권한/설정/CLAUDE.md 변조)은 host_write/host_edit·plan_mode 토글 금지로 봉인.
_NEVER_AUTO_TOOLS: frozenset[str] = frozenset({
    "deliver",                                            # egress (자기 게이트로만)
    "host_write", "host_edit", "host_move", "host_copy",  # host 변조
    "terminal", "python_exec", "run_in_sandbox", "process",  # 임의 실행
    "bash_evidence",                                      # evidence dir 쉘(codex — 실 destructive)
    "enter_plan_mode", "exit_plan_mode",                  # 안전-모드 토글(self-grant)
})
# (tool, action) 위험 조합 — 안전+위험 action 을 한 툴에 묶은 경우 위험 action 만 금지.
_NEVER_AUTO_ACTIONS: frozenset[tuple[str, str]] = frozenset({
    ("browser_action", "fill"), ("browser_action", "click"),
    ("browser_action", "click_xy"), ("browser_action", "press"),
    ("browser_action", "eval"),
})
# 코어 필수 위험-단위 — plugin 이 risk_actions 로 표시하든 말든 **항상** operator risk opt-in 을 요구한다
# (login 을 plugin 자발적 표시에 맡기지 않음 — codex). (tool, action).
_CORE_RISK_ACTIONS: frozenset[tuple[str, str]] = frozenset({
    ("browser_action", "login"),
})
# 자율 grant login_mode = **allowlist {sso} 만**(denylist 아님 — 미래 mode 추가 시 자동 fail-closed).
# `auto` 는 non-SSO 에서 `defaults`(기본자격 브루트)로 흘러 SA_WEB_DEFAULT_CREDS_ENABLED 에 의존, `defaults`
# 는 브루트 → 자율 금지. 오타/미지 mode 도 allowlist 밖이라 거부(codex — denylist zombie·fail-open 봉쇄).
_AUTONOMOUS_LOGIN_MODE_ALLOW: frozenset[str] = frozenset({"sso"})


def is_floored(tool: str, action: str) -> bool:
    """(tool, action) 이 코어 하한(절대 auto-approve 불가)인가."""
    return tool in _NEVER_AUTO_TOOLS or (tool, action) in _NEVER_AUTO_ACTIONS


@dataclass(frozen=True, slots=True)
class Capability:
    """한 도구의 허용 action 서브셋 + 위험-단위 전용 필드."""
    tool: str
    actions: frozenset[str]
    risk_actions: frozenset[str] = frozenset()    # login 등 별도 operator opt-in 필요
    login_modes: frozenset[str] | None = None     # browser_action:login 전용(predicate 아님)


@dataclass(frozen=True, slots=True)
class CapabilityGrant:
    """이 워커에 부여된 자율 능력의 완전한 불변 서술 (일급 객체)."""
    grant_id: str
    capabilities: tuple[Capability, ...]
    operator_cap: frozenset[str]                  # SA_AUTONOMOUS_TOOLS 스냅샷(감사 근거)
    risk_optin: frozenset[str]                    # "tool:action" operator 스냅샷
    scope: Mapping[str, str]                      # charter_ref/worker/task_type

    def permits(self, tool: str, action: str | None, *, login_mode: str | None = None) -> bool:
        """belt·suspenders 공유 순수함수. 기본-거부: 명시 (tool, action) 만 True."""
        caps = [c for c in self.capabilities if c.tool == tool]
        if not caps or action is None:
            return False
        # 같은 tool 이 여러 Capability 면 **모두** 만족해야(엄격한 것이 이김 — 첫 항목만 보던 버그 수정).
        if not all(action in c.actions for c in caps):
            return False
        if is_floored(tool, action):              # floor 는 permits 에서도 이김(이중 안전)
            return False
        # 위험 action = 이중 opt-in. plugin 표시(risk_actions) OR **코어 필수(_CORE_RISK_ACTIONS)** 이면
        # operator SA_AUTONOMOUS_RISK_ACTIONS 스냅샷에 있어야. login 은 코어 필수라 plugin 이 빠뜨려도 강제.
        is_risk = (tool, action) in _CORE_RISK_ACTIONS or any(action in c.risk_actions for c in caps)
        if is_risk and f"{tool}:{action}" not in self.risk_optin:
            return False
        if tool == "browser_action" and action == "login":
            modes: frozenset[str] = frozenset()
            for c in caps:
                if "login" in c.actions:          # login_modes 는 login 선언 cap 에서만(상관 보존)
                    modes |= (c.login_modes or frozenset())
            if (login_mode is None or login_mode not in modes
                    or login_mode not in _AUTONOMOUS_LOGIN_MODE_ALLOW):
                return False                      # 자율 login 은 login_mode == 'sso' 만(allowlist)
        return True


def build_effective_grants(
    declared: Sequence[Capability],
    *, scope: Mapping[str, str], grant_id: str,
) -> "CapabilityGrant | None":
    """유효 grant = 계약선언 ∩ operator env − floor. 유효 능력 0 → None(→ resolver 미주입 →
    오늘 byte-for-byte). operator env 비면 하드 deny(스킬 선언 무의미)."""
    from secu_agent.agent.tools.autonomy import (
        autonomous_allowed_capabilities, autonomous_allowed_risk_actions,
    )
    op_caps = autonomous_allowed_capabilities()   # {(tool, action)} — (tool, "")=그 툴 전체 action
    if not op_caps:
        return None                               # operator 상한 미설정 → 하드 deny
    op_risk = autonomous_allowed_risk_actions()   # {"tool:action"}
    # 같은 tool 선언 병합(중복 → union). login_modes 는 **login 을 선언한 cap 에서만** 취합해 action↔mode
    # 상관을 보존한다(codex): C1(login,{auto})+C2(navigate,{sso}) 가 login+sso 를 합성하지 못하게.
    merged: dict[str, Capability] = {}
    for cap in declared:
        cap_lm = cap.login_modes if "login" in cap.actions else None  # 정규화: login 없으면 modes 무의미
        prev = merged.get(cap.tool)
        if prev is None:
            merged[cap.tool] = Capability(cap.tool, cap.actions, cap.risk_actions, cap_lm)
        else:
            lm = (prev.login_modes or frozenset()) | (cap_lm or frozenset())
            merged[cap.tool] = Capability(
                cap.tool, prev.actions | cap.actions,
                prev.risk_actions | cap.risk_actions, lm or None)
    eff: list[Capability] = []
    for cap in merged.values():
        allowed = frozenset(
            a for a in cap.actions
            if not is_floored(cap.tool, a)
            and ((cap.tool, a) in op_caps or (cap.tool, "") in op_caps)
        )
        if not allowed:
            continue
        login_modes = None
        if cap.login_modes is not None:            # 자율 login allowlist {sso} 만(미지 mode fail-closed)
            login_modes = frozenset(m for m in cap.login_modes if m in _AUTONOMOUS_LOGIN_MODE_ALLOW)
        risk = cap.risk_actions & allowed

        def _permittable(a: str, _tool=cap.tool, _risk=risk, _lm=login_modes) -> bool:
            # 위험 action(코어필수 login 포함)은 operator risk opt-in 필요. login 은 유효 login_mode 도.
            if (_tool, a) in _CORE_RISK_ACTIONS or a in _risk:
                if f"{_tool}:{a}" not in op_risk:
                    return False
                if _tool == "browser_action" and a == "login" and not _lm:
                    return False
            return True

        allowed = frozenset(a for a in allowed if _permittable(a))  # zombie(permit 불가) 제거
        if not allowed:
            continue
        eff.append(Capability(cap.tool, allowed, risk & allowed, login_modes))
    if not eff:
        return None
    return CapabilityGrant(
        grant_id, tuple(eff),
        # operator 상한 스냅샷 — action 정보 보존(canonical `tool:action`, bare 는 tool). 감사 provenance.
        operator_cap=frozenset(f"{t}:{a}" if a else t for t, a in op_caps),
        risk_optin=op_risk,
        scope=types.MappingProxyType({str(k): str(v) for k, v in scope.items()}),  # read-only
    )


def maybe_inject_autonomous_grant(
    context: object, audit: "AuditLog", registry: "ToolRegistry",
    *, declared: Sequence[Capability], scope: Mapping[str, str],
) -> "CapabilityGrant | None":
    """cli._run 자율-grant 배선(테스트 가능하게 추출). **주입 조건 이중 가드**:
    (1) declared 빈 → 미주입, (2) 유효 grant 0(env 미설정·전부 floor·zombie) → 미주입.
    두 경우 모두 `context.approval_resolver` 불변(기본 None) → 오늘과 byte-for-byte(fail-closed).
    non-None grant 일 때만 CapabilityGrantResolver(생성자 하드검증)를 approval slot 에 + configured 감사."""
    if not declared:
        return None
    grant = build_effective_grants(
        declared, scope=scope, grant_id=f"{scope.get('task_id', '?')}:auto")
    if grant is None:
        return None
    context.approval_resolver = CapabilityGrantResolver(grant, audit, registry=registry)  # type: ignore[attr-defined]
    audit.append("autonomous_grant_configured", {
        "grant_id": grant.grant_id,
        "grants": sorted(f"{c.tool}:{a}" for c in grant.capabilities for a in c.actions),
        # provenance: operator env 상한·risk opt-in·scope 전체를 감사에 영속(사후 "왜 이 grant" 재구성).
        "operator_cap": sorted(grant.operator_cap),
        "risk_optin": sorted(grant.risk_optin),
        "scope": dict(grant.scope),
    })
    return grant


# ── Slice3 Part C: 자율 login 코어 floor(allowlist 필수 + one-shot) ──────────────
# 자율 SSO login 은 (1) operator IdP origin allowlist(SA_WEB_SSO_IDP_ORIGINS) 가 설정돼야 하고
# (browser_tool 이 미설정 시 후방호환=비-strict 경로로 흐르므로 자율 실계정 fill 이 origin 검증 없이
# 발생 = Slice3 무력화), (2) 프로세스당 정확히 1회만 허용(§12.1 one-shot reserve / §12.2 fresh worker
# 마다 재시도 → lockout 배수 방지). capability.py 는 이미 browser_action:login 을 코어 floor 로 안다
# (도메인-프리 아님 = 안전 하한) — 그 축의 명문화. reset API 없음(§12.1) — 테스트 전용 리셋만.
_AUTONOMOUS_LOGIN_LATCH: dict[str, bool] = {"consumed": False}
_AUTONOMOUS_LOGIN_LATCH_LOCK = threading.Lock()  # 다중 thread/loop check-and-set 원자화(codex)


def _sso_idp_allowlist_configured() -> bool:
    """자율 SSO login 이 strict origin 검증 경로를 타는지 = **유효 origin 이 실제로 파싱되는지**.
    raw env 가 비공백이어도(`","`·`"not a url"`) 파싱 origin 0개면 browser 는 후방호환(비-strict)
    경로로 흐른다 → 여기서 raw 만 보면 fail-open(codex). **browser_tool 의 단일 파서**에 위임해
    drift·불일치를 제거한다. import/부분초기화 실패는 예외가 아니라 clean deny(fail-closed, codex)."""
    try:
        from secu_agent.agent.tools.browser_tool import _sso_idp_origins
        return bool(_sso_idp_origins())
    except Exception:                          # 파서 import/평가 실패 → 미설정 취급(deny)
        return False


def _consume_autonomous_login_latch() -> bool:
    """미소비면 소비 마킹 후 True. 이미 소비면 False(2회차 거부). threading.Lock 으로 다중
    thread/event-loop 동시 호출도 원자화. **다중 process/restart 의 durable one-shot 은 부모 소유
    AuthAttemptLeaseBroker = §12.2 일반화 단계로 이연**(이 latch 는 프로세스당 1회만 보장)."""
    with _AUTONOMOUS_LOGIN_LATCH_LOCK:
        if _AUTONOMOUS_LOGIN_LATCH["consumed"]:
            return False
        _AUTONOMOUS_LOGIN_LATCH["consumed"] = True
        return True

# reset API 없음(§12.1): 프로덕션 reset 경로를 두지 않는다. 테스트는 conftest 가 모듈 dict 를
# 직접 초기화(_AUTONOMOUS_LOGIN_LATCH["consumed"]=False) — public reset 함수 미제공(codex).


class CapabilityGrantResolver:
    """ApprovalResolver 프로토콜 구현 — grant 를 읽는 첫 소비자. 생성자 라이브-registry 하드검증으로
    grant 생성 시점 fail-closed."""

    def __init__(self, grant: CapabilityGrant, audit: "AuditLog", *, registry: "ToolRegistry") -> None:
        seen_tools: set[str] = set()
        for cap in grant.capabilities:
            if cap.tool in seen_tools:             # 같은 tool 중복 Capability = 오설정(fail-loud)
                raise ValueError(f"autonomous grant: duplicate capability for tool {cap.tool!r}")
            seen_tools.add(cap.tool)
            tool_cls = registry.get(cap.tool)
            if tool_cls is None:
                raise ValueError(f"autonomous grant: unknown tool {cap.tool!r}")
            if not getattr(tool_cls, "is_destructive", False):
                raise ValueError(
                    f"autonomous grant: {cap.tool!r} 은 destructive 아님 — ask 안 남, grant 불요(오설정)")
            if cap.tool in _NEVER_AUTO_TOOLS:
                raise ValueError(f"autonomous grant: {cap.tool!r} 은 never-auto(floor)")
            if not cap.tool or "*" in cap.tool:
                raise ValueError(f"autonomous grant: invalid/wildcard tool {cap.tool!r}")
            for a in cap.actions:
                if is_floored(cap.tool, a):
                    raise ValueError(f"autonomous grant: {cap.tool}:{a} 은 floored")
        self._grant = grant
        self._audit = audit

    async def resolve(self, req: ApprovalRequest) -> "ApprovalDecision | None":
        ti = req.tool_input if isinstance(req.tool_input, dict) else {}
        action = ti.get("action") if isinstance(ti.get("action"), str) else None
        login_mode = ti.get("login_mode") if isinstance(ti.get("login_mode"), str) else None
        if not self._grant.permits(req.tool_name, action, login_mode=login_mode):
            return None                           # → invoker.py:89-90 기존 fail-closed
        # ── Slice3 활성화 floor: 자율 browser_action 은 **web scope 설정 필수** ──
        # 완전한 in-browser egress 경계는 불가(worker/OOPIF/DNS-TOCTOU/307-308, codex 라운드2) →
        # 자율 브라우징을 operator 선언 scope 안으로 가둬 off-scope Document/redirect egress 를
        # url_safety scope 게이트로 차단(운영 안전 floor). scope 미설정이면 자율 브라우징 deny.
        if req.tool_name == "browser_action":
            try:
                from secu_agent.agent.tools.url_safety import web_scope_active
                _scoped = web_scope_active()
            except Exception:
                _scoped = False                   # 판정 불가 → fail-closed(deny)
            if not _scoped:
                self._audit.append("autonomous_browser_denied", {
                    "grant_id": self._grant.grant_id, **dict(self._grant.scope),
                    "tool": req.tool_name, "action": action,
                    "reason": ("web scope 미설정 — 자율 브라우징은 SA_WEB_ALLOWED_DOMAINS/CIDRS "
                               "또는 SA_WEB_REQUIRE_SCOPE 필수(off-scope egress 차단)"),
                    "invocation_id": req.invocation_id,
                })
                return None
        # ── Slice3 Part C: 자율 login floor — allowlist 필수 + one-shot(프로세스당 1회) ──
        if req.tool_name == "browser_action" and action == "login":
            if not _sso_idp_allowlist_configured():
                self._audit.append("autonomous_login_denied", {
                    "grant_id": self._grant.grant_id, **dict(self._grant.scope),
                    "tool": req.tool_name, "action": action,
                    "reason": "SA_WEB_SSO_IDP_ORIGINS 미설정 — 자율 SSO login 은 IdP origin allowlist 필수",
                    "invocation_id": req.invocation_id,
                })
                return None                       # fail-closed(후방호환 경로로 자율 fill 금지)
            if not _consume_autonomous_login_latch():
                self._audit.append("autonomous_login_denied", {
                    "grant_id": self._grant.grant_id, **dict(self._grant.scope),
                    "tool": req.tool_name, "action": action,
                    "reason": "one-shot latch 소비됨 — 프로세스당 자율 login 1회(lockout 방지)",
                    "invocation_id": req.invocation_id,
                })
                return None
        self._audit.append("autonomous_approval", {  # 사람 승인과 동일 shape
            "grant_id": self._grant.grant_id, **dict(self._grant.scope),
            "tool": req.tool_name, "action": action,
            "reason": "autonomous capability grant", "invocation_id": req.invocation_id,
        })
        return ApprovalDecision(
            behavior="allow", reason=f"capability grant {self._grant.grant_id}",
            updated_input=None,                   # 모델 updated_input 절대 미반영(confused-deputy 차단)
        )
