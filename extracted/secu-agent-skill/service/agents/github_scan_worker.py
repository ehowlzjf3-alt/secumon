"""Worker entrypoint for one GitHub repo scan fanout target.

## 2026-08-26: 여기에 에이전트를 붙였다

이 워커는 껍데기만 있고 판단이 없었다. `build_spec` 이 `task_spec.json` 에
`"skill": github_scan`, `"skill_resource": "worker.md"` 를 적어 배달하는데,
워커는 그 봉투를 뜯지 않고 `_handle_target()`(정규식 스캔 함수)을 직접 불렀다.
github 3단계(scan/report/recheck) 어디에도 `run_agent` 호출이 없었다.

그 결과가 실측으로 드러났다:

  · finding 이 `core_state.finding_upsert` 로 **직접** 들어가 `judge_task_finding` 을
    건너뛰었다 → category 판정자(PII 소수부 거부 R1)에 닿지 못함
  · `make_agent_verification(status="verified")` 가 판단 주체 없이 붙었다
  · `kr_phone` 오탐 3,867건 — CatBoost 손실값 `0.0706314374` 가 `070-****-4374` 로

이제 `worker.md` 계약대로 에이전트가 돈다:
  `github_task_scan` 으로 스캔 → `github_submit_finding` 으로 제출(=판정 경로) →
  `github_repo_set_status` 로 종료.

## ⚠️ 폴백은 없다 — kill-switch 도 없앴다 (2026-08-27)

에이전트가 실패하면 **`error_crash` 로 닫는다.** 다른 길이 없다.

★ `SA_GITHUB_SCAN_AGENT=0` 결정론 경로를 두었다가 지웠다. 요구가 바뀌었기 때문이다:
  **모든 finding 은 등록 전에 LLM 판정을 타야 한다**(사용자 결정 2026-08-27).
  결정론 경로는 정의상 그걸 못 한다 — 스위치가 있으면 언젠가 켜지고, 켜진 줄도 모른다.

  실제로 그렇게 됐다: `github.scan` 플래그가 0인데도 finding 이 쏟아졌다. 08-25 18:54 에
  뜬 `run_scan_pass` 가 **1.5일째 안 끝나고** 있었고(플래그는 패스 *시작* 때만 본다),
  그 사이 판정 없는 finding 27,414건이 쌓였다. 스위치를 남기면 같은 일이 또 생긴다.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from domains.services.github.application.contracts import (
    COMPONENT_GITHUB_SCAN,
    GITHUB_SCAN_SKILL,
)
from service.agents import quality_events as _quality
from service.agents.worker_result import write_worker_result

#: 에이전트가 "끝냈다" 고 볼 수 없는 종료 사유 — 종료도구를 봤어도 신뢰하지 않는다.
_INCOMPLETE_REASONS = {
    "stream_error", "no_completion", "aborted", "max_turns",
    "max_tokens", "contract_violation",
}

_TERMINAL_TOOL = "github_repo_set_status"


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _build_user_text(spec: dict[str, Any]) -> str:
    target = spec.get("target") or {}
    repo = str(target.get("repo") or "").strip()
    tid = target.get("id")
    branch = str(target.get("default_branch") or "").strip()
    lines = [
        f"Scan exactly one GitHub Enterprise repository: {repo}",
        "",
        f"github_repo_target.id = {tid}",
    ]
    # ⚠️ default_branch 는 **참고값**이다. 열거 API(`/repositories`)가 이 필드를 안 줘서
    #    `or \"main\"` 폴백으로 채워진 값이 큐에 있다(2026-08-26 실측: 표본 25개 중
    #    14개가 실제로는 master). 이 값을 신뢰하지 말고 필요하면 repo 메타를 확인하라.
    if branch:
        lines.append(f"queue default_branch = {branch!r} (unverified — may be a fallback value)")
    lines += [
        "",
        "Finish by calling "
        f"{_TERMINAL_TOOL}(target_ids=[{tid}], status=…, finding_count=…, reason=…).",
    ]
    return "\n".join(lines)


def _finding_count(result: dict[str, Any]) -> int:
    total = 0
    for call in result.get("terminal_calls") or []:
        inp = call.get("input") or {}
        try:
            total += int(inp.get("finding_count") or 0)
        except (TypeError, ValueError):
            continue
    return total


def _record_quality(
    *, status: str, reason: str | None, c_seen: int | None,
    c_acct: int | None, findings: int | None,
) -> None:
    """skill_quality worker_result 이벤트 — best-effort(내부에서 예외 삼킴), #1 눈 v1.

    github 은 이 표에 **한 건도 없었다**(smb 318 · confluence 99 · github 0) —
    워커가 안 돌았으니 당연했다. 이제 여기서 채워진다.
    """
    _quality.record_worker_result(
        domain="github", worker_type="github_scan", component=COMPONENT_GITHUB_SCAN,
        execution_status=status, reason_code=reason,
        ledger_enforced=_quality.ledger_enforced_from_env(),
        candidates_seen=c_seen, candidates_accounted=c_acct,
        worker_reported_findings_count=findings,
    )


def _run_agent_scan(spec: dict[str, Any], evidence_dir: Path) -> int:
    from service.agents import runtime
    from domains.services.github.plugin.toolsets import github_scan_tools

    runtime._ensure_dotenv()
    target = spec.get("target") or {}
    try:
        result: dict[str, Any] = asyncio.run(runtime.run_agent(
            tool_classes=github_scan_tools(),
            skill_body=runtime.load_skill_contract(
                GITHUB_SCAN_SKILL, resource="worker.md"),
            user_text=_build_user_text(spec),
            label=str(spec.get("task_id") or f"github-scan-{target.get('repo')}"),
            terminal_tools={_TERMINAL_TOOL},
            charter_ref=str(spec.get("charter_ref") or ""),
            max_turns=_int_env("GITHUB_SCAN_MAX_TURNS", 40),
            # ★ 예산을 **명시한다.** 안 넘기면 엔진 기본(idle 120 / wall 300)을 물려받고,
            #   그 둘은 LLM 요청 타임아웃(프로파일 300s)과 같거나 작아서 요청 하나가
            #   멎으면 워커가 통째로 죽는다 — 2026-08-26 에 메일 워커가 그렇게 43% 죽었다.
            max_wall_clock_sec=_int_env("GITHUB_SCAN_MAX_WALL_SEC", 1500),
            max_idle_sec=_int_env("GITHUB_SCAN_MAX_IDLE_SEC", 360),
            max_tokens_total=_int_env("GITHUB_SCAN_MAX_TOKENS_TOTAL", 500_000),
            evidence_dir=evidence_dir,
            # `_collection_mode` 는 **코드가 실행 시작 시 한 번 심는 provenance** 다.
            # 코어 정책 A(브라우저 검증) 면제 판정이 이걸 본다 — 에이전트가 쓴
            # target/location 문자열로 판단하면 게이트 우회로가 되기 때문이다.
            # SSO 레인(github_task_worker)은 이 키를 안 심는다 → 거기선 게이트가 산다.
            extra_metadata={"github_target": target, "_collection_mode": "api_scan"},
            candidate_ledger_enforce=True,
            # 종료도구가 findings 유무와 무관하게 **필수** — 안 부르면 claim 이 안 풀리고
            # stale reclaim(30분~)까지 큐가 묶인다.
            require_terminal_tool=True,
        ))
    except Exception as e:  # noqa: BLE001
        write_worker_result(
            evidence_dir, status="error_crash",
            summary=f"github scan agent failed: {e!r}", rc=1,
        )
        _record_quality(status="error_crash", reason="exception",
                        c_seen=None, c_acct=None, findings=None)
        return 1

    c_seen = int(result.get("candidates_seen") or 0)
    c_acct = int(result.get("candidates_accounted") or 0)
    incomplete = result.get("reason") in _INCOMPLETE_REASONS
    if result.get("error") or incomplete or not result.get("saw_terminal"):
        write_worker_result(
            evidence_dir, status="error_crash",
            summary=(
                f"reason={result.get('reason')} terminal={result.get('saw_terminal')} "
                f"error={result.get('error')}"
            ),
            rc=1,
            turns=int(result.get("turns") or 0),
            tokens_in=int(result.get("tokens_in") or 0),
            tokens_out=int(result.get("tokens_out") or 0),
            candidates_seen=c_seen, candidates_accounted=c_acct,
        )
        _record_quality(status="error_crash", reason=str(result.get("reason") or "unknown"),
                        c_seen=c_seen, c_acct=c_acct, findings=None)
        return 1

    findings = _finding_count(result)
    write_worker_result(
        evidence_dir, status="ok",
        summary=f"reason={result.get('reason')} terminal={result.get('saw_terminal')}",
        findings=findings,
        turns=int(result.get("turns") or 0),
        tokens_in=int(result.get("tokens_in") or 0),
        tokens_out=int(result.get("tokens_out") or 0),
        candidates_seen=c_seen, candidates_accounted=c_acct,
    )
    _record_quality(status="ok", reason=str(result.get("reason") or ""),
                    c_seen=c_seen, c_acct=c_acct, findings=findings)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        raise SystemExit("usage: python -m service.agents.github_scan_worker <evidence_dir>")
    evidence_dir = Path(args[0])
    spec_path = evidence_dir / "task_spec.json"
    if not spec_path.exists():
        write_worker_result(
            evidence_dir, status="error_crash", summary="task_spec.json 없음", rc=1)
        return 1
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        write_worker_result(
            evidence_dir, status="error_crash",
            summary=f"invalid task_spec.json: {e!r}", rc=1)
        return 1

    return _run_agent_scan(spec, evidence_dir)


if __name__ == "__main__":
    raise SystemExit(main())
