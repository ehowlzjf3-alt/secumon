"""환경 설정 위생 — 세 저장소의 `.env` 가 조용히 서로를 가리는 것을 막는다.

배경(2026-08-15 실측): `load_runtime_env` 는 **skill/.env → engine/.env** 순으로 읽고
`if key not in os.environ` 이라 **먼저 잡힌 값이 이긴다**. 양쪽에 같은 키가 있으면
엔진 값은 조용히 죽는다. 실제로 `SMB_USERNAME`/`SMB_PASSWORD` 가 서로 다른 값으로
양쪽에 있었다 — 어느 경로로 기동하느냐에 따라 **다른 계정으로 SMB 접속**을 시도하게 되고,
비밀번호가 안 맞으면 AD lockout 위험이다.

같은 날 소유권을 정리해 **중복을 7 → 0** 으로 만들었다. 이 파일은 그 상태를 고정한다.
"값이 같으면 봐준다"가 아니라 **중복 자체를 금지**한다 — 값이 같은 중복은 언젠가 갈라지는
중복일 뿐이고, 갈라지는 순간 조용하기 때문이다.

소유권 규칙 원문: `docs/CONFIG-OWNERSHIP.md`

⚠️ 이 테스트는 **값을 출력하지 않는다**(비밀이 로그·CI에 남으면 안 된다). 키 이름만 본다.
⚠️ `.env` 는 gitignore 라 없을 수 있다 — 없으면 skip.

관련: `docs/MAIL-EGRESS-POLICY.md`, `docs/LESSONS-LEARNED.md` 3-5b
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[2]
SKILL_ENV = SKILL_ROOT / ".env"
ENGINE_ROOT = Path(
    os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent"))
)
ENGINE_ENV = ENGINE_ROOT / ".env"
DIGI_ENV_EXAMPLE = SKILL_ROOT.parent / "digisecu-employee" / ".env.example"

# ── 소유권 매트릭스 ────────────────────────────────────────────────────────────
# 기준은 "누가 읽느냐"다. 이름에 도메인이 붙어 있어도 **코어 도구가 읽으면 코어 소유**다
# (예: WEB_USER_AGENT 는 core web_fetch_tool, SA_WEB_SSO_* 는 core browser_tool).

# 코어(엔진) 소유 — skill/.env 에 나타나면 first-wins 로 엔진 단일소스를 이겨버린다.
_CORE_OWNED = {
    # 에이전트 / LLM
    "SA_CHAT_PROFILE",            # v3.90 split-brain 의 원인이었던 바로 그 키
    "SA_CHAT_PROFILE_CHAIN",
    "SA_TASK_REASONING_EFFORT",   # 엔진 harness/runner.py 만 읽는다
    "LITELLM_API_KEY", "OPENAI_CRED_KEY", "SOC_USER_ID",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    # 코어 런타임
    "SECU_AGENT_PG_DSN", "SECU_AGENT_DB_BACKEND", "SA_PLUGINS", "SA_RESULTS_DIR",
    "MCP_INTERNAL_HOST", "KNOX_OWN_SINGLEID",
    # 코어 도구가 직접 읽는 것(이름만 도메인처럼 보임)
    "WEB_USER_AGENT", "WEB_REQUEST_TIMEOUT", "SA_WEB_SSO_USER", "SA_WEB_SSO_PASS",
}

# 스킬 소유 — engine/.env 에 나타나면 엔진 쪽 값은 死값이 된다(엔진 코드 참조 0곳).
_SKILL_OWNED_PREFIXES = ("GITHUB_", "CONFLUENCE_", "JENKINS_", "SMB_", "POP3_",
                         "COLLECTOR_", "SA_SMB_", "SA_DELIVERY_", "SA_KNOX_",
                         "MCP_SPLUNK_")
_SKILL_OWNED_EXTRA = {"WEB_MAX_PAGES_PER_DOMAIN", "WEB_VULN_PROBE_ENABLED",
                      "MAIL_SENDER_EMAIL", "MCP_SERVER_URL", "SA_ENGINE_DIR",
                      "DEFAULT_CHARTER_REF"}


def _is_skill_owned(key: str) -> bool:
    return key in _SKILL_OWNED_EXTRA or key.startswith(_SKILL_OWNED_PREFIXES)


def _keys(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        k = k.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", k):
            out[k] = v.strip().strip('"').strip("'")
    return out


@pytest.fixture(scope="module")
def envs() -> tuple[dict[str, str], dict[str, str]]:
    if not SKILL_ENV.exists() or not ENGINE_ENV.exists():
        pytest.skip("로컬 .env 없음(배포/CI 환경) — 위생 검사 대상 아님")
    return _keys(SKILL_ENV), _keys(ENGINE_ENV)


def test_no_key_is_defined_in_both_env_files(envs) -> None:
    """★ 중복 자체를 금지한다. 값이 같은 중복은 '아직 안 갈라진' 중복일 뿐이다."""
    skill, engine = envs
    dupes = sorted(set(skill) & set(engine))
    assert not dupes, (
        f"skill/.env 와 engine/.env 에 같은 키가 있다: {dupes}. "
        "load_runtime_env 는 skill 을 먼저 읽어 engine 값을 죽인다 — "
        "소유하는 쪽 한 곳에만 둬라. (docs/CONFIG-OWNERSHIP.md)"
    )


def test_core_owned_keys_are_not_defined_in_skill_env(envs) -> None:
    """에이전트/LLM·코어 런타임 설정은 엔진이 단일소스다."""
    skill, _ = envs
    strays = sorted(k for k in skill if k in _CORE_OWNED)
    assert not strays, (
        f"코어 소유 키가 skill/.env 에 있다: {strays}. "
        "skill 이 먼저 읽혀 엔진 값을 이긴다 — v3.90 split-brain 과 같은 구조다."
    )


def test_skill_owned_keys_are_not_defined_in_engine_env(envs) -> None:
    """도메인 크리덴셜/노브는 스킬이 단일소스다(엔진 코드는 읽지 않는다)."""
    _, engine = envs
    strays = sorted(k for k in engine if _is_skill_owned(k) and k not in _CORE_OWNED)
    assert not strays, (
        f"스킬 소유 키가 engine/.env 에 있다: {strays}. "
        "엔진 코드는 이 값을 읽지 않아 死값이 되고, 스킬 값과 갈리면 추적이 어렵다."
    )


def test_env_values_have_no_unexpanded_variable_references(envs) -> None:
    """★ `load_runtime_env` 는 값을 **원문 그대로** 대입한다 — `${HOME}` 을 펼치지 않는다.

    2026-08-15 실증: engine/.env 의 `SA_PLUGINS="${HOME}/…/bootstrap.py"` 는 원래부터
    깨진 값이었는데, skill/.env 의 절대경로가 first-wins 로 이겨서 **가려져 있었다**.
    중복을 없애는 순간 가림막이 사라져 `PluginLoadError: plugin 파일 없음: ${HOME}/…` 로
    터졌다(도메인 능력 0 = 워커 전멸).

    ⚠️ 값 동일성을 `os.path.expandvars` 로 비교하면 이 차이가 **보이지 않는다**.
    런타임이 안 펼치므로 비교도 펼치면 안 된다.
    """
    skill, engine = envs
    offenders = sorted(
        f"{origin}:{k}"
        for origin, d in (("skill", skill), ("engine", engine))
        for k, v in d.items()
        if "${" in v
    )
    assert not offenders, (
        f".env 값에 미전개 변수 참조가 있다: {offenders}. "
        "load_runtime_env 는 expandvars 를 하지 않는다 — 절대경로로 적어라."
    )


def test_digisecu_template_does_not_pin_the_llm_profile() -> None:
    """digisecu 는 파드 주입 목록일 뿐 — 여기서 모델을 핀하면 세 번째 소스가 생긴다."""
    if not DIGI_ENV_EXAMPLE.exists():
        pytest.skip("digisecu-employee 체크아웃 없음")
    keys = _keys(DIGI_ENV_EXAMPLE)
    assert "SA_CHAT_PROFILE" not in keys, (
        "digisecu-employee/.env.example 이 SA_CHAT_PROFILE 을 정의한다. "
        "워커 LLM 단일소스는 engine/.env 뿐이다 — 주석으로만 남겨라."
    )


def test_bare_domain_allowlist_requires_the_initial_send_gate(envs) -> None:
    """⚠️ `도메인` 한 줄이면 그 도메인 **전체**가 열린다(코어 `_recipient_allowed` suffix 매칭).

    ## 왜 조건이 바뀌었나 (2026-08-31)

    예전 규칙은 "정확한 주소만" 이었다. 전제는 *"실 담당자 발송 금지 단계"* 였다 —
    아무에게도 안 보내는 동안엔 목록이 곧 브레이크였기 때문이다.

    그 전제가 끝났다. 사용자 결정:

        수동 발송   → 실제 담당자에게    (그래서 목록을 열어야 한다)
        회신        → 모두에게
        최초 발송   → 닫힘

    목록을 열면 브레이크가 사라지므로 **다른 브레이크가 있어야 한다.** 그게
    최초 발송 게이트다(`owner_recipients.initial_autosend_enabled`,
    `service/tests/test_initial_send_gate.py`). 그래서 이 테스트는 "도메인 금지" 가
    아니라 **"도메인을 열었으면 게이트가 닫혀 있어야 한다"** 를 지킨다.

    ★ 둘 다 열려 있으면 큐가 통째로 실존 임직원에게 나간다
      (2026-08-31 실측 대기: smb 48 · github 552 · confluence 44 · dev_web 71).
    """
    skill, engine = envs
    raw = skill.get("SA_DELIVERY_RECIPIENT_ALLOW", engine.get("SA_DELIVERY_RECIPIENT_ALLOW", ""))
    entries = [e.strip() for e in raw.split(",") if e.strip()]
    bare_domains = [e for e in entries if "@" not in e or e.startswith("@")]
    if not bare_domains:
        return
    from service.services.owner_recipients import INITIAL_AUTOSEND_ENV

    opened = skill.get(INITIAL_AUTOSEND_ENV, engine.get(INITIAL_AUTOSEND_ENV, ""))
    assert str(opened).strip().lower() not in {"1", "true", "yes", "on"}, (
        f"allowlist 가 도메인 전체로 열려 있는데({bare_domains}) "
        f"자동 최초 발송({INITIAL_AUTOSEND_ENV})까지 켜져 있다 — "
        "브레이크가 둘 다 풀렸다. 큐가 통째로 나간다."
    )
