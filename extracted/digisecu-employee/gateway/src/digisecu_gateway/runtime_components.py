"""파이프라인 컴포넌트 → 도메인 분류 + 런타임 3축 파생 (순수 함수, DB 무접촉).

codex 설계 교정 반영:
- **per-employee 귀속은 범주 오류**: heartbeat/run은 `component`(공유 도메인 워커) 키다. employees.status(개인)와
  섞지 않고 **도메인 런타임 상태/활동**으로만 노출한다.
- **catch-all 금지**: "나머지 전부 smb"로 몰면 미등록/오타 컴포넌트가 smb로 위장된다. 열거된 컴포넌트만
  매핑하고 미상은 `None`(unknown) 으로 fail-closed.
- **pipeline_run엔 phase 없음**: activity(phase)는 heartbeat 전용 — 과거 run에 phase를 붙이지 않는다.
- **scheduled/event-driven 컴포넌트**(github.scan 등)는 cadence 메타가 없으면 오래된 heartbeat만으로 '죽음'
  단정 불가 → 임계값은 적용하되 응답에 as_of/last_beat_at 을 항상 실어 UI가 신선도를 스스로 판단하게 한다.
"""
from __future__ import annotations

from .domains import DOMAINS

# 접두 규칙(도메인 워커 명명): github.*/github_*, dev_web*, confluence.*/confluence_*, smb.*.
#
# ⚠️ `smb.` 는 **점까지 포함**해야 한다. smb 는 무접두 원조 도메인이라 `task`·`collector` 같은
#    일반명을 선점했고(아래 _SMB_COMPONENTS), 접두 없는 catch-all 을 두면 남의 컴포넌트를
#    빨아들인다. 반대로 `smb.` 로 시작하는 이름은 명백히 smb 것이라 규칙으로 잡아도 안전하다.
_PREFIX_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("github.", "github_"), "github"),
    (("dev_web",), "dev_web"),
    (("confluence.", "confluence_"), "confluence"),
    (("smb.",), "smb"),
)

# smb 의 **무접두** 컴포넌트 — 이름이 일반적이라 명시 열거만 smb 로 분류(catch-all 아님).
# `smb.` 로 시작하는 것은 위 접두 규칙이 잡으므로 여기 적지 않는다.
#
# ⚠️ 열거는 조용히 낡는다. 실측 2026-08-28: 평면 태스크 레인이 은퇴하면서 smb 큐를 실제로
#    도는 주체가 `task` → `smb.lead` 로 바뀌었는데, 그 이름이 여기에도 접두 규칙에도 없어
#    **콘솔에서 통째로 빠졌다**. 리드가 살아 도는 동안에도 smb 도메인 카드는
#    `liveness=stale` 로 읽혔다(보이는 게 은퇴/휴면 컴포넌트뿐이라). 다른 3도메인은 접두
#    규칙이 리드를 잡아서 같은 증상이 없었다 — smb 만 무접두다. 그래서 `smb.` 규칙을 넣었다.
_SMB_COMPONENTS: frozenset[str] = frozenset({
    "task", "task.worker",
    "hunt", "hunt.worker",
    "collector", "collector.owner",
    "mail", "reverify", "reply_inbound", "scan",
})


def domain_of_component(component: str) -> str | None:
    """컴포넌트 → 도메인(smb/dev_web/github/confluence) 또는 None(미등록=unknown, fail-closed)."""
    c = (component or "").strip()
    if not c:
        return None
    for prefixes, dom in _PREFIX_RULES:
        if c.startswith(prefixes):
            return dom
    if c in _SMB_COMPONENTS:
        return "smb"
    return None


# ── 3축 임계/매핑 ──
LIVE_MAX_AGE_S = 300.0     # < 5분 = live
DELAYED_MAX_AGE_S = 900.0  # < 15분 = delayed, 이후 stale

# heartbeat phase → activity. producer 는 task/report/sweep/poll/reply_verify/reverify/scan/recheck/discovery/error
# 등 **다양한 작업 phase**를 쓰고 PHASE_* 상수도 계속 늘어난다. active allowlist 로 열거하면 미열거 phase 를 쓰는
# 가동 워커가 idle 로 오접힌다(codex). 따라서 **idle/disabled 만 명시하고 그 외 non-empty phase 는 active**로 본다
# (live heartbeat + non-idle phase = 실제로 그 작업을 수행 중). 안전방향: 미상을 idle 아닌 active 로.
_IDLE_PHASES = frozenset({"idle", "owner_wait", "waiting", "sleeping"})
_DISABLED_PHASES = frozenset({"disabled", "stopped", "off"})


def liveness_of_age(age_seconds: float | None) -> str:
    """heartbeat 나이 → live/delayed/stale/unknown."""
    if age_seconds is None:
        return "unknown"
    if age_seconds < LIVE_MAX_AGE_S:
        return "live"
    if age_seconds < DELAYED_MAX_AGE_S:
        return "delayed"
    return "stale"


def activity_of_phase(phase: str | None) -> str:
    """heartbeat phase → active/idle/disabled/unknown. idle/disabled만 명시, 그 외 non-empty phase = active."""
    p = (phase or "").strip().lower()
    if not p:
        return "unknown"
    if p in _IDLE_PHASES:
        return "idle"
    if p in _DISABLED_PHASES:
        return "disabled"
    return "active"


def health_of_terminal_status(status: str | None) -> str:
    """최신 terminal run status(ok/error) → ok/degraded/unknown. error를 'investigating'으로 바꾸지 않는다."""
    s = (status or "").strip().lower()
    if s == "error":
        return "degraded"
    if s == "ok":
        return "ok"
    return "unknown"


# ── 도메인 집계 우선순위 ──
def aggregate_liveness(values: list[str]) -> str:
    if not values:
        return "unknown"
    if "live" in values:
        return "live"
    if "delayed" in values:
        return "delayed"
    if all(v == "stale" for v in values):
        return "stale"
    return "unknown"


def aggregate_activity(live_activities: list[str]) -> str:
    """live/delayed 컴포넌트의 activity 만 집계(죽은 워커의 마지막 phase는 무의미)."""
    if not live_activities:
        return "idle"
    if any(a == "active" for a in live_activities):
        return "active"
    if all(a == "disabled" for a in live_activities):
        return "disabled"
    return "idle"


def aggregate_health(healths: list[str]) -> str:
    if any(h == "degraded" for h in healths):
        return "degraded"
    if any(h == "ok" for h in healths):
        return "ok"
    return "unknown"


def is_known_domain(domain: str) -> bool:
    return domain in DOMAINS
