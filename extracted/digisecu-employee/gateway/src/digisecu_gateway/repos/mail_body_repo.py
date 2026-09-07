"""발송 요청 본문 — 담당자에게 나간 메일의 **요청 시점** 본문.

## ★ 이건 "발송본" 이 아니다

저장값은 워커가 `deliver()` 에 넘긴 payload 라 egress redact **이전**이다. 실제로 나간
(마스킹 후) 본문은 **DB 어디에도 없다** — `mail_message.body_html`·`body_excerpt` 도,
`*_report_thread.report_html` 도 전부 deliver 호출 전 로컬 body 다(2026-08-24 확인).

그래서 여기서 `masking.redact()` 를 **다시** 건다. 사용자 결정(2026-08-25):
"마스킹한 값으로 메일 화면을 띄우면 될 것 같은데."

결과는 실제 나간 메일보다 **더** 가려진 값이다(`redact` 는 과마스킹 우선). 화면 라벨이
"발송본" 이 아니라 **"발송 요청 본문"** 인 이유다 — 1,639 대 1 사건과 같은 종류의
거짓말을 여기서 또 만들지 않는다.

## redact 가 잡는 것과 못 잡는 것

잡는다: 주민번호·SSN·`password=`/`token=` 류·크리덴셜 URL·AWS 키·이메일·카드번호·고엔트로피 토큰.
못 잡는다: **공정 데이터**(`{"prc":"KIYO-…","가동률":79.0}`). 시크릿 패턴이 아니다.
  → 다만 그건 콘솔 발견 요약·hit preview 에 이미 나와 있어 **새로 생기는 경계가 아니다.**
    (2026-08-24 저쪽 세션이 dev_web 메일 본문에서 그걸 찾아 `a8a08aa` 로 생성 시점을 고쳤다.
     기존 저장분은 그대로다.)

## 순서가 중요하다

**마스킹 → 절단.** 반대로 하면 토큰이 detector 임계 밑으로 짧아져 누수한다
(`masking.py` 모듈 주석이 같은 규칙을 박아뒀다).

## `state` — 나간 것인가 아닌가 (2026-08-27)

실측: 4도메인 중 **smb 만** 발송 전 본문이 없었다. 나머지 셋은 리포트 생성 시점에
`report_html`/`report_json` 을 남겨 발송 전에도 보인다(github 3/3·confluence 13/13·
dev_web 79/79). smb 는 `report_mail_agent` 가 `delivery_mode == "sent"` 일 때만
`mail_message_add` 를 불러서 `mail_message` 가 0행이었다.

이제 smb 도 안 나간 본문을 `agent_verdict='draft:<사유>'` 로 남긴다. 그래서 이 응답은
**초안과 발송본을 구분해야 한다** —

    state="sent"     실제로 나갔다 (smb 만 판정 가능)
    state="draft"    본문은 있는데 안 나갔다. `stateDetail` 에 게이트 사유
    state="unknown"  판정 불가 — 나머지 3도메인은 이게 **정상**이다.
                     그 본문은 리포트 생성 시점 산출물이라 발송 여부와 무관하다.
                     발송 판정은 `SourceItem.deliveryEvidence` 축이 답한다.

⚠️ `unknown` 을 "안 나갔다" 로 그리면 안 된다. 못 판정하는 것과 안 나간 것은 다르다.
"""
from __future__ import annotations

import json

from ..db import ReadOnlyPool
from ..domains import DOMAIN_TABLES, report_col
from ..masking import redact
from ..models import MailBody

#: 본문 상한(마스킹 **후** 절단). 메일 HTML 은 수십 KB 가 되고 브라우저 iframe 에 통째로
#: 넣으면 티켓 화면이 무거워진다. 자르면 `truncated` 로 **자른 것을 말한다**.
BODY_CAP = 200_000

#: smb 만 본문이 별도 테이블(`mail_message`)에 있다. 나머지 셋은 스레드 테이블 안이다.
_SMB_TABLE = "mail_message"

_readable: dict[str, bool] = {}


def reset_probe() -> None:
    _readable.clear()


