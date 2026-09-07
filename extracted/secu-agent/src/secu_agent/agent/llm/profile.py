"""LLM profile model + YAML loader.

env interpolation: ${VAR} → os.environ[VAR] (없으면 빈 문자열)
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

_ENV_PATTERN = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def _interpolate(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _interpolate(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_interpolate(v) for v in obj]
    if isinstance(obj, str):
        return _ENV_PATTERN.sub(lambda m: os.environ.get(m.group(1), ""), obj)
    return obj


class AuthConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # v3.56: oauth_codex — ~/.codex/auth.json 의 OAuth access_token 을 런타임에
    # resolve/refresh 해서 Bearer 로 사용 (api_key/headers 와 달리 토큰이 YAML/.env 에
    # 안 들어감 — password_ref 정책과 동일선상). codex_responses transport 전용.
    mode: Literal["api_key", "headers", "oauth_codex"] = "api_key"
    api_key: str = ""
    # oauth_codex 일 때 토큰 store 경로 (~ 확장됨).
    token_path: str = "~/.codex/auth.json"


class LLMProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    base_url: str
    model: str
    auth: AuthConfig = Field(default_factory=AuthConfig)
    headers: dict[str, str] = Field(default_factory=dict)
    proxy: str | None = None
    # bool 또는 CA 번들 경로(str). 사내 MITM 환경에서는 CA 번들 경로를 직접 박을 수 있게
    # 한다 (e.g. /etc/ssl/certs/ca-certificates.crt). client 어댑터는 이 값을 그대로
    # httpx.AsyncClient(verify=...) 로 넘긴다.
    verify_ssl: bool | str = True
    timeout: int = Field(default=300, gt=0)
    trust_env: bool = False
    # v3.56: codex_responses — OpenAI Responses API(=Codex backend). 기본은 기존
    # chat.completions 어댑터(openai_chat). factory 가 이 값으로 client 분기.
    transport: Literal[
        "openai_chat", "codex_responses",
    ] = "openai_chat"
    # xhigh/minimal 은 gpt-5 계열(codex) reasoning dial. chat.completions 게이트웨이는
    # low/medium/high 만 쓰고, codex transport 가 xhigh/minimal 까지 전달.
    reasoning_effort: Literal["minimal", "low", "medium", "high", "xhigh"] | None = None
    # v3.32: 비추론 모델 (qwen3.5 등) 은 reasoning_effort 를 받지 않음. False 면
    # 프로필/요청 어디서 와도 reasoning_effort 를 절대 inject 하지 않는다.
    reasoning_effort_supported: bool = True
    # v3.65: Codex "Fast" = service_tier(priority) — 1.5x 속도(크레딧 더 씀, 추론/모델
    # 무변 = 품질 손실 0). codex_responses 전용. None 이면 client 가 기본 'priority' 적용.
    # 'default'/'auto' 로 표준속도, env SA_CODEX_SERVICE_TIER 가 최우선 override.
    service_tier: str | None = None
    # v3.32: 모델별 정적 extra_body — qwen 의 enable_thinking=False 같은
    # chat_template_kwargs 를 박는 용도. per-request extra_body 와 merge 됨
    # (reasoning_effort 가 같이 들어가면 두 dict 모두 보존).
    extra_body: dict[str, Any] = Field(default_factory=dict)
    # v3.87 Front-D: 하네스 등급. **생산성 loop-guard(반복실패/무진척 감지) 임계값만**
    # 모델 등급에 맞춰 조절하는 데 쓴다 — 강한 모델(frontier)은 스스로 복구하니 느슨하게(오탐
    # halt 줄임), 약한 모델(small)은 루프 위험이 커 엄격하게(조기 halt). **코어 소비 지점은
    # engine._tool_guardrail_config 단 한 곳**(안전 불변식 url_safety/마스킹/egress/권한/
    # 파괴적 게이트는 이 값을 절대 읽지 않는다 — 등급 무관 항상 켜짐). plugin 이 자기 예산
    # 함수(TaskContract.budget)에서 이 필드를 읽어 예산을 등급화하는 건 허용된 생산성 조절이지
    # 안전 게이트가 아니다. None=mid(무변).
    harness_tier: Literal["frontier", "mid", "small"] | None = None


def load_profiles(path: Path) -> dict[str, LLMProfile]:
    if not path.exists():
        raise FileNotFoundError(f"LLM profiles file not found: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    profiles_raw = raw.get("profiles", {})
    if not isinstance(profiles_raw, dict):
        raise ValueError(f"'profiles' must be a mapping in {path}")
    interpolated = _interpolate(profiles_raw)
    out: dict[str, LLMProfile] = {}
    for name, cfg in interpolated.items():
        if not isinstance(cfg, dict):
            raise ValueError(f"Profile '{name}' must be a mapping")
        out[name] = LLMProfile(**{**cfg, "name": name})
    return out
