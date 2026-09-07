#!/usr/bin/env bash
# 워커 런타임 env 파일 조립 — 이미지에서 뺀 .env 를 **주입 경로**로 되돌린다.
#
# 【왜 필요한가】 06ca136 이 이미지 컨텍스트에서 .env 를 제외했다. 그 전까지 워커는 baked
#   /skill/.env 를 런타임에 실제로 읽고 있었다(bootstrap 이 /skill 을 sys.path[0] 에 넣어
#   service.runtime_env 가 site-packages 대신 /skill/service 로 resolve → parents[1]/.env).
#   즉 파일을 빼면 38키가 조용히 사라진다. 그 중 32키는 live 컨테이너가 -e 로 주지 않던 것들
#   (MCP_SPLUNK_GATEWAY_*, SA_KNOX_MAIL_MCP_URL, SA_DELIVERY_*, POP3_*, SMB_HUNT_* …).
#   → 빌드에서 뺀 대신 **여기서 명시 주입**한다. 없어진 걸 눈에 보이게 만드는 게 핵심이다.
#
# 【docker --env-file 의 함정 — 이 스크립트의 존재 이유】
#   1) 따옴표를 안 벗긴다. `SMB_USERNAME="ds\foo"` → 값이 `"ds\foo"` (따옴표 포함) 로 들어간다.
#      SMB 인증은 조용히 실패하고 guest 로 떨어진다(2026-08 스윕 6주 정지와 같은 계열의 사고).
#   2) `${HOME}` 등 미전개 참조를 전개하지 않는다. 셸이 아니다.
#      engine/.env 의 SA_PLUGINS 는 호스트 경로다 — 그대로 주입하면 이미지 ENV
#      (/skill/plugin/bootstrap.py) 를 덮어써서 **플러그인 0개**가 된다.
#   3) 호스트 경로(SA_RESULTS_DIR=/home/…)도 컨테이너에 없다.
#   → 따옴표를 벗기고, 컨테이너에서 깨지는 키는 **빼고**(이미지 ENV 가 이기게 둔다) 리포트한다.
#
# 【우선순위】 코어 load_runtime_env 와 동일: skill/.env 먼저, engine/.env 는 없는 키만
#   (코어가 setdefault 라 먼저 읽은 쪽이 이긴다). 실행 시 -e 로 준 값이 최우선인 건 docker 규칙.
#
# 【사용】
#   ENVFILE="$(deploy/engine/runtime-env.sh)"      # 경로가 stdout, 리포트는 stderr
#   docker run --env-file "$ENVFILE" ...           # run-worker.sh 가 이걸 한다
#   deploy/engine/runtime-env.sh --check           # 파일 안 만들고 무엇이 주입/제외되는지만 본다
#
# 【주의】 출력 파일은 평문 시크릿이다. mode 600, mktemp 경로. 쓰고 나면 지운다(run-worker.sh 가 trap).
set -euo pipefail

ENGINE_SRC="${ENGINE_SRC:-$HOME/project/secu-agent}"
SKILL_SRC="${SKILL_SRC:-$HOME/project/secu-agent-skill}"

CHECK=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --out)   OUT="${2:?--out 에 경로 필요}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "ERROR: 알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

# 컨테이너 토폴로지 키 — 이미지 ENV / run-worker.sh 가 정한다. 호스트 값이 이기면 안 된다.
DROP_KEYS=" SA_PLUGINS SA_RESULTS_DIR SA_SKILLS_DIRS SA_ENGINE_DIR HOME PATH PYTHONPATH XDG_CACHE_HOME "

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
: >"$TMP/keep"; : >"$TMP/report"

emit() { printf '%s\n' "$1" >>"$TMP/report"; }

seen_has() { grep -qxF "$1" "$TMP/seen" 2>/dev/null; }
: >"$TMP/seen"

scan_file() {
  local src="$1" label="$2"
  if [[ ! -f "$src" ]]; then emit "  (없음) $label: $src"; return; fi
  local n_keep=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"          # ltrim
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue
    line="${line#export }"
    local k="${line%%=*}" v="${line#*=}"
    k="${k%"${k##*[![:space:]]}"}"                   # rtrim key
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # 값: 앞뒤 공백 → 감싼 따옴표 1겹 제거 (코어 _load_env_file 과 동일 규칙)
    v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    if [[ ${#v} -ge 2 && ( ( "${v:0:1}" == '"' && "${v: -1}" == '"' ) || ( "${v:0:1}" == "'" && "${v: -1}" == "'" ) ) ]]; then
      v="${v:1:${#v}-2}"
    fi

    if seen_has "$k"; then continue; fi              # 먼저 읽은 파일이 이긴다(코어 setdefault)
    printf '%s\n' "$k" >>"$TMP/seen"

    if [[ "$DROP_KEYS" == *" $k "* ]]; then
      emit "  [제외:토폴로지] $k — 이미지/run-worker 가 정한다"; continue
    fi
    if [[ "$v" == *'${'* || "$v" == *'$('* ]]; then
      emit "  [제외:미전개  ] $k — 값에 \${…} 가 남아있다(docker 는 전개 못 함)"; continue
    fi
    if [[ "$v" == /home/* || "$v" == '~/'* ]]; then
      emit "  [제외:호스트경로] $k = $v — 컨테이너에 없는 경로"; continue
    fi
    # 값에 개행/NUL 은 env-file 이 표현 못 한다.
    if [[ "$v" == *$'\n'* ]]; then
      emit "  [제외:개행    ] $k — env-file 이 다중행 값을 표현 못 한다"; continue
    fi
    printf '%s=%s\n' "$k" "$v" >>"$TMP/keep"
    n_keep=$((n_keep+1))
    if [[ "$v" == *localhost* || "$v" == *127.0.0.1* ]]; then
      emit "  [주의:localhost] $k — --network host 전제(run-worker.sh 기본값)"
    fi
    # 인라인 주석/짝 안 맞는 따옴표가 값에 남은 경우. 코어 _load_env_file 도 똑같이 오염된 값을
    # 만들므로(strip('"') 는 양끝만 본다) 여기서 값을 고치지 않는다 — 고치면 호스트 실행과 결과가
    # 갈린다. 대신 .env 자체의 결함으로 보고한다.
    if [[ "$v" == *'"'* || "$v" == *"'"* || "$v" == *' #'* ]]; then
      emit "  [결함:값오염 ] $k — 값에 따옴표/인라인주석이 남았다. 코어도 같게 파싱한다 → .env 를 고쳐라"
    fi
  done <"$src"
  emit "  → $label: ${n_keep}키 주입"
}

emit "runtime-env 조립 (skill 먼저 = 코어 load_runtime_env 우선순위)"
scan_file "$SKILL_SRC/.env"  "skill"
scan_file "$ENGINE_SRC/.env" "engine"
emit "총 주입키: $(wc -l <"$TMP/keep")"

cat "$TMP/report" >&2

if [[ "$CHECK" == 1 ]]; then
  echo "--- 주입될 키(값 미표시) ---" >&2
  cut -d= -f1 "$TMP/keep" | sort | tr '\n' ' ' | fold -w 100 -s >&2; echo >&2
  exit 0
fi

if [[ -z "$OUT" ]]; then OUT="$(mktemp -t de-runtime-env.XXXXXX)"; fi
umask 077
: >"$OUT"; chmod 600 "$OUT"
cat "$TMP/keep" >>"$OUT"
printf '%s\n' "$OUT"