def _probe(pool: ReadOnlyPool, table: str) -> bool:
    """읽을 수 있는가. ★ 못 읽는 것을 "본문 없음" 으로 그리면 거짓말이다."""
    if table not in _readable:
        try:
            pool.fetch_one(f"SELECT 1 AS ok FROM {table} LIMIT 1")
            _readable[table] = True
        except Exception:  # noqa: BLE001 — 42501(미부여)·42P01(미생성)
            _readable[table] = False
    return _readable[table]


def _clip(text: str | None) -> tuple[str | None, bool]:
    """마스킹은 호출부가 이미 했다고 가정하고 **자르기만** 한다."""
    if not text:
        return None, False
    if len(text) <= BODY_CAP:
        return text, False
    return text[:BODY_CAP], True


def mail_body(pool: ReadOnlyPool, *, domain: str, thread_id: int) -> MailBody:
    """스레드 1건의 발송 요청 본문(재마스킹).

    smb → `mail_message`(발송본 우선, 없으면 최신 초안) · 나머지 → `*_report_thread.report_html`.
    """
    dom = str(domain or "").lower()
    spec = DOMAIN_TABLES.get(dom)
    if spec is None:
        return MailBody(domain=dom, threadId=thread_id, access="unavailable")

    if dom == "smb":
        return _smb_body(pool, thread_id)
    return _thread_body(pool, dom, spec.report_thread_table, thread_id)


def _smb_body(pool: ReadOnlyPool, thread_id: int) -> MailBody:
    if not _probe(pool, _SMB_TABLE):
        return MailBody(domain="smb", threadId=thread_id, access="denied")

    # ★ **발송본을 먼저** 고른다. 한 스레드에 초안과 발송본이 같이 있을 수 있고
    #   (초안 → 게이트 통과 → 발송), 그때 최신순으로만 고르면 초안이 이길 수 있다.
    #   실제로 나간 것이 있으면 그것이 답이다.
    rows = pool.fetch_all(
        "SELECT subject, mail_to, mail_cc, body_html, body_excerpt, received_at, "
        "agent_verdict "
        f"FROM {_SMB_TABLE} WHERE thread_id = %s AND direction = 'out' "
        "ORDER BY (agent_verdict = 'sent') DESC, received_at DESC NULLS LAST, id DESC "
        "LIMIT 1",
        [int(thread_id)],
    )
    if not rows:
        # ★ 발송 기록이 없으면 **스레드에 저장된 초안**을 본다.
        #   `mail_thread.report_json` 은 2026-08-29 에 생겼는데 이 읽기 경로가 안 붙어
        #   있었다(열도 있고 `REPORT_HAS_JSON` 에도 들어 있는데 아무도 안 읽는다).
        #   그래서 발송 전 smb 티켓은 콘솔에서 본문이 빈 칸이었고, 화면은 본문이 있을
        #   때만 "메일 준비됨"·발송 버튼을 그리므로 **발송할 방법 자체가 없었다**
        #   (2026-08-31 실측: W36 draft 22건 전부).
        return _smb_draft_body(pool, thread_id)
    r = rows[0]

    # ★ 마스킹 먼저, 절단은 그 다음.
    raw = r.get("body_html") or r.get("body_excerpt")
    body, truncated = _clip(redact(str(raw)) if raw else None)
    verdict = str(r.get("agent_verdict") or "")
    if verdict == "sent":
        state, detail = "sent", None
    elif verdict.startswith("draft:"):
        # `draft:dry_run` → 게이트가 막았다 / `draft:unknown` → deliver 결과를 못 읽었다.
        state, detail = "draft", verdict.split(":", 1)[1] or None
    else:
        state, detail = "unknown", None

    return MailBody(
        domain="smb",
        threadId=thread_id,
        access="ok",
        state=state,
        stateDetail=detail,
        hasBody=bool(body),
        subject=redact(str(r["subject"])) if r.get("subject") else None,
        # 수신자는 담당자 메일이라 마스킹하지 않는다 — 화면이 이미 담당자를 이름·부서로
        # 그리고 있고(SourceItem.assignee), 여기서만 가리면 두 화면이 어긋난다.
        mailTo=str(r["mail_to"]) if r.get("mail_to") else None,
        mailCc=str(r["mail_cc"]) if r.get("mail_cc") else None,
        sentAt=_num(r.get("received_at")),
        isHtml=bool(r.get("body_html")),
        body=body,
        truncated=truncated,
    )


