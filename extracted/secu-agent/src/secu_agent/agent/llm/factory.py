"""LLM client factory — env 기반.

web/chat 도 scheduler 도 둘다 같은 profile 로 LLM client 만든다. 중복 제거.
.env 자동 로드 + config/llm_profiles.yaml 에서 profile 선택.
"""
from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path

from secu_agent.agent.llm.base import LLMClient

log = logging.getLogger(__name__)


def _project_root() -> Path:
    # src/secu_agent/agent/llm/factory.py → parents[4] = repo root
    return Path(__file__).resolve().parents[4]


def _ensure_dotenv() -> None:
    env_path = _project_root() / ".env"
    if not env_path.exists():
        return
    pat = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")

    def _expand(s: str) -> str:
        def _sub(m):
            name = m.group(1) or m.group(2)
            return os.environ.get(name, m.group(0))
        for _ in range(2):
            s = pat.sub(_sub, s)
        return s

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = _expand(v)


def _build_client(profile) -> LLMClient:
    """profile.transport 에 따라 client 선택.

    - codex_responses → OpenAI Responses API 어댑터 (사내 enterprise codex)
    - 그 외 (openai_chat) → chat.completions 게이트웨이(oss/o4-mini/qwen fallback 보험)
    """
    transport = getattr(profile, "transport", "openai_chat")
    if transport == "codex_responses":
        from secu_agent.agent.llm.codex_responses_client import CodexResponsesClient
        return CodexResponsesClient(profile)
    from secu_agent.agent.llm.internal_gateway import OpenAICompatClient
    return OpenAICompatClient(profile)


def make_llm_client_from_env() -> LLMClient:
    from secu_agent.agent.llm.fallback import FallbackLLMClient
    from secu_agent.agent.llm.profile import load_profiles

    _ensure_dotenv()
    # 기본 프로필 = gemma (사내 게이트웨이). env 미설정은 사고이지 의도가 아니므로
    # 사내로 fail-safe 한다 — 구 기본값 codex 는 chatgpt.com 외부 egress 였다.
    # 외부 프로필(codex/o4-mini)은 SA_CHAT_PROFILE 로 **명시**해야 쓰인다.
    profile_name = os.environ.get("SA_CHAT_PROFILE", "gemma")
    profile_path = Path(os.environ.get(
        "SA_CHAT_PROFILES_PATH",
        str(_project_root() / "config" / "llm_profiles.yaml"),
    ))
    profiles = load_profiles(profile_path)
    profile_names = _profile_names_from_env(
        profiles=profiles,
        profile_name=profile_name,
        chain_raw=os.environ.get("SA_CHAT_PROFILE_CHAIN"),
    )
    clients: list[LLMClient] = [_build_client(profiles[name]) for name in profile_names]
    if len(clients) == 1:
        return clients[0]
    return FallbackLLMClient(clients)


def build_chat_client_from_profile(profile_name: str) -> LLMClient:
    """단일 named profile 로 LLM client 구성. v3.43: vision 같은 specialty 호출용.

    Raises:
        KeyError: profile 이 llm_profiles.yaml 에 없음.
    """
    from secu_agent.agent.llm.profile import load_profiles

    _ensure_dotenv()
    profile_path = Path(os.environ.get(
        "SA_CHAT_PROFILES_PATH",
        str(_project_root() / "config" / "llm_profiles.yaml"),
    ))
    profiles = load_profiles(profile_path)
    if profile_name not in profiles:
        raise KeyError(
            f"profile {profile_name!r} 없음 — {profile_path} 에 정의된 것: "
            f"{', '.join(profiles)}"
        )
    return _build_client(profiles[profile_name])


# ── v3.81 T1c: 역할별 모델 라우팅 ─────────────────────────────────────
#
# judge/summarizer 등 보조 역할은 메인 세션 client 를 그대로 쓰는 게 기본 —
# env `SA_<ROLE>_PROFILE` (예: SA_JUDGE_PROFILE=o4-mini) 이 named profile 을
# 가리키면 그 모델로 분리한다 (저비용 모델로 judge/압축 오프로드).
# per-worker 라우팅은 WorkerSpec.env 의 SA_CHAT_PROFILE,
# per-subagent-type 은 agents/<name>.md frontmatter `profile:` (AgentTool).

_role_client_cache: dict[str, LLMClient] = {}
# 로드 실패한 (role:name) 키 — 재파싱(YAML/dotenv I/O)·재경고 방지용 sentinel.
# config 는 프로세스 수명 동안 정적이므로 실패도 한 번만 판정하면 충분.
_role_client_failed: set[str] = set()
# 캐시 자체를 보호(check-then-set 경쟁 방지). client 구성은 lock 밖에서 수행.
_role_client_lock = threading.Lock()


def make_role_client(role: str, *, default: LLMClient) -> LLMClient:
    """역할별 client — env 미설정/로드 실패 시 default(세션 client) 반환.

    process-lifetime 캐시: 역할 client 는 세션 간 공유(HTTP 풀 재사용),
    프로세스 종료가 수명 (aclose 안 함 — 세션 client 와 달리 소유자 없음).
    실패는 fail-open (기본 client 로 동작 지속) — 실패한 profile 은 sentinel 로
    캐시해 같은 입력 재호출 시 YAML/dotenv 재파싱과 warning 반복을 막는다
    (첫 실패 경고 1회만 방출).
    """
    env_name = f"SA_{role.upper()}_PROFILE"
    name = (os.environ.get(env_name) or "").strip()
    if not name:
        return default
    cache_key = f"{role}:{name}"
    with _role_client_lock:
        cached = _role_client_cache.get(cache_key)
        if cached is not None:
            return cached
        if cache_key in _role_client_failed:
            # 이미 실패로 판정된 profile — 재파싱/재경고 없이 fail-open.
            return default
    try:
        client = build_chat_client_from_profile(name)
    except Exception as e:  # noqa: BLE001 — 라우팅 실패가 루프를 멈추면 안 됨
        with _role_client_lock:
            first_failure = cache_key not in _role_client_failed
            _role_client_failed.add(cache_key)
        if first_failure:
            log.warning(
                "역할 %s 의 profile %r 로드 실패 (%s) — 기본 client 사용: %r",
                role, name, env_name, e,
            )
        return default
    with _role_client_lock:
        # 다른 스레드가 먼저 채웠으면 그 인스턴스를 재사용(HTTP 풀 단일화).
        existing = _role_client_cache.get(cache_key)
        if existing is not None:
            return existing
        _role_client_cache[cache_key] = client
    log.info("역할 %s → profile %r client 라우팅 (%s)", role, name, env_name)
    return client


def _profile_names_from_env(
    *,
    profiles: dict[str, object],
    profile_name: str,
    chain_raw: str | None,
) -> list[str]:
    raw = chain_raw or profile_name
    requested = [part.strip() for part in raw.split(",") if part.strip()]
    selected = [name for name in requested if name in profiles]
    if selected:
        return selected
    return [next(iter(profiles))]
