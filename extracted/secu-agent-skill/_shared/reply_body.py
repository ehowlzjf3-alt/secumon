"""회신 본문 조립 — **LLM 이 답을 쓰고, 템플릿은 갖다 쓴다.** 4도메인 한 벌.

## 왜 (2026-08-31 사용자 지시)

> "지금 메일 답장 양식이 너무 정해져있나본데? 폴더 위치를 물었는데 답변은 그냥
>  조치방법 답변이라 이상하잖아."
> "본문을 LLM 이 쓰고 템플릿을 갖다쓸수 있게하자 어때"

지금(2026-08-31 이전) 구조는 `reply_kind` 세 개 중 하나를 고르는 것이었다 —
`not_fixed` / `how_to` / `confirmed`. 담당자가 무엇을 묻든 셋 중 하나로 떨어진다.
"어느 폴더인가요?" 에 대한 답이 **없어서** `how_to`(조치방법 안내)가 나갔다.

뒤집는다:

    이전   양식을 고른다 → 양식이 문장을 정한다
    이후   LLM 이 문장을 쓴다 → 필요하면 검증된 블록을 **덧붙인다**

## 무엇이 LLM 것이고 무엇이 아닌가

    LLM 이 쓴다      `answer` — 담당자 질문에 대한 답. 이 티켓의 사실에 근거해야 한다.
    코드가 고정한다  인사·서명·회신요청·발신 주체. 사람이 검수한 문장이다.
    블록으로 고른다  절차 안내(OS별 권한 변경 등). **검증된 문구**라 LLM 이
                     새로 지어내면 안 되는 것들.

⚠️ 블록은 LLM 이 **고르기만** 한다. 내용을 쓰지 못한다 — 그게 블록인 이유다.
   틀린 절차를 그럴듯하게 지어내는 것이 이 도메인에서 가장 비싼 실수다.
"""
from __future__ import annotations

import re

from dataclasses import dataclass
from html import escape
from typing import Any

#: ★ 문단 사이는 **한 줄 비운다**(사용자 요청 2026-09-01 "문단 사이에 엔터 두 번 해").
#:   `<p>` 만 쓰면 클라이언트 기본 여백에 맡기게 되는데, Knox 메일에서 촘촘하게 붙어
#:   읽기 어려웠다. 여백을 본문 셸에서 **명시**한다 — 클라이언트마다 다르게 보이면 안 된다.
_SHELL_STYLE = (
    "font-family:'Malgun Gothic',sans-serif;line-height:1.7"
)
#: 문단 자체의 아래 여백. 한 줄(≈1.7em) 만큼 띄운다.
_PARA_STYLE = "margin:0 0 1.15em"


def numbered_lines(title: str, items: tuple[str, ...] | list[str]) -> str:
    """제목 + 번호 목록을 **한 줄에 하나씩** 낸다.

    ★ 사용자 지시(2026-08-31): "템플릿 쓸 때는 꼭 줄바꿈으로 한 줄씩 넣고".
      `<ol><li>` 는 메일 클라이언트에 따라 여백·번호가 뭉개진다. 번호를 텍스트로 박고
      `<div>` 로 줄을 나누면 어디서 열어도 한 줄에 하나로 보인다.
    """
    from html import escape as _e

    rows = "".join(
        f'<div style="margin:3px 0">{i}. {_e(str(x))}</div>'
        for i, x in enumerate(items, 1)
    )
    # ★ 절차 안내는 **본문과 분리해 보이게** 카드에 넣는다(사용자 요청 2026-09-01:
    #   "처음에 발송되는 메일처럼 박스나 표에 넣어서 … 본문이랑 분류되는 느낌으로").
    #   최초 조치요청 메일의 `.info-card` 와 같은 결이다 — 회신에는 <style> 을 못 쓰므로
    #   (일부 클라이언트가 <head> 밖 style 을 버린다) 인라인으로 같은 모양을 낸다.
    return (
        '<div style="background:#f2f7fb;border-left:4px solid #3182ce;'
        'border-radius:0 8px 8px 0;padding:14px 18px;margin:18px 0">'
        f'<div style="font-weight:700;margin:0 0 8px">{_e(title)}</div>'
        f'{rows}'
        "</div>"
    )


