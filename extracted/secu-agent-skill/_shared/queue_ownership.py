"""큐 소유권 — 위임된 검토원은 큐를 닫지 않는다 (Phase 2, 사용자 확정 2026-08-21).

## 규칙

```
위임된 검토원  SA_AGENT_DEPTH >= 1  → 닫지 않는다. 권고만 남긴다. 리드가 닫는다.
단독 검토원    SA_AGENT_DEPTH == 0  → 닫는다. (Phase 1 동작 그대로)
```

`SA_AGENT_DEPTH` 는 코어가 워커 env 로 +1 씩 주입한다(`agent_tool.py::_worker_env`).
**이미 있는 신호**라 새 배선이 필요 없고, 기존 러너 경로(`run_agent`)와 Phase 1
실기동 경로(`python -m secu_agent.agent <dir>` 직접)는 둘 다 depth 0 이라 **동작이
바뀌지 않는다** — 변경 범위가 정확히 '리드가 spawn 한 검토원' 하나다.

## 왜 4도메인 전부 같은 규칙인가

사용자 원칙 ②. smb 만 예외로 두면(계약 후처리에서 닫고, 나머지 셋은 종료 도구가
닫고) 리드 층에서 다시 도메인별 분기가 생긴다. 그러면 "누가 닫았는가"가 도메인마다
달라지고, 그 차이는 **에러를 내지 않는다** — 둘 다 닫거나(경합) 둘 다 안 닫는다
(큐가 walked 인 채로 영영 남는다). 조용히 틀리는 것이 이 프로젝트의 반복된 실패라
규칙 하나로 못 박고 테스트로 고정한다.

## 권고는 어떻게 리드에게 가는가

위임된 검토원은 자기 evidence_dir 에 `recommended_status.json` 을 쓴다. 리드의
`delegate_inspect` 는 이미 그 디렉터리를 찾아 `worker_result.json` 을 읽으므로
같은 자리에서 권고를 집어 봉투에 넣는다. LLM 산문 파싱이 아니라 파일이다.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("shared.queue_ownership")

AGENT_DEPTH_ENV = "SA_AGENT_DEPTH"
RECOMMENDATION_FILENAME = "recommended_status.json"


def agent_depth() -> int:
    """이 프로세스의 spawn 깊이. 코어 `agent_tool._agent_depth` 와 같은 시맨틱."""
    raw = (os.environ.get(AGENT_DEPTH_ENV) or "").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def is_delegated_inspector() -> bool:
    """위임된 검토원인가 — True 면 큐를 닫지 않는다."""
    return agent_depth() >= 1


def write_recommendation(
    evidence_dir: Path | str | None,
    *,
    target_ids: list[int] | None = None,
    status: str,
    finding_count: int | None = None,
    reason: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """리드가 읽을 권고를 남긴다. 반환값은 도구가 그대로 돌려줄 payload.

    권고를 **여러 번** 쓸 수 있다(검토원이 여러 타깃을 맡은 경우) — append 가 아니라
    덮어쓰기다. 마지막 판단이 그 검토원의 판단이다.
    """
    payload: dict[str, Any] = {
        "deferred_to_lead": True,
        "recommended_status": status,
        "target_ids": [int(t) for t in (target_ids or [])],
        "finding_count": finding_count,
        "reason": reason,
        **extra,
    }
    if evidence_dir is None:
        log.warning("권고를 쓸 evidence_dir 이 없다 — 리드는 권고를 못 받는다")
        return payload
    path = Path(evidence_dir) / RECOMMENDATION_FILENAME
    try:
        path.write_text(
            json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8")
    except OSError:
        # 권고 기록 실패가 검토원 종료를 막으면 안 된다 — 리드는 봉투의
        # source/summary 로 물러선다.
        log.exception("권고 기록 실패: %s", path)
    return payload


def read_recommendation(evidence_dir: Path | str) -> dict[str, Any] | None:
    path = Path(evidence_dir) / RECOMMENDATION_FILENAME
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        got = json.loads(raw)
    except ValueError:
        return None
    return got if isinstance(got, dict) else None


# ── 리드 쪽: 권고 모으기 (v3.98) ───────────────────────────────────────
#
# 검토원은 자기 evidence_dir 에 권고를 남기고, 리드는 그걸 보고 큐를 닫는다. 그런데
# 리드가 권고를 **말없이 뒤집을 수 있었다** — 2026-08-21 실기동에서 smb 리드가 권고
# `triaged_completed` 를 `closed` 로 바꿨고 근거가 아무 데도 안 남았다.
# `set_target_status` 가 그걸 알아채려면 "이 타깃에 대한 권고가 있었나" 를 물어야 한다.

def result_dirs(evidence_dir: Path | str) -> list[Path]:
    """검토원 결과가 들어 있는 하위 디렉터리 — **두 종류다.**

    ⚠️ one-shot 은 `sub-*`, 세션은 `session-<id>-<domain>` 에 쓴다. serve 모드도
    `_serve_loop` 반환 뒤 같은 `on_submit`/`on_no_submit` 훅을 타므로 권고 파일은
    양쪽 다 생긴다(코어 `cli.py`).

    ★ `inspector_channel.sub_dirs()` 를 넓혀서 재사용하면 안 된다. 그건 one-shot 위임
    전후 diff 용이고, 세션 디렉터리를 "이번 위임의 결과" 로 오인하게 만든다.
    용도가 다르면 함수도 달라야 한다.
    """
    base = Path(evidence_dir)
    out: list[Path] = []
    for pattern in ("sub-*", "session-*"):
        try:
            out += [p for p in base.glob(pattern) if p.is_dir()]
        except OSError:
            continue
    return sorted(out)


def collect_recommendations(evidence_dir: Path | str) -> dict[int, dict[str, Any]]:
    """`{target_id: 권고}` — 같은 타깃에 권고가 둘이면 **나중 것**이 이긴다.

    나중 것을 택하는 근거는 `write_recommendation` 의 시맨틱과 같다(append 가 아니라
    덮어쓰기 — 마지막 판단이 그 검토원의 판단이다). 여기서는 디렉터리 mtime 순으로 본다.
    """
    out: dict[int, dict[str, Any]] = {}
    dirs = result_dirs(evidence_dir)
    try:
        dirs.sort(key=lambda p: p.stat().st_mtime)
    except OSError:
        pass
    for d in dirs:
        rec = read_recommendation(d)
        if not rec:
            continue
        for tid in (rec.get("target_ids") or []):
            try:
                out[int(tid)] = rec
            except (TypeError, ValueError):
                continue
    return out
