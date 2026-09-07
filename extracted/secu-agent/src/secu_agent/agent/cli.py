"""Agent CLI — `python -m secu_agent.agent <evidence_dir>`.

evidence_dir 안의 `task_spec.json` 을 읽어 task_type 에 맞는 도구셋 + prompt 로딩.
"""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import signal as _signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from secu_agent.agent.candidate_ledger import (
    CANDIDATE_METRICS_VERSION, candidate_ledger_stats,
)
from secu_agent.agent.events import (
    LoopCompleted, LoopError, TextChunk,
    ToolCallCompleted, ToolCallStarted, TurnStarted,
)
from secu_agent.agent.harness.budget import AgentBudget
from secu_agent.agent.harness.runner import GuardedHarness, write_errored_finding
from secu_agent.agent.llm.factory import _build_client
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.llm.profile import load_profiles
from secu_agent.agent.prompts import system_prompt
from secu_agent.agent.schema.worker_result import (
    WORKER_RESULT_FILENAME, build_worker_result, normalize_completion_reason,
    write_worker_result,
)
from secu_agent.agent.task_contract import (
    TaskContract, get_task_contract, register_task_contract,
)
from secu_agent.agent.tools import (
    ToolSuccess, build_registry_for_task, registered_task_toolsets,
)


async def _shutdown_mcp_quiet() -> None:
    """MCP 클라이언트 정리 (best-effort, no-op if none)."""
    try:
        from secu_agent.mcp.state import shutdown_mcp
        await shutdown_mcp()
    except Exception:  # noqa: BLE001
        pass


def _load_dotenv(path: Path) -> None:
    """간단 .env 로더 + ${VAR}/$VAR expansion 지원."""
    import re
    if not path.exists():
        return
    pat = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")

    def _expand(s: str) -> str:
        def _sub(m: "re.Match[str]") -> str:
            name = m.group(1) or m.group(2)
            return os.environ.get(name, m.group(0))
        # 두 번 돌려서 nested expansion 가능 (간단 케이스)
        for _ in range(2):
            new = pat.sub(_sub, s)
            if new == s:
                return s
            s = new
        return s

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if v[:1] in ('"', "'"):
            quote = v[0]
            end = v.find(quote, 1)
            if end != -1:
                v = v[1:end]
        else:
            hash_pos = v.find("#")
            if hash_pos != -1:
                v = v[:hash_pos].rstrip()
        os.environ.setdefault(k.strip(), _expand(v))


def _build_user_message_finding_narrator(
    spec: dict, evidence_dir: Path | None = None,
) -> str:
    """v3.76: finding_narrator — 백필 대상 finding_ids 와 (있으면) 현재 요약을 inline 으로."""
    t = spec.get("target", {})
    finding_ids = t.get("finding_ids") or []
    parts = [
        f"# task_id: {spec['task_id']}  (finding 위험내용 백필 — sub-agent)",
        f"# charter: {spec.get('charter_ref', '-')}",
        "",
        "## 대상 finding_ids",
        f"  {list(finding_ids)}",
        "",
    ]
    try:
        from secu_agent import state as _state
        rows = []
        for fid in finding_ids:
            r = _state.finding_get(int(fid))
            if r is not None:
                rows.append(r)
        if rows:
            parts.append("## 현재 상태 (요약만 — 상세/증거는 도구로 조회)")
            for r in rows:
                parts.append(
                    f"- id={r['id']} [{r.get('severity')}] {r.get('asset')} — "
                    f"{str(r.get('summary') or '')[:120]}"
                )
            parts.append("")
    except Exception:
        pass
    parts += [
        "각 finding 을 session_search/read_evidence_file 로 읽고,",
        "4부 위험내용(risk_narrative)+증거해설(evidence_notes)+pivot 해석(pivot_interpretation)을",
        "enrich_finding 으로 채워넣어라. 증거로 못 만드는 항목은 비워둔다(가짜 템플릿 금지). 마스킹 유지.",
    ]
    return "\n".join(parts)


_PKG_SETUP_HEAD_LINES = 80
_PKG_LOG_HEAD_LINES = 30


def _pkg_read_text_safe(p: Path, head_lines: int) -> str:
    if not p.exists():
        return f"(missing: {p.name})"
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"(read failed: {e})"
    lines = text.splitlines()
    if len(lines) <= head_lines:
        return text
    return "\n".join(lines[:head_lines]) + f"\n... [+{len(lines) - head_lines} more lines]"