@dataclass(frozen=True, slots=True)
class ReplyBlock:
    """덧붙일 수 있는 검증된 문단.

    name: LLM 이 고를 때 쓰는 이름.
    purpose: 언제 쓰는 블록인지 한 줄. **프롬프트에 실린다** — 여기가 부정확하면
        LLM 이 엉뚱한 블록을 고른다.
    domains: 이 블록을 쓸 수 있는 도메인. 빈 값이면 전 도메인 공용.
    """

    name: str
    purpose: str
    html: str
    domains: tuple[str, ...] = ()
    #: 이 블록이 **이미 회신 요청 문장을 담고 있는가.**
    #: True 면 껍데기가 자기 회신요청을 넣지 않는다 — 안 그러면 같은 부탁이
    #: 두 번 나간다(github 블록의 마지막 단계가 그렇다, 실측 2026-08-31).
    includes_reply_request: bool = False


_BLOCKS: dict[str, ReplyBlock] = {}


def register_reply_block(block: ReplyBlock) -> None:
    """멱등 등록 — 어댑터 등록과 같은 시맨틱(같은 이름 재등록은 no-op)."""
    if block.name in _BLOCKS:
        return
    _BLOCKS[block.name] = block


def reply_blocks(domain: str | None = None) -> list[ReplyBlock]:
    """이 도메인이 쓸 수 있는 블록. 도메인 전용이 먼저, 공용이 뒤."""
    d = str(domain or "")
    own = [b for b in _BLOCKS.values() if d and d in b.domains]
    shared = [b for b in _BLOCKS.values() if not b.domains]
    return sorted(own, key=lambda b: b.name) + sorted(shared, key=lambda b: b.name)


def block_menu(domain: str | None = None) -> str:
    """프롬프트에 실을 블록 목록. 이름과 용도만 — 본문은 싣지 않는다."""
    rows = reply_blocks(domain)
    if not rows:
        return "(이 도메인에 등록된 블록 없음)"
    return "\n".join(f"  · {b.name} — {b.purpose}" for b in rows)


#: LLM 이 답변 첫머리에 다시 붙이는 인사. 코드가 이미 `{이름}님,` 을 넣으므로 중복된다.
#: 실측 2026-09-01: **`성예찬님, 성예찬님, 안녕하세요.`** 가 그대로 나갔다.
_GREETING_RE = re.compile(
    r"^\s*(?:[가-힣A-Za-z .]{1,20}(?:님|씨|책임|수석|프로)\s*,?\s*)?"
    r"(?:안녕하세요[.,!]?\s*)?(?:[가-힣A-Za-z .]{1,20}(?:님|씨)\s*,?\s*)?"
)


def _strip_duplicate_greeting(text: str, owner_name: str) -> str:
    """답변 첫머리의 인사를 걷어낸다 — 인사는 **코드가 한 번만** 넣는다.

    ⚠️ 이름이 들어간 인사만 건드린다. 본문 첫 문장이 그냥 설명이면 손대지 않는다.
    """
    body = str(text or "").lstrip()
    name = re.sub(r"(님|씨)$", "", str(owner_name or "").strip())
    if not body:
        return body
    head = body[:60]
    if name and name in head:
        m = _GREETING_RE.match(body)
        if m and m.end() and name in body[:m.end()]:
            return body[m.end():].lstrip()
    if head.startswith("안녕하세요"):
        m = re.match(r"^안녕하세요[.,!]?\s*", body)
        if m:
            return body[m.end():].lstrip()
    return body

