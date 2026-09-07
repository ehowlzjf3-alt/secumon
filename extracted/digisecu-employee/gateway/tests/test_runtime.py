"""도메인 런타임 분류/파생 + detail redact — 무DB 순수함수 회귀. codex A1/A2 설계 반영."""
from digisecu_gateway import runtime_components as rc
from digisecu_gateway.runtime_service import _sanitize_detail


def test_component_domain_prefix_mapping():
    assert rc.domain_of_component("github.scan") == "github"
    assert rc.domain_of_component("github_task_worker") == "github"
    assert rc.domain_of_component("dev_web_task") == "dev_web"
    assert rc.domain_of_component("dev_web_hunt") == "dev_web"
    assert rc.domain_of_component("confluence.space_task") == "confluence"
    assert rc.domain_of_component("confluence_report") == "confluence"


def test_smb_only_enumerated_no_catchall():
    # 무접두 smb 는 명시 열거만. 미등록/오타/타도메인 파편은 None(fail-closed) — smb 로 위장 금지.
    for c in ("task", "task.worker", "hunt", "collector", "collector.owner", "mail", "reverify", "scan"):
        assert rc.domain_of_component(c) == "smb", c
    for c in ("jenkins.foo", "weird.unknown", "randomjob", "", "  "):
        assert rc.domain_of_component(c) is None, c


def test_smb_dotted_components_are_mapped_by_prefix():
    """★ 리드가 화면에서 통째로 빠져 있었다 (실측 2026-08-28).

    평면 태스크 레인이 은퇴하면서 smb 큐를 실제로 도는 주체가 `task` → `smb.lead` 로
    바뀌었는데, 그 이름이 열거에도 접두 규칙에도 없었다. `domain_of_component` 가 None 을
    주면 그 컴포넌트는 도메인에 안 붙고 **화면에서 사라진다** — 리드가 살아 도는 동안에도
    smb 도메인 카드가 `liveness=stale` 로 읽혔다(보이는 게 은퇴/휴면 컴포넌트뿐이라).

    다른 3도메인은 접두 규칙이 리드를 잡아 같은 증상이 없었다. smb 만 무접두다.
    """
    assert rc.domain_of_component("smb.lead") == "smb"
    assert rc.domain_of_component("smb.lead.worker") == "smb"
    # 앞으로 생길 smb.* 도 자동으로 잡힌다 — 열거를 다시 낡게 두지 않는다.
    assert rc.domain_of_component("smb.some_future_component") == "smb"


def test_smb_prefix_rule_requires_the_dot():
    """⚠️ `smb` catch-all 이면 안 된다 — 남의 컴포넌트를 빨아들인다."""
    for c in ("smbclient", "smb_backup_job", "smbstatus"):
        assert rc.domain_of_component(c) is None, c


def test_liveness_thresholds():
    assert rc.liveness_of_age(0) == "live"
    assert rc.liveness_of_age(299) == "live"
    assert rc.liveness_of_age(300) == "delayed"
    assert rc.liveness_of_age(899) == "delayed"
    assert rc.liveness_of_age(900) == "stale"
    assert rc.liveness_of_age(None) == "unknown"


def test_activity_from_phase():
    # idle/disabled 만 명시, 그 외 non-empty phase 는 active(가동 워커가 미열거 phase 로 idle 오접힘 방지, codex).
    assert rc.activity_of_phase("task") == "active"
    assert rc.activity_of_phase("hunt") == "active"
    assert rc.activity_of_phase("report_mail") == "active"
    # producer 가 실제 쓰지만 옛 allowlist 에 없던 phase — 이제 active 로 올바르게 분류.
    for p in ("reverify", "scan", "recheck", "discovery", "sso_discovery", "error"):
        assert rc.activity_of_phase(p) == "active", p
    assert rc.activity_of_phase("idle") == "idle"
    assert rc.activity_of_phase("owner_wait") == "idle"
    assert rc.activity_of_phase("disabled") == "disabled"
    assert rc.activity_of_phase(None) == "unknown"
    assert rc.activity_of_phase("") == "unknown"
    assert rc.activity_of_phase("  ") == "unknown"


def test_health_never_maps_error_to_investigating():
    # error 는 실패 사실이지 사람이 조사중이라는 증거가 아니다(codex).
    assert rc.health_of_terminal_status("error") == "degraded"
    assert rc.health_of_terminal_status("ok") == "ok"
    assert rc.health_of_terminal_status(None) == "unknown"
    assert rc.health_of_terminal_status("running") == "unknown"


def test_aggregate_liveness_priority():
    assert rc.aggregate_liveness(["stale", "live", "delayed"]) == "live"
    assert rc.aggregate_liveness(["stale", "delayed"]) == "delayed"
    assert rc.aggregate_liveness(["stale", "stale"]) == "stale"
    assert rc.aggregate_liveness([]) == "unknown"


def test_aggregate_activity_only_live():
    assert rc.aggregate_activity(["active", "idle"]) == "active"
    assert rc.aggregate_activity(["disabled", "disabled"]) == "disabled"
    assert rc.aggregate_activity(["idle"]) == "idle"
    assert rc.aggregate_activity([]) == "idle"


def test_aggregate_health():
    assert rc.aggregate_health(["ok", "degraded"]) == "degraded"
    assert rc.aggregate_health(["ok", "unknown"]) == "ok"
    assert rc.aggregate_health(["unknown"]) == "unknown"
    assert rc.aggregate_health([]) == "unknown"


