#!/usr/bin/env bash
# 워커 컨테이너 실행 래퍼 — 이미지에서 뺀 .env 를 런타임 주입으로 대체한다.
#
# 06ca136 이전에는 이미지에 baked 된 /skill/.env 가 런타임에 38키를 먹여줬다. 그 파일을 뺀 이상
# **주입은 선택이 아니라 필수**다. 이 스크립트가 그 유일한 정문이다. 손으로 docker run 하지 마라.
#
# 여기 박힌 값들은 2026-07 4도메인 실기동에서 실제로 돌던 컨테이너 설정 그대로다
# (`docker inspect smb-task-live` 기준): --network host, SA_ENGINE_DIR=/app,
# SA_PLUGINS=/skill/plugin/bootstrap.py, SA_RESULTS_DIR=/results, codex auth ro 마운트.
#
# 【사용】
#   deploy/engine/run-worker.sh --verify                        # 실행 전 게이트: 키 주입 검증만
#   deploy/engine/run-worker.sh --domain smb  -- task --plan smb_task
#   deploy/engine/run-worker.sh --domain github --name gh-1 -- task --plan github_task
#
# 【안전】 env 파일은 평문 시크릿이라 mode 600 + 종료 시 삭제(trap). 컨테이너 내부에서는
#   docker 가 env 로 넘기므로 파일이 이미지/볼륨에 남지 않는다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${REGISTRY:-harbor.security.samsungds.net/digital-employee}"
TAG="${TAG:-smoke}"
IMAGE="${IMAGE:-$REGISTRY/engine-worker:$TAG}"
SKILL_SRC="${SKILL_SRC:-$HOME/project/secu-agent-skill}"

DOMAIN="smb"
NAME=""
PROFILE="${SA_CHAT_PROFILE:-}"
VERIFY=0
RESULTS_DIR="${RESULTS_DIR:-}"
CODEX_AUTH="${CODEX_AUTH:-$HOME/.codex}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)  DOMAIN="${2:?}"; shift 2 ;;
    --name)    NAME="${2:?}"; shift 2 ;;
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --image)   IMAGE="${2:?}"; shift 2 ;;
    --results) RESULTS_DIR="${2:?}"; shift 2 ;;
    --verify)  VERIFY=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "ERROR: 알 수 없는 인자: $1 (컨테이너 인자는 -- 뒤에)" >&2; exit 2 ;;
  esac
done

case "$DOMAIN" in
  smb)        SKILLS_DIRS=/skill/domains/smb/skills ;;
  dev_web)    SKILLS_DIRS=/skill/domains/dev_web/skills ;;
  github)     SKILLS_DIRS=/skill/domains/services/github/skills ;;
  confluence) SKILLS_DIRS=/skill/domains/services/confluence/skills ;;
  all)        SKILLS_DIRS=/skill/domains/smb/skills:/skill/domains/dev_web/skills:/skill/domains/services/github/skills:/skill/domains/services/confluence/skills ;;
  *) echo "ERROR: --domain 은 smb|dev_web|github|confluence|all" >&2; exit 2 ;;
esac

command -v docker >/dev/null || { echo "ERROR: docker 없음" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "ERROR: 이미지 없음: $IMAGE (deploy/engine/build.sh 로 빌드하거나 docker pull)" >&2; exit 1; }

ENVFILE="$("$HERE/runtime-env.sh")"
trap 'rm -f "$ENVFILE"' EXIT

# 컨테이너 토폴로지 — runtime-env.sh 가 의도적으로 뺀 키들을 여기서 확정한다(-e 가 --env-file 보다 우선).
TOPO=(
  -e SA_ENGINE_DIR=/app
  -e SA_RESULTS_DIR=/results
  -e SA_PLUGINS=/skill/plugin/bootstrap.py
  -e "SA_SKILLS_DIRS=$SKILLS_DIRS"
  -e SA_SMB_EVIDENCE_DIR=/results/evidence
  -e XDG_CACHE_HOME=/home/engine/.cache
)
[[ -n "$PROFILE" ]] && TOPO+=(-e "SA_CHAT_PROFILE=$PROFILE")

