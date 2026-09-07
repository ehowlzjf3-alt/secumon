"""계약이 자기 LLM client 를 공급하는 훅 + 배선 누락 fail-loud (v3.95, Phase 1).

## 왜 훅이 필요한가

코어 `cli.py` 는 선택된 프로파일로 **날것** client 를 만든다. 그런데 도메인 워커는
게이트웨이 호환 래퍼가 있어야 산다:

  - vision 미지원 모델에 ImageBlock → 400(invalid_request) → 재시도도 폴백도 안 걸림
    = 태스크 영구 사망
  - 텍스트없는 tool_use 메시지 → LiteLLM 500
  - `SA_CHAT_PROFILE_CHAIN` 폴백
  - 실제로 서빙한 모델 기록(provenance)

이걸 코어에 하드코딩하면 도메인 누출이고, 계약이 못 들면 워커가 방어막 없이 돈다.
그래서 `register_task_toolset` 과 같은 결의 등록형 훅으로 뺀다.

## 왜 fail-loud 가 필요한가

`build_registry_for_task` 는 미등록 task_type 을 generic fallback(scan_text +
**코어 범용 submit_finding**)으로 조용히 떨어뜨린다. 그 관용은 "plugin 미부착" 을 위한
것인데, 계약이 등록됐다는 건 plugin 이 붙었다는 뜻이다. 이 조합을 통과시키면 도메인
워커가 코어 범용 submit 을 쥐고 돌아 **task_type judge 디스패치를 통째로 우회**한다.
실제로 github/confluence 가 그 상태로 오래 돌았다(Phase 0c 에서 봉합).
"""
from __future__ import annotations

import pytest

from secu_agent.agent.task_contract import (
    TaskContract, get_task_contract, register_task_contract, unregister_task_contract,
)


def _contract(task_type: str, **kw) -> TaskContract:
    return TaskContract(
        task_type=task_type,
        build_user_message=lambda spec, ev: "go",
        terminal_tools=frozenset({"submit_finding"}),
        **kw,
    )


def test_build_client_defaults_to_none() -> None:
    """미공급이면 코어 기본 경로 — 오늘과 byte-for-byte 동일해야 한다."""
    assert _contract("t-default").build_client is None


def test_build_client_receives_profile_roster_and_spec() -> None:
    """훅이 선택을 **바꿀** 수 있어야 한다 — 능력 기반 대체(vision)가 그 용도다."""
    seen: dict = {}

    def hook(profile, profiles, spec):
        seen.update(profile=profile, profiles=profiles, spec=spec)
        return "wrapped-client"

    c = _contract("t-hook", build_client=hook)
    out = c.build_client("P", {"a": 1}, {"task_id": "x"})
    assert out == "wrapped-client"
    assert seen["profile"] == "P"
    assert seen["profiles"] == {"a": 1}
    assert seen["spec"] == {"task_id": "x"}


def test_contract_with_hook_round_trips_through_the_registry() -> None:
    def hook(profile, profiles, spec):
        return "c"

    register_task_contract(_contract("t-roundtrip", build_client=hook))
    try:
        got = get_task_contract("t-roundtrip")
        assert got is not None and got.build_client is hook
    finally:
        unregister_task_contract("t-roundtrip")


# ── 배선 누락 fail-loud ──────────────────────────────────────────────────


def test_contract_without_toolset_is_rejected_by_the_worker(tmp_path, capsys) -> None:
    """★ 계약만 있고 도구셋이 없으면 워커가 rc=2 로 죽어야 한다.

    조용한 generic fallback 은 도메인 submit/judge 게이트를 통째로 끈다.
    """
    import argparse
    import asyncio
    import json

    from secu_agent.agent.cli import _run

    register_task_contract(_contract("t-no-toolset"))
    try:
        ev = tmp_path / "ev"
        ev.mkdir()
        (ev / "task_spec.json").write_text(
            json.dumps({"task_id": "t1", "task_type": "t-no-toolset", "target": {}}),
            encoding="utf-8",
        )
        args = argparse.Namespace(
            evidence_dir=str(ev),
            profile="config/llm_profiles.yaml",
            profile_name=None,
            max_turns=None,
        )
        rc = asyncio.run(_run(args, {}))
        assert rc == 2, f"generic fallback 으로 조용히 통과했다 (rc={rc})"
        err = capsys.readouterr().err
        assert "register_task_toolset" in err, err
    finally:
        unregister_task_contract("t-no-toolset")


def test_registered_toolset_passes_the_wiring_check() -> None:
    """가드가 정상 배선까지 막으면 안 된다 — 코어 자신의 계약들이 통과하는지."""
    from secu_agent.agent.tools import registered_task_toolsets
    from secu_agent.agent.task_contract import registered_task_contracts

    from secu_agent.agent.cli import GENERIC_TASK_TYPE

    toolsets = registered_task_toolsets()
    for task_type in registered_task_contracts():
        if task_type == GENERIC_TASK_TYPE:
            continue    # generic fallback 을 쓰는 게 이 계약의 정의다 — 유일한 예외
        assert task_type in toolsets, (
            f"코어 계약 {task_type!r} 에 도구셋이 없다 — 가드가 코어 자신을 막는다"
        )


def test_generic_contract_is_the_only_toolset_exemption() -> None:
    """예외가 하나로 유지되는지 — 늘어나면 가드가 무력해진다."""
    from secu_agent.agent.cli import GENERIC_TASK_TYPE
    from secu_agent.agent.task_contract import registered_task_contracts
    from secu_agent.agent.tools import registered_task_toolsets

    exempt = [t for t in registered_task_contracts()
              if t not in registered_task_toolsets()]
    assert exempt == [GENERIC_TASK_TYPE], (
        f"도구셋 없는 계약이 늘었다: {exempt} — 배선 누락이거나 예외가 번지고 있다"
    )