#: 공감·위로 상투구. 사용자 결정 2026-09-01: **담백하게.**
#: 프롬프트에도 넣었지만 부탁은 언젠가 깨진다 — 문장째로 걷어낸다.
_EMPATHY_RE = re.compile(
    r"[^.\n]*?(?:어려움이 (?:있으셨|많으셨)|당황하셨|번거로우셨|불편을 드려|"
    r"혼란을 드려|염려하셨)[^.\n]*\.\s*"
)


def _strip_empathy(text: str) -> str:
    """공감형 상투구를 뺀다 — 사실만 남긴다.

    ⚠️ 문장 단위로만 지운다. 사실이 든 문장은 건드리지 않는다.
    """
    out = _EMPATHY_RE.sub("", str(text or ""))
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _paragraphs(text: str) -> str:
    """LLM 이 쓴 평문 → HTML 문단.

    ⚠️ **반드시 escape 한다.** LLM 이 쓴 문자열이 그대로 메일 HTML 에 들어간다 —
       마크업을 통과시키면 본문 구조를 LLM 이 바꿀 수 있다.
    """
    out: list[str] = []
    for para in str(text or "").replace("\r\n", "\n").split("\n\n"):
        para = para.strip()
        if not para:
            continue
        out.append(
            f'<p style="{_PARA_STYLE}">' + escape(para).replace("\n", "<br/>") + "</p>"
        )
    return "\n".join(out)


def render_reply(
    *,
    domain: str,
    answer: str,
    owner_name: str = "담당자",
    blocks: tuple[str, ...] | list[str] = (),
    ticket_no: str | None = None,
    include_reply_request: bool = True,
) -> dict[str, Any]:
    """회신 본문을 조립한다.

    돌려주는 것: `{"html", "blocks_used", "blocks_unknown"}`.

    ⚠️ 모르는 블록 이름은 **조용히 버리지 않는다** — `blocks_unknown` 으로 돌려준다.
       LLM 이 없는 블록을 골랐다는 사실은 호출부가 알아야 한다(재시도 근거).
    """
    known = {b.name: b for b in reply_blocks(domain)}
    used: list[str] = []
    unknown: list[str] = []
    chosen: list[str] = []
    for name in blocks or ():
        b = known.get(str(name))
        if b is None:
            unknown.append(str(name))
            continue
        if b.name in used:
            continue
        used.append(b.name)
        chosen.append(b.html)

    from _shared.mail_subject import address_name

    # ★ 호칭은 한 번만. 이름이 이미 `김명규님` 으로 올 수 있다 — 실제로 `김명규님님,` 이
    #   나갔다(2026-09-01). 규칙을 네 곳에 두면 한 곳만 고쳐진다.
    parts = [
        f'<p style="{_PARA_STYLE}">{escape(address_name(owner_name))},</p>',
        _paragraphs(_strip_empathy(_strip_duplicate_greeting(answer, owner_name))),
    ]
    parts.extend(chosen)
    if any(known[n].includes_reply_request for n in used):
        include_reply_request = False
    if include_reply_request:
        parts.append(
            "<p>조치 또는 확인이 끝나면 <b>본 메일에 회신</b>해 주시면 "
            "DS보안관제에서 다시 확인하겠습니다.</p>"
        )
    sig = "감사합니다.<br/>삼성전자 DS 정보보호센터 · DS보안관제"
    if ticket_no:
        # ★ 티켓 번호를 본문에도 남긴다 — 담당자가 제목을 고쳐 답장해도 매칭된다.
        sig += f'<br/><span style="color:#888;font-size:12px">티켓 {escape(ticket_no)}</span>'
    parts.append(f"<p>{sig}</p>")

    return {
        "html": f'<div style="{_SHELL_STYLE}">\n' + "\n".join(p for p in parts if p) + "\n</div>",
        "blocks_used": used,
        "blocks_unknown": unknown,
    }