MOUNTS=()
[[ -d "$CODEX_AUTH" ]] && MOUNTS+=(-v "$CODEX_AUTH:/home/engine/.codex:ro")
[[ -n "$RESULTS_DIR" ]] && { mkdir -p "$RESULTS_DIR"; MOUNTS+=(-v "$RESULTS_DIR:/results"); }

# --verify: 실행 게이트. 주입이 실제로 컨테이너 안에 도착했는지, 토폴로지가 안 깨졌는지 본다.
# 06ca136 로 사라진 32키가 다시 사라지면 여기서 잡힌다(조용한 0건 금지).
if [[ "$VERIFY" == 1 ]]; then
  echo ">> 주입 검증: $IMAGE"
  docker run --rm --network host --env-file "$ENVFILE" "${TOPO[@]}" "${MOUNTS[@]}" \
    --entrypoint /app/.venv/bin/python "$IMAGE" -c '
import os, sys
# 이미지에 .env 가 남아있으면 안 된다(06ca136 의 목적).
leaked = [p for p in ("/skill/.env", "/skill/.env.example", "/app/.env") if os.path.exists(p)]
# baked 파일 없이도 살아야 하는 키들 — 없으면 해당 기능이 조용히 죽는다.
required = {
    "MCP_SPLUNK_GATEWAY_URL": "dev_web 담당자 조회(splunk MCP)",
    "SA_KNOX_MAIL_MCP_URL":   "메일 발송 sink",
    "SA_DELIVERY_RECIPIENT_ALLOW": "메일 egress 허용목록",
    "SMB_USERNAME":           "SMB auth 스윕(없으면 guest 전용으로 추락)",
    "SMB_PASSWORD":           "SMB auth 스윕",
    "SMB_HUNT_PARALLEL":      "SMB 헌팅 병렬도",
    "GITHUB_TOKEN":           "github 도메인",
    "CONFLUENCE_API_TOKEN":   "confluence 도메인",
    "LITELLM_API_KEY":        "사내 LLM 게이트웨이",
    "SECU_AGENT_PG_DSN":      "코어 상태 DB",
}
topo = {"SA_ENGINE_DIR": "/app", "SA_RESULTS_DIR": "/results",
        "SA_PLUGINS": "/skill/plugin/bootstrap.py"}
missing = [(k, why) for k, why in required.items() if not os.environ.get(k)]
badtopo = [(k, v, os.environ.get(k)) for k, v in topo.items() if os.environ.get(k) != v]
quoted  = [k for k in required if (os.environ.get(k) or "").startswith(("\"", "\x27"))]
print(f"  주입된 env 키 수: {len(os.environ)}")
print(f"  이미지 내 .env 잔존: {leaked or 0}")
for k, why in missing: print(f"  MISSING {k}  ← {why}")
for k, want, got in badtopo: print(f"  TOPO    {k}={got!r} (기대 {want!r})")
for k in quoted: print(f"  QUOTED  {k} ← 따옴표가 값에 섞였다(SMB auth 조용한 실패 계열)")
ok = not (leaked or missing or badtopo or quoted)
print("  판정:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
'
  exit $?
fi

[[ $# -gt 0 ]] || { echo "ERROR: 실행할 컨테이너 인자가 없다 (예: -- task --plan smb_task)" >&2; exit 2; }

RUN=(docker run --rm --network host --env-file "$ENVFILE" "${TOPO[@]}" "${MOUNTS[@]}")
[[ -n "$NAME" ]] && RUN+=(--name "$NAME")
echo ">> $IMAGE  domain=$DOMAIN  args=$*"
"${RUN[@]}" "$IMAGE" "$@"
