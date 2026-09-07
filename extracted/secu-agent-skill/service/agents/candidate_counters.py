"""도메인 도구 → 코어 candidate ledger counter 등록 (침묵 게이트 v3.90 lockstep).

도메인 스캔/검색 도구들은 코어 ScanTextTool 을 거치지 않고 detector `scan_text()`
를 직접 호출한다 — 코어의 seen 자동기록을 안 탄다. 여기서 각 도구 결과(JSON)의
후보 수 필드를 파싱하는 counter 를 코어 `register_candidate_counter` 로 등록해
장부(seen)를 채운다. 헌팅 워커의 `_tool_classes()` 가 `ensure_registered()` 를
호출한다 (idempotent — 워커 프로세스당 1회).

- seen 대상: 결과가 에이전트에게 "후보"로 제시되고 후속(제출/기각)이 필요한 것.
- `confluence_task_scan` 은 finding 을 state.finding_upsert 로 **자동 적재**(코어
  SubmitFindingTool 미경유) — seen 과 submitted 를 같은 수로 기록해 게이트 중립
  (자동적재는 침묵이 아님) + 장부 관측만 남긴다.
- ⚠️ `github_task_scan` 은 **더 이상 자동 적재하지 않는다**(2026-08-27, `register=False`).
  후보만 돌려주고 등록은 에이전트가 `github_submit_finding` 으로 한다. 그래서 seen 만
  세고 **submitted 는 세지 않는다** — 코어 계약(`agent/CONTRACTS.md`)의 submitted 는
  submit_finding **성공**이다. 예전 counter 를 남겨두는 바람에 한 건도 등록되지 않은
  실행이 장부상 `submitted=N` 으로 찍혀 침묵 게이트가 그 실행 동안 무력화됐다
  (실측 로그: `seen=2, submitted=2, triaged=2` — 두 건 다 거부된 실행이었다).
- smb_fetch_scan 의 `persisted` 는 파일-hit 상태 적재(finding 아님) — accounted
  아님. seen 만 기록.

경계(문서화 — fail-open, over-block 보다 안전):
- `smb_task_python`(codex 3R #4): python 샌드박스 stdout(자유서술)이라 구조적
  카운트 불가. 미제출 시 saw_terminal=False → low-exposure draft 경로가 받음.
  vision(smb_inspect_image/pdf page_images 자유서술)도 동일.
- web confirmed-but-scan-hit-0(codex 4R #1): web_site_sweep/web_task_scan 의
  `semantic_status="confirmed"` 는 콘텐츠 형식 확인이라 세면 clean 사이트를
  over-block → 안 센다. 무인증 노출이 detector hit 없이 확인만 된 경우는 모델이
  browser+scan_text(코어 배선, seen 기록)로 확인하는 흐름에 의존.
"""
from __future__ import annotations

import json
from typing import Any

from secu_agent.agent.candidate_ledger import (
    CandidateCounter,
    register_candidate_counter,
)


