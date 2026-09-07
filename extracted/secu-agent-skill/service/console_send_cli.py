"""콘솔 발송 CLI — control-plane 이 자식 프로세스로 부르는 유일한 진입점.

    python -m service.console_send_cli --domain github --thread-id 301 [--requested-by knox_id]

stdout 에 결과 JSON 한 줄. 종료코드는 **발송 여부가 아니라 실행 성공 여부**다:

    0   실행됨 — 결과는 stdout 의 `mode`("sent" | "dry_run") 를 보라
    2   시작조차 못 함(스레드 없음·본문 없음·수신자 없음)
    3   인자가 어휘 밖

★ 게이트가 막아 dry-run 이 된 것은 **오류가 아니다.** 종료코드 0 이고 `reasons` 에 사유가 있다.
  0이 아닌 코드로 만들면 호출부가 "고장" 과 "정책상 안 나감" 을 못 가른다.

## 왜 CLI 인가

control-plane 은 Node 라 `deliver()` 를 직접 못 부른다. 콘솔 스택에 파이썬 서비스를
하나 더 띄우는 대신 자식 프로세스로 부르기로 했다(사용자 결정 2026-08-25).

## ⚠️ 이 방식의 유일한 위험 = 인자 주입

호출부는 **반드시 배열 인자**로 spawn 해야 한다(`shell: true` 금지). 여기서도 방어한다:

  · `--domain` 은 4개 어휘 대조. 그 밖은 즉시 거부.
  · `--thread-id` 는 정수. 문자열이 그대로 SQL 로 가는 경로가 없다.
  · `--requested-by` 는 **기록만** 한다 — 판정에 쓰지 않는다. 길이·제어문자만 자른다.
  · 메일 내용(수신자·제목·본문)은 **인자로 받지 않는다.** 받으면 그게 곧 2026-08-25 에
    지운 `/owner-mail-send` 다. 서버가 DB 에서 다시 읽는다.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

_DOMAINS = ("smb", "github", "confluence", "dev_web")

#: 감사 문자열에서 제어문자·개행을 뺀다 — 로그 한 줄을 여러 줄로 위조하는 것 방지.
_UNSAFE = re.compile(r"[\x00-\x1f\x7f]")
_REQUESTED_BY_MAX = 200


def _clean(value: str) -> str:
    return _UNSAFE.sub("", str(value or ""))[:_REQUESTED_BY_MAX].strip()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="console_send_cli", add_help=True)
    # ⚠️ choices 로 어휘를 강제한다 — 그 밖의 값은 argparse 가 먼저 거부한다.
    ap.add_argument("--domain", required=True, choices=_DOMAINS)
    ap.add_argument("--thread-id", required=True, type=int)
    ap.add_argument("--requested-by", default="")
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        # argparse 는 2 로 죽는데, 여기선 "어휘 밖" 을 3 으로 구분한다.
        print(json.dumps({"error": "invalid arguments"}, ensure_ascii=False))
        return 3

    if args.thread_id < 1:
        print(json.dumps({"error": "thread_id must be >= 1"}, ensure_ascii=False))
        return 3

    # ★ import 를 여기서 한다 — `--help` 나 인자 오류가 무거운 엔진 import 를 안 끌게.
    from service.runtime_env import load_runtime_env
    from service.services.console_send import ConsoleSendError, send_thread

    # ★★ 런타임 env 를 **스스로** 읽는다. 부모(control-plane)의 환경에 기대면 안 된다 —
    #    `*_REMEDIATION_MAIL_MODE` 가 없으면 `delivery_targets` 가 담당자 대신 DSSOC 를
    #    돌려주고, 화면엔 "보냈다" 로 남는다. 실제로 확인했다: 같은 스레드가
    #    env 있을 때 담당자, 없을 때 DSSOC 였다(2026-08-25).
    #    ⚠️ plugins 는 안 읽는다 — 발송 경로가 쓰는 도구는 직접 import 한다.
    load_runtime_env(load_plugins=False)

    try:
        out = send_thread(
            domain=args.domain,
            thread_id=args.thread_id,
            requested_by=_clean(args.requested_by),
        )
    except ConsoleSendError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 2

    # stdout 은 **JSON 한 줄만**. 다른 출력이 섞이면 호출부 파싱이 깨진다.
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