def _build_user_message_package_sandbox(spec: dict, result_dir: Path) -> str:
    """포팅: ai-sandbox build_initial_user_message — evidence_dir 산출물 요약.

    network_iocs.json 대신 network_iocs_aggregate.json 도 허용 (TH evidence_dir 산물).
    """
    extract_path = result_dir / "extract.json"
    source_dir = result_dir / "source"
    entrypoint_rel = None
    if extract_path.exists():
        try:
            extract_data_for_paths = json.loads(extract_path.read_text(encoding="utf-8"))
            meta_for_paths = extract_data_for_paths.get("package_meta", {})
            entrypoint_rel = (
                extract_data_for_paths.get("entrypoint_path")
                or meta_for_paths.get("entrypoint_path")
            )
        except (OSError, json.JSONDecodeError):
            entrypoint_rel = None
    setup_candidates = [source_dir / "setup.py", result_dir / "setup.py"]
    setup_path = next((p for p in setup_candidates if p.exists()), None)
    pkg_json_candidates = [source_dir / "package.json", result_dir / "package.json"]
    pkg_json = next((p for p in pkg_json_candidates if p.exists()), None)
    script_path = None
    if isinstance(entrypoint_rel, str) and entrypoint_rel:
        candidate = result_dir / entrypoint_rel
        try:
            if (candidate.exists() and candidate.is_file()
                    and candidate.resolve().is_relative_to(result_dir.resolve())):
                script_path = candidate
        except OSError:
            script_path = None
    trace_path = result_dir / "install_trace.log"
    file_signals_path = result_dir / "file_signals.json"
    dependency_analysis_path = result_dir / "dependency_analysis.json"
    execution_plan_path = result_dir / "execution_plan.json"
    analysis_runs_path = result_dir / "analysis_runs.json"
    timeline_path = result_dir / "timeline.json"
    network_iocs_path = result_dir / "network_iocs.json"
    if not network_iocs_path.exists():
        network_iocs_path = result_dir / "network_iocs_aggregate.json"
    enrichment_path = result_dir / "reputation_enrichment.json"

    parts: list[str] = []
    t = spec.get("target", {})
    parts.append(f"# task_id: {spec.get('task_id')}  (package_sandbox)")
    if t:
        parts.append(f"# target: {t.get('package')} {t.get('version', '')}")
    parts.append(f"# 분석 대상 evidence_dir: {result_dir}")
    parts.append("")
    if source_dir.exists():
        parts.append(
            "패키지 소스 전체는 `source/` 아래에 mirror돼 있다. "
            "`read_evidence_file('source/<path>')`, `grep_evidence`로 직접 확인 가능."
        )
        parts.append("")

    if extract_path.exists():
        try:
            data = json.loads(extract_path.read_text(encoding="utf-8"))
            meta = data.get("package_meta", {})
            sigs = data.get("signals", [])
            stats = data.get("stats", {})
            parts.append("## 패키지 메타 (extract.json에서)")
            for k in ("name", "version", "source_path", "sha256", "install_time_sec"):
                if k in meta:
                    parts.append(f"- {k}: {meta[k]}")
            parts.append("")
            parts.append(f"## 자동 추출된 시그널 ({len(sigs)}개)")
            for s in sigs:
                lns = s.get("raw_line_nums", [])
                ln_str = ",".join(str(x) for x in lns[:5])
                if len(lns) > 5:
                    ln_str += f",+{len(lns) - 5}more"
                parts.append(f"- type={s.get('type')!r}  raw_lines={ln_str}")
            parts.append("")
            if stats:
                parts.append("## 실행 통계")
                for k, v in stats.items():
                    parts.append(f"- {k}: {v}")
                parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(extract.json 파싱 실패: {e})")
    else:
        parts.append("(extract.json 없음 — log_parser가 안 돌았거나 path 다름)")

    if setup_path is not None:
        rel = setup_path.relative_to(result_dir)
        parts.append(f"## setup.py 앞부분 (`{rel}`)")
        parts.append("```python")
        parts.append(_pkg_read_text_safe(setup_path, _PKG_SETUP_HEAD_LINES))
        parts.append("```")
        parts.append("")
    elif pkg_json is not None:
        rel = pkg_json.relative_to(result_dir)
        parts.append(f"## package.json 앞부분 (`{rel}`)")
        parts.append("```json")
        parts.append(_pkg_read_text_safe(pkg_json, _PKG_SETUP_HEAD_LINES))
        parts.append("```")
        parts.append("")
    elif script_path is not None:
        rel = script_path.relative_to(result_dir)
        lang = {
            ".py": "python", ".js": "javascript", ".mjs": "javascript",
            ".cjs": "javascript", ".sh": "bash", ".bash": "bash",
        }.get(script_path.suffix.lower(), "text")
        parts.append(f"## 단일 스크립트 entrypoint (`{rel}`)")
        parts.append(f"```{lang}")
        parts.append(_pkg_read_text_safe(script_path, _PKG_SETUP_HEAD_LINES))
        parts.append("```")
        parts.append("")

    if file_signals_path.exists():
        try:
            fs = json.loads(file_signals_path.read_text(encoding="utf-8"))
            summary = fs.get("summary", {})
            parts.append("## 정적 파일 스캔 (file_signals.json)")
            parts.append(f"- fingerprint: {fs.get('package_fingerprint', '?')[:16]}…")
            for k, v in summary.items():
                parts.append(f"- {k}: {v}")
            interesting = [
                f for f in fs.get("files", [])
                if f.get("static_signals") or f.get("previously_seen_count", 0) > 0
            ]
            if interesting:
                parts.append("")
                parts.append("### 시그널 있거나 cross-package에서 본 파일")
                for f in interesting[:20]:
                    sigs = ",".join(f.get("static_signals", [])) or "-"
                    seen = f.get("previously_seen_count", 0)
                    seen_str = f" (다른 패키지에서 {seen}회 발견)" if seen else ""
                    parts.append(f"- `{f['path']}` (hash={f['hash'][:12]}…)  sigs=[{sigs}]{seen_str}")
            parts.append("")
            parts.append("전체 파일 목록 + import 리스트는 `read_evidence_file(path='file_signals.json')`로 확인.")
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(file_signals.json 파싱 실패: {e})")

    if trace_path.exists():
        parts.append("## install_trace.log 첫 라인 미리보기")
        parts.append("```")
        parts.append(_pkg_read_text_safe(trace_path, _PKG_LOG_HEAD_LINES))
        parts.append("```")
        parts.append("")

    if dependency_analysis_path.exists():
        try:
            deps = json.loads(dependency_analysis_path.read_text(encoding="utf-8"))
            summary = deps.get("summary", {})
            policy = deps.get("policy", {})
            parts.append("## 의존성 메타데이터 (dependency_analysis.json)")
            parts.append(f"- mode: {policy.get('mode', '?')}")
            parts.append(f"- dynamic_dependency_install: {policy.get('dynamic_dependency_install', '?')}")
            for k in (
                "total_dependencies", "runtime_dependencies", "build_dependencies",
                "optional_dependencies", "requirement_files", "direct_url_dependencies",
                "vcs_dependencies", "path_dependencies", "unpinned_dependencies",
                "internal_namespace_candidates", "findings",
            ):
                if k in summary:
                    parts.append(f"- {k}: {summary[k]}")
            findings = deps.get("findings", [])
            if findings:
                parts.append("### 의존성 관련 finding")
                for item in findings[:10]:
                    loc = item.get("source_path", "?")
                    line = item.get("line")
                    line_s = f":{line}" if line else ""
                    parts.append(
                        f"- `{item.get('kind')}` severity={item.get('severity')} "
                        f"at `{loc}{line_s}` dep={item.get('dependency')!r}"
                    )
            parts.append(
                "의존성은 기본적으로 설치/해석하지 않은 metadata-only context다. "
                "의존성 자체 행위와 현재 패키지 행위를 섞어 판정하지 말 것."
            )
            parts.append("전체 의존성 메타데이터는 `read_evidence_file(path='dependency_analysis.json')`로 확인.")
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(dependency_analysis.json 파싱 실패: {e})")

    if execution_plan_path.exists():
        try:
            ep = json.loads(execution_plan_path.read_text(encoding="utf-8"))
            summary = ep.get("summary", {})
            policy = ep.get("policy", {})
            parts.append("## 추가 동적 실행 계획 (execution_plan.json)")
            parts.append(f"- strategy: {policy.get('strategy', '?')}")
            for k in (
                "scenario_count", "candidate_count", "static_only_findings",
                "behavior_inventory", "planned_behaviors", "static_only_behaviors",
                "deferred_behaviors", "unsupported_behaviors", "needs_additional_dynamic",
            ):
                if k in summary:
                    parts.append(f"- {k}: {summary[k]}")
            inventory = ep.get("behavior_inventory", [])
            if inventory:
                parts.append("### 정적 behavior inventory")
                for b in inventory[:12]:
                    refs = ",".join(b.get("source_refs", [])[:3])
                    sinks = ",".join(b.get("sinks", [])[:5])
                    parts.append(
                        f"- `{b.get('behavior_id')}` status={b.get('execution_status')} "
                        f"risk={b.get('risk')} behavior={b.get('behavior')!r} "
                        f"scenario={b.get('scenario_id')} sinks=[{sinks}] refs={refs}"
                    )
            parts.append("전체 계획은 `read_evidence_file(path='execution_plan.json')`로 확인.")
            parts.append(
                "behavior_inventory에서 static_only/deferred/unsupported 항목은 추가 scenario로 "
                "실행되지 않았다는 뜻이지 무해하다는 뜻이 아니다. 최종 limitations에 반영하라."
            )
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(execution_plan.json 파싱 실패: {e})")

    if network_iocs_path.exists():
        try:
            ni = json.loads(network_iocs_path.read_text(encoding="utf-8"))
            stats = ni.get("stats", {})
            parts.append(f"## 네트워크 IOC ({network_iocs_path.name})")
            for k in ("dns_queries", "http_requests", "unique_domains", "unique_urls"):
                if k in stats:
                    parts.append(f"- {k}: {stats[k]}")
            domains = ni.get("domains", [])
            urls = ni.get("normalized_urls", []) or ni.get("urls", [])
            if domains:
                parts.append(f"- domains: {', '.join(domains[:10])}")
            if urls:
                parts.append(f"- urls: {', '.join(urls[:10])}")
            parts.append(f"전체 네트워크 IOC는 `read_evidence_file(path='{network_iocs_path.name}')`로 확인.")
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(network_iocs 파싱 실패: {e})")

    if analysis_runs_path.exists():
        try:
            ar = json.loads(analysis_runs_path.read_text(encoding="utf-8"))
            summary = ar.get("summary", {})
            parts.append("## 추가 scenario 실행 결과 (analysis_runs.json)")
            for k in (
                "planned_scenarios", "selected_scenarios", "executed_scenarios",
                "cached_scenarios", "errored_scenarios", "network_triggered_scenarios",
            ):
                if k in summary:
                    parts.append(f"- {k}: {summary[k]}")
            runs = ar.get("runs", [])
            if runs:
                parts.append("### 실행된 scenario")
                for run in runs[:10]:
                    net = run.get("network_iocs", {})
                    domains = ",".join((net.get("domains") or [])[:5])
                    sigs = ",".join((run.get("extract", {}).get("signal_types") or [])[:5])
                    parts.append(
                        f"- `{run.get('scenario_id')}` status={run.get('status')} "
                        f"type={run.get('type')} signals=[{sigs}] domains=[{domains}]"
                    )
            parts.append("전체 scenario 결과는 `read_evidence_file(path='analysis_runs.json')`로 확인.")
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(analysis_runs.json 파싱 실패: {e})")

    if timeline_path.exists():
        try:
            tl = json.loads(timeline_path.read_text(encoding="utf-8"))
            summary = tl.get("summary", {})
            counts = tl.get("counts", {})
            parts.append("## 정규화 timeline (timeline.json)")
            for k in (
                "total_events", "static_events", "baseline_events", "scenario_events",
                "network_events", "process_events", "file_events",
            ):
                if k in summary:
                    parts.append(f"- {k}: {summary[k]}")
            by_kind = counts.get("by_kind") if isinstance(counts.get("by_kind"), dict) else {}
            if by_kind:
                top = sorted(by_kind.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
                parts.append("- event_kinds: " + ", ".join(f"{k}={v}" for k, v in top))
            parts.append("전체 흐름은 `read_evidence_file(path='timeline.json')`로 확인.")
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(timeline.json 파싱 실패: {e})")

    if enrichment_path.exists():
        try:
            en = json.loads(enrichment_path.read_text(encoding="utf-8"))
            summary = en.get("summary", {})
            parts.append("## 평판 조회 scaffold (reputation_enrichment.json)")
            parts.append(f"- provider: {en.get('provider', '?')}")
            parts.append(f"- status: {en.get('status', '?')}")
            reason = en.get("reason")
            if reason:
                parts.append(f"- reason: {reason}")
            for k in ("domains", "urls", "queried", "malicious", "suspicious", "unknown"):
                if k in summary:
                    parts.append(f"- {k}: {summary[k]}")
            parts.append(
                "GTI가 not_configured/disabled이면 평판 공백을 benign 근거로 쓰지 말고, "
                "로컬 evidence 중심으로 판정."
            )
            parts.append("")
        except (OSError, json.JSONDecodeError) as e:
            parts.append(f"(reputation_enrichment.json 파싱 실패: {e})")

    parts.append(
        "위 데이터를 시작점으로, 필요한 부분은 read_evidence_file/grep_evidence로 직접 확인하고, "
        "최종 판정을 submit_verdict로 제출해라. 의심 시그널의 raw_line_nums는 "
        "install_trace.log의 1-based 라인 번호다. 정적 시그널과 동적 trace를 "
        "교차검증하면 false positive를 줄일 수 있다. "
        "submit_verdict에는 실제 관찰 행위, trigger/untrigger scenario, timeline 기반 "
        "attack_chain, dependency_context, reputation_summary, limitations를 구조화해서 남겨라."
    )
    return "\n".join(parts)


def _build_user_message_generic(
    spec: dict, evidence_dir: Path | None = None,
) -> str:
    parts = [
        f"# task_id: {spec['task_id']}",
        f"# task_type: {spec['task_type']}",
    ]
    if "charter_ref" in spec:
        parts.append(f"# charter: {spec['charter_ref']}")
    parts += [
        "",
        "## 스코프 (target)",
        "```json",
        json.dumps(spec.get("target", {}), ensure_ascii=False, indent=2),
        "```",
    ]
    if "discovery_summary" in spec:
        parts += [
            "",
            "## discovery_summary",
            "```json",
            json.dumps(spec["discovery_summary"], ensure_ascii=False, indent=2),
            "```",
        ]
    parts += [
        "",
        "도구로 fetch → scan_text → 의심되면 drill → 최종 submit_finding.",
    ]
    return "\n".join(parts)


# 코어 `generic` — 도구셋을 등록하지 않고 build_registry_for_task 의 generic
# fallback 을 쓰는 유일한 계약. 배선 누락 가드의 유일한 예외다.
GENERIC_TASK_TYPE = "generic"

# ── 코어 task_type 실행계약 (도메인 아님 — 범용/코어 상주 sub-agent) ──────────
# 이전엔 _run 안의 if task_type==".." 하드코딩 분기였다. 이제 코어 계약도 도메인
# plugin 과 똑같이 register_task_contract 로 등록한다. 새 도메인 워커는 자기 계약을
# 등록하면 코어 0줄 수정으로 실행된다.
def _finding_narrator_budget(spec: dict, profile: Any) -> AgentBudget:
    # v3.76: 배치(~10건/spawn)로 read→enrich 반복. 건당 조회+enrich 몇 턴씩.
    return AgentBudget(max_turns=40)


def _package_sandbox_budget(spec: dict, profile: Any) -> AgentBudget:
    # 한 패키지 분석은 submit_verdict로 끝난다 — turn 수로 자르지 않는다(무제한).
    # 폭주 방어는 token budget + repeat 가드가 담당.
    if getattr(profile, "transport", "openai_chat") == "codex_responses":
        # codex(xhigh)는 한 턴 reasoning이 길어 기본 idle 120s/wall 300s를 넘긴다.
        # Responses API는 reasoning 중 관측 가능한 stream 이벤트가 없어 idle watchdog이
        # 오작동 → codex 일 때만 넉넉히 푼다.
        return AgentBudget(max_turns=None, max_idle_sec=600, max_wall_clock_sec=1800)
    return AgentBudget(max_turns=None)


def _finding_narrator_metadata(spec: dict) -> dict[str, Any]:
    # v3.76: narrator 는 단일 terminal 도구 없음 — 여러 enrich_finding 후 텍스트 요약 종료.
    t = spec.get("target", {})
    return {"finding_ids": t.get("finding_ids", [])}


def _package_sandbox_metadata(spec: dict) -> dict[str, Any]:
    return {"terminal_tools": {"submit_verdict"}}


def _generic_on_no_submit(evidence_dir: Path, spec: dict, reason: str) -> int:
    write_errored_finding(
        evidence_dir,
        task_id=spec["task_id"], task_type=spec["task_type"], reason=reason,
    )
    print("[agent] no terminal tool call — wrote errored finding.json", file=sys.stderr)
    return 3


def _generic_on_submit(evidence_dir: Path, spec: dict) -> int:
    print(str(evidence_dir / "finding.json"))
    return 0


def _finding_narrator_on_no_submit(evidence_dir: Path, spec: dict, reason: str) -> int:
    # DB-only task type — narrator 는 enrich(DB merge)만, 새 finding.json 생성 X.
    print("[agent] no terminal — leaving DB state as-is", file=sys.stderr)
    return 3


def _package_sandbox_on_no_submit(evidence_dir: Path, spec: dict, reason: str) -> int:
    # SB와 동일하게 errored verdict.json 작성.
    errored = {
        "risk_level": "errored",
        "confidence": 0.0,
        "reasoning": [f"agent harness aborted: agent did not submit (reason={reason})"],
        "evidence_paths": [],
        "iocs": {"domains": [], "hashes": [], "urls": [], "ips": []},
        "mitre_attack": [], "observed_behavior": [],
        "triggered_scenarios": [], "untriggered_scenarios": [],
        "attack_chain": [],
        "dependency_context": {"mode": None, "findings": [],
                               "notable_dependencies": [], "summary": {}},
        "reputation_summary": {"provider": None, "status": None, "malicious": None,
                               "suspicious": None, "unknown": None, "notes": []},
        "limitations": [],
    }
    (evidence_dir / "verdict.json").write_text(
        json.dumps(errored, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print("[agent] no submit_verdict — wrote errored verdict.json", file=sys.stderr)
    return 3


def _package_sandbox_on_submit(evidence_dir: Path, spec: dict) -> int:
    print(str(evidence_dir / "verdict.json"))
    return 0


register_task_contract(TaskContract(
    task_type=GENERIC_TASK_TYPE,
    build_user_message=_build_user_message_generic,
    terminal_tools=frozenset({"submit_finding"}),
    on_no_submit=_generic_on_no_submit,
    on_submit=_generic_on_submit,
))
register_task_contract(TaskContract(
    task_type="finding_narrator",
    build_user_message=_build_user_message_finding_narrator,
    terminal_tools=frozenset({"enrich_finding"}),
    budget=_finding_narrator_budget,
    metadata=_finding_narrator_metadata,
    on_no_submit=_finding_narrator_on_no_submit,
    on_submit=None,  # DB-only — finding.json 미출력, rc 0
))
register_task_contract(TaskContract(
    task_type="package_sandbox",
    build_user_message=_build_user_message_package_sandbox,
    terminal_tools=frozenset({"submit_verdict"}),
    needs_mcp_bootstrap=True,
    budget=_package_sandbox_budget,
    metadata=_package_sandbox_metadata,
    on_no_submit=_package_sandbox_on_no_submit,
    on_submit=_package_sandbox_on_submit,
))


def _select_profile_name(
    explicit: str | None, profiles: dict[str, Any],
) -> str | None:
    """워커 profile 선택 — v3.81 T1c.

    우선순위: --profile-name (per-worker argv / WorkerSpec) >
    env SA_CHAT_PROFILE (chat 와 동일 모델 — 이전엔 무시돼 YAML 첫
    프로파일로 silent downgrade 되던 버그) > YAML 첫 프로파일.
    env 가 무효한 이름을 가리키면 그대로 반환 — 호출부가 rc=2 로
    fail-closed (silent fallback 금지: 모델 다운그레이드는 보이게 죽는다).
    """
    if explicit:
        return explicit
    env_name = (os.environ.get("SA_CHAT_PROFILE") or "").strip()
    if env_name:
        return env_name
    return next(iter(profiles), None)


def _browser_shutdown_timeout() -> float:
    """워커 종료 시 브라우저 회수 상한(초). 0 이하면 5초로 폴백(무한대 금지)."""
    try:
        t = float(os.environ.get("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "5"))
    except ValueError:
        return 5.0
    return t if t > 0 else 5.0


async def _shutdown_worker_browser() -> None:
    """워커 종료 시 열려 있는 chromium 을 **bounded** graceful 회수 (F5-A).

    웹 앱은 lifespan(web/app.py)에서 하지만 subprocess 워커 종료 경로엔 훅이 없어,
    브라우저를 켠 워커가 끝나면 chromium 이 init 로 reparent 돼 상주했다
    (browser_tool.py:1660 설계 주석이 이미 경고). `_stop_session` 의 await 들과 락
    획득은 unbounded 라, 응답 없는 chromium 이 워커 종료·worker_result 작성을 무한정
    막을 수 있다(try/except 는 raise 만 잡고 hang 은 못 잡는다 — codex 리뷰 #1). 그래서
    `wait_for` 로 상한을 둔다. best-effort — 어떤 예외/타임아웃도 워커 종료를 막지
    않는다. 미기동 세션엔 안전한 no-op(_is_running 가드). OS 수준 최종 회수(SIGKILL)는
    후속 F5-C(process-group)가 담당한다.
    """
    try:
        from secu_agent.agent.tools.browser_tool import shutdown_browser
        await asyncio.wait_for(
            shutdown_browser(), timeout=_browser_shutdown_timeout(),
        )
    except Exception as e:  # noqa: BLE001 — TimeoutError 포함, best-effort
        print(f"[agent] browser shutdown skipped: {e!r}", file=sys.stderr)


async def _maybe_await(value: Any) -> Any:
    """계약 후처리 훅이 **async 여도** 되게 한다 (v3.97).

    ★ 왜 필요한가: 이 훅들은 async `_run` **안에서** 불린다 — 즉 실행 중인 이벤트 루프가
    항상 있다. 그래서 sync 훅은 `asyncio.run()` 을 못 쓰고, 정리 작업이 비동기면
    (예: 리드가 열어 둔 검토원 세션을 닫는 것) **조용히 건너뛰게 된다.**
    2026-08-21 실기동에서 정확히 그랬다: 세션 4개가 안 닫히고 프로세스가 남았다.

    sync 훅은 그대로 동작한다(반환값이 awaitable 이 아니면 통과).
    """
    if inspect.isawaitable(value):
        return await value
    return value


@dataclass(slots=True)
class _PassResult:
    """엔진 루프 1회(=질문 1개)의 결과. 세션은 이걸 여러 번 모은다."""

    completion: LoopCompleted | None = None
    saw_submit: bool = False
    submit_count: int = 0
    text: str = ""


async def _drive_once(
    harness: Any, messages: list[Any], sys_prompt: str | None,
    terminal_names: set[str],
) -> _PassResult:
    """엔진 루프를 한 번 돌리고 사람이 읽는 로그를 stderr 로 낸다.

    ⚠️ stdout 은 건드리지 않는다 — serve 모드에서 stdout 은 **부모와의 메시지 채널**이다.
    (오늘 단발 경로도 전부 stderr 였다. 그 성질을 계약으로 굳힌다.)

    `messages` 에 이번 pass 의 최종 assistant 메시지를 **append 한다** — 다음 질문이
    직전 결론을 컨텍스트로 받는다. 중간 tool_use/tool_result 는 넣지 않는다
    (코어 `ChatSession` 과 같은 패턴 — 컨텍스트 폭주 억제).
    """
    out = _PassResult()
    chunks: list[str] = []
    async for ev in harness.run(initial_messages=messages, system=sys_prompt):
        if isinstance(ev, TurnStarted):
            print(f"\n--- turn {ev.turn} ---", file=sys.stderr)
        elif isinstance(ev, TextChunk):
            chunks.append(ev.text)
            sys.stderr.write(ev.text)
            sys.stderr.flush()
        elif isinstance(ev, ToolCallStarted):
            print(f"\n[tool→] {ev.name}({_short_input(ev.input)})", file=sys.stderr)
        elif isinstance(ev, ToolCallCompleted):
            outcome = "ok" if isinstance(ev.result, ToolSuccess) else f"err:{ev.result.kind}"
            size = len(ev.result.content) if isinstance(ev.result, ToolSuccess) else 0
            print(f"[tool←] {ev.name}: {outcome} ({size} chars)", file=sys.stderr)
            if ev.name in terminal_names and isinstance(ev.result, ToolSuccess):
                out.saw_submit = True
                # findings_count 는 실제 finding 수 — non-finding terminal
                # (submit_verdict/enrich_finding 등)은 세지 않는다(codex #19).
                if ev.name == "submit_finding":
                    out.submit_count += 1
        elif isinstance(ev, LoopError):
            print(f"\n[loop error] {ev.message}", file=sys.stderr)
        elif isinstance(ev, LoopCompleted):
            out.completion = ev
            if ev.final_message is not None:
                messages.append(ev.final_message)
    out.text = "".join(chunks).strip()
    return out


# ── v3.97: 대화형 세션(serve) ────────────────────────────────────────
#
# 왜: 단발 위임은 "작업 하나" 를 통째로 맡긴다. 그러면 워커가 10턴을 혼자 돌며 다 끝내고,
# 부모(리드)는 결과만 받는 디스패처가 된다 — 실측에서 리드가 피벗 기록을 8런 내리
# 0건 썼다. 위임 단위를 **질문**으로 바꾸려면 워커가 질문 사이에 살아 있어야 한다.
#
# 프로토콜(줄 단위 JSON, stdin→stdout):
#     ← {"ask": "<질문>"}            부모가 묻는다
#     → {"ok": true, "turn": 1, "text": "...", "saw_submit": false, ...}
#     ← {"close": true}              부모가 끝낸다 (EOF 도 같음)
#     → {"ok": true, "closed": true}
#
# ⚠️ stdout 은 **이 채널 전용**이다. 사람이 읽는 로그는 전부 stderr 로 간다.
# ⚠️ 답의 **내용 필터링은 부모 쪽 책임**이다. 워커는 자기가 본 것을 말한다 —
#    마스킹/봉투는 부모(리드) 경계에서 한다. 여기서 두 번 하면 진실이 둘이 된다.
_SERVE_MAX_ASKS = "SA_SERVE_MAX_ASKS"
_SERVE_MAX_TURNS = "SA_SERVE_MAX_TURNS_TOTAL"

# 컨텍스트 이월 트립와이어. 압축은 **만들지 않았다** — 실측상 필요가 없어서다:
#
#   질문1  누적입력 28,858 tok / 4턴
#   질문2  누적입력  7,716 tok / 1턴   ← 앞 질문의 도구 결과가 버려진 자리
#   질문3  누적입력 33,490 tok / 4턴
#
# 질문 안에서 부푼 것(28K·33K)은 그 질문이 끝나면 사라진다. 실제로 이월되는 것은
# **최종 답변 텍스트뿐**(질문당 대략 500~1,200 tok)이라 질문 40개를 다 써도 50K 언저리다.
# 그러니 압축 대신 "커지면 보이게" 만 한다 — 안 커지면 아무 일도 없고, 커지면 그때
# 코어 compactor 를 붙이면 된다. 조용히 커지는 것만 막는다.
_SERVE_CTX_WARN = "SA_SERVE_CTX_WARN_TOKENS"

# ★ 질문 1개의 턴 예산. 계약 예산(`<DOMAIN>_MAX_TURNS`)과 **의미가 다르다**:
#   단발  = 작업 하나를 통째로 끝내는 예산 (smb 기본 80)
#   세션  = 질문 하나에 답하는 예산 (몇 턴이면 충분)
# 같은 값을 쓰면 둘 중 하나가 망가진다 — 2026-08-21 실기동에서 게이트가 8 로 맞췄더니
# 단발 위임이 `max_turns` 로 죽었다(rc=3, 쓸 수 있는 결과 0).
#
# ★★ 그리고 그 실패가 세션의 값어치를 그대로 보여줬다:
#     단발에서 캡에 걸리면 **워커를 통째로 잃는다**(error_budget, 결과 없음).
#     세션에서 캡에 걸리면 **체크포인트**다(continuable, "계속해" 로 이어감).
_SERVE_TURNS_PER_ASK = "SA_SERVE_MAX_TURNS_PER_ASK"
_TURNS_PER_ASK_DEFAULT = 8

# ── v3.99: serve 전용 종료 도구 ───────────────────────────────────────
#
# 실측(2026-08-22, 리드 게이트 4런): 부모가 던진 질문 22건 중 **17건(77%)이 빈 답**으로
# 돌아왔다. 원인은 채널이 둘인데 서로 경쟁하는 것이다 — 워커 계약은 "보고는
# `report_inspection` 으로" 라고 시키고, serve 프로토콜은 `text`(모델 산문)를 답으로 읽는다.
# 워커는 계약을 따라 리포트를 쓰고 **산문 없이 끝낸다**(세션 stderr 이 턴마다 완전히 공백).
#
# terminal 도구는 엔진 루프를 실제로 멈춘다(`engine.py` `if terminal: … return`). 그러니
# serve 에서 이 도구를 terminal 로 만들면 "리포트를 쓰면 그 pass 가 끝난다" 가 된다 —
# 답이 반드시 오고 남은 턴을 허비하지 않는다.
#
# ⚠️ **단발 경로에는 넣지 않는다.** Phase 1 동등성(검토원 단독 실행이 오늘과 같은 결과)이
#    거기 걸려 있다.
_SERVE_ANSWER_TOOLS = ("report_inspection",)

# 워커가 세션(serve)으로 도는가. **`--serve` 플래그가 유일한 진실**이고, 이 env 는 그걸
# 다운스트림(도메인 계약의 system_prompt 훅 등)이 읽을 수 있게 옮겨 적은 것이다.
# 계약 훅은 argparse 를 못 보고 spec 에도 그 사실이 없다 — spec 에 넣으면 spec 을 쓰는
# 쪽(세션 레지스트리)이 두 번째 진실을 갖게 된다.
SERVE_MODE_ENV = "SA_WORKER_SERVE"
# 워커의 증거 디렉터리 — 계약 훅이 인자로 못 받는 자리에서 쓴다.
EVIDENCE_DIR_ENV = "SA_EVIDENCE_DIR"


@dataclass(slots=True)
class _ServeResult:
    completion: LoopCompleted | None = None
    saw_submit: bool = False
    submit_count: int = 0
    asks: int = 0


def _serve_limit(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def _arm_serve_answer_tools(harness: Any) -> list[str]:
    """serve 에서만 답 도구를 종료 도구로 올린다. 반환 = 실제로 올린 이름들.

    엔진은 **`context.metadata["terminal_tools"]`** 를 본다(계약 객체가 아니라). 그래서
    여기서 그 집합에 더한다 — 계약의 원래 종료 도구(`submit_finding` 등)는 그대로 둔다.

    ★ `_drive_once` 에 넘기는 `terminal_names` 는 **건드리지 않는다.** 그건 `saw_submit`
      부기용이고, `saw_submit` 은 세션 종료 때 `on_submit` / `on_no_submit` 중 무엇을
      부를지 고른다. smb 검토원은 그 분기로 큐 권고 상태를 정한다
      (`domains/smb/plugin/inspect_contract.py::_close_queue(saw_submit=…)`) — 여기서
      같이 올리면 "리포트를 썼다" 가 "finding 을 제출했다" 로 조용히 둔갑한다.
      **엔진을 멈추는 집합과 제출을 세는 집합은 다른 것이다.**

    레지스트리에 없는 이름은 올리지 않는다 — 광고할 수 없는 종료 도구를 요구하면
    이행 불가능한 계약이 된다(엔진 `_advertised_terminals` 와 같은 취지).
    """
    registry = getattr(harness, "registry", None)
    md = harness.context.metadata
    current = set(md.get("terminal_tools") or {"submit_finding"})
    added: list[str] = []
    for name in _SERVE_ANSWER_TOOLS:
        if registry is not None and registry.get(name) is None:
            continue
        if name in current:
            continue
        current.add(name)
        added.append(name)
    md["terminal_tools"] = current
    if added:
        print(f"[agent] serve: 답 도구를 종료 도구로 올린다 {added} "
              f"(단발 경로는 무변)", file=sys.stderr)
    return added


async def _serve_loop(
    harness: Any, messages: list[Any], sys_prompt: str | None,
    terminal_names: set[str], spec: dict, task_type: str,
) -> _ServeResult:
    """부모가 묻고 워커가 답하는 루프. 첫 메시지(task 계약)는 이미 `messages` 에 있다.

    ★ 세션 예산: `harness.budget` 은 `run()` **호출마다** 리셋된다(턴/wall-clock).
      그래서 세션 전체 상한을 여기서 따로 센다 — 없으면 질문 100개로 예산이 무한이 된다.
    """
    out = _ServeResult()
    max_asks = _serve_limit(_SERVE_MAX_ASKS, 40)
    max_turns_total = _serve_limit(_SERVE_MAX_TURNS, 120)
    # 계약 예산(작업 하나 분량)을 질문 하나 분량으로 갈아끼운다. `AgentBudget` 은 frozen
    # 이라 replace 로 새로 만든다. 단발 경로는 이 코드를 안 타므로 영향이 없다.
    import dataclasses as _dc
    per_ask = _serve_limit(_SERVE_TURNS_PER_ASK, _TURNS_PER_ASK_DEFAULT)
    print(f"[agent] serve: 질문당 턴 예산 {per_ask} "
          f"(계약값 {harness.budget.max_turns} → 세션용으로 대체)", file=sys.stderr)
    harness.budget = _dc.replace(harness.budget, max_turns=per_ask)
    _arm_serve_answer_tools(harness)
    turns_total = 0
    loop = asyncio.get_running_loop()

    def _emit(payload: dict) -> None:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    _emit({"ok": True, "ready": True, "task_id": spec.get("task_id"),
           "task_type": task_type})

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:                      # EOF = 부모가 사라졌다 → 종료
            print("[agent] serve: stdin EOF — 세션 종료", file=sys.stderr)
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError as e:
            _emit({"ok": False, "error": f"invalid json: {e}"})
            continue
        if req.get("close"):
            _emit({"ok": True, "closed": True, "asks": out.asks})
            break

        question = str(req.get("ask") or "").strip()
        if not question:
            _emit({"ok": False, "error": "ask 가 비어 있다"})
            continue
        if out.asks >= max_asks:
            _emit({"ok": False, "error": f"세션 질문 상한 {max_asks} 초과",
                   "limit": "asks"})
            continue
        if turns_total >= max_turns_total:
            _emit({"ok": False, "error": f"세션 턴 상한 {max_turns_total} 초과",
                   "limit": "turns"})
            continue

        out.asks += 1
        print(f"\n[agent] serve ask#{out.asks}: {question[:80]}", file=sys.stderr)
        messages.append(UserMessage(content=[TextBlock(text=question)]))
        one = await _drive_once(harness, messages, sys_prompt, terminal_names)
        turns_total += one.completion.total_turns if one.completion else 0
        out.saw_submit = out.saw_submit or one.saw_submit
        out.submit_count += one.submit_count
        if one.completion is not None:
            out.completion = one.completion

        # 이월 컨텍스트 트립와이어 — 1턴짜리 답의 입력토큰이 곧 "들고 가는 양" 이다.
        tokens_in = (one.completion.usage.input_tokens
                     if one.completion and one.completion.usage else 0)
        turns_used = one.completion.total_turns if one.completion else 0
        warn_at = _serve_limit(_SERVE_CTX_WARN, 120_000)
        if turns_used <= 1 and tokens_in > warn_at:
            print(f"[agent] ⚠️ serve 이월 컨텍스트 {tokens_in:,} tok > {warn_at:,} — "
                  f"압축이 필요한 구간에 들어섰다(ask#{out.asks})", file=sys.stderr)

        seen, submitted, triaged = candidate_ledger_stats(harness.context.metadata)
        _emit({
            "ok": True,
            "turn": out.asks,
            "text": one.text,
            "tokens_in": tokens_in,
            "reason": one.completion.reason if one.completion else "no_completion",
            "turns_used": one.completion.total_turns if one.completion else 0,
            "turns_total": turns_total,
            "saw_submit": one.saw_submit,
            "findings_count": one.submit_count,
            "candidates_seen": seen,
            "candidates_accounted": submitted + triaged,
        })
    return out


async def _run(args: argparse.Namespace, info: dict[str, Any]) -> int:
    """info: v3.81 T1b worker_result 작성용 종료 정보 홀더 — main() 이 소비."""
    # ★ 계약의 system_prompt 훅보다 **먼저** 세워야 한다. 훅은 아래 `contract.system_prompt`
    #   에서 한 번 불리고 그 뒤엔 못 바꾼다.
    if getattr(args, "serve", False):
        os.environ[SERVE_MODE_ENV] = "1"
    evidence_dir = Path(args.evidence_dir).resolve()
    # 다운스트림(계약 훅·플러그인)이 "이 워커의 증거 디렉터리" 를 알 수 있게 한다.
    # ★ `build_client` 훅이 `build_user_message` 보다 **먼저** 불리는데(아래 1005 vs 1075),
    #   evidence_dir 를 인자로 받는 건 뒤쪽 훅뿐이라 앞쪽 훅은 알 방법이 없었다.
    #   setdefault 라 바깥에서 준 값이 이긴다.
    os.environ.setdefault(EVIDENCE_DIR_ENV, str(evidence_dir))
    if not evidence_dir.is_dir():
        print(f"[agent] evidence_dir does not exist: {evidence_dir}", file=sys.stderr)
        info["summary"] = f"evidence_dir 없음: {evidence_dir}"
        return 1

    spec_path = evidence_dir / "task_spec.json"
    if not spec_path.exists():
        print(f"[agent] task_spec.json not found in {evidence_dir}", file=sys.stderr)
        info["summary"] = "task_spec.json 없음"
        return 1
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    task_type = spec.get("task_type")

    project_root = Path(__file__).resolve().parents[3]
    _load_dotenv(project_root / ".env")

    # plugin 을 먼저 로드 — 도메인 task_type 의 실행계약/도구셋이 여기서 등록된다
    # (등록 자체가 그 task_type 을 워커에 허용시킨다).
    try:
        from secu_agent.plugins import load_plugins
        load_plugins()
    except Exception as e:  # noqa: BLE001 — fail-loud (worker_result 는 main 이 작성)
        print(f"[agent] plugin 로드 실패 (SA_PLUGINS): {e}", file=sys.stderr)
        info["summary"] = f"plugin 로드 실패: {e}"
        return 2

    # task_type 실행계약 resolve. 코어 generic/finding_narrator/package_sandbox +
    # plugin 등록분. 미등록 task_type = unsupported → fail-closed.
    contract = get_task_contract(task_type)
    if contract is None:
        print(f"[agent] unsupported task_type: {task_type}", file=sys.stderr)
        info["summary"] = f"unsupported task_type: {task_type}"
        return 1

    # ★ 계약은 있는데 도구셋이 없으면 **확실한 배선 버그**다 — fail-loud.
    #
    # build_registry_for_task 는 미등록 task_type 을 generic fallback(scan_text +
    # 코어 범용 submit_finding)으로 조용히 떨어뜨린다. 그 관용은 "plugin 미부착"
    # 상태를 위한 것이고, 계약이 등록됐다는 건 plugin 이 붙었다는 뜻이다.
    # 이 조합을 통과시키면 도메인 워커가 코어 범용 submit_finding 을 쥐고 돌아
    # **task_type judge 디스패치를 통째로 우회**한다(정오탐 게이트가 꺼진다).
    # 실제로 github/confluence 가 그 상태로 오래 돌았다.
    # 단 코어 `generic` 은 예외다 — generic fallback 도구셋을 쓰는 것이 그 계약의 정의라
    # 도구셋을 따로 등록하지 않는다. (이 예외를 빼먹었더니 가드가 코어 자신을 막았다.)
    if task_type != GENERIC_TASK_TYPE and task_type not in registered_task_toolsets():
        msg = (
            f"task_type {task_type!r} 계약은 등록됐는데 도구셋이 없다 — "
            f"register_task_toolset 누락(배선 버그). generic fallback 으로 떨어지면 "
            f"도메인 submit/judge 게이트를 우회한다."
        )
        print(f"[agent] {msg}", file=sys.stderr)
        info["summary"] = msg
        return 2

    profile_path = Path(args.profile).resolve()
    try:
        profiles = load_profiles(profile_path)
    except (FileNotFoundError, ValueError) as e:
        print(f"[agent] profile load failed: {e}", file=sys.stderr)
        info["summary"] = f"profile load 실패: {e}"
        return 2
    profile_name = _select_profile_name(args.profile_name, profiles)
    if profile_name is None or profile_name not in profiles:
        print(f"[agent] profile {profile_name!r} not in {list(profiles)}", file=sys.stderr)
        info["summary"] = f"profile {profile_name!r} 없음"
        return 2
    profile = profiles[profile_name]

    # 계약이 client 를 공급하면 그쪽 — 도메인 워커의 게이트웨이 호환 래퍼(vision/5xx/
    # 폴백/provenance)가 이 훅으로 들어온다. 미공급이면 코어 기본(오늘과 동일).
    if contract.build_client is not None:
        try:
            client = contract.build_client(profile, profiles, spec)
        except Exception as e:  # noqa: BLE001
            print(f"[agent] contract build_client 실패: {e!r}", file=sys.stderr)
            info["summary"] = f"contract build_client 실패: {e!r}"
            return 2
    else:
        client = _build_client(profile)  # transport 분기 (codex_responses / openai_chat)

    # MCP bootstrap (CLI 경로). web 은 lifespan 에서 하지만 CLI 는 직접 — config/
    # mcp_servers.yaml 의 server(gti/splunk 등) 연결 후 registry 에 도구가 등록된다.
    # package_sandbox 가 GTI 평판조회를 쓰려면 필요. server 죽어도 fail-safe(log only).
    # SA_MCP_BOOTSTRAP=0 으로 끌 수 있음(네트워크 회피).
    _mcp_on = os.environ.get("SA_MCP_BOOTSTRAP", "1").strip().lower() not in {"0", "false", "no", "off"}
    if _mcp_on and contract.needs_mcp_bootstrap:
        try:
            from secu_agent.mcp.state import bootstrap_from_yaml
            n = await bootstrap_from_yaml(project_root / "config" / "mcp_servers.yaml")
            if n:
                print(f"[agent] mcp tools registered: {n}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 — MCP 없어도 분석은 진행
            print(f"[agent] mcp bootstrap failed (무시): {e}", file=sys.stderr)

    registry = build_registry_for_task(task_type)
    # 예산 우선순위: argv > spec.budget.max_turns > 계약 기본(task_type별) > 코어 기본.
    spec_max_turns = spec.get("budget", {}).get("max_turns")
    if args.max_turns:
        budget = AgentBudget(max_turns=args.max_turns)
    elif spec_max_turns:
        budget = AgentBudget(max_turns=int(spec_max_turns))
    elif contract.budget is not None:
        budget = contract.budget(spec, profile)
    else:
        budget = AgentBudget()
    harness = GuardedHarness(
        client=client, registry=registry, evidence_dir=evidence_dir, budget=budget,
    )
    # v3.80 Slice0c: charter_ref 는 task_type 무관 공통 주입 — 이 agent 가
    # 다시 sub-agent 를 spawn 할 때 inherit_charter_ref 가 여기서 상속받는다.
    harness.context.metadata["charter_ref"] = spec.get("charter_ref", "")
    # task_type 별 ToolContext metadata 주입 (계약 등록형)
    if contract.metadata is not None:
        harness.context.metadata.update(contract.metadata(spec))

    # candidate ledger 침묵 게이트 — 워커는 기본 enforce(무인 경로: 후보를 보고도
    # 제출·기각 없이 끝내는 침묵을 엔진이 되돌린다). SA_CANDIDATE_LEDGER=0 은 운영
    # kill-switch 로 **권위적**(codex #17): 계약 metadata 가 이미 넣은 True 도 끈다.
    # triage_candidates 미노출 task_type(package_sandbox/finding_narrator 등)은
    # enforce 해도 게이트가 스스로 꺼지므로 triage 있는 toolset 만 켠다(codex #7 스코핑).
    _ledger_on = os.environ.get("SA_CANDIDATE_LEDGER", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }
    if not _ledger_on:
        harness.context.metadata["candidate_ledger_enforce"] = False
    elif registry.get("triage_candidates") is not None:
        harness.context.metadata.setdefault("candidate_ledger_enforce", True)

    # v3.89 Slice2: 자율-능력 grant 주입(테스트 가능한 헬퍼) — 계약 선언 ∩ operator env − floor.
    # 유효 0(기본·env 미설정·zombie)이면 resolver 미주입 → approval_resolver None → 오늘과 byte-for-byte.
    from secu_agent.agent.tools.capability import maybe_inject_autonomous_grant
    maybe_inject_autonomous_grant(
        harness.context, harness.audit, registry,
        declared=getattr(contract, "autonomous_grants", ()),
        scope={
            "charter_ref": str(spec.get("charter_ref", "")),
            "task_type": task_type, "task_id": str(spec.get("task_id", "")),
        },
    )

    user_text = contract.build_user_message(spec, evidence_dir)
    sys_prompt = (
        contract.system_prompt(spec) if contract.system_prompt is not None
        else system_prompt(task_type)
    )

    # ⚠️ 계약이 client 를 공급하면 **실제 서빙 프로파일이 코어 선택과 다를 수 있다**
    # (능력 기반 대체 — 예: 이미지가 필수인 워커에 vision 불가 모델이 선택된 경우).
    # 코어 선택만 찍으면 로그가 거짓이 된다: 2026-08-20 dev_web 실기동에서 계약이
    # deepseek→gemma 로 바꿨는데 시작 줄은 계속 deepseek 이라고 말하고 있었다.
    def _served_profile(c) -> str | None:
        """실제로 **선두에서 서빙하는** 프로파일 이름.

        폴백 체인이면 `client.name` 은 체인 전체 문자열이라(예:
        "fallback(retry(a) -> retry(b))") 시작 줄에 그대로 찍으면 읽기 어렵다.
        체인의 선두 client 를 한 겹 벗겨 이름만 꺼낸다.
        """
        direct = getattr(c, "_profile_name", None)
        if direct:
            return str(direct)
        members = getattr(c, "_clients", None) or getattr(c, "clients", None)
        if members:
            return _served_profile(members[0])
        return None

    _served = _served_profile(client)
    if not _served or _served == profile.name:
        _actual = f"profile={profile.name} model={profile.model}"
    else:
        # ★ 대체가 일어났으면 **모델명도 대체된 쪽**이어야 한다. 2026-08-22 실측:
        #     profile=deepseek→gemma model=private-deepseek-v4-seunghanee
        #   화살표는 맞는데 모델은 여전히 코어가 고른 쪽이었다. 220731b 가 프로파일
        #   이름은 고쳤지만 이 필드를 같이 안 고쳤다 — 같은 사고의 남은 절반이다.
        #   `model=` 으로 어트리뷰션을 세면 답이 뒤집힌다(A/B 집계가 정확히 그렇게 센다).
        _served_model = getattr(profiles.get(_served), "model", None)
        _actual = (f"profile={profile.name}→{_served} "
                   f"model={_served_model or profile.model} (계약이 대체)")
    print(f"[agent] start task_id={spec['task_id']} type={task_type} {_actual}",
          file=sys.stderr)

    # terminal 도구 — 계약이 들고 있는 성공 신호 집합 (예: finding_narrator 는
    # enrich_finding 호출 자체가 진행/성공 신호, package_sandbox 는 submit_verdict).
    terminal_names: set[str] = set(contract.terminal_tools)

    messages: list[Any] = [UserMessage(content=[TextBlock(text=user_text)])]
    completion: LoopCompleted | None = None
    saw_submit = False
    submit_success_count = 0
    try:
        if getattr(args, "serve", False):
            # v3.97: 대화형 세션 — 부모(리드)가 질문을 던지고 답을 받는다. 자세한 계약은
            # `_serve_loop` docstring. 단발 경로는 아래 else 로 오늘과 동일하다.
            passes = await _serve_loop(
                harness, messages, sys_prompt, terminal_names, spec, task_type)
            completion = passes.completion
            saw_submit = passes.saw_submit
            submit_success_count = passes.submit_count
        else:
            one = await _drive_once(harness, messages, sys_prompt, terminal_names)
            completion = one.completion
            saw_submit = one.saw_submit
            submit_success_count = one.submit_count
    finally:
        # nested finally: client.aclose() 가 raise/hang 해도 브라우저 회수는 반드시
        # 시도한다(F5-A codex 리뷰 #2). 브라우저 teardown 은 bounded — 아래 helper 참고.
        try:
            await client.aclose()
        finally:
            await _shutdown_worker_browser()

    print(file=sys.stderr)
    print(f"[agent] done — reason={completion.reason if completion else '?'} "
          f"turns={completion.total_turns if completion else 0}", file=sys.stderr)

    seen, submitted, triaged = candidate_ledger_stats(harness.context.metadata)
    summary = (
        f"task {spec.get('task_id')} ({task_type}): "
        f"reason={completion.reason if completion else 'no_completion'}, "
        f"submit={saw_submit}"
    )
    if seen > 0:
        # 침묵 장부를 부모/오케스트레이터가 그대로 본다 — accounted=0 이면
        # "clean" 이 아니라 "무해명 침묵" 으로 읽혀야 한다.
        summary += f", candidates seen={seen} accounted={submitted + triaged}"
    info.update({
        "task_id": spec.get("task_id"),
        "task_type": task_type,
        "reason": completion.reason if completion else "no_completion",
        "turns_used": completion.total_turns if completion else 0,
        "tokens_in": (completion.usage.input_tokens
                      if completion and completion.usage else 0),
        "tokens_out": (completion.usage.output_tokens
                       if completion and completion.usage else 0),
        "saw_submit": saw_submit,
        "findings_count": submit_success_count,
        "candidates_seen": seen,
        "candidates_accounted": submitted + triaged,
        "summary": summary,
    })

    # NOTE(candidate ledger): terminal 침묵(seen>0, accounted 0)은 엔진 게이트가
    # 리마인더로 잡고 worker_result.candidates_seen/accounted 로 **가시화** 한다.
    # 자동 재점검(rc 강제)은 하지 않는다 — 무한 재큐 위험(codex 2R #8) 때문에
    # 부채는 부모/오케스트레이터 판정에 맡긴다(설계 결정).
    if not saw_submit:
        reason = completion.reason if completion else "no_completion"
        rc = (
            await _maybe_await(contract.on_no_submit(evidence_dir, spec, reason))
            if contract.on_no_submit is not None else 3
        )
        if contract.needs_mcp_bootstrap:
            await _shutdown_mcp_quiet()
        return rc

    if contract.needs_mcp_bootstrap:
        await _shutdown_mcp_quiet()
    return (
        await _maybe_await(contract.on_submit(evidence_dir, spec))
        if contract.on_submit is not None else 0
    )


def _short_input(d: dict) -> str:
    parts = []
    for k, v in list(d.items())[:3]:
        s = str(v)
        if len(s) > 60:
            s = s[:60] + "..."
        parts.append(f"{k}={s!r}")
    return ", ".join(parts)


# ── v3.81 T1b: worker_result.json 작성 (WorkerPool fail-closed 계약) ──────
#
# 부모(WorkerPool/AgentTool)는 워커 transcript 를 받지 않고 이 파일 하나만
# 읽는다. 누락 = 부모가 crash 로 fail-closed 판정하므로, 모든 종료 경로
# (정상/에러/SIGTERM grace)에서 best-effort 로 쓴다. agent_result.json
# (fail-open 보조 채널)은 그대로 — 비대칭은 의도된 것 (Slice0d).

def _worker_status_for(rc: int, info: dict[str, Any]) -> str:
    if rc == 0:
        return "ok"
    reason = str(info.get("reason") or "")
    # 워커 내부 budget watchdog(토큰/idle/wall-clock)은 signal.set → "aborted",
    # 턴 소진은 "max_turns" — 둘 다 graceful 자체종결, 부분 결과 유효.
    if reason in ("max_turns", "max_tokens", "aborted"):
        return "error_budget"
    return "error_crash"


def _write_worker_result_best_effort(
    evidence_dir: Path, rc: int, info: dict[str, Any],
) -> None:
    if not evidence_dir.is_dir():
        return
    try:
        result = build_worker_result(
            rc=rc,
            status=_worker_status_for(rc, info),  # type: ignore[arg-type]
            summary=str(info.get("summary") or f"worker 종료 rc={rc}"),
            findings_count=int(info.get("findings_count") or 0),
            turns_used=int(info.get("turns_used") or 0),
            tokens_in=int(info.get("tokens_in") or 0),
            tokens_out=int(info.get("tokens_out") or 0),
            candidates_seen=int(info.get("candidates_seen") or 0),
            candidates_accounted=int(info.get("candidates_accounted") or 0),
            # ASK-2: 엔진 LoopStopReason 을 정규화 어휘로 매핑해 스키마에 승격.
            completion_reason=normalize_completion_reason(info.get("reason")),
            metrics_version=CANDIDATE_METRICS_VERSION,
        )
        write_worker_result(evidence_dir, result)
    except Exception as e:  # noqa: BLE001 — 결과 기록 실패가 rc 를 가리면 안 됨
        print(f"[agent] worker_result.json 기록 실패: {e!r}", file=sys.stderr)


def _install_sigterm_grace_writer(evidence_dir: Path) -> None:
    """SIGTERM(부모 backstop/cancel) grace 안에 error_cancel 기록 시도.

    이미 결과 파일이 있으면 건드리지 않는다 — 정상 완료 직후 도착한
    SIGTERM 이 유효한 ok 결과를 덮어쓰는 race 방지. 기록 후 기본 동작으로
    재시그널 (부모는 rc=-15 로 시그널 종료를 본다).
    """
    def _on_term(signum: int, frame: Any) -> None:  # noqa: ARG001
        try:
            if not (evidence_dir / WORKER_RESULT_FILENAME).exists():
                write_worker_result(evidence_dir, build_worker_result(
                    rc=128 + signum, status="error_cancel",
                    summary=f"signal {signum} 수신 — grace 기록",
                    completion_reason="cancelled",
                    # v3.90 코어 워커는 grace 종료도 versioned — None 이면 read-model
                    # 이 구(pre-v3.90) 워커로 오인한다(codex #5).
                    metrics_version=CANDIDATE_METRICS_VERSION,
                ))
        except Exception:  # noqa: BLE001 — 죽는 길에 또 죽지 않기
            pass
        _signal.signal(signum, _signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    try:
        _signal.signal(_signal.SIGTERM, _on_term)
    except (ValueError, OSError):
        pass  # 비메인스레드/플랫폼 제약 — grace 기록만 포기 (부모는 missing 으로 fail-closed)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="secu_agent.agent")
    p.add_argument("evidence_dir", help="task evidence_dir (task_spec.json 위치)")
    p.add_argument("--profile", default="config/llm_profiles.yaml")
    p.add_argument("--profile-name", default=None)
    p.add_argument("--max-turns", type=int, default=None)
    # v3.97: 대화형 세션 — stdin/stdout JSON 줄 프로토콜. 미지정이면 오늘의 단발 실행.
    p.add_argument("--serve", action="store_true",
                   help="대화형 세션 모드 (stdin: {\"ask\":…} / stdout: 답)")
    args = p.parse_args(argv)

    evidence_dir = Path(args.evidence_dir).resolve()
    _install_sigterm_grace_writer(evidence_dir)
    info: dict[str, Any] = {}
    try:
        rc = asyncio.run(_run(args, info))
    except Exception as e:  # noqa: BLE001 — 워커 최외곽: 죽음도 보고하고 죽는다
        print(f"[agent] worker 예외: {e!r}", file=sys.stderr)
        info.setdefault("summary", f"worker 예외: {e!r}")
        # info["reason"] 이 (엔진 루프 진입 전 crash 라) 미설정이면 crash 로 —
        # normalize_completion_reason 이 그대로 통과시킨다. 이미 있으면 보존.
        info.setdefault("reason", "crash")
        rc = 4
    _write_worker_result_best_effort(evidence_dir, rc, info)
    return rc


if __name__ == "__main__":
    sys.exit(main())