def _payload(result_content: str) -> dict[str, Any]:
    try:
        data = json.loads(result_content)
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def _int_field(result_content: str, key: str) -> int:
    try:
        return int(_payload(result_content).get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _confluence_search_seen(tool_input: dict, result: str) -> int:
    del tool_input
    return _int_field(result, "candidate_pages")


def _web_sweep_seen(tool_input: dict, result: str) -> int:
    # scan_hit_summary.total = detector(secret/PII) hit 수 = 진짜 후보 신호.
    # codex 3R #3 은 confirmed probe/resource 도 세라 했으나, codex 4R #1: web 의
    # semantic_status="confirmed" 는 "민감 노출"이 아니라 "콘텐츠 형식 확인"(정상
    # HTML/JS/robots 포함) → clean 사이트도 seen>0 로 over-block. 보수적으로 detector
    # hit 만 센다. confirmed-but-scan-hit-0 노출은 커버리지 갭(fail-open, 아래 문서).
    del tool_input
    summary = _payload(result).get("scan_hit_summary")
    if not isinstance(summary, dict):
        return 0
    try:
        return int(summary.get("total") or 0)
    except (TypeError, ValueError):
        return 0


def _web_task_scan_seen(tool_input: dict, result: str) -> int:
    # raw_finding_count = heuristic finding 후보 수. resource_summary.confirmed 는
    # 콘텐츠 확인이라 over-block(codex 4R #1) → 세지 않는다.
    del tool_input
    return _int_field(result, "raw_finding_count")


def _smb_fetch_scan_seen(tool_input: dict, result: str) -> int:
    del tool_input
    return _int_field(result, "hits_count")


def _smb_inspect_pdf_seen(tool_input: dict, result: str) -> int:
    del tool_input
    hits = _payload(result).get("scan_hits")
    return len(hits) if isinstance(hits, list) else 0


def _task_scan_finding_count(tool_input: dict, result: str) -> int:
    del tool_input
    return _int_field(result, "finding_count")


_COUNTERS: tuple[CandidateCounter, ...] = (
    CandidateCounter(
        name="skill:confluence_browser_search:seen",
        tool_name="confluence_browser_search", bucket="seen",
        count=_confluence_search_seen,
    ),
    CandidateCounter(
        name="skill:web_site_sweep:seen",
        tool_name="web_site_sweep", bucket="seen",
        count=_web_sweep_seen,
    ),
    CandidateCounter(
        name="skill:web_task_scan:seen",
        tool_name="web_task_scan", bucket="seen",
        count=_web_task_scan_seen,
    ),
    CandidateCounter(
        name="skill:smb_fetch_scan:seen",
        tool_name="smb_fetch_scan", bucket="seen",
        count=_smb_fetch_scan_seen,
    ),
    CandidateCounter(
        name="skill:smb_inspect_pdf:seen",
        tool_name="smb_inspect_pdf", bucket="seen",
        count=_smb_inspect_pdf_seen,
    ),
    # task_scan 류: 자동적재 finding = seen 이자 submitted (게이트 중립·관측용)
    CandidateCounter(
        name="skill:confluence_task_scan:seen",
        tool_name="confluence_task_scan", bucket="seen",
        count=_task_scan_finding_count,
    ),
    CandidateCounter(
        name="skill:confluence_task_scan:submitted",
        tool_name="confluence_task_scan", bucket="submitted",
        count=_task_scan_finding_count,
    ),
    CandidateCounter(
        name="skill:github_task_scan:seen",
        tool_name="github_task_scan", bucket="seen",
        count=_task_scan_finding_count,
    ),
    # ⚠️ `skill:github_task_scan:submitted` 는 **없다**(2026-08-27 제거).
    #    이 도구가 자동적재하던 시절엔 "후보 = 곧 등록" 이라 submitted 로 세는 게 맞았다.
    #    그런데 github 은 `register=False` 로 바뀌어 **후보만 돌려주고 등록은 안 한다**
    #    (`service_task_tools._persist_scanned_findings` docstring). 그대로 두면 한 건도
    #    등록되지 않은 실행이 장부상 `submitted=N` 이 되어 침묵 게이트가 그 실행 동안
    #    무력화된다 — 실제 실패 로그가 `seen=2, submitted=2, triaged=2` 였다(둘 다 거부됐다).
    #    코어 계약(`agent/CONTRACTS.md`)은 submitted = **submit_finding 성공**이다.
    #    confluence 는 아직 자동적재(register 기본 True)라 아래 counter 를 유지한다.
)

_registered = False


def ensure_registered() -> None:
    """counter 일괄 등록 — idempotent (중복 등록은 무시)."""
    global _registered
    if _registered:
        return
    for counter in _COUNTERS:
        try:
            register_candidate_counter(counter)
        except ValueError:
            pass  # 같은 이름 이미 등록 (다른 워커 경로/테스트 재진입)
    _registered = True
