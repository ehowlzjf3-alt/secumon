"""스레드 어댑터가 **4도메인 다 등록되고 계약을 지키는지** 고정한다.

## 왜

`_shared/thread_adapter.py` 는 2026-08-26 에 만들어졌지만 **호출부가 0** 인 채로
닷새를 있었다(메모리 `wiring-that-was-never-wired`). 계약과 테스트는 있는데
등록하는 곳이 없으면, 계약은 있는 게 아니다. 여기가 그 재발을 막는다.

## ★ 왜 서브프로세스 스냅샷인가

`plugin.bootstrap` 은 **import 만으로 프로세스 전역을 바꾼다**(judge 등록,
browser-verified task_type 등). 평범한 import 로 짜면 다른 테스트가 깨진다 —
이 저장소에서 이미 두 번 있었던 일이다(`_shared/tests/test_inspect_contract_wiring.py`
머리말). 그래서 격리 프로세스가 어댑터 상태를 JSON 으로 떠 오고, 테스트는
그 스냅샷만 본다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_DOMAINS = ("smb", "github", "confluence", "dev_web")

#: 계약이 **필수**로 요구하는 슬롯. 하나라도 비면 위층이 도메인 분기를 하게 된다.
_REQUIRED = (
    "list_threads", "thread_get", "finding_ids", "claim_next", "set_status",
    "bump_attempt", "reclaim_stale", "schedule_retry", "deliver_report",
)

_DUMP = r'''
import inspect, json, sys
sys.path.insert(0, %(repo)r)
import plugin.bootstrap as bootstrap  # 등록 부수효과 — 이 프로세스 안에서만
bootstrap.register_all()
from _shared.thread_adapter import get_thread_adapter, thread_adapter_names
from _shared.reply_body import reply_blocks

out = {"names": list(thread_adapter_names()), "by_domain": {}}
for d in %(domains)r:
    a = get_thread_adapter(d)
    if a is None:
        out["by_domain"][d] = None
        continue
    out["by_domain"][d] = {
        "domain": a.domain,
        "queue_label": a.queue_label,
        "statuses": list(a.statuses),
        "claimable": list(a.claimable_statuses),
        "callable": {s: callable(getattr(a, s, None)) for s in %(required)r},
        "deliver_report_async": inspect.iscoroutinefunction(a.deliver_report),
        "supports_build": a.supports_build(),
        "supports_recheck": a.supports_recheck(),
        "supports_recheck_preview": a.supports_recheck_preview(),
        "has_delivery_targets": a.delivery_targets is not None,
        "has_reply_envelope": a.reply_envelope is not None,
        "ticket_no": a.ticket_no(24),
        "blocks": [b.name for b in reply_blocks(d)],
    }
print("###JSON###" + json.dumps(out, ensure_ascii=False))
'''


@pytest.fixture(scope="module")
def snap() -> dict:
    """격리 프로세스에서 어댑터 상태를 떠 온다 — 이 프로세스 전역은 안 건드린다."""
    env = dict(os.environ)
    prev = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join([str(_REPO), prev]) if prev else str(_REPO)
    code = _DUMP % {"repo": str(_REPO), "domains": _DOMAINS, "required": _REQUIRED}
    proc = subprocess.run([sys.executable, "-c", code], cwd=str(_REPO), env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"스냅샷 실패\n{proc.stdout}\n{proc.stderr}"
    marker = "###JSON###"
    assert marker in proc.stdout, f"스냅샷 출력 없음\n{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.split(marker, 1)[1])


def test_all_four_domains_are_registered(snap) -> None:
    assert sorted(snap["names"]) == sorted(_DOMAINS), (
        "스레드 어댑터 등록이 빠졌다 — plugin/bootstrap.py:_register_thread_layer 확인")


@pytest.mark.parametrize("domain", _DOMAINS)
def test_required_slots_are_callable(snap, domain: str) -> None:
    a = snap["by_domain"][domain]
    assert a is not None, f"{domain} 어댑터 미등록"
    assert a["queue_label"], "큐 라벨이 비면 프롬프트에 도메인 이름이 안 나온다"
    assert a["statuses"], "상태 어휘가 비었다"
    missing = [s for s, ok in a["callable"].items() if not ok]
    assert not missing, f"{domain} 필수 슬롯이 호출 불가: {missing}"


@pytest.mark.parametrize("domain", _DOMAINS)
def test_deliver_report_is_async(snap, domain: str) -> None:
    """계약이 async 를 요구한다 — sync 를 끼우면 호출부가 await 에서 터진다."""
    assert snap["by_domain"][domain]["deliver_report_async"]


@pytest.mark.parametrize("domain", _DOMAINS)
def test_claimable_statuses_are_in_the_vocabulary(snap, domain: str) -> None:
    """★ 2026-08-31 에 실제로 잡힌 버그의 회귀 테스트.

    dev_web 을 `("report_ready","reverify_requested")` 로 썼는데
    `reverify_requested` 는 상태 어휘에 **없는 값**이었다. 그대로 뒀으면
    dev_web 만 조용히 idle 이 된다(2026-08-26 과 같은 사고).
    """
    a = snap["by_domain"][domain]
    unknown = [s for s in a["claimable"] if s not in a["statuses"]]
    assert not unknown, f"{domain} claimable 에 어휘에 없는 상태: {unknown}"


@pytest.mark.parametrize("domain", _DOMAINS)
def test_recheck_is_possible_everywhere(snap, domain: str) -> None:
    assert snap["by_domain"][domain]["supports_recheck"], (
        f"{domain} 이 재검증을 못 한다고 말한다 — 융합 도메인도 할 수 있다")


def test_only_split_domains_expose_build_preview(snap) -> None:
    """만들기/배달이 갈린 곳은 둘뿐이다(실측). 융합 도메인이 True 면 거짓말이다."""
    b = {d: snap["by_domain"][d]["supports_build"] for d in _DOMAINS}
    assert b == {"github": True, "confluence": True, "smb": False, "dev_web": False}, b


def test_ticket_numbers_do_not_collide(snap) -> None:
    """네 도메인의 같은 스레드 번호가 서로 다른 티켓이어야 한다."""
    nos = {d: snap["by_domain"][d]["ticket_no"] for d in _DOMAINS}
    assert len(set(nos.values())) == len(_DOMAINS), f"티켓 번호 충돌: {nos}"
    assert nos["smb"] == "SMB00024", "smb 는 기존 표기를 유지해야 한다(이미 사람이 본 번호)"


@pytest.mark.parametrize("domain", _DOMAINS)
def test_delivery_targets_wired(snap, domain: str) -> None:
    """수신처 규칙이 없으면 회신 도구가 담당자를 못 정한다."""
    assert snap["by_domain"][domain]["has_delivery_targets"]


def test_only_smb_has_a_reply_all_envelope(snap) -> None:
    """받은 메일이 있는 도메인은 smb 뿐 — 나머지는 기본 봉투로 떨어진다."""
    have = {d for d in _DOMAINS if snap["by_domain"][d]["has_reply_envelope"]}
    assert have == {"smb"}, have


def test_reply_blocks_registered_where_expected(snap) -> None:
    blocks = {d: snap["by_domain"][d]["blocks"] for d in _DOMAINS}
    assert "smb_howto_windows" in blocks["smb"]
    assert "github_remediation_steps" in blocks["github"]
    assert "confluence_remediation_steps" in blocks["confluence"]
    # dev_web 은 고정 절차가 없다 — 지어내지 않았음을 고정한다.
    assert blocks["dev_web"] == [], blocks["dev_web"]


def test_list_threads_never_ships_the_report_body() -> None:
    """목록에 본문을 실으면 리드 컨텍스트가 보고서 HTML 로 찬다.

    (순수 함수라 부트스트랩이 필요 없다 — 서브프로세스 밖에서 돈다.)
    """
    from _shared.thread_adapter import summarize_thread_row

    row = {"id": 7, "status": "reported", "host": "1.2.3.4",
           "report_json": "{...}", "report_html": "<html>" + "x" * 9000}
    out = summarize_thread_row("smb", row, coord_keys=("host",))
    assert "report_json" not in out and "report_html" not in out
    assert out["has_report_body"] is True, "본문이 '없다'와 '안 실었다'는 다르다"
    assert out["ticket_no"] == "SMB00007"
    assert out["coordinate"] == "1.2.3.4"
