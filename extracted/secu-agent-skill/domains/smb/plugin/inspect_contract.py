"""smb 검토원 실행계약 — task_type `smb_file_inspect` (Phase 1).

## 왜 새 이름이 아니라 `smb_file_inspect` 인가

이 이름의 **도구셋은 이미 등록돼 있다**(`plugin/bootstrap.py`, v3.23 2단 구조의 잔재).
계약과 `agents/*.md` 가 없어 도달만 불가능했을 뿐이다. 새 이름을 만들면 그 등록이
영원히 죽은 채로 남는다.

⚠️ 단 도구셋은 **오늘 워커의 것**(`smb_task_tools`)을 쓴다. 구 `smb_file_inspect_tools`
(ReadFileContentTool + ReportInspectionTool)는 파일 1개 단위 위임용이라 오늘 워커와
동등하지 않다 — Phase 1 의 게이트가 "오늘과 동등" 이므로 여기서 도구를 줄이지 않는다.
그 축소는 Phase 2 에서 리드/검토원 경계를 그을 때 측정하며 한다.

## 종료 도구

오늘 smb 워커의 terminal 은 `smb_submit_finding` **하나뿐**이라, 보고할 게 없는 워커는
종료 도구를 부를 수 없다(다른 3도메인은 set_status 가 findings 무관 필수 종료다).
그 상태를 그대로 옮긴다 — 고치는 것은 동등성 판정 뒤에.
"""
from __future__ import annotations

from typing import Any


def _user_message(spec: dict) -> str:
    from service.agents.smb_task_agent import _build_user_text

    target = spec.get("target") or {}
    host = target.get("host")
    if not host:
        raise RuntimeError("smb 검토원 spec 에 target.host 가 없다")

    # 은퇴한 평면 러너가 넘기던 host_digest 와 같은 모양으로 복원한다
    # (원본: `smb_task_agent._write_task_worker_spec`, 태그 `flat-lane-last`).
    # 러너 경로는 spec 에 `shares` 를 실어 보내지만, AgentTool 로 spawn 되면 `target`
    # 만 온다 — 그때는 DB 에서 되살린다. shares 가 비면 프롬프트의 공유 목록이 통째로
    # 사라져 오늘과 동등하지 않은 워커가 된다(조용히 빈손으로 끝난다).
    shares = spec.get("shares") or []
    if not shares:
        from service import state_domain as state
        rows = state.smb_shares_of_host(str(host)) or []
        wanted = {int(x) for x in (target.get("share_ids") or []) if x is not None}
        if target.get("share_id") is not None:
            wanted.add(int(target["share_id"]))
        shares = [r for r in rows if not wanted or int(r.get("id", -1)) in wanted]

    share_ids = target.get("share_ids") or [
        int(s["id"]) for s in shares if s.get("id") is not None
    ]
    host_digest: dict[str, Any] = {
        "host": host, "shares": shares, "share_ids": share_ids,
    }
    return _build_user_text(host_digest, charter_ref=str(spec.get("charter_ref") or ""))


def _metadata(spec: dict) -> dict[str, Any]:
    # ★ share 스코프는 **spec 에서** 온다 — hit 판정 도구가 남의 공유를 못 건드리게 하는
    #   근거이고, LLM 입력이 아니다(`hit_triage_tools._scope_share_ids`).
    return {
        "smb_host": (spec.get("target") or {}).get("host"),
        "smb_share_ids": _shares_of(spec),
    }



