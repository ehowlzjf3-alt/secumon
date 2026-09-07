#!/usr/bin/env bash
# 엔진(secu-agent) boot 이미지 + 워커(engine+skill) 이미지 빌드 → Harbor 태그.
#
# 【무수정 원칙】 secu-agent / secu-agent-skill repo 에 파일을 남기지 않는다. 빌드 컨텍스트를
#   임시 디렉토리에 조립(.venv/.git 제외)하고 corp-ca.crt 를 컨텍스트 루트에 스테이징한다.
# 【빌드타임 네트워크】 PyPI·Docker Hub·Playwright CDN·apt 는 현재 셸의 http(s)_proxy 로 나간다.
#   사내 MITM(samsungsemi-prx.com) TLS 재서명은 corp-ca.crt(표준+사내 CA 병합본)로 신뢰한다.
# 【자격증명】 이 스크립트는 build+tag 까지만. docker login(로봇토큰)·docker push 는 사용자가 직접 실행
#   (토큰은 Claude 미열람). 마지막에 실행할 명령을 출력한다.
set -euo pipefail

REGISTRY="${REGISTRY:-harbor.security.samsungds.net/digital-employee}"
TAG="${TAG:-smoke}"
ENGINE_SRC="${ENGINE_SRC:-$HOME/project/secu-agent}"
SKILL_SRC="${SKILL_SRC:-$HOME/project/secu-agent-skill}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/engine
CA="$HERE/corp-ca.crt"

[[ -f "$CA" ]] || { echo "ERROR: corp-ca.crt 없음: $CA (host 신뢰저장소에서 생성: cp /etc/ssl/certs/ca-certificates.crt $CA)" >&2; exit 1; }
for f in pyproject.toml uv.lock src config; do
  [[ -e "$ENGINE_SRC/$f" ]] || { echo "ERROR: engine 소스 누락: $ENGINE_SRC/$f" >&2; exit 1; }
done

EXC=(--exclude .venv --exclude .git --exclude __pycache__ --exclude '*.pyc' --exclude node_modules \
     --exclude '.env' --exclude '.env.*' \
     --exclude '*.pem' --exclude '*.key' --exclude '*.p12' --exclude '*.pfx' --exclude '*.jks')
CTX="$(mktemp -d)"; trap 'rm -rf "$CTX"' EXIT

echo ">> base 엔진 이미지 컨텍스트 조립: $CTX/base"
mkdir -p "$CTX/base"
cp "$CA" "$CTX/base/corp-ca.crt"
rsync -a "${EXC[@]}" "$ENGINE_SRC/pyproject.toml" "$ENGINE_SRC/uv.lock" "$CTX/base/"
rsync -a "${EXC[@]}" "$ENGINE_SRC/src"    "$CTX/base/"   # → $CTX/base/src (부모에 넣어야 중첩 안 됨)
rsync -a "${EXC[@]}" "$ENGINE_SRC/config" "$CTX/base/"   # → $CTX/base/config
echo ">> docker build $REGISTRY/engine:$TAG"
docker build -f "$HERE/Dockerfile" \
  --build-arg HTTP_PROXY="${http_proxy:-}" \
  --build-arg HTTPS_PROXY="${https_proxy:-}" \
  --build-arg NO_PROXY="${no_proxy:-}" \
  -t "$REGISTRY/engine:$TAG" "$CTX/base"

echo ">> worker 이미지 컨텍스트 조립: $CTX/worker (engine/ + skill/)"
mkdir -p "$CTX/worker/engine"
cp "$CA" "$CTX/worker/corp-ca.crt"
rsync -a "${EXC[@]}" "$ENGINE_SRC/pyproject.toml" "$ENGINE_SRC/uv.lock" "$CTX/worker/engine/"
rsync -a "${EXC[@]}" "$ENGINE_SRC/src"    "$CTX/worker/engine/"   # → engine/src (부모에 넣어야 중첩 안 됨)
rsync -a "${EXC[@]}" "$ENGINE_SRC/config" "$CTX/worker/engine/"   # → engine/config
rsync -a "${EXC[@]}" "$SKILL_SRC/"        "$CTX/worker/skill/"
# 컨텍스트 감사 — EXC 를 누가 잘못 건드리면 시크릿이 다시 이미지로 들어간다. 빌드 **전에** 막는다.
# (2026-08 확인: 이 가드가 없던 이미지에는 /skill/.env 31키가 평문으로 들어가 있었고,
#  런타임이 그 파일을 실제로 읽고 있었다 — 죽은 파일이 아니었다.)
LEAKED="$(find "$CTX" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
             -o -name '*.p12' -o -name '*.pfx' -o -name '*.jks' \) -not -name '*.env.template' -print)"
if [[ -n "$LEAKED" ]]; then
  echo "ERROR: 빌드 컨텍스트에 자격증명/키 자료가 있다 — EXC 규칙 확인:" >&2
  printf '%s\n' "$LEAKED" | sed 's/^/  /' >&2
  exit 1
fi

echo ">> docker build $REGISTRY/engine-worker:$TAG"
docker build -f "$HERE/Dockerfile.worker" \
  --build-arg HTTP_PROXY="${http_proxy:-}" \
  --build-arg HTTPS_PROXY="${https_proxy:-}" \
  --build-arg NO_PROXY="${no_proxy:-}" \
  -t "$REGISTRY/engine-worker:$TAG" "$CTX/worker"

cat <<EOF

빌드 완료:
  $REGISTRY/engine:$TAG
  $REGISTRY/engine-worker:$TAG

⚠️ 이 이미지에는 .env 가 없다(의도). 예전엔 baked /skill/.env 가 런타임에 38키를 먹여줬으므로
   **주입 없이 실행하면 32키가 조용히 사라진다**(splunk MCP·메일 egress·SMB_HUNT_* …).
   반드시 래퍼로 실행:
     deploy/engine/run-worker.sh --verify                    # 주입 게이트(먼저 이걸로 확인)
     deploy/engine/run-worker.sh --domain smb -- task --plan smb_task
   k8s 는 deploy/engine/claim-smoke.yaml 상단의 Secret 생성 절차를 따른다.

다음(사용자 직접 — 로봇토큰은 stdin, Claude 미열람):
  read -rs HARBOR_TOKEN   # 토큰 입력(화면 미표시)
  printf '%s' "\$HARBOR_TOKEN" | docker login harbor.security.samsungds.net \\
    -u 'robot\$digital-employee+digital-employee' --password-stdin
  docker push $REGISTRY/engine:$TAG
  docker push $REGISTRY/engine-worker:$TAG
  unset HARBOR_TOKEN
EOF
