"""제출 장부 집계 — `python -m secu_agent.agent.harness.submissions_report <dir> [...]`

## 왜 읽는 쪽을 같이 만드나

`payload.error_message` 는 2026-08-23(`8c3c8ba`)부터 거부 사유를 온전히 기록하는데,
두 저장소 통틀어 **읽는 코드가 0개**였다. 남기기만 하고 읽지 않으면 계측이 아니다.
장부를 만드는 커밋과 같은 묶음에 소비자를 넣어 그 전례를 반복하지 않는다.

읽기 전용이다 — DB·네트워크·LLM 을 건드리지 않고, 주어진 디렉토리 아래
`.harness/submissions.jsonl` 만 재귀로 모아 센다.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path
from typing import Any, Iterator


def iter_rows(roots: "list[Path]") -> Iterator[dict[str, Any]]:
    """`<root>/**/.harness/submissions.jsonl` 전부를 한 줄씩 흘린다.

    깨진 줄은 건너뛴다 — 장부 한 줄이 깨졌다고 집계 전체를 죽이지 않는다.
    """
    for root in roots:
        if root.is_file():
            paths = [root]
        else:
            paths = sorted(root.rglob(".harness/submissions.jsonl"))
        for path in paths:
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(row, dict):
                    row["_source"] = str(path)
                    yield row


def summarize(rows: "list[dict[str, Any]]") -> dict[str, Any]:
    by_exit: collections.Counter = collections.Counter()
    by_reason: collections.Counter = collections.Counter()
    by_task_reason: collections.Counter = collections.Counter()
    blocked_hits: collections.Counter = collections.Counter()
    mixed_assets: set[str] = set()
    override_present = 0

    for row in rows:
        by_exit[str(row.get("exit_path") or "?")] += 1
        code = str(row.get("reason_code") or "")
        task = str(row.get("task_type") or "?")
        if code:
            by_reason[code] += 1
            by_task_reason[(task, code)] += 1
        if code == "mixed_confidence":
            fingerprint = str(row.get("asset_fingerprint") or "")
            if fingerprint:
                mixed_assets.add(fingerprint)
        if row.get("override_present"):
            override_present += 1
        for outcome in row.get("hit_outcomes") or ():
            if not isinstance(outcome, dict) or outcome.get("hit_verdict") != "blocked":
                continue
            blocked_hits[(
                str(outcome.get("category") or "?"),
                str(outcome.get("kind") or "?"),
                str(outcome.get("hit_reason_code") or "?"),
            )] += 1

    return {
        "total": len(rows),
        "by_exit": by_exit,
        "by_reason": by_reason,
        "by_task_reason": by_task_reason,
        "blocked_hits": blocked_hits,
        "mixed_assets": len(mixed_assets),
        "override_present": override_present,
    }


def render(summary: dict[str, Any], *, top: int = 15) -> str:
    out: list[str] = [f"제출 시도 {summary['total']}건"]

    out.append("\n== 종료 경로 ==")
    for name, count in summary["by_exit"].most_common():
        out.append(f"{count:7d}  {name}")

    out.append("\n== 판정 사유 ==")
    for code, count in summary["by_reason"].most_common():
        out.append(f"{count:7d}  {code}")

    out.append("\n== 도메인 x 사유 ==")
    for (task, code), count in summary["by_task_reason"].most_common(top):
        out.append(f"{count:7d}  {task:12s} {code}")

    out.append("\n== 막힌 hit (category/kind/사유) ==")
    for (category, kind, code), count in summary["blocked_hits"].most_common(top):
        out.append(f"{count:7d}  {category}/{kind}  {code}")

    out.append(
        f"\nmixed_confidence 를 겪은 고유 자산: {summary['mixed_assets']}개"
        "  (= 확정 hit 이 있는데 약한 hit 때문에 못 남긴 자산)"
    )
    # ⚠️ gate_override 는 TaskFinding 에 `extra` 필드가 없어 도장이 안 찍힌다.
    #    아래가 0 이 아니게 되는 날이 배선이 살아난 날이다.
    out.append(f"gate_override 도장이 찍힌 제출: {summary['override_present']}건")
    return "\n".join(out)


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="증거 디렉토리의 제출 장부(submissions.jsonl)를 집계한다 (읽기 전용)",
    )
    parser.add_argument("paths", nargs="+", type=Path,
                        help="증거 디렉토리 (또는 submissions.jsonl 파일)")
    parser.add_argument("--top", type=int, default=15, help="상위 N개만 표시 (기본 15)")
    parser.add_argument("--json", action="store_true", help="집계를 JSON 으로 출력")
    args = parser.parse_args(argv)

    rows = list(iter_rows(args.paths))
    if not rows:
        print("submissions.jsonl 을 찾지 못했다 — 경로를 확인하라.", file=sys.stderr)
        return 1

    summary = summarize(rows)
    if args.json:
        print(json.dumps({
            "total": summary["total"],
            "by_exit": dict(summary["by_exit"]),
            "by_reason": dict(summary["by_reason"]),
            "by_task_reason": {f"{t}|{c}": n for (t, c), n in summary["by_task_reason"].items()},
            "blocked_hits": {
                f"{cat}|{kind}|{code}": n
                for (cat, kind, code), n in summary["blocked_hits"].items()
            },
            "mixed_assets": summary["mixed_assets"],
            "override_present": summary["override_present"],
        }, ensure_ascii=False, indent=2))
    else:
        print(render(summary, top=args.top))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