# ── 후처리: 큐 닫기 ──────────────────────────────────────────────────────
#
# ★ smb 는 **큐 닫기가 워커 밖에 있다.** 다른 3도메인은 워커가 `<d>_target_set_status`
# 를 종료 도구로 불러 자기 큐를 닫지만, smb 는 러너(은퇴한 `_task_one_host`)가
# `run_agent()` 가 돌아온 뒤에 `share_set_status(...)` 를 한다.
#
# 그래서 검토원 단독으로는 공유를 닫을 수 없다 — 2026-08-20 첫 실기동에서 실측됐다
# (rc=3, share 는 `walked` 인 채로 남음). 코어 계약의 `on_submit`/`on_no_submit` 이
# 정확히 이 자리라 러너 로직을 여기로 옮긴다.
#
# ⚠️ 이건 "동등하게 만드는" 작업이지 새 정책이 아니다. 러너와 같은 것을 한다:
#   - submit 없이 끝났으면 draft 노출 finding 을 만든다(저노출도 기록은 남긴다)
#   - 공유를 triaged_completed 로 닫는다
#   - 그 host 의 열린 작업이 없으면 메일 draft 를 승격한다


def _shares_of(spec: dict) -> list[int]:
    target = spec.get("target") or {}
    ids = [int(x) for x in (target.get("share_ids") or []) if x is not None]
    if not ids and target.get("share_id") is not None:
        ids = [int(target["share_id"])]
    return ids


from service.state_domain import SMB_SUBNET_GAP_RESCAN_SECONDS

#: 스캔 큐가 남은 채 닫힌 공유가 다시 잡히기까지.
#:
#: ★ 새 숫자를 만들지 않는다. 이 저장소의 "주간보다 빨리 다시" 는 **8시간**이고
#:   그 값이 이미 세 군데에 있다:
#:     SMB_SUBNET_GAP_RESCAN_SECONDS   주간 판이 끝난 서브넷의 gap 재조사
#:     SMB_COMMUNICATION_RETRY_SECONDS 통신 실패 재시도
#:     recheck/how-to 배달 실패 쿨다운(4도메인 공통, docs/domain-parity 참조)
#:   설계 주석(state_domain.py, v3.83)이 "weekly board cycle 은 cycle_swept_at 으로
#:   새판을 만들고, gap rescan 은 8h" 라고 못박고 있다. 공유 층에만 그 8시간 짝이
#:   없어서 7일을 통째로 기다렸다 — 그 비대칭을 메우는 것이지 새 정책이 아니다.
_RESCAN_SOON_SECONDS = SMB_SUBNET_GAP_RESCAN_SECONDS


def _looked_at_files(evidence_dir) -> int:
    """검토원이 **실제로 연** 파일 수. 코드가 센 값이지 자기신고가 아니다.

    `report_inspection` 이 `inspector_report.json` 의 `looked_at` 에 박아 둔다.
    보고가 없거나 못 읽으면 0 — 모르면 "봤다" 고 치지 않는다(fail-safe).
    """
    if evidence_dir is None:
        return 0
    try:
        import json as _json
        from pathlib import Path as _Path

        from _shared.inspector_report import REPORT_FILENAME

        raw = (_Path(evidence_dir) / REPORT_FILENAME).read_text(encoding="utf-8")
        return int(((_json.loads(raw) or {}).get("looked_at") or {}).get("files") or 0)
    except Exception:  # noqa: BLE001 — 못 읽으면 0
        return 0


