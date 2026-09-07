"""티켓 상태 지정 — 콘솔에서 사람이 고른 상태를 도메인 스레드에 반영한다.

    python -m service.ticket_status_cli --domain smb --thread-id 129 \
        --status closed --requested-by <운영자>

## 왜 CLI 인가

발송(`console_send_cli`)·담당자(`owner_set_cli`)와 같은 이유다. control-plane 은 제품
DB(`digisecu_control`)만 쓰고, 게이트웨이는 읽기 전용 롤이다 — 도메인 DB 에 쓰는 문은
여기 하나다.

## 종료 코드 — 발송/담당자 CLI 와 같은 규약

    0  반영됨   stdout 에 JSON 한 줄(무엇이 무엇으로 바뀌었는지)
    2  못 함    스레드 없음 · 이미 그 상태 · 어휘 밖 도메인
    3  인자가 어휘 밖

## ⚠️ 무엇을 쓰고 무엇을 안 쓰나

- 쓴다: 스레드의 `status`(콘솔 필터가 이걸 읽는다) + `last_reason`(누가 왜 바꿨나).
- 안 쓴다: 이미 나간 메일, finding, 재검증 기록. 상태만 바꾼다 — 사실을 고치지 않는다.
"""
from __future__ import annotations

import argparse
import json

_DOMAINS = ("smb", "github", "confluence", "dev_web")


def _clean(value: str | None, *, limit: int = 200) -> str:
    text = str(value or "")
    return "".join(ch for ch in text if ch.isprintable())[:limit]


def main(argv: list[str] | None = None) -> int:
    from service.services.ticket_status import TICKET_STATUS_ORDER

    parser = argparse.ArgumentParser(description="티켓 상태 지정")
    parser.add_argument("--domain", required=True, choices=_DOMAINS)
    parser.add_argument("--thread-id", required=True, type=int)
    parser.add_argument("--status", required=True, choices=TICKET_STATUS_ORDER)
    parser.add_argument("--requested-by", default="")
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        print(json.dumps({"error": "invalid arguments"}, ensure_ascii=False))
        return 3

    if args.thread_id < 1:
        print(json.dumps({"error": "thread_id must be >= 1"}, ensure_ascii=False))
        return 3

    from service.runtime_env import load_runtime_env

    # ⚠️ 플러그인은 안 읽는다 — DB 쓰기만 한다(발송·담당자 CLI 와 같은 이유).
    load_runtime_env(load_plugins=False)

    from service.services.ticket_status import TicketStatusError, set_ticket_status

    try:
        out = set_ticket_status(
            domain=args.domain,
            thread_id=int(args.thread_id),
            ticket_status=args.status,
            requested_by=_clean(args.requested_by),
        )
    except TicketStatusError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 2

    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
