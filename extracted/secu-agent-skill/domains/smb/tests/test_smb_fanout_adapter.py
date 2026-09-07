"""v3.88: SMB E2E fanout 어댑터 (register_fanout_adapter 재부착) 단위 검증.

de-domain(코어 v3.80)에서 제거된 `RalphController._smb_subnet_phase`/`_smb_batch_phase`
depth-first 드라이버를 대체하는 v3.88 메커니즘. 코어가 `register_fanout_adapter`(4-hook
claim_next/build_spec/release/summarize)를 제공하고, 스킬은 클린아키텍처 application 레이어
(`domains/smb/application/fanout.py`)에서 포트로 store/runtime 을 주입한다. 포트 주입이므로
DB 없이 fake 로 검증한다(구 phase 테스트 test_smb_subnet_phase/test_smb_batch_driver 대체).
"""
from __future__ import annotations

from pathlib import Path

from domains.smb.application.fanout import FanoutServices, register


class _FakeStore:
    def claim_mail_thread(self, *, session_id: int, status: str):
        return None

    def set_mail_thread_status(self, thread_id, status, **fields):
        pass


class _FakeRuntime:
    def __init__(self, root: Path):
        self._root = root

    def make_evidence_dir(self, label: str) -> Path:
        d = self._root / label
        d.mkdir(parents=True, exist_ok=True)
        return d

    def worker_env(self) -> dict[str, str]:
        return {"SA_PLUGINS": "x"}


def _services(tmp_path: Path) -> FanoutServices:
    return FanoutServices(store=_FakeStore(), runtime=_FakeRuntime(tmp_path))


def test_register_wires_all_smb_fanout_adapters(tmp_path):
    from secu_agent.agent.fanout import list_fanout_adapters

    assert register(_services(tmp_path)) is True
    names = set(list_fanout_adapters())
    # #2 조치요청 · #3 답장재검증. #1 점검(`smb_task`)은 은퇴했다 —
    # walked share 큐는 이제 `smb.lead` 가 검토원으로 소비한다(2026-08-28).
    assert {"smb_report_mail", "smb_reply_verify"} <= names
    assert "smb_task" not in names, "은퇴한 평면 어댑터가 되살아났다"
