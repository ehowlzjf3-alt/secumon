"""스레드 어댑터 — 조치요청/재검증을 **한 몸**으로, 4도메인 **한 벌**로.

## 무엇을 없애는가 (실측 2026-08-26)

지금 스레드 계층은 파이썬 16파일 2,565줄 · 스킬 8벌 496줄이다. 그런데 도메인 이름만
정규화하고 diff 하면:

    github_report_agent   vs confluence_report_agent    203줄 중 24줄 차이
    github_recheck_agent  vs confluence_recheck_agent   184줄 중 23줄 차이

그 24줄이 전부 줄바꿈 포맷과 `repo`/`space` 라벨이다. **실질 로직 차이 0** —
함수 이름은 물론 줄 번호까지 같다(`_handle_thread` 양쪽 75행). 복붙 쌍둥이다.
그래서 "github·confluence 에 각각 LLM 을 붙인다" 는 쌍둥이를 네 벌로 늘리는 일이었다.

dev_web/smb 쪽은 함수 골격이 같고(`_tool_classes`/`_build_user_text`/`_deliver_call`/
`_delivery_mode`/`_mail_body_for_thread`) 살이 갈렸다 — 통합 가능하나 품이 더 든다.

## 왜 report 와 recheck 를 나누지 않는가

**둘은 별개 큐가 아니라 한 테이블의 두 단계다.**

    github/confluence_report_thread (상태 15종)
      draft → reported ─────────→ report_ready → awaiting_owner
                                                      ↓
              recheck_requested → rechecking → remediated / still_open / …

      report 워커가 claim:   reported
      recheck 워커가 claim:  recheck_requested        ← 같은 테이블

    mail_thread (smb) 도 같다: report=reported, reply_verify=reply_received

나누면 **한 테이블에 소유자가 둘**이 된다 — 2026-08-26 에 태스크 큐에서 없앤 그 모양이다.
검토원도 나눌 필요가 없다. 세션이 있으면 리드가 질문을 다르게 던지면 된다:

    ask_inspector(s1, "이 repo 의 finding 경로가 아직 HEAD 에 살아 있어?")   ← recheck
    ask_inspector(s1, "담당자에게 보낼 설명을 써줘")                          ← report

파이프라인 단계마다 워커를 하나씩 두는 건 평면 사고방식의 산물이다.

## 계약

`LeadAdapter` 와 같은 결이다 — **이름·스키마는 고정, 큐 배관만 도메인이 채운다**.
사용자 원칙 ②(각 도메인의 구현방법은 동일해야 한다).

⚠️ 도메인별로 표면이 균질하지 않다(실측):

    finding_ids            github·confluence·smb 있음 / dev_web 없음(thread.finding_id 단수)
    schedule_recheck_retry github·confluence 있음 / dev_web·smb 다른 이름
    inbound 매칭           smb(mail_thread)만 — POP3 답장 대조

없는 것은 **없다고 말한다**(`None` 을 돌려주는 슬롯). 조용한 no-op 금지 —
`LeadAdapter.run_verb` 가 `unsupported(...)` 를 요구하는 것과 같은 이유다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True, slots=True)
class ThreadAdapter:
    """도메인 하나의 스레드 큐 배관 (조치요청 + 재검증).

    domain: `<domain>_thread` task_type 의 접두어이자 어댑터 조회 키.
    queue_label: 프롬프트·오류 메시지에 쓰는 사람이 읽을 큐 이름.
    statuses: 이 큐의 **닫힌** 상태 어휘. 정본을 참조하고 **복사하지 마라** —
        2026-08-21 에 smb 상태 복사본이 실제 DB 와 달라 조용히 틀린 적이 있다.
    """

    domain: str
    queue_label: str
    statuses: tuple[str, ...]

    # ── 큐 읽기 ──────────────────────────────────────────────────────
    # 상태별 스레드 목록. **본문 없음** — 좌표·상태·카운트만(리드 규격과 같다).
    list_threads: Callable[..., list[dict[str, Any]]]
    thread_get: Callable[[int], dict[str, Any] | None]
    # 이 스레드가 가리키는 finding id 들. dev_web 은 단수라 어댑터가 리스트로 감싼다.
    finding_ids: Callable[[dict[str, Any]], list[int]]

    # ── 큐 쓰기 ──────────────────────────────────────────────────────
    claim_next: Callable[..., dict[str, Any] | None]
    set_status: Callable[..., None]
    bump_attempt: Callable[..., None]
    reclaim_stale: Callable[[], Any]
    # 재시도 예약. 도메인마다 이름이 다르다(`schedule_recheck_retry` /
    # `schedule_communication_retry`) — 어댑터가 그 차이를 흡수한다.
    schedule_retry: Callable[..., float | None]

    # ── 조치요청 ─────────────────────────────────────────────────────
    # 스레드 하나를 처리한다(만들기 + 배달 + 사후 기록). async.
    # ⚠️ 이미 claim 된 스레드를 받는다 — 어댑터가 claim 하지 않는다.
    deliver_report: Callable[..., Any]

    # ── 선택 슬롯 — 없으면 **없다고 말한다** ─────────────────────────
    # thread → {subject, html, recipients, cc, finding_count, deliver_hint}
    # ⚠️ **여기서 배달하지 않는다.** 만들기만 하고, 보낼지는 위층이 정한다.
    #
    # ★ 2026-08-31 실측 — 넷 중 둘만 있다. 계약을 필수로 두면 없는 도메인이
    #   거짓 래퍼를 끼워 넣게 된다(그게 이 계약이 없애려던 바로 그 모양이다):
    #
    #     github / confluence   application 층에 `build_report_for_thread` 가 있다.
    #                           만들기와 배달이 이미 갈려 있다.
    #     smb / dev_web         LLM 워커 **한 런**이 도구로 만들고 그 안에서
    #                           `deliver` 종료도구를 부른다. 쪼갤 수 없다.
    #
    #   → 융합된 도메인은 `None` 이다. `supports_build()` 로 물어라.
    build_report: Callable[..., dict[str, Any]] | None = None

    # ── 재검증 ───────────────────────────────────────────────────────
    # thread → {final_status, results[]}. 라이브 재조회를 한다(읽기 전용).
    recheck: Callable[..., dict[str, Any]] | None = None
    deliver_recheck: Callable[..., Any] | None = None

    # 이 큐를 도는 파이프라인 컴포넌트 이름 — `control_flag` 의 키다.
    #
    # ★ 4도메인이 제각각이다(실측 2026-08-31): `mail` · `github.report` ·
    #   `confluence.report` · `dev_web_report`. 이름을 통일하면 이미 사람이 켜고 끄던
    #   플래그가 다른 행을 가리키게 되므로 **바꾸지 않고 계약이 흡수한다.**
    #   ⚠️ 각 도메인 `application/contracts.py` 의 상수를 **참조**하라 — 복사하면 갈린다.
    report_component: str | None = None
    recheck_component: str | None = None

    # 이 스레드의 재검증 기록(최신 우선). "실제로 다시 확인했는가" 의 유일한 근거다.
    #
    # ★ 2026-08-31 — 회신 본문이 "재점검한 결과" 라고 말하는데 기록이 없는 일이
    #   두 번 있었다(smb 실측). 워커가 재검증 도구를 건너뛰고 바로 회신을 만들면,
    #   조립기가 **저장된 지난 스캔 결과로 폴백**해 표를 채운다. 담당자에게는
    #   "방금 확인했다" 로 읽힌다 — 하지 않은 검증을 했다고 말하는 것이다.
    #   프롬프트로 부탁할 일이 아니라 코드가 막아야 한다(`_shared/reply_guard`).
    recheck_records: Callable[[int], list[dict[str, Any]]] | None = None

    # ── 회신 ─────────────────────────────────────────────────────────
    # 조치요청 메일 수신처. 정책 정본은 `service/services/owner_recipients.
    # delivery_targets` 한 곳이고, 도메인 래퍼가 env 이름만 다르게 넘긴다.
    # 반환: {"recipients": [...], "cc": [...], "mode": normal|no_owner|dry_run}
    delivery_targets: Callable[..., dict[str, Any]] | None = None
    # 회신 봉투 — 제목·수신처·인용문. thread → {subject, recipients, cc, quote_html}
    #
    # ★ 넷이 같지 않다(실측 2026-08-31). smb 만 수신 메일을 갖고 있어서
    #   **reply-all + RE 카운트 + 원문 인용**을 할 수 있다(POP3 대조). 나머지 셋은
    #   받은 메일이 없으니 스레드에 적힌 담당자에게 새로 보낸다.
    #   없으면 `_shared/reply_envelope.default_reply_envelope` 가 대신한다 —
    #   그래서 회신 도구는 도메인 분기를 하지 않는다.
    reply_envelope: Callable[..., dict[str, Any]] | None = None

    # ── 선택 표면 ────────────────────────────────────────────────────
    # 스레드 큐를 채우는 동기화(github/confluence 는 claim 전에 돈다).
    sync_threads: Callable[[], Any] | None = None
    # 아직 볼 게 남은 상태들. `LeadAdapter.claimable_statuses` 와 같은 계약 —
    # 상태를 러너가 통일하면 도메인 하나가 조용히 idle 이 된다(2026-08-26 실측).
    claimable_statuses: tuple[str, ...] = ()
    # 도메인 전용 메모(프롬프트에 실린다). 예: smb 의 POP3 답장 대조.
    notes: dict[str, str] = field(default_factory=dict)

    def supports_recheck(self) -> bool:
        """재검증을 **실행**할 수 있는가. 없으면 없다고 말한다 — 조용한 no-op 금지.

        ⚠️ 2026-08-31 정정: 예전엔 `recheck and deliver_recheck` 둘 다를 요구했다.
           그러면 smb·dev_web 이 영원히 False 다 — 둘은 재조회와 사후기록이 LLM
           한 런에 융합돼 있어 `recheck` 를 따로 못 준다. **할 수 있는데 없다고
           말하는** 건 계약이 틀린 것이다. 실행 가능성은 `deliver_recheck` 가 정한다.
        """
        return self.deliver_recheck is not None

    def supports_recheck_preview(self) -> bool:
        """배달 **없이** 재검증 결과만 볼 수 있는가(github·confluence 만).

        `supports_build()` 와 같은 구조다 — 융합 도메인은 미리보기가 없다.
        """
        return self.recheck is not None

    def supports_build(self) -> bool:
        """배달과 **따로** 본문을 만들 수 있는가.

        False 면 만들기가 배달 안에 융합돼 있다(smb·dev_web 의 LLM 한 런).
        미리보기·초안 검토 같은 기능은 이 값을 보고 **가능한 도메인에서만** 켜라.
        """
        return self.build_report is not None

    def ticket_no(self, thread_id: int) -> str:
        """이 스레드의 티켓 번호 — `SMB00024` · `GH00137` · `CF00019` · `DW00045`.

        회신 매칭의 1차 키다. 제목 태그 파싱의 취약함은 `_shared/ticket_id` 참조.
        """
        import service.state_domain as state

        # ★ 저장값이 정본이다. 없으면 그 자리에서 만들어 저장한다(멱등).
        #   공식으로만 계산하면 접두 규칙이 바뀌었을 때 이미 나간 번호와 갈린다.
        stored = state.thread_ensure_ticket_no(self.domain, int(thread_id))
        if stored:
            return stored
        from _shared.ticket_id import ticket_no

        return ticket_no(self.domain, thread_id)


_ADAPTERS: dict[str, ThreadAdapter] = {}


def register_thread_adapter(adapter: ThreadAdapter) -> None:
    """멱등 등록 — 같은 이름 재등록은 덮어쓰기가 아니라 no-op.

    `plugin/bootstrap.py` 의 `_register_idempotent` 와 같은 시맨틱이라, 플러그인
    이중 로드가 있어도 조용히 다른 객체로 바뀌지 않는다.
    """
    if adapter.domain in _ADAPTERS:
        return
    _ADAPTERS[adapter.domain] = adapter


def unregister_thread_adapter(domain: str) -> bool:
    return _ADAPTERS.pop(domain, None) is not None


def get_thread_adapter(domain: str) -> ThreadAdapter | None:
    return _ADAPTERS.get(str(domain))


def thread_adapter_names() -> tuple[str, ...]:
    return tuple(sorted(_ADAPTERS))


def _reset_for_test() -> None:
    _ADAPTERS.clear()


# ── 목록 투영 ────────────────────────────────────────────────────────
#: 목록에 **절대 싣지 않는** 열. 계약이 "본문 없음" 을 요구한다 —
#: 리드가 큐를 훑을 때 보고서 HTML 수백 KB 를 컨텍스트로 끌고 오면 안 된다.
#: ⚠️ `mail_thread.report_json` 은 2026-08-30 에 콘솔용으로 **새로 생긴** 열이다.
#:    도메인별로 본문 열 이름이 다르니 여기 한 곳에서 막는다.
_BODY_COLUMNS = frozenset({"report_json", "report_html"})


def summarize_thread_row(
    domain: str,
    row: dict[str, Any],
    *,
    coord_keys: tuple[str, ...],
) -> dict[str, Any]:
    """스레드 행 → 목록용 요약. 본문을 떨구고 티켓 번호·좌표를 붙인다.

    coord_keys: 이 도메인의 좌표 열 이름들(`("host",)` · `("repo",)` ·
        `("space_key",)` · `("domain","url")`). 넷의 이름이 다 달라서
        위층이 도메인별 분기를 하지 않도록 `coordinate` 한 칸으로 접는다.
    """
    from _shared.ticket_id import ticket_no

    out = {k: v for k, v in row.items() if k not in _BODY_COLUMNS}
    # 본문을 뺐다는 사실 자체는 남긴다 — "없다" 와 "안 실었다" 는 다르다.
    out["has_report_body"] = any(row.get(k) for k in _BODY_COLUMNS)
    out["domain"] = domain
    try:
        out["ticket_no"] = ticket_no(domain, int(row["id"]))
    except (KeyError, TypeError, ValueError):
        out["ticket_no"] = None
    parts = [str(row.get(k)) for k in coord_keys if row.get(k)]
    out["coordinate"] = " ".join(parts)
    return out
