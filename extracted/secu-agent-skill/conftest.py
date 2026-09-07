"""service/tests 공용 fixture — 엔진 tests/conftest 의 tmp_db 패턴 + SMB seed.

실행 (엔진 스위트와 동시 실행 금지 — 공유 PG, 직렬 only):
    cd ~/project/secu-agent-skill
    PYTHONPATH=~/project/secu-agent/src:. ~/project/secu-agent/.venv/bin/python \
        -m pytest service/tests plugin/tests -q
"""
from __future__ import annotations

import os
import time

import pytest

# de-domain 정리: DB 헬퍼는 여러 테스트가 직접 import 하므로 정식 모듈(db_setup)로 분리.
from service.tests.db_setup import _ensure_test_db, _resolve_test_dsn, _truncate_all_managed


def _register_test_wide_plugins() -> None:
    """테스트 전반이 필요로 하되 개별 테스트가 스스로 등록하지 않는 registration 만 좁게 공급.

    프로덕션은 SA_PLUGINS→register_all() 로 전부 등록하지만, 그 전체를 테스트 세션에 걸면
    evidence_judge/agent_type 를 자체 등록하는 테스트와 충돌한다. 여기서는 충돌 없는 두 가지만:
    문서 민감도 스캐너 + SMB sub-agent 도구셋. (둘 다 개별 테스트가 등록하지 않음.)
    """
    # (1) 문서 민감도 스캐너 — scan_text(include_document_signals=True) 가 쓰는 등록형 스캐너.
    try:
        import importlib

        doc = importlib.import_module("_shared.detectors.document_sensitivity")
        fn = getattr(doc, "scan_document_sensitivity", None)
        if fn is not None:
            from secu_agent.detectors import text_scan

            if fn not in text_scan._TEXT_SIGNAL_SCANNERS:  # append 형 — 중복 등록 회피
                text_scan.register_text_signal_scanner(fn)
    except Exception:  # noqa: BLE001 — 등록 실패해도 세션 setup 은 계속
        pass

    # (2) SMB sub-agent task 도구셋 — build_registry_for_task("smb_file_inspect").
    try:
        from secu_agent.agent.tools import register_task_toolset

        from domains.smb.plugin.toolsets import smb_file_inspect_tools

        try:
            register_task_toolset("smb_file_inspect", smb_file_inspect_tools)
        except ValueError:
            pass  # 이미 등록됨 — 멱등
    except Exception:  # noqa: BLE001
        pass

    # (3) 도메인 memory scope — de-domain(v3.84 #5) 이후 코어 base 는 global/operator 뿐이고
    #     SMB 어휘(host/share/path_pattern)는 plugin.bootstrap 이 register_memory_scope 로
    #     등록한다. 그 bootstrap 을 세션에 걸지 않으므로(evidence_judge/agent_type 충돌 회피)
    #     memory_recall_for_share/memory_add 를 직접 부르는 테스트를 위해 여기서 좁게 등록. (멱등)
    try:
        from secu_agent.state import register_memory_scope

        for scope in ("host", "share", "path_pattern"):
            register_memory_scope(scope)
    except Exception:  # noqa: BLE001
        pass

    # (4) 스킬 state 네임스페이스(skill_smb/dev_web/github/confluence) 순수-메모리 등록.
    #     bootstrap 도 이 registrar 에 위임한다(단일 소스). state-schema 를 검증하는 테스트가
    #     `import plugin.bootstrap`(=register_all 충돌) 없이 등록 표면을 얻게 하는 collision-free seam.
    #     checksum-멱등·dormant(첫 connection(ns) 전엔 DDL 무영향)이라 세션 1회로 충분·안전.
    try:
        from plugin.state_schema_wiring import register_state_schemas

        register_state_schemas()
    except Exception:  # noqa: BLE001
        pass


@pytest.fixture(scope="session", autouse=True)
def _pg_test_env():
    """세션 1회: 테스트 DB 보장 + env 고정 + 코어/도메인 스키마 부트스트랩."""
    dsn = _resolve_test_dsn()
    _ensure_test_db(dsn)
    os.environ["SECU_AGENT_PG_DSN"] = dsn
    from secu_agent import state
    state._reset_pg_pool()
    # 프로덕션 register_all(=plugin.bootstrap import) 전체는 evidence_judge/agent_type 도 등록해,
    # 그것을 자체 fixture 로 등록하는 테스트(test_smb_evidence_judge 등)와 ValueError 충돌한다
    # (기존 테스트의 격리 가정). 따라서 bootstrap 을 import 하지 않고, 테스트 전반이 필요로 하되
    # 개별 테스트가 직접 등록하지 않는 것만 좁게 등록한다:
    #   (1) 문서 민감도 스캐너(semiconductor_process 등 문서 시그널 스캔),
    #   (2) SMB sub-agent task 도구셋(smb_file_inspect — build_registry_for_task).
    _register_test_wide_plugins()
    import service.state_domain as sd
    sd._SCHEMA_READY = False
    with sd.connect():  # 코어 + 도메인 스키마 부트스트랩
        pass
    yield
    state._reset_pg_pool()


