#!/usr/bin/env bash
# dev_web **발견(discovery) 전용** 루프.
#
# ★ 2026-08-31 로 범위가 줄었다. 메일 큐(조치요청·재검증)는 4도메인 공용 러너가
#   돈다 — `service/agents/thread_pipeline_runner.py`. 여기 남은 것은 **새 대상
#   찾아오기** 하나뿐이고, 그건 메일 큐와 성격이 다른 축이라 합치지 않았다.
#
#   github·confluence 는 자기 pipeline_runner 가, smb 는 collector.runner 가
#   같은 일을 한다. dev_web 만 그 자리가 없어서 이 셸이 대신한다.
#
# ★ `platform.control_flag` 를 **존중한다** — 다른 러너와 같은 스위치로 꺼진다.
#   존중 안 하면 콘솔에서 껐는데 이것만 계속 도는, 화면과 실제가 어긋나는 상태가 된다.
#
# 사용:
#   PYTHONPATH=.:$SA_ENGINE_DIR/src scripts/dev_web_loop.sh
# 끄기:
#   UPDATE platform.control_flag SET enabled=0 WHERE component IN ('dev_web_task','dev_web_report');

set -uo pipefail

PY="${DEV_WEB_PYTHON:-$HOME/project/secu-agent/.venv/bin/python}"
INTERVAL="${DEV_WEB_LOOP_INTERVAL:-60}"

# ★★ 배치 상한 — **2026-08-28 부터 이 루프에서 쓰이지 않는다.**
#   유일한 소비자였던 task 블록(`runners.task --max-targets "$BATCH"`)이 평면 레인
#   은퇴로 지워졌다. 리드는 자기 동시성 설정(`lead_agent._DEFAULT_MAX_SESSIONS`=2)을 쓴다.
#
#   ⚠️ 왜 상한이 필요했는지는 남긴다: `run_task_pass(max_targets=None)` 은 대상이
#   바닥날 때까지 while 을 돌았고, 2026-08-25 실측에서 워커 1개가 1분에
#   dev_web_target 2,598건을 전부 claim 했다. 그러면 (1) 다른 워커가 집을 게 없고
#   (2) 죽으면 전량이 stale claim 으로 묶이고 (3) 진척이 "다 했다" 처럼 보인다.
#   리드 경로에 배치 상한을 다시 둘 일이 있으면 이 실측을 근거로 삼아라.

# ★★ 패스 시간 상한. **없으면 한 패스가 영원히 매달린다.**
#   2026-08-26 실측: `runners.report` 한 패스가 gateway.security.samsungds.net:443 소켓에
#   붙은 채 **17시간** 살아 있었다(State=S, ep_poll, 송수신 큐 0 — 오지 않을 응답 대기).
#   루프 셸이 그 자식을 기다리느라 task 패스도 같이 멎어, dev_web 이 01:53 에 멈춘 채
#   pending 60건이 12시간을 굶었다. 그런데 `pipeline_run` 엔 status='running' 으로 남아
#   화면상으론 **일하는 중**으로 보였다 — 죽은 것보다 나쁘다.
#   ⚠️ HTTP 클라이언트 타임아웃이 따로 있어도 이 백스톱은 지운다는 뜻이 아니다.
#      매달리는 지점은 매번 다르고, 루프가 자기 자식을 못 놓는 것 자체가 결함이다.
PASS_TIMEOUT="${DEV_WEB_PASS_TIMEOUT:-1800}"

# `timeout` 은 TERM 뒤 60s 까지 기다렸다 KILL — 파이썬이 정리(claim 해제)할 틈을 준다.
run_pass() {
  timeout --kill-after=60 "$PASS_TIMEOUT" "$@"
  local rc=$?
  # 124 = 상한 초과. 조용히 넘기면 다음 패스에서 같은 자리에 또 매달린다.
  [ "$rc" = "124" ] && echo "[dev_web_loop] ⚠️ 패스가 ${PASS_TIMEOUT}s 를 넘겨 강제 종료됨: $*"
  return "$rc"
}

