#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install uv before running this bootstrap." >&2
  exit 1
fi

uv sync

if [[ "${SA_SKIP_PLAYWRIGHT_INSTALL:-0}" != "1" ]]; then
  if [[ "$(uname -s)" == "Linux" ]]; then
    uv run playwright install --with-deps chromium
  else
    uv run playwright install chromium
  fi
fi

uv run secu-agent doctor
