"""리드 경계 — 배선 스냅샷 (Phase 2a).

여기서 막는 것은 **조용한 유출**이다. 리드 도구셋에 본문 반환 도구가 하나 섞여도
아무 에러가 안 난다 — 리드는 잘 도는 것처럼 보이고, Phase 3 에서 그 반환값이
codex 로 나간다.

★ 서브프로세스 스냅샷인 이유는 `test_inspect_contract_wiring.py` 와 같다 —
`plugin.bootstrap` 은 import 만으로 프로세스 전역을 바꾼다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]

LEADS = [
    ("smb_lead", "smb", "smb_file_inspect", "domains/smb"),
    ("dev_web_lead", "dev_web", "dev_web_inspect", "domains/dev_web"),
    ("github_lead", "github", "github_inspect", "domains/services/github"),
    ("confluence_lead", "confluence", "confluence_inspect",
     "domains/services/confluence"),
    ("confluence_search_lead", "confluence_search", "confluence_search_inspect",
     "domains/services/confluence"),
]

# 리드 도구의 **정확한 집합**. 늘리려면 "리드가 이걸로 본문을 볼 수 있는가" 를 먼저
# 답하고 이 목록을 고쳐라 — 조용히 늘어나면 안 된다. (이 가드는 2026-08-21 세션 도구
# 3종을 추가할 때 실제로 발동했다 — 그게 이 테스트의 일이다.)
#
# 세션 3종이 경계에 안전한 근거:
#   open_inspection   세션 메타(id/도메인/타깃/카운트)만 반환. 본문 없음.
#   ask_inspector     `InspectorAnswer` 봉투 — 검토원 결과가 지나는 그 봉투이고,
#                     `LeadTool.execute` 마스킹을 그대로 통과한다.
#   close_inspection  같은 봉투(최종본).
#
# target_hit_summary(v3.98)가 경계에 안전한 근거:
#   · `line_preview`(본문 줄)를 **SELECT 하지 않는다** — 컬럼을 안 읽는 것이 그 약속이다.
#   · `masked` 는 `hit_view.value_view` 를 통과한 것만 나간다(마스킹 표식 + 공백 없음).
#     통과 못 하면 값 대신 `shape_of()` 가 나간다 — fail-closed.
#   · 반환 봉투를 **도구가** 조립한다(어댑터가 아니라) — 어댑터 하나가 캡을 못 건너뛴다.
# verify(v3.99)가 경계에 안전한 근거: 입력은 좌표뿐이고(action 은 Literal 로 닫힘),
# 반환은 `lead_verbs.build_verify_result` 의 닫힌 필드 집합 + 닫힌 결과 enum 이다.
# 어댑터가 규격 밖 값을 주면 `error` 로 접는다 — 조용히 통과시키지 않는다.
# report_no_targets(2026-08-28)가 경계에 안전한 근거:
#   · 입력은 산문 한 줄(`observed`)뿐이고 그 문장은 **판정에 안 쓰인다** — 도구가
#     `adapter.list_targets(status=None, limit=1)` 로 큐를 직접 다시 조회한다.
#   · 본문을 읽지 않는다. 반환은 닫힌 필드(accepted/waived/why/next/evidence)뿐이고
#     큐에 row 가 있으면 그 한 행의 목록 메타(list_targets 와 같은 것)만 샘플로 낸다.
#   · terminal_tools 에 **넣지 않는다** — 넣으면 execute 진입만으로 종료 신호가 서서
#     부르기만 하면 게이트가 풀린다. 면제는 도구가 사실을 확인한 뒤에만 선다.
EXPECTED_LEAD_TOOLS = {
    "list_targets", "target_detail", "target_hit_summary", "verify", "delegate_inspect",
    "set_target_status", "record_pivot", "report_no_targets",
    "open_inspection", "ask_inspector", "close_inspection",
}

# 리드에 있으면 안 되는 이름(정의상 본문/임의실행/마스킹 우회).
FORBIDDEN_IN_LEAD = {
    "agent",                    # 코어 위임 도구 — 마스킹 없이 검토원 결과를 준다
    "smb_task_python", "python_exec", "bash_evidence",
    "read_file_quick", "read_file_content",
    "confluence_fetch_page", "confluence_fetch_attachment",
    "web_fetch", "github_browse", "confluence_browser_search",
    "browser_action", "browser_query", "browser_session",
    "scan_text", "submit_finding",
}

_DUMP = r'''
import json, sys
sys.path.insert(0, %(repo)r)
import plugin.bootstrap  # noqa: F401  (등록 부수효과 — 이 프로세스 안에서만)
from pathlib import Path
from secu_agent.agent.agents import get_agent, load_agents
from secu_agent.agent.task_contract import get_task_contract, registered_task_contracts
from secu_agent.agent.tools import build_registry_for_task, registered_task_toolsets
from _shared.lead_adapter import get_lead_adapter, lead_adapter_names

out = {"contracts": sorted(registered_task_contracts()),
       "toolsets": sorted(registered_task_toolsets()),
       "adapters": list(lead_adapter_names()), "by_type": {}}
for tt, domain, inspector, adir in %(leads)r:
    c = get_task_contract(tt)
    entry = {"contract": c is not None}
    reg = build_registry_for_task(tt)
    entry["tools"] = sorted(t.name for t in reg.all())
    entry["read_only"] = sorted(t.name for t in reg.all() if t.is_read_only)
    if c is not None:
        entry["terminal_tools"] = sorted(c.terminal_tools)
        entry["has_build_client"] = c.build_client is not None
        spec = {"task_id": "t", "task_type": tt, "charter_ref": "CH",
                "target": {}}
        try:
            entry["system_prompt_len"] = len((c.system_prompt(spec) or "").strip())
        except Exception as e:
            entry["system_prompt_error"] = repr(e)
        try:
            md = c.metadata(spec)
            entry["metadata"] = {k: sorted(v) if isinstance(v, set) else v
                                 for k, v in md.items()}
            adir_actual = md.get("agents_dir")
            entry["agents_in_dir"] = sorted(
                a.name for a in load_agents(agents_dir=adir_actual))
        except Exception as e:
            entry["metadata_error"] = repr(e)
        try:
            entry["user_message"] = c.build_user_message(spec, None)[:400]
        except Exception as e:
            entry["user_message_error"] = repr(e)
    ad = get_lead_adapter(domain)
    entry["adapter"] = None if ad is None else {
        "inspect_agent": ad.inspect_agent, "statuses": list(ad.statuses),
        "queue_label": ad.queue_label}
    a = get_agent(tt, agents_dir=%(repo)r + "/" + adir + "/agents")
    entry["agent_md"] = None if a is None else {
        "task_type": a.task_type, "profile": a.profile}
    out["by_type"][tt] = entry
print("###JSON###" + json.dumps(out, ensure_ascii=False))
'''


@pytest.fixture(scope="module")
def snap() -> dict:
    env = dict(os.environ)
    prev = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join([str(_REPO), prev]) if prev else str(_REPO)
    code = _DUMP % {"repo": str(_REPO), "leads": LEADS}
    proc = subprocess.run([sys.executable, "-c", code], cwd=str(_REPO), env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"스냅샷 실패\n{proc.stdout}\n{proc.stderr}"
    marker = "###JSON###"
    assert marker in proc.stdout, f"스냅샷 출력 없음\n{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.split(marker, 1)[1])


@pytest.mark.parametrize("tt,domain,_i,_d", LEADS)
def test_lead_contract_registered(snap, tt, domain, _i, _d):
    assert snap["by_type"][tt]["contract"], f"{tt} 계약 미등록"
    assert domain in snap["adapters"], f"{domain} 어댑터 미등록"


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_lead_toolset_is_exactly_the_declared_set(snap, tt, _dom, _i, _d):
    """★ 도구가 조용히 늘면 경계가 넓어진다."""
    got = set(snap["by_type"][tt]["tools"])
    assert got == EXPECTED_LEAD_TOOLS, (
        f"{tt} 리드 도구셋이 규격과 다르다.\n"
        f"  더 있음: {sorted(got - EXPECTED_LEAD_TOOLS)}\n"
        f"  빠짐:    {sorted(EXPECTED_LEAD_TOOLS - got)}"
    )


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_no_content_returning_tool_in_lead(snap, tt, _dom, _i, _d):
    """★ 경계는 프롬프트가 아니라 **도구 등록**이다."""
    leaked = set(snap["by_type"][tt]["tools"]) & FORBIDDEN_IN_LEAD
    assert not leaked, (
        f"{tt} 리드에 본문/임의실행/마스킹우회 도구가 노출됐다: {sorted(leaked)}")


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_lead_terminal_tool_is_callable(snap, tt, _dom, _i, _d):
    e = snap["by_type"][tt]
    assert e["terminal_tools"] == ["set_target_status"], (
        f"{tt} 종료 도구가 규격과 다르다: {e['terminal_tools']}")
    assert set(e["terminal_tools"]) <= set(e["tools"]), (
        f"{tt} 종료 도구가 도구셋에 없다 — 워커가 영원히 못 끝낸다")


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_lead_has_build_client(snap, tt, _dom, _i, _d):
    """없으면 gateway/retry/fallback 래퍼 없이 돈다(Phase 1 과 같은 이유)."""
    assert snap["by_type"][tt]["has_build_client"], f"{tt} build_client 훅 누락"


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_lead_system_prompt_loads(snap, tt, _dom, _i, _d):
    e = snap["by_type"][tt]
    assert "system_prompt_error" not in e, e.get("system_prompt_error")
    assert e["system_prompt_len"] > 500, (
        f"{tt} 리드 계약 본문이 비었거나 너무 짧다 — _shared/skills/lead/lead.md 확인")


@pytest.mark.parametrize("tt,_dom,inspector,_d", LEADS)
def test_lead_can_only_reach_own_domain_inspector(snap, tt, _dom, inspector, _d):
    """★ agents_dir 가 도메인별로 고정돼야 리드가 남의 검토원을 spawn 못 한다."""
    e = snap["by_type"][tt]
    assert "metadata_error" not in e, e.get("metadata_error")
    assert inspector in e["agents_in_dir"], (
        f"{tt} 의 agents_dir 에 검토원 {inspector} 가 없다 — 위임 불가")
    # 다른 도메인 검토원이 같은 디렉터리에 있으면 안 된다(confluence 는 자기 둘만 허용).
    foreign = {"smb_file_inspect", "dev_web_inspect", "github_inspect",
               "confluence_inspect", "confluence_search_inspect"}
    same_dir_ok = {inspector}
    if tt.startswith("confluence"):
        same_dir_ok = {"confluence_inspect", "confluence_search_inspect"}
    assert set(e["agents_in_dir"]) & foreign <= same_dir_ok, (
        f"{tt} 의 agents_dir 에 남의 도메인 검토원이 보인다: "
        f"{sorted(set(e['agents_in_dir']) & foreign - same_dir_ok)}")


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_lead_agent_md_has_no_profile_pin(snap, tt, _dom, _i, _d):
    """`profile:` 은 --profile-name 핀이 되어 SA_CHAT_PROFILE 을 덮는다(불변식)."""
    md = snap["by_type"][tt]["agent_md"]
    assert md is not None, f"agents/{tt}.md 로드 실패 — frontmatter name 이 파일명과 다른가"
    assert md["task_type"] == tt
    assert not md["profile"], f"{tt}.md 에 profile 핀이 있다: {md['profile']}"


@pytest.mark.parametrize("tt,_dom,_i,_d", LEADS)
def test_lead_user_message_states_the_boundary(snap, tt, _dom, _i, _d):
    """리드 프롬프트가 "본문은 안 온다" 를 말해야 한다 — 경계는 아니지만 요청 낭비를 줄인다."""
    e = snap["by_type"][tt]
    assert "user_message_error" not in e, e.get("user_message_error")
    assert "본문" in e["user_message"]


def test_lead_and_inspector_toolsets_are_disjoint_in_spirit(snap):
    """리드 도구 이름은 도메인 접두어가 없어야 한다 — 5큐가 **같은 이름**을 쓰는 게 규격이다."""
    for tt, _dom, _i, _d in LEADS:
        for name in snap["by_type"][tt]["tools"]:
            assert not name.startswith(("smb_", "dev_web_", "github_", "confluence_",
                                        "devops_")), (
                f"{tt} 에 도메인 접두어 도구가 있다: {name} — 리드 도구는 도메인 무관 규격이다")