@pytest.fixture(autouse=True)
def _no_real_egress(monkeypatch):
    """테스트는 **실제 발송 스위치를 물려받지 않는다.**

    ★ 왜 — `.env` 에 `SA_DELIVERY_AUTOSEND_SINKS="knox_mail"` 이 켜져 있다. 그 값을 스위트가
    그대로 읽으면 **개발자 기계 설정에 따라 테스트 결과가 갈린다**. 실제로 그랬다:
    수신처 정책에 "자율발송 중이면 도메인 모드를 명시하라" 는 게이트를 넣자, 그 env 를 물려받던
    테스트 여러 개가 한꺼번에 깨졌다 — 테스트가 검증하려던 것과 무관한 이유로.

    발송 경로를 정말 검사하는 테스트는 자기가 `monkeypatch.setenv` 로 켜면 된다(그게 의도를
    드러내는 쪽이다). 기본은 **꺼짐** 이어야 한다 — 스위트가 실 egress 설정을 건드릴 이유가 없다.

    ⚠️ 수신처 모드도 같다. `.env` 를 `normal` 로 바꾸자 이번엔 재확인 회신 테스트가
    "DSSOC 에게 갔다" 대신 "담당자에게 갔다" 를 보고 깨졌다 — 검증하려던 것과 무관한 이유로.
    **운영 설정이 테스트 결과를 바꾸면 그 스위트는 기계마다 다른 답을 낸다.**
    """
    for name in (
        "SA_DELIVERY_AUTOSEND_SINKS",
        "SMB_REMEDIATION_MAIL_MODE",
        "GITHUB_REMEDIATION_MAIL_MODE",
        "CONFLUENCE_REMEDIATION_MAIL_MODE",
        "DEV_WEB_REMEDIATION_MAIL_MODE",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def tmp_db():
    """모든 managed schema(public/core/platform/skill_*) 테이블 truncate — P2 platform-aware.

    도메인 schema 는 state_domain 의 lazy ensure 가, core/platform 은 코어 부트스트랩이 만든다.
    """
    import service.state_domain as sd

    with sd.connect() as c:  # ensure(+core/platform provision) + truncate
        _truncate_all_managed(c)
    yield None


@pytest.fixture(autouse=True)
def _ensure_domain_memory_scopes():
    """도메인 memory scope(host/share/path_pattern)를 **매 테스트 전** 재등록.

    코어 v3.88 de-domain: `_CORE_MEMORY_SCOPES={global,operator}` 만 기본. 도메인 scope 는
    plugin/bootstrap.py:187-188 이 register_memory_scope 로 공급하나, 테스트 세션은 bootstrap
    import 를 피한다(agent_type 충돌). 세션 1회 등록은 order-fragile — 형제 테스트
    (_shared/tests/test_memory_tools.py)의 autouse teardown 이 이 scope 를 **unregister** 하므로,
    이후 테스트가 `ValueError: invalid scope: host/path_pattern` 로 깨진다(전수 스위트에서 결정적).
    register_memory_scope 는 멱등 → function-scope 로 매 테스트 전 보장한다.
    """
    from secu_agent.state import register_memory_scope
    for scope in ("host", "share", "path_pattern"):
        register_memory_scope(scope)
    yield


@pytest.fixture(autouse=True)
def _tool_checkpoint_test_mode():
    """엔진 tests/conftest 에서 포팅(v3.89) — 검문소는 프로덕션 항상 강제이나, 스킬 테스트도
    tool.execute() 를 invoke_tool 밖 cold 로 직접 부른다. 강제를 낮춰 cold-call 을 허용.
    invoke_tool 경로는 permit 이 매칭·소비되므로 happy-path 는 여전히 검증된다(env 노출 0).

    de-domain: conftest 를 루트로 승격할 때 이 autouse 픽스처가 누락됐다 — 없으면 cold-call
    테스트가 ToolCheckpointBypass 로 실패한다. 여기서 재공급한다.
    """
    from secu_agent.agent.tools import base
    prev = base.set_checkpoint_enforced(False)
    yield
    base.set_checkpoint_enforced(prev)


@pytest.fixture()
def client():
    """이 도메인 서비스의 app (service.app.create_app) TestClient — web 테스트용."""
    from fastapi.testclient import TestClient

    from service.app import create_app

    return TestClient(create_app())


@pytest.fixture()
def seed(tmp_db):
    """SeedFactory — 테스트가 원하는 모양으로 share/file/hit을 채워넣는다."""
    import service.state_domain as sd

    class _Seeder:
        def __init__(self):
            self.scan_id = sd.scan_start("smb", ["192.0.2.0/24"])
            self._share_ids: list[int] = []
            self._file_ids: list[int] = []

        def share(
            self, host="192.0.2.10", share="testshare",
            null=False, guest=False, auth=True, cred_id=None,
            read=True, write=False, status="walked",
            file_total=0, severity=None, summary=None,
            listing_review=None, access_modes=None,
        ) -> int:
            _, sid = sd.upsert_smb_share(
                self.scan_id, "192.0.2.0/24", host, share,
                null_login_ok=null, guest_login_ok=guest, auth_login_ok=auth,
                auth_credential_id=cred_id,
                share_read=read, share_write=write,
                access_modes=access_modes,
            )
            sd.share_set_status(
                sid, status,
                walk_done_at=time.time() if status != "pending" else None,
                walk_file_count=file_total,
                severity=severity, summary=summary,
            )
            if listing_review:
                sd.share_set_listing_review(sid, listing_review)
            self._share_ids.append(sid)
            return sid

        def file(
            self, share_id: int, path="a/b/secret.env",
            size=128, text=True, suspicious=True,
            fetch_status="text", read=True, write=False,
            scanned=True, hits=0,
        ) -> int:
            fid = sd.upsert_smb_file(
                share_id, path,
                size=size, is_text_candidate=text, suspicious_name=suspicious,
            )
            sd.file_record_fetch(
                fid, fetch_status=fetch_status,
                file_read=read, file_write=write,
            )
            if scanned:
                sd.file_record_scan(fid, hits_count=hits)
            self._file_ids.append(fid)
            return fid

        def hit(
            self, file_id: int,
            category="secret", kind="aws_access_key_id",
            masked="AKIA****", line_no=10, line_preview="export KEY=AKIA****",
            verdict="pending", confidence=None, note=None, validation=None,
        ) -> int:
            sd.add_file_hits(file_id, [{
                "category": category, "kind": kind, "masked": masked,
                "line_no": line_no, "line_preview": line_preview,
                "validation": validation,
            }])
            # 가장 마지막 INSERT의 id
            with sd.connect() as c:
                row = c.execute(
                    "SELECT id FROM smb_file_hit WHERE file_id=? "
                    "ORDER BY id DESC LIMIT 1", (file_id,)
                ).fetchone()
                hit_id = int(row["id"])
            if verdict != "pending":
                sd.file_hit_set_verdict(
                    hit_id, verdict=verdict, confidence=confidence, note=note,
                )
            return hit_id

        def credential(self, name="test-cred", username="testuser",
                       env_var="TEST_SMB_PW") -> int:
            os.environ.setdefault(env_var, "fake-not-used")
            return sd.cred_add(name, username, f"env:{env_var}")

    return _Seeder()




# ── plugin.bootstrap 은 in-process 로 import 하지 마라 (2026-08-20) ──────────────
#
# 이 모듈은 **import 만으로 프로세스 전역을 바꾼다**: evidence judge 등록,
# finding category, 민감어휘 시그널, task_type canonicalizer,
# `register_browser_verified_task_type("dev_web")` 등.
#
# 그래서 스위트는 이 모듈을 in-process 로 로드하지 않는 규약으로 굴러왔다
# (`test_github_secret_evidence_judge.py` 가 bootstrap 을 **텍스트로** 읽는 것이 그 흔적).
# 이 세션에서 그 규약을 두 번 어겨 각각 10건 / 1건을 깨뜨렸다:
#   1) plugin/tests/test_bootstrap_idempotent.py  → 서브프로세스로 격리
#   2) _shared/tests/test_inspect_contract_wiring.py → 서브프로세스 스냅샷으로 격리
# 파일 단위 가드로는 세 번째를 못 막는다 — 여기서 저장소 전역으로 고정한다.
#
# bootstrap 이 필요한 테스트는 서브프로세스에서 돌려라(위 두 파일이 그 본보기다).
def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    import sys

    if "plugin.bootstrap" not in sys.modules:
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    msg = (
        "⚠️ plugin.bootstrap 이 이 pytest 프로세스에 in-process 로 로드됐다 — "
        "전역 레지스트리(judge/category/browser-verified)가 오염돼 다른 테스트의 "
        "결과가 바뀔 수 있다. 필요한 테스트는 서브프로세스에서 돌려라 "
        "(_shared/tests/test_inspect_contract_wiring.py 참조)."
    )
    if reporter is not None:
        reporter.write_line("")
        reporter.write_line(msg, red=True, bold=True)
    session.exitstatus = session.exitstatus or 1
