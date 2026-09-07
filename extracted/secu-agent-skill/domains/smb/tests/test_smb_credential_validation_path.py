"""smb credential finding 이 게이트를 넘는 **유일한 경로**를 규약에 고정한다.

배경(2026-08-17 실측, W34 재수집 후 첫 30런에서 halt 2건):

halt ①  12.23.65.139 — 제출 1회차는 서식이 완벽했다(severity/task_type/hits 전부).
        게이트 판정은 `suspected`:
            "reachable target hint and credential material but no GET/login-form
             POST validation result"
        워커가 고치려고 재전송했는데 **JSON 이 깨졌다** — `preview` 가
        `connectionString="…&quot;…"` 처럼 인용부호로 가득해서, 긴 페이로드를 다시
        뱉는 과정에 `<|"|>` 토큰 아티팩트가 섞이며 finding 전체가 hits 한 개의
        거대한 key 로 붕괴했다. 같은 붕괴가 두 번 → halt, 확정된 크리덴셜 유실.

halt ②  12.23.67.40 — JSON 은 멀쩡했고 5회 전부 같은 `suspected` 판정.
        워커는 검증을 **시도했다**(smb_credential_probe 성공,
        smb_origin_credential_probe 는 SA_CRED_PROBE 미설정으로 forbidden).
        그런데 그 사실을 게이트가 읽는 형태로 옮기지 못했다.

게이트(`_has_probe_validation`)가 인정하는 것은 딱 둘이다:
  · `hit.validation.kind == "credential_reachability"`  ← smb_credential_probe 반환값
  · risk_narrative/evidence_notes/preview 안의 마커 문자열
    (`safe_probe`, `credential_reachability`, `GET 도달`, `로그인 POST` …)

즉 **경로는 있는데 규약이 그 경로를 안 알려주고 있었다.** 워커는 "검증 결과를
risk_narrative 에 남겨라" 라는 지시만 받고, 무엇을 남겨야 인정되는지 몰라
한국어 서술을 썼고 마커가 없어 계속 거부됐다.

⚠️ 이 파일은 **게이트를 약화하지 않는다.** 고정하는 것은 "실제로 실행한 도구의
반환값을 그대로 옮겨라" 이지 "마커를 타이핑하면 통과한다" 가 아니다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
WORKER_MD = ROOT / "domains/smb/skills/smb_task/worker.md"


@pytest.fixture(scope="module")
def worker() -> str:
    return WORKER_MD.read_text(encoding="utf-8")


def test_contract_names_the_tool_whose_output_the_gate_accepts(worker) -> None:
    """★ smb_credential_probe 가 규약에 없으면 워커는 그 도구를 찾지 못한다."""
    assert "smb_credential_probe(" in worker, (
        "게이트가 직접 인정하는 도구(smb_credential_probe)가 규약에 없다"
    )


def test_contract_says_to_copy_the_validation_object_verbatim(worker) -> None:
    """반환값을 **옮기라**고 해야 한다 — 요약/의역하면 kind 가 사라져 게이트가 못 읽는다."""
    assert "hits[].validation" in worker
    assert "credential_reachability" in worker
    assert "verbatim" in worker.lower()


def test_contract_covers_the_non_http_case(worker) -> None:
    """MSSQL 1433 같은 비-HTTP 대상은 safe_probe 로 검증 자체가 불가능하다.

    그 경우를 안 다루면 워커는 만족시킬 수 없는 요구를 무한 재시도한다(halt ②).
    """
    assert "validated" in worker and "0" in worker
    assert "MSSQL" in worker
    assert "verification_method" in worker


def test_contract_forbids_inventing_a_probe_result(worker) -> None:
    """⚠️ 이 규약이 '마커를 적으면 통과'로 읽히면 게이트가 무력화된다."""
    assert "Name only tools you actually called" in worker, (
        "실행하지 않은 도구를 적지 말라는 금지가 없다 — 게이트 우회 지침이 되어버린다"
    )
    assert "inventing one is worse" in worker


def test_contract_warns_about_quote_dense_preview(worker) -> None:
    """★ halt ① 의 직접 원인 — 인용부호로 가득한 긴 preview 재전송."""
    assert "preview" in worker and "double quotes" in worker
    assert "without its surrounding quotes" in worker


def test_gate_markers_the_contract_relies_on_still_exist() -> None:
    """★ 코어가 인정하는 마커가 바뀌면 이 규약도 같이 고쳐야 한다.

    규약이 `safe_probe`/`credential_reachability` 를 쓰라고 안내하는 근거는 코어의
    `_VALIDATION_TEXT_MARKERS` 다. 거기서 빠지면 안내가 死지침이 된다.
    """
    from secu_agent.agent.evidence_judgment import _VALIDATION_TEXT_MARKERS

    lowered = {m.lower() for m in _VALIDATION_TEXT_MARKERS}
    assert "safe_probe" in lowered
    assert "credential_reachability" in lowered


def test_probe_tool_returns_the_shape_the_contract_promises() -> None:
    """규약이 `results[].validation` 을 옮기라고 하니, 도구가 실제로 그 모양이어야 한다."""
    import inspect

    from domains.smb.plugin.tools import smb_credential_probe_tool as p

    src = inspect.getsource(p.SmbCredentialProbeTool.execute)
    assert '"results"' in src
    assert '"validation": e.get("validation")' in src
    assert '"validated"' in src