def _close_queue(spec: dict, *, saw_submit: bool, evidence_dir=None) -> None:
    import time

    from service import state_domain as state

    from domains.smb.plugin import share_close_backstop as backstop

    from _shared.queue_ownership import is_delegated_inspector, write_recommendation

    # 큐 소유권(Phase 2): 위임된 검토원은 닫지 않는다 — 리드가 닫는다.
    # 다른 3도메인은 종료 도구 안에서 같은 가드를 탄다. smb 만 종료 도구가 아니라
    # 계약 후처리에서 닫으므로 가드도 여기 있다 — 규칙은 같다.
    if is_delegated_inspector():
        # ★ 권고는 검토원이 **실제로 한 일**을 반영해야 한다.
        #
        #   리드의 `set_target_status` 는 권고와 다르게 닫으려면 근거를 요구한다.
        #   그래서 아무것도 못 한 검토원이 "완료" 를 권고하면 리드가 그걸 따르도록
        #   압박받는다 — 그건 판단이 아니라 관성이다.
        #
        #   실측 2026-08-28: `clean` 판정 131건 중 56건(43%)이 파일을 한 번도 안 연
        #   세션이었다. 열람량은 이제 코드가 센다(`inspector_report.record_read`).
        looked = _looked_at_files(evidence_dir)
        if saw_submit:
            status, reason = "triaged_completed", "검토원 제출 있음"
        elif looked > 0:
            status, reason = "triaged_completed", f"검토원 제출 없음 (파일 {looked}건 열람)"
        else:
            # 못 본 것을 "완료" 로 권고하지 않는다. 큐에 되돌려 다음 검토원이 본다.
            status, reason = "walked", "검토원이 파일을 하나도 열지 못했다 — 판정 근거 없음"
        write_recommendation(
            evidence_dir, target_ids=_shares_of(spec),
            status=status,
            finding_count=1 if saw_submit else 0,
            reason=reason,
            queue="smb_share",
            host=(spec.get("target") or {}).get("host"),
            saw_submit=saw_submit,
            looked_at_files=looked,
        )
        return

    # ★ 백스톱 둘(노출 finding · 남은 큐 재점검)은 `share_close_backstop` 한 곳에만
    #   산다. 이 자리는 **위임이 아닌** 경로라 오늘 운영에서는 거의 안 지나간다 —
    #   같은 규칙을 리드(`lead_adapter._set_status`)도 타야 해서 모듈로 뺐다.
    for share_id in _shares_of(spec):
        extra = backstop.apply(
            share_id, "triaged_completed",
            saw_submit=saw_submit, rescan_soon_seconds=_RESCAN_SOON_SECONDS)
        try:
            state.share_set_status(
                share_id, "triaged_completed",
                hits_count=1 if (saw_submit or extra.get("_exposure_finding_id")) else 0,
                processed_at=time.time(),
                **backstop.db_fields(extra),
            )
        except Exception:  # noqa: BLE001
            pass

    host = (spec.get("target") or {}).get("host")
    if host:
        try:
            from service.agents.smb_task_agent import _task_session_id
            if state.smb_task_host_open_count(str(host), session_id=_task_session_id()) == 0:
                state.mail_thread_promote_host_drafts(str(host))
        except Exception:  # noqa: BLE001
            pass


def _on_submit(evidence_dir, spec: dict) -> int:
    _close_queue(spec, saw_submit=True, evidence_dir=evidence_dir)
    return 0


def _on_no_submit(evidence_dir, spec: dict, reason: str) -> int:
    """★ smb 의 유일한 종료 도구는 `smb_submit_finding` 이라, **깨끗한 공유는 종료 도구를
    부를 수 없다**. 러너 경로도 같은 성질이었고 러너가 대신 닫아줬다.

    그러니 '제출 없음' 자체는 실패가 아니다 — 예산 소진·계약 위반 같은 비정상 종료만
    실패로 본다. 그 판정은 코어가 `reason` 으로 준다.
    """
    _close_queue(spec, saw_submit=False, evidence_dir=evidence_dir)
    clean_end = str(reason or "").strip() in {"end_turn", "stop", ""}
    return 0 if clean_end else 3


def smb_inspect_contract():
    from _shared.inspect_contract import (
        INSPECTOR_IDLE_SEC_DEFAULT, build_inspect_contract,
    )
    from domains.smb.plugin.toolsets import smb_task_tools

    return build_inspect_contract(
        task_type="smb_file_inspect",
        skill_name="smb_task",
        tools=smb_task_tools,
        terminal_tools=frozenset({"smb_submit_finding"}),
        user_message=_user_message,
        metadata=_metadata,
        env_prefix="SMB_TASK",
        default_turns=80,
        default_wall_sec=1200,
        default_idle_sec=INSPECTOR_IDLE_SEC_DEFAULT,
        default_tokens=800_000,
        # smb_inspect_image(analyze=True) 로 이미지 문서를 읽는 흐름이 있다 → 능력 슬롯.
        vision_fallback="gemma",
        candidate_ledger_enforce=True,
        require_terminal_tool=False,
        on_submit=_on_submit,
        on_no_submit=_on_no_submit,
    )
