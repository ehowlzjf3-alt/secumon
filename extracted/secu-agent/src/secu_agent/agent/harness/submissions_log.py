"""제출 시도 장부 — `<evidence_dir>/.harness/submissions.jsonl` (append-only).

## 왜 만들었나 (2026-08-28 실측)

거부된 제출은 **아무 파일도 안 남긴다.** `submit_finding.execute` 의 거부 return 이
`finding.json` 경로를 정하는 줄보다 위에 있어서, 판정에 걸린 순간 증거가 사라진다.
4도메인 증거 디렉토리에서 거부가 기록된 run 172개 중 **143개(83%)에 finding.json 이 없다.**

audit 로그의 `payload.error_message` 에는 사유가 온전히 남지만(2026-08-23 `8c3c8ba` 이후),
두 저장소 통틀어 **읽는 코드가 0개**였다. 그리고 그 필드는 8-23 이전 거부 1,540건에는
아예 없다. 그래서 사유를 세려면 별도 장부가 필요하다.

## 무엇을 담고 무엇을 안 담나

담는다: 시각·도구·판정·사유 코드·hit 수와 category·종료 경로.
**안 담는다: 자산 원문, hit 의 masked/preview, finding 요약.** 거부된 finding 의 내용을
새 파일에 옮기면 그 자체가 새 유출 표면이다. 자산은 지문(sha256 앞 16자)으로만 적는다.

⚠️ `finding.json` 은 **세션당 한 파일을 덮어쓴다**(고정 이름). 성공한 제출도 마지막
1건만 남는다. 이 장부는 append-only 라 시도 전부가 남는다 — 그게 차이다.

⚠️ 이 모듈은 **절대 예외를 밖으로 던지지 않는다.** 계측이 제출을 죽이면 안 된다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_FILENAME = "submissions.jsonl"

#: 종료 경로 — `submit_finding.execute` 의 return 자리마다 하나씩. 늘리면 여기 먼저 적는다.
EXIT_PATHS = (
    "validation_error",     # pydantic 입력 검증 실패 (판정 도달 전)
    "browser_gate",         # 정책 A — 대상 호스트를 브라우저로 안 열었다
    "judgment_rejected",    # 증거계약 거부
    "io_error",             # 파일/DB 쓰기 실패
    "nonpersist_success",   # 판정은 통과했으나 영속 대상 아님(informational 등)
    "persist_success",      # lifecycle finding 생성/갱신
)


def asset_fingerprint(value: str) -> str:
    """자산 원문 대신 적는 지문. 같은 자산인지 비교만 하면 되므로 되돌릴 필요가 없다."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:16]


def record_submission(
    evidence_dir: Any,
    *,
    tool: str,
    exit_path: str,
    verdict: str = "",
    reason_code: str = "",
    should_persist: bool | None = None,
    task_type: str = "",
    asset: str = "",
    hit_categories: "list[str] | tuple[str, ...]" = (),
    hit_outcomes: "list[dict[str, Any]] | tuple[dict[str, Any], ...]" = (),
    override_present: bool = False,
) -> None:
    """제출 시도 한 건을 장부에 붙인다. 실패해도 조용히 넘어간다(계측이 제출을 못 막는다).

    ⚠️ `override_present` 는 지금 **항상 False** 다 — `TaskFinding` 에 `extra` 필드가 없어
    도장이 안 찍힌다(`gate_override` 미배선). 그 사실이 보여야 고쳐지므로 지표는 남긴다.
    """
    try:
        base = Path(evidence_dir) / ".harness"
        base.mkdir(parents=True, exist_ok=True)
        outcomes = [
            {
                "index": o.get("index"),
                "category": o.get("category"),
                "kind": o.get("kind"),
                "hit_verdict": o.get("hit_verdict"),
                "hit_reason_code": o.get("hit_reason_code"),
            }
            for o in (hit_outcomes or ())
            if isinstance(o, dict)
        ]
        blocked = sum(1 for o in outcomes if o.get("hit_verdict") == "blocked")
        row = {
            "ts": time.time(),
            "tool": tool,
            "exit_path": exit_path,
            "verdict": verdict,
            "reason_code": reason_code,
            "should_persist": should_persist,
            "task_type": task_type,
            "asset_fingerprint": asset_fingerprint(asset),
            "hit_count": len(hit_categories),
            "confirmed_count": len(outcomes) - blocked if outcomes else None,
            "blocked_count": blocked if outcomes else None,
            "hit_categories": sorted({str(c) for c in (hit_categories or ())}),
            "hit_outcomes": outcomes,
            "override_present": bool(override_present),
        }
        with (base / _FILENAME).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 — 계측 실패가 제출을 죽이면 안 된다
        log.warning("submissions.jsonl 기록 실패 (%s/%s)", tool, exit_path, exc_info=True)
