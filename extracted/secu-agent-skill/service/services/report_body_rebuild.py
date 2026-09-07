"""저장된 조치요청 본문을 **다시 만든다** — 4도메인 한 벌.

## 왜 필요한가 (2026-08-31)

문안을 고쳐도 **이미 저장된 본문은 옛 문구 그대로** 남는다. 화면과 발송은 저장본을
쓰므로, 생성기만 고치면 사용자 눈에는 아무것도 안 바뀐 것으로 보인다.

    사용자: "DSSOC가 아니라 DS보안관제라고 했는데. 본문이 안 고쳐졌네 다들"

실측 당시 남아 있던 것:

    "2주 누적 확인"(발송 근거 아님)   smb 1 · github 144 · confluence 20
    "DSSOC"                          smb 46 · github 290 · confluence 44
    "(정보보안)" → (정보보호)          smb 51 · github 290 · confluence 44

## 두 가지 규칙

1. **나간 적 있는 스레드는 건드리지 않는다.** 발송본을 재생성으로 갈아치우면
   "우리가 무엇을 보냈나" 가 사라진다. 그건 이 저장소가 반복해서 지켜 온 선이다.
2. **상태를 바꾸지 않는다.** `mark_report_ready` 는 status 를 `report_ready` 로 옮기고
   attempt 를 올린다 — 큐에 있던 스레드가 재생성만으로 자리를 옮기면 안 된다.
   그래서 상태 setter 에 **현재 status 를 그대로** 넘긴다.

⚠️ smb 는 본문 구조가 다르다(`mail_thread.report_json` 안의 `html`). 그쪽은
   `smb_draft_report.rebuild_draft_body` 가 담당한다 — 여기서는 나머지 셋만 본다.
"""
from __future__ import annotations

import json
import logging

log = logging.getLogger(__name__)

#: 도메인 → (application 모듈, 스레드 조회, 상태 setter 이름)
_SPEC = {
    "github": ("domains.services.github.application.scanner",
               "github_report_thread_get", "github_report_thread_set_status"),
    "confluence": ("domains.services.confluence.application.reporter",
                   "confluence_report_thread_get", "confluence_report_thread_set_status"),
    "dev_web": ("service.agents.dev_web_report_agent",
                "dev_web_report_thread_get", "dev_web_report_thread_set_status"),
}


def rebuild_body(domain: str, thread_id: int) -> bool:
    """이 스레드의 저장 본문을 다시 만든다. 나갔으면 False(건드리지 않음)."""
    from importlib import import_module

    from service import state_domain as state

    spec = _SPEC.get(str(domain or "").lower())
    if spec is None:
        return False
    module_path, getter_name, setter_name = spec

    try:
        thread = getattr(state, getter_name)(int(thread_id))
        if not thread:
            return False

        # ★ 나간 적 있으면 손대지 않는다.
        if state.thread_sent_notice_count(domain, int(thread_id)) > 0:
            return False
        if thread.get("notified_at"):
            return False

        app = import_module(module_path)
        builder = getattr(app, "build_report_for_thread", None)
        if builder is None:
            return False
        report = builder(dict(thread))
        html = report.get("html")
        if not html:
            return False

        # ★ 상태는 **지금 것 그대로**. 재생성이 큐 자리를 옮기면 안 된다.
        getattr(state, setter_name)(
            int(thread_id),
            str(thread.get("status") or "report_ready"),
            report_json=json.dumps(
                {k: v for k, v in report.items() if k != "html"},
                ensure_ascii=False, sort_keys=True,
            ),
            report_html=html,
            last_reason="본문 재생성(문안 수정 반영)",
        )
        return True
    except Exception:  # noqa: BLE001 — 한 건 실패가 전체를 죽이지 않는다
        log.warning("[%s] 본문 재생성 실패 thread=%s", domain, thread_id, exc_info=True)
        return False


def rebuild_stale_bodies(domain: str, *, patterns: tuple[str, ...], limit: int = 500) -> dict:
    """옛 문구가 남은 **안 나간** 스레드의 본문을 다시 만든다."""
    from service import state_domain as state

    table = {"github": "github_report_thread",
             "confluence": "confluence_report_thread",
             "dev_web": "dev_web_report_thread"}.get(str(domain or "").lower())
    if table is None:
        return {"seen": 0, "rebuilt": 0, "skipped_sent": 0}

    where = " OR ".join("report_html LIKE ?" for _ in patterns)
    with state.connect() as c:
        rows = [int(r["id"]) for r in c.execute(
            f"SELECT id FROM {table} WHERE ({where}) ORDER BY id LIMIT ?",
            [*(f"%{p}%" for p in patterns), int(limit)],
        )]

    rebuilt = skipped = 0
    for tid in rows:
        if rebuild_body(domain, tid):
            rebuilt += 1
        else:
            skipped += 1
    log.info("[%s] 본문 재생성 %s건 (대상 %s · 건너뜀 %s)", domain, rebuilt, len(rows), skipped)
    return {"seen": len(rows), "rebuilt": rebuilt, "skipped_sent": skipped}