def _smb_draft_body(pool: ReadOnlyPool, thread_id: int) -> MailBody:
    """발송 기록이 없을 때 — `mail_thread.report_json` 의 초안 본문.

    ⚠️ `report_json` 은 JSON **문자열**이다. 통째로 내려보내면 화면에 원시 JSON 이
       그려진다. 안의 `html` 을 꺼내 쓴다.
    """
    rows = pool.fetch_all(
        "SELECT report_json, subject_tag, recipient FROM mail_thread WHERE id = %s",
        [int(thread_id)],
    )
    if not rows or not rows[0].get("report_json"):
        return MailBody(domain="smb", threadId=thread_id, access="ok", hasBody=False)
    r = rows[0]
    try:
        draft = json.loads(str(r["report_json"]))
    except (TypeError, ValueError):
        draft = {}
    raw = draft.get("html") or draft.get("plain_summary")
    body, truncated = _clip(redact(str(raw)) if raw else None)
    return MailBody(
        domain="smb",
        threadId=thread_id,
        access="ok",
        # ★ 초안은 초안이라고 말한다. "발송됨" 으로 그리면 이 저장소가 반복해서 만든
        #   거짓말이 된다.
        state="draft",
        stateDetail="발송 전 초안",
        hasBody=bool(body),
        subject=redact(str(r["subject_tag"])) if r.get("subject_tag") else None,
        mailTo=str(r["recipient"]) if r.get("recipient") else None,
        isHtml=bool(draft.get("html")),
        body=body,
        truncated=truncated,
    )


def _thread_body(pool: ReadOnlyPool, domain: str, table: str, thread_id: int) -> MailBody:
    # ⚠️ `report_col` 은 **아는 컬럼만** 받는다(내부 dict 를 `[col]` 로 조회 → 모르면 KeyError).
    #    `subject_tag`·`recipient` 는 4도메인 공통이라 애초에 거칠 필요가 없다.
    #    처음에 그걸 통과시켰다가 github 에서 500 이 났다 — 게이트웨이 테스트는 이 라우트를
    #    github 으로 부르지 않아 못 잡았고, 라이브 호출에서 드러났다.
    html_expr = report_col(table, "report_html", "text")
    json_expr = report_col(table, "report_json", "text")
    notified_expr = report_col(table, "notified_at", "double precision")
    rows = pool.fetch_all(
        f"SELECT {html_expr} AS report_html, {json_expr} AS report_json, "
        f"t.subject_tag AS subject_tag, t.recipient AS recipient, "
        f"{notified_expr} AS notified_at "
        f"FROM {table} t WHERE t.id = %s",
        [int(thread_id)],
    )
    if not rows:
        return MailBody(domain=domain, threadId=thread_id, access="ok", hasBody=False)
    r = rows[0]

    html = r.get("report_html")
    raw = html or r.get("report_json")
    body, truncated = _clip(redact(str(raw)) if raw else None)
    return MailBody(
        domain=domain,
        threadId=thread_id,
        access="ok",
        # ★ 이 셋은 **리포트 생성 시점** 본문이다 — 발송 여부와 무관하므로 판정하지 않는다.
        #   `notified_at` 이 있다고 이 본문이 그때 나간 그 본문이라는 보장도 없다.
        state="unknown",
        hasBody=bool(body),
        subject=redact(str(r["subject_tag"])) if r.get("subject_tag") else None,
        mailTo=str(r["recipient"]) if r.get("recipient") else None,
        sentAt=_num(r.get("notified_at")),
        isHtml=bool(html),
        body=body,
        truncated=truncated,
    )


def _num(v: object) -> float | None:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
