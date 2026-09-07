# syntax=docker/dockerfile:1.7
#
# Build with the skill repo and the de-domain engine as named BuildKit contexts:
#
#   docker buildx build \
#     --build-context skill=. \
#     --build-context engine=../secu-agent \
#     -f deploy/container/Dockerfile \
#     -t secu-agent-skill:local .
#
# The resulting image contains both editable installs so the Kubernetes
# manifests can run the domain web services and background agents directly.
FROM python:3.12-slim AS runtime

ARG SECU_PIP_INDEX_URL=""
ARG SECU_PIP_TRUSTED_HOST=""
ARG SECU_PIP_CERT=""
# 사내 프록시가 TLS 를 중간에서 끊는다 — 그 CA 를 신뢰하지 않으면 pip 가
# CERTIFICATE_VERIFY_FAILED 로 죽는다(2026-08-25 재빌드 실패).
# ⚠️ `SECU_PIP_CERT` 는 **컨테이너 안 경로**라 호스트 경로를 넣어도 안 된다.
#    그래서 CA 자체를 빌드 컨텍스트로 받아 시스템 신뢰 저장소에 등록한다:
#      --build-context ca=/usr/local/share/ca-certificates
#    사외 빌드에서는 빈 디렉터리가 와서 아무 일도 안 일어난다.

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 secu \
    && mkdir -p /var/lib/secu-agent/evidence \
    && chown -R secu:secu /var/lib/secu-agent

# 사내 CA 등록(있을 때만). 빈 컨텍스트면 COPY 는 아무것도 안 옮기고 지나간다.
COPY --from=ca . /usr/local/share/ca-certificates/
RUN update-ca-certificates || true
# certifi 는 시스템 저장소를 **안 본다** — pip·requests 가 쓰는 번들에도 이어붙인다.
# (이 저장소가 예전에 밟은 'certifi 함정' 과 같은 것이다.)
RUN python -c "import certifi,pathlib;b=pathlib.Path(certifi.where());e=pathlib.Path('/etc/ssl/certs/ca-certificates.crt');b.write_text(b.read_text()+chr(10)+e.read_text()) if e.exists() else None" || true

RUN set -eu; \
    if [ -n "$SECU_PIP_INDEX_URL$SECU_PIP_TRUSTED_HOST$SECU_PIP_CERT" ]; then \
      { \
        echo "[global]"; \
        if [ -n "$SECU_PIP_INDEX_URL" ]; then echo "index-url = $SECU_PIP_INDEX_URL"; fi; \
        if [ -n "$SECU_PIP_CERT" ]; then echo "cert = $SECU_PIP_CERT"; fi; \
        if [ -n "$SECU_PIP_TRUSTED_HOST" ]; then \
          echo "trusted-host ="; \
          for host in $SECU_PIP_TRUSTED_HOST; do echo "    $host"; done; \
        fi; \
      } > /etc/pip.conf; \
    fi

WORKDIR /app/engine
COPY --from=engine --chown=10001:10001 . /app/engine
RUN python -m pip install --upgrade pip \
    && python -m pip install -e /app/engine

WORKDIR /app/skill
COPY --from=skill --chown=10001:10001 . /app/skill
RUN python -m pip install -e '/app/skill[all]'

ENV PYTHONPATH=/app/engine/src:/app/skill \
    TH_ENGINE_DIR=/app/engine \
    TH_PLUGINS=/app/skill/plugin/bootstrap.py \
    TH_SMB_EVIDENCE_DIR=/var/lib/secu-agent/evidence \
    TH_E2E_EVIDENCE_DIR=/var/lib/secu-agent/evidence

USER 10001
WORKDIR /app/skill

ENTRYPOINT ["python", "-m"]
CMD ["domains.smb.webapp.app"]
