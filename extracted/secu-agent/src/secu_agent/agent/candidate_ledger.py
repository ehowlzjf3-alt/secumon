"""Candidate ledger — 침묵(과소보고) 방지 게이트의 장부.

evidence judge(submit_finding)는 "제출한 것"만 검사한다 — 허풍 방지 문.
이 모듈은 반대쪽 문이다: 도구가 관찰한 **후보**(scan hit/검색 결과)를 장부에
기록하고, 제출도 기각 기록도 없이 text-only 로 끝내려는 침묵을 엔진이
결정론적으로 되돌린다. 약한 모델의 비대칭 인센티브(제출=기각 위험,
침묵=무벌칙)를 깨는 것이 목적.

도메인-프리: 코어는 "후보"가 무엇인지 모른다. 코어 도구(scan_text 등)는
record_candidates_seen 을 직접 호출하고, 도메인 plugin 은
register_candidate_counter 로 자기 도구 결과에서 후보를 세는 counter 를
등록한다(invoker 초크포인트가 ToolSuccess 후 실행 — 도구 코드 0줄 수정).

게이트는 opt-in: metadata["candidate_ledger_enforce"] 가 truthy 일 때만
발동한다(워커 cli 가 set, 대화형 chat 은 미설정 → 기존과 byte-for-byte).
"""
from __future__ import annotations

import copy
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

log = logging.getLogger(__name__)

LEDGER_KEY = "candidate_ledger"
ENFORCE_KEY = "candidate_ledger_enforce"
TRIAGE_TOOL_NAME = "triage_candidates"

# candidate 계수 시맨틱 버전 — worker_result.metrics_version 로 전파된다.
# counter 단위/집계 규칙을 바꾸면 이 값을 올려, read-model 이 구/신 데이터를
# 섞지 않고 GROUP BY 할 수 있게 한다. v1 = 총-침묵(seen>0∧accounted==0) 게이트.
CANDIDATE_METRICS_VERSION = 1

_MAX_SOURCES = 20
_MAX_SAMPLES = 20
_MAX_SAMPLE_CHARS = 200

CandidateBucket = Literal["seen", "submitted", "triaged"]
_BUCKETS = frozenset({"seen", "submitted", "triaged"})


def _ledger(metadata: dict[str, Any]) -> dict[str, Any]:
    raw = metadata.get(LEDGER_KEY)
    if not isinstance(raw, dict):
        raw = {}
        metadata[LEDGER_KEY] = raw
    raw.setdefault("seen", 0)
    raw.setdefault("submitted", 0)
    raw.setdefault("triaged", 0)
    raw.setdefault("sources", {})
    raw.setdefault("samples", [])
    return raw


