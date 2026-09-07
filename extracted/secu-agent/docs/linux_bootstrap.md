# Linux Bootstrap

Use this before moving a locally tested build into the internal Linux runtime.
The checks are local only: `doctor` does not call the LLM endpoint or scan any
targets.

## First Setup

```bash
uv sync
uv run playwright install --with-deps chromium
uv run secu-agent doctor
```

For machine-readable verification:

```bash
uv run secu-agent doctor --json
```

The command exits `0` when there are no failed checks. Warnings are allowed so
local macOS testing can still pass while noting that production is Linux.

## Required Environment

Set these in `.env` or the process environment:

```bash
# 워커/채팅 프로필 (security 게이트웨이). 워커는 단일 프로필, chat 만 fallback 체인.
# LITELLM_API_KEY 필요(config/llm_profiles.yaml).
#   기본값(코드) = gemma — env 미설정·오타 시에도 사내로 착지한다.
#   ⚠️ deepseek 은 vision 미지원(400) — 이미지가 근거인 smb/dev_web 은 자동으로 gemma 로 대체된다.
SA_CHAT_PROFILE=gemma
SA_CHAT_PROFILE_CHAIN=gemma
LITELLM_API_KEY=<litellm-gateway-key>
SA_CHAT_TOKEN=<long-random-token>
SECU_AGENT_PG_DSN=postgresql://secu_agent:<password>@127.0.0.1:5432/secu_agent
SA_RESULTS_DIR=/var/lib/secu-agent/findings
```

> 프로필 단일 소스: 워커(skill 도메인 포함)는 engine `.env` 의 `SA_CHAT_PROFILE`
> 을 따른다. skill repo `.env` 에 `SA_CHAT_PROFILE` 을 **핀하지 마라** — skill .env
> 가 먼저 로드(setdefault)되어 engine 값을 덮어써 split-brain(워커만 다른 모델)이
> 된다. (v3.90 실사고: skill .env 가 워커 프로필을 지배해 split-brain 이 났다.)

> **외부 프로필(`o4-mini`/`codex`)은 기본값이 아니다.** 기본 프로필은 `gemma`
> (사내 게이트웨이)이며, `SA_CHAT_PROFILE` 미설정·오타 시에도 사내로 착지한다.
> 외부 egress 가 필요한 일회성 대조 실험이 아니라면 `OPENAI_API_KEY` /
> `OPENAI_BASE_URL` / `OPENAI_MODEL` 을 `.env` 에 두지 마라 —
> `OPENAI_CRED_KEY`(사내 apigw `x-dep-ticket`)와는 다른 변수다.

For the internal gateway profiles, provide the gateway credential/header values
referenced in `config/llm_profiles.yaml`:

```bash
OPENAI_CRED_KEY=<gateway-ticket>
SOC_USER_ID=<internal-user-id>
```

## Browser Runtime

Browser supervisor flows require Playwright Chromium. On Linux, install system
dependencies and Chromium with:

```bash
uv run playwright install --with-deps chromium
```

For offline or pre-baked images, install browsers into a fixed cache and carry
that directory with the image:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
uv run playwright install chromium
uv run secu-agent doctor
```

## Web Runtime

Run the web UI on an internal interface:

```bash
SA_SCHEDULER=off uv run secu-agent web --host 0.0.0.0 --port 8765
```

Enable the scheduler after the Postgres DSN, result path, credentials, and browser
checks pass:

```bash
SA_SCHEDULER=on SA_SCHEDULER_INTERVAL=60 \
  uv run secu-agent web --host 0.0.0.0 --port 8765
```

## One-Command Bootstrap

The repository also includes:

```bash
scripts/bootstrap_linux.sh
```

It runs `uv sync`, installs Playwright Chromium, and finishes with
`secu-agent doctor`.