# ── detail redaction: URL userinfo/query/fragment 제거 + 시크릿 마스킹 + 길이 제한 ──
def test_sanitize_detail_strips_url_query_and_secret():
    out = _sanitize_detail("https://confluence.samsungds.net/dosearchsite.action?queryString=password&token=abc123secretlong")
    assert "queryString" not in out
    assert "token=abc123secretlong" not in out
    assert "confluence.samsungds.net/dosearchsite.action" in out  # scheme+host+path 보존


def test_sanitize_detail_strips_userinfo():
    out = _sanitize_detail("https://admin:s3cr3t@git.internal/repo.git")
    assert "s3cr3t" not in out and "admin" not in out
    assert "git.internal" in out


def test_sanitize_detail_non_http_scheme_credentials():
    # codex #2: 비-HTTP URL(postgres/redis/s3)의 userinfo·query 도 벗겨야 한다.
    out = _sanitize_detail("connect postgres://dbuser:dbpass@10.0.0.5:5432/prod?sslmode=require done")
    assert "dbpass" not in out and "dbuser" not in out and "sslmode" not in out
    assert "10.0.0.5" in out


def test_sanitize_detail_embedded_url_query():
    # 문장 내 임베디드 http URL 의 query(검색어·토큰)도 제거.
    out = _sanitize_detail("scanned https://wiki.internal/dosearchsite.action?queryString=password&apikey=abcd1234 ok")
    assert "queryString" not in out and "apikey=abcd1234" not in out and "password" not in out
    assert "wiki.internal/dosearchsite.action" in out


def test_sanitize_detail_preserves_benign_counters():
    assert _sanitize_detail("claimed=1 scanned=1 findings=1 errors=0") == "claimed=1 scanned=1 findings=1 errors=0"


def test_sanitize_detail_length_cap():
    out = _sanitize_detail("x" * 500)
    assert out is not None and len(out) <= 200


def test_sanitize_detail_none():
    assert _sanitize_detail(None) is None


# ── src 파싱·담당자 매칭 (2026-08-28 실측 결함) ──────────────────────────────

def test_github_src_parses_both_asset_forms():
    """★ github asset 은 **두 폼**으로 들어온다 — URL 폼을 못 벗기면 티켓이 뭉개진다.

    실측 2026-08-28: `https://` 폼을 안 벗겨서
    `split_part('https://host/org/repo', '/', 1|2)` 가 `'https:'` + `''` 가 됐고,
    github finding 38건 중 31건(82%)이 **`'https:/'` 라는 가짜 src 하나**로 접혔다.
    티켓이 4개로 보인 이유다 — 제대로 파싱하면 33개다.
    """
    import re

    from digisecu_gateway.domains import SRC_EXPR

    expr = SRC_EXPR["github"]
    # SQL 을 직접 돌리지 않고, 두 폼을 모두 벗기는 절이 있는지 구조로 고정한다.
    assert "^https?://[^/]+/" in expr, "URL 폼(scheme+host) 제거 절이 없다"
    assert "^github:" in expr, "github: 접두 제거 절이 없다"
    # 벗기는 순서가 중요하다 — host 를 먼저 걷어내야 'github:' 접두가 드러난다.
    assert expr.index("^https?://[^/]+/") < expr.index("^github:")
    # 조각이 하나뿐일 때 'org/' 가 아니라 NULL 이 되도록.
    assert "NULLIF" in expr


def test_owner_emails_splits_a_joined_recipient_list():
    """★ `owner_recipient` 는 한 명이 아닐 수 있다(스레드가 담당자를 합집합으로 쌓는다).

    단건 검증기 `_owner_email` 에 그대로 넣으면 통째로 거부돼 화면이 "담당자 없음" 이 된다.
    실측 2026-08-28: confluence 스레드 17건 중 6건이 다중주소, finding 이 있는 12개 space
    중 5개가 이 이유로 미매칭이었다(상관 100%).
    """
    from digisecu_gateway.repos import finding_repo as fr

    assert fr._owner_emails("a.b@samsung.com") == ["a.b@samsung.com"]
    assert fr._owner_emails("a@samsung.com, b@samsung.com") == ["a@samsung.com", "b@samsung.com"]
    assert fr._owner_emails("a@samsung.com;b@samsung.com") == ["a@samsung.com", "b@samsung.com"]
    assert fr._owner_emails("a@samsung.com, a@samsung.com") == ["a@samsung.com"], "중복 제거"
    assert fr._owner_emails(None) == []
    assert fr._owner_emails("garbage") == []
    # 하나가 깨져도 나머지는 살린다.
    assert fr._owner_emails("nope, ok@samsung.com") == ["ok@samsung.com"]


def test_owner_email_singular_stays_strict():
    """⚠️ 단건 검증기는 **느슨해지면 안 된다** — 그쪽은 발송 대상을 고르는 자리다.

    표시용(_owner_emails)과 발송용(_owner_email)의 엄격함을 분리했다는 사실을 고정한다.
    """
    from digisecu_gateway.repos import finding_repo as fr

    assert fr._owner_email("a@samsung.com, b@samsung.com") is None
    assert fr._owner_email("a@samsung.com") == "a@samsung.com"