# control_flag 조회. 못 읽으면 **돌지 않는다**(fail-closed) — DB 가 죽었는데
# 계속 도는 것보다 멈추는 쪽이 낫다.
#
# ★★ 런타임 env 를 **스스로** 읽는다. 부모 셸의 export 에 기대면 안 된다.
#   2026-08-26 실측: 이 프로브가 `load_runtime_env()` 를 안 불러 `SECU_AGENT_PG_DSN` 이
#   없었고, `state.connect()` 가 RuntimeError → except → `0` → 루프가 **아무것도 안 하고
#   60초마다 자기만** 했다. 로그엔 "시작" 한 줄뿐이라 정상으로 보였다.
#   원래 돌던 루프는 우연히 DSN 이 export 된 셸에서 떠 있었을 뿐이다 —
#   되살리는 순간 숨은 의존이 드러났다(`console_send_cli.py` 가 같은 이유로 자기가 읽는다).
#
# ★ 그리고 fail-closed 는 **시끄러워야** 한다. "플래그 꺼짐" 과 "DB 를 못 읽음" 이 둘 다
#   조용한 0 이면, 12시간을 멈춰 있어도 아무도 모른다. 사유를 구분해 찍는다.
#     0 = 꺼짐 · 1 = 켜짐 · 2 = 못 읽음
flag_probe() {
  "$PY" - "$1" <<'FLAGPY' 2>/dev/null
import sys
try:
    from service.runtime_env import load_runtime_env
    load_runtime_env(load_plugins=False)   # plugins 는 불필요(느리고 전역을 오염시킨다)
    from service import state_domain as state
    with state.connect() as c:
        r = c.execute(
            "SELECT enabled FROM platform.control_flag WHERE component=?",
            (sys.argv[1],),
        ).fetchone()
    print(1 if (r and int(r["enabled"] or 0)) else 0)
except Exception as e:
    print(2)
    print(repr(e)[:200], file=sys.stderr)
FLAGPY
}

flag_enabled() {
  local component="$1" out
  out=$(flag_probe "$component")
  case "$out" in
    1) return 0 ;;
    0) return 1 ;;
    *) echo "[dev_web_loop] control_flag 를 못 읽었다($component) — 이번 주기 건너뜀." >&2
       return 1 ;;
  esac
}

echo "[dev_web_loop] 시작 — 주기 ${INTERVAL}s"
while true; do
  # ★ 발견(#0) — 없던 자리다. github·confluence 는 *_pipeline_runner 가 이 단계를
  #   control_flag.interval_seconds 로 하루 한 번 돌리는데, dev_web 은 그 러너가 없어서
  #   discovery 를 부르는 곳이 **한 번도 없었다**. 마지막 발견이 2026-08-24 이고
  #   그동안 소스(Splunk)에는 하루 1,400만 건이 쌓였다 — pending 0 은 고갈이 아니라
  #   미공급이었다. --if-due 가 control_flag 를 보고 스스로 조절하므로 매 틱 불러도 된다.
  if flag_enabled dev_web_discovery; then
    run_pass "$PY" -m domains.dev_web.runners.discovery --if-due || echo "[dev_web_loop] discovery 실패(계속)"
  fi
  # ★ 평면 task 블록은 지웠다 (2026-08-28). 이 큐의 시작점은 `dev_web.lead` 이고,
  #   리드는 자기 러너(`lead_agent`)가 돈다 — 이 셸 루프가 아니다.
  #   `domains.dev_web.runners.task` 는 은퇴 heartbeat 만 찍는 스텁이라 부를 이유가 없다.
  # ★ report 블록은 지웠다 (2026-08-31). 메일 큐(조치요청·재검증)는 4도메인 공용
  #   러너가 돈다 — `service/agents/thread_pipeline_runner.py`.
  #   여기 남겨 두면 같은 컴포넌트를 둘이 돌린다.
  #
  # ⚠️ **discovery 는 남긴다.** 그건 메일 큐가 아니라 "새 대상 찾아오기" 이고
  #   공용 러너가 하지 않는다. 여기서 지우면 dev_web 만 다시 대상을 못 가져온다 —
  #   위 주석의 그 사고(마지막 발견 8/24, 소스엔 하루 1,400만 건)가 재발한다.
  sleep "$INTERVAL"
done