def _as_count(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def record_candidates_seen(
    metadata: dict[str, Any],
    *,
    source_tool: str,
    count: int,
    samples: tuple[str, ...] | list[str] = (),
) -> None:
    """도구가 후보 count 개를 관찰했다고 기록. count<=0 은 no-op.

    samples 는 리마인더 텍스트용 위치/분류 라벨 — 민감값을 넣지 마라
    (masked/preview 가 아닌 category/kind/location 수준만).
    """
    n = _as_count(count)
    if n <= 0:
        return
    ledger = _ledger(metadata)
    ledger["seen"] = _as_count(ledger.get("seen")) + n
    sources = ledger["sources"]
    if isinstance(sources, dict) and (
        source_tool in sources or len(sources) < _MAX_SOURCES
    ):
        sources[source_tool] = _as_count(sources.get(source_tool)) + n
    bucket = ledger["samples"]
    if isinstance(bucket, list):
        for s in samples:
            if len(bucket) >= _MAX_SAMPLES:
                break
            text = str(s).strip()[:_MAX_SAMPLE_CHARS]
            if text and text not in bucket:
                bucket.append(text)


def record_candidates_accounted(
    metadata: dict[str, Any],
    *,
    bucket: Literal["submitted", "triaged"],
    count: int,
) -> None:
    """후보 처리(제출/기각) count 건 기록. count<=0 은 no-op."""
    if bucket not in ("submitted", "triaged"):
        raise ValueError(f"invalid accounted bucket: {bucket!r}")
    n = _as_count(count)
    if n <= 0:
        return
    ledger = _ledger(metadata)
    ledger[bucket] = _as_count(ledger.get(bucket)) + n


def candidate_ledger_stats(metadata: dict[str, Any]) -> tuple[int, int, int]:
    """(seen, submitted, triaged). 장부 없음/깨짐 = (0, 0, 0)."""
    raw = metadata.get(LEDGER_KEY)
    if not isinstance(raw, dict):
        return (0, 0, 0)
    return (
        _as_count(raw.get("seen")),
        _as_count(raw.get("submitted")),
        _as_count(raw.get("triaged")),
    )


def candidate_ledger_unreconciled(metadata: dict[str, Any]) -> bool:
    """enforce 상태에서 **완전 침묵**(후보 관찰 & 제출·기각 전무)인가.

    설계 결정(codex 2라운드): 정확-카운트 대조(seen>accounted)는 counter 단위
    불일치(page vs hit)·반복 스캔 이중집계·크레딧 흡수·무한 재점검 루프를 낳는다
    — cumulative 정수 counter 에 후보 identity 가 없어 exact 화해가 원천적으로
    불안정하기 때문. 그래서 게이트는 **이진 신호** 로 좁힌다: "관찰했는데 제출도
    기각도 0" = 실제 사고(22 seen, 0 accounted) 그 자체. 이 조건은 단위 불일치·
    이중집계에 면역이고 정당한 워커를 over-block 하지 않는다.

    알려진 절충(문서화): 어떤 accounting 이든 한 번 일어나면(submit∨triage 1건)
    게이트는 그 실행 동안 off — 이후 관찰한 새 후보의 침묵은 놓친다(narrow
    under-block). over-block/재점검-루프보다 안전한 방향으로 택함.

    엔진 게이트 조건에서 triage_available 만 뺀 판정 — terminal 즉시-break 하는
    외부 러너(skill run_agent)가 "지금 끊으면 엔진 게이트가 개입 못 한다" 를
    판단할 때 쓴다. True 면 러너는 break 를 미루고 엔진이 리마인더를 주입하게
    계속 소비해야 한다.
    """
    if not metadata.get(ENFORCE_KEY):
        return False
    seen, submitted, triaged = candidate_ledger_stats(metadata)
    return seen > 0 and submitted == 0 and triaged == 0


def build_candidate_ledger_reminder(
    metadata: dict[str, Any],
    *,
    triage_available: bool,
) -> str | None:
    """침묵 종료 시도에 대한 시스템 노트 (None = 게이트 비발동).

    발동 조건 전부 충족 시에만:
    - metadata[ENFORCE_KEY] truthy (워커 opt-in — chat 경로는 미설정)
    - 후보 관찰 > 0, 제출 0, 기각 기록 0 (완전 침묵)
    - triage_candidates 도구가 이 registry 에 노출됨 (없는 toolset 에서
      이행 불가능한 요구를 하지 않는다 — skill lockstep 전 안전)
    """
    if not triage_available:
        return None
    if not candidate_ledger_unreconciled(metadata):
        return None
    seen, _submitted, _triaged = candidate_ledger_stats(metadata)
    raw = metadata.get(LEDGER_KEY)
    sources = raw.get("sources") if isinstance(raw, dict) else {}
    samples = raw.get("samples") if isinstance(raw, dict) else []
    source_line = ", ".join(
        f"{tool}={_as_count(cnt)}" for tool, cnt in sources.items()
    ) if isinstance(sources, dict) else ""
    lines = [
        "[SYSTEM NOTE] Candidate ledger is UNRECONCILED. Your tools observed "
        f"{seen} candidate signal(s) but recorded 0 submissions and 0 "
        "dismissals — total silence. A text-only answer is NOT an acceptable "
        "way to end this task; silence is not a verdict.",
        "You must engage the candidates — do at least one of:",
        "- deep-dive a candidate (read the original content, open the endpoint) "
        "and, if real exposure is confirmed, submit it via your finding-"
        f"submission tool (e.g. submit_finding / <domain>_submit_finding); or",
        f"- dismiss candidates explicitly via {TRIAGE_TOOL_NAME} with a "
        "concrete, per-candidate reason observed during deep-dive (e.g. "
        "'placeholder value, no real credential', 'requires auth — no data "
        "visible'). Generic reasons without inspection are a policy violation.",
    ]
    if source_line:
        lines.append(f"Observed candidate sources: {source_line}.")
    if isinstance(samples, list) and samples:
        lines.append("Sample candidates: " + "; ".join(
            str(s)[:_MAX_SAMPLE_CHARS] for s in samples[:6]
        ))
    return "\n".join(lines)


# ── 등록형 counter 훅 (도메인 plugin 용 — 코어 0줄 수정) ────────────────────────
@dataclass(frozen=True)
class CandidateCounter:
    """도구 결과에서 후보/처리 건수를 세는 counter.

    count(tool_input, result_content) -> int — tool_input 은 deep copy 로
    전달된다(counter 가 실행 입력을 변조 못 함). 예외/음수는 0 취급.
    """

    name: str
    tool_name: str
    bucket: CandidateBucket
    count: Callable[[dict[str, Any], str], int]

    def __post_init__(self) -> None:
        if self.bucket not in _BUCKETS:
            raise ValueError(f"invalid bucket: {self.bucket!r}")


_COUNTERS: dict[str, list[CandidateCounter]] = {}
_COUNTERS_LOCK = threading.Lock()


def register_candidate_counter(counter: CandidateCounter) -> None:
    """counter 등록 (plugin API). name 은 **전역 유일**(codex #20).

    unregister_candidate_counter(name) 가 전 tool 에서 name 을 지우므로, 같은
    name 을 서로 다른 tool 에 허용하면 한쪽 해제가 다른쪽 counter 까지 지운다.
    등록 시점에 전역 유일을 강제해 그 비대칭을 없앤다.
    """
    with _COUNTERS_LOCK:
        for counters in _COUNTERS.values():
            for existing in counters:
                if existing.name == counter.name:
                    raise ValueError(
                        f"candidate counter already registered: {counter.name!r}"
                    )
        _COUNTERS.setdefault(counter.tool_name, []).append(counter)


def unregister_candidate_counter(name: str) -> None:
    """등록 해제 (test/plugin 재부착용). 미등록은 무시."""
    with _COUNTERS_LOCK:
        for tool_name in list(_COUNTERS):
            kept = [c for c in _COUNTERS[tool_name] if c.name != name]
            if kept:
                _COUNTERS[tool_name] = kept
            else:
                del _COUNTERS[tool_name]


def has_candidate_counters(tool_name: str) -> bool:
    """invoker fast-path — 등록 없으면 input dump 자체를 생략."""
    with _COUNTERS_LOCK:
        return bool(_COUNTERS.get(tool_name))


def run_candidate_counters(
    tool_name: str,
    tool_input: dict[str, Any],
    result_content: str,
    metadata: dict[str, Any],
) -> None:
    """등록된 counter 실행 — ToolSuccess 후 invoker 가 호출. best-effort.

    counter 예외는 격리(다른 counter/도구 결과에 영향 0). 장부 기록만 하고
    아무것도 반환하지 않는다 — counter 는 도구 실행을 바꿀 수 없다.
    """
    with _COUNTERS_LOCK:
        counters = tuple(_COUNTERS.get(tool_name, ()))
    if not counters:
        return
    for counter in counters:
        try:
            n = _as_count(counter.count(copy.deepcopy(tool_input), result_content))
        except Exception:
            # codex 2R #14: counter 예외를 조용히 삼키면 게이트가 fail-open(seen=0)
            # 한다 — health 신호로 남긴다(도메인 결과 스키마 변경/counter 버그 조기포착).
            log.warning(
                "candidate counter %r failed for tool %r — seen undercounted",
                counter.name, tool_name, exc_info=True,
            )
            continue
        if n <= 0:
            continue
        if counter.bucket == "seen":
            record_candidates_seen(metadata, source_tool=tool_name, count=n)
        else:
            record_candidates_accounted(metadata, bucket=counter.bucket, count=n)
