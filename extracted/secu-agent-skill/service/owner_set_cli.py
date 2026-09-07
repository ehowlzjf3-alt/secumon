"""담당자 지정 — 콘솔에서 사람이 고른 Knox ID 를 실제 담당자로 반영한다.

    python -m service.owner_set_cli --domain smb --thread-id 37 \
        --knox-id donghee4.kim --requested-by <운영자>

## 왜 CLI 인가

발송(`service/console_send_cli.py`)과 같은 이유다. 담당자 해석은 **Knox API** 를 타는데
게이트웨이·control-plane 은 그걸 못 부른다(사내 MCP 게이트웨이 경유이고, 게이트웨이는
읽기 전용 롤이다). control-plane 이 승인 뒤에 이 CLI 를 부른다.

## 종료 코드 — 발송 CLI 와 같은 규약

    0  반영됨   stdout 에 JSON 한 줄(누구로 바뀌었는지)
    2  못 함    스레드 없음 · Knox 에 없는 ID · 사내 메일이 아님
    3  인자가 어휘 밖

## ⚠️ 무엇을 쓰고 무엇을 안 쓰나

- 쓴다: 스레드의 `recipient`·`owner_recipient`(다음 메일이 그리로 간다),
  smb 는 `asset_owner`(그 IP 의 담당자 기록. 다음 주차 스레드가 이걸 읽는다).
- 안 쓴다: 이미 **나간 메일**의 수신처. 그건 일어난 일이라 고치지 않는다.

## ⚠️ 사내 계정만

Knox 에서 찾을 수 없는 ID 는 거부한다. 파트너·외부 주소로 담당자를 바꾸면 조치요청이
사외로 나간다 — 발송 게이트가 막겠지만, 애초에 담당자로 적지 않는다.
"""
from __future__ import annotations

import argparse
import json
import sys

_DOMAINS = ("smb", "github", "confluence", "dev_web")


def _clean(value: str | None, *, limit: int = 200) -> str:
    text = str(value or "")
    return "".join(ch for ch in text if ch.isprintable())[:limit]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="티켓 담당자 지정")
    parser.add_argument("--domain", required=True, choices=_DOMAINS)
    parser.add_argument("--thread-id", required=True, type=int)
    parser.add_argument("--knox-id", required=True)
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

    # ⚠️ 플러그인은 안 읽는다 — Knox 조회와 DB 쓰기만 한다(발송 CLI 와 같은 이유).
    load_runtime_env(load_plugins=False)

    from service.services.owner_assign import OwnerAssignError, assign_owner

    try:
        out = assign_owner(
            domain=args.domain,
            thread_id=int(args.thread_id),
            knox_id=_clean(args.knox_id, limit=64),
            requested_by=_clean(args.requested_by),
        )
    except OwnerAssignError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 2

    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
