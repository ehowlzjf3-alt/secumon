# 무수정 엔진(secu-agent) boot-smoke 이미지 — M3.3a-Gate2.
#
# 빌드: docker build -f deploy/engine/Dockerfile -t digisecu/engine:smoke \
#         --build-arg HTTP_PROXY=$http_proxy --build-arg HTTPS_PROXY=$https_proxy --build-arg NO_PROXY=$no_proxy \
#         ~/project/secu-agent
# build context = secu-agent(무수정). .dockerignore 없이 **선택 COPY**로 .venv/.git 제외.
# non-root uid 10001, readOnlyRootFS 지향(런타임에 /results·/tmp·playwright 캐시는 emptyDir).
FROM python:3.12-slim

# 사내 프록시(samsungsemi-prx.com)가 HTTPS를 MITM한다 — 모든 네트워크 op **전에** 시스템 신뢰저장소를
# 호스트 번들(표준+사내 CA 병합)로 교체하고, 도구별 CA env도 지정(pip/uv/apt/curl/node·playwright).
COPY corp-ca.crt /etc/ssl/certs/ca-certificates.crt

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY \
    http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY no_proxy=$NO_PROXY \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    UV_NATIVE_TLS=true \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir uv

WORKDIR /app
# 의존성 레이어(락 고정) — 소스 변경과 분리해 캐시.
COPY pyproject.toml uv.lock /app/
COPY src /app/src
RUN uv sync --frozen --no-dev

# psycopg는 secu-agent pyproject 의존성에 없으나 state.py가 무조건 import한다(배포가 제공하는 구조).
# 무수정 원칙상 pyproject를 못 건드리므로 venv에 명시 설치(호스트 .venv 버전 정합).
RUN uv pip install --python /app/.venv/bin/python "psycopg[binary,pool]==3.3.4"

# 런타임에 참조하는 설정(llm_profiles/mcp_servers 등). 없으면 무시.
COPY config /app/config

# playwright chromium 프리베이크(+시스템 libs). doctor의 chromium 체크 통과용.
RUN uv run playwright install --with-deps chromium

# non-root + 쓰기 경로 소유권(런타임 emptyDir가 덮음).
RUN useradd -u 10001 -m -s /usr/sbin/nologin engine \
 && mkdir -p /results \
 && chown -R 10001:10001 /results /app /opt/ms-playwright

USER 10001
ENV SA_RESULTS_DIR=/results \
    HOME=/home/engine
# 진입점 = venv 콘솔스크립트 직접(uv run의 lock 재동기화 회피 — pip 설치한 psycopg 보존).
# 파드 args로 doctor / web --host 0.0.0.0 지정.
ENTRYPOINT ["/app/.venv/bin/secu-agent"]
