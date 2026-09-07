# M4 read 게이트웨이 이미지 — threat_hunter read-only. 엔진/스킬 무수정(런타임 import 없음, 격리).
# 런타임 deps 최소(fastapi/psycopg/pydantic) — 스킬/엔진을 이미지에 넣지 않는다(connect() 격리 강화).
FROM python:3.12-slim

# 사내 프록시 MITM CA 먼저.
COPY corp-ca.crt /etc/ssl/certs/ca-certificates.crt
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY \
    http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY no_proxy=$NO_PROXY \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    UV_SYSTEM_CERTS=true \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PYTHONUNBUFFERED=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8091

RUN pip install --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml /app/
COPY src /app/src
RUN uv pip install --system --no-cache-dir .

RUN useradd -u 10001 -m -s /usr/sbin/nologin gw
USER 10001
EXPOSE 8091
# SECU_AGENT_PG_DSN(digisecu_gw_ro role)·GATEWAY_TOKEN 은 런타임 주입(fail-closed).
ENTRYPOINT ["digisecu-gateway"]
