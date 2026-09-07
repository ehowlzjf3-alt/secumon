"""티켓 번호 — 4도메인 한 벌. 회신 매칭의 **1차 키**가 된다.

## 왜 (2026-08-31 사용자 지시)

지금 회신 매칭은 **제목 태그**로 한다. 도메인마다 모양이 다르고 src 이름이 키다:

    [GitHub 보안취약점 조치요청](RTPMS/delaylotautonomous)
    [Confluence 보안취약점 조치요청](DSCERT)
    [Dev Web 보안취약점 조치요청](site.cdep.samsungds.net)
    [보안취약점 조치요청](12.23.67.40)            ← smb 만 접두가 없다

`mail_inbound.classify_subject_tag_from_subject` 가 정규식 4개를 **순서대로** 시도하고,
코드 주석이 그 취약함을 이미 적어 뒀다 — *"접두 있는 것을 먼저 본다. SMB 정규식은
접두를 요구하지 않아서 순서가 바뀌면 다른 도메인 답장이 smb 로 잘못 분류될 수 있다."*

그 외에도:
  · src 이름에 괄호·대괄호가 들어가면 정규식이 깨진다
  · 같은 host 의 이번 주 스레드와 지난 주 스레드가 **같은 태그**다(주차 구분 없음)
  · 사람이 제목을 편집하면 못 붙는다

티켓 번호는 스레드 행 id 라 위 셋이 한 번에 없어진다.

## 형식

    SMB00024 · GH00137 · CF00019 · DW00045

⚠️ smb 는 이미 `SMB%05d` 를 쓰고 있고(`state_domain.mail_thread_ticket_no`,
   웹 화면 `display_title`) **바꾸지 않는다.** 이미 사람이 본 번호를 재발급하면
   같은 티켓이 두 번호로 불린다.
"""
from __future__ import annotations

import re

#: 도메인 → 티켓 번호 접두. ⚠️ smb 는 기존 표기(SMB)를 그대로 쓴다.
TICKET_PREFIX: dict[str, str] = {
    "smb": "SMB",
    "github": "GH",
    "confluence": "CF",
    "dev_web": "DW",
}
_BY_PREFIX = {v: k for k, v in TICKET_PREFIX.items()}

#: 조치요청 제목 태그의 **닫는 대괄호까지**. 티켓 괄호를 그 뒤에 끼운다.
#: 4도메인 태그가 전부 `…조치요청]` 로 끝난다(SMB/GitHub/Confluence/Dev Web).
_TAG_HEAD_RE = re.compile(r"\[[^\]]*조치요청\s*\]")

#: 제목에서 티켓 번호를 읽는 두 가지 모양.
#:
#:   ① 태그 안쪽   `[보안취약점 조치요청](SMB00024)(10.125.102.246) …`   ← 현재 형식
#:   ② 앞 블록     `[티켓 SMB00024] …`                                   ← 이전 형식
#:
#: ⚠️ ②를 계속 읽는다. 이미 그 형식으로 나간 메일의 답장이 아직 돌아온다.
#:    읽기는 넓게, 쓰기는 하나로.
TICKET_SUBJECT_RE = re.compile(
    r"\[\s*티켓\s+([A-Z]{2,3})(\d{5,})\s*\]"          # ② [티켓 SMB00024]
    r"|"
    r"조치요청\s*\]\s*\(\s*([A-Z]{2,3})(\d{5,})\s*\)"  # ① …조치요청](SMB00024)
)


def ticket_no(domain: str, thread_id: int) -> str:
    """`(도메인, 스레드 id)` → 티켓 번호. 모르는 도메인은 거부한다."""
    prefix = TICKET_PREFIX.get(str(domain or ""))
    if not prefix:
        raise ValueError(f"티켓 접두가 없는 도메인: {domain!r} (등록: {sorted(TICKET_PREFIX)})")
    return f"{prefix}{int(thread_id):05d}"


def subject_marker(domain: str, thread_id: int) -> str:
    """제목에 붙일 표식. 제목 **앞**에 둔다 — RE:/FW: 가 앞에 붙어도 살아남는다."""
    return f"[티켓 {ticket_no(domain, thread_id)}]"


def parse_ticket(subject: str) -> tuple[str, int] | None:
    """제목에서 `(도메인, 스레드 id)` 를 뽑는다. 없거나 모르는 접두면 None.

    ⚠️ 조용히 추측하지 않는다 — 접두가 등록 어휘 밖이면 None 이다. 그래야 호출부가
       제목 태그 경로로 **명시적으로** 폴백한다.
    """
    m = TICKET_SUBJECT_RE.search(str(subject or ""))
    if not m:
        return None
    prefix = m.group(1) or m.group(3)
    number = m.group(2) or m.group(4)
    domain = _BY_PREFIX.get(prefix or "")
    if not domain:
        return None
    try:
        return domain, int(number)
    except (TypeError, ValueError):
        return None


def stamp_subject(subject: str, domain: str, thread_id: int) -> str:
    """제목 **앞**에 티켓 표식을 붙인다. 이미 있으면 그대로 둔다(멱등).

    ## 왜 제목 앞인가

    `RE:` / `FW:` / `RE:(3)` 은 앞에 **덧붙는다**. 표식이 뒤에 있으면 긴 제목이 잘릴 때
    먼저 사라지고, 앞에 있으면 회신 접두가 그 앞에 쌓일 뿐 표식은 남는다.

    ## ⚠️ 기존 제목 태그를 지우지 않는다

    `[보안취약점 조치요청](IP)` 같은 태그는 **그대로 둔다.** 이유 둘:

      · 이미 나간 메일들의 답장은 태그로만 매칭된다. 태그를 없애면 그 답장들이 미아가 된다.
      · 표식은 접두라 `_SUBJECT_TAG_RE.search()` 가 여전히 태그를 찾는다 — 역호환이다.

    티켓은 **1차 키**이고 태그는 폴백이다. 둘 다 실려 있어야 그 관계가 성립한다.
    """
    return stamp_subject_with(subject, ticket_no(domain, thread_id))


def stamp_subject_with(subject: str, ticket: str | None) -> str:
    """이미 정해진 티켓 번호로 제목을 찍는다(멱등). 번호가 없으면 **찍지 않는다**.

    ★ 발송 경로는 이 형태를 쓴다 — 번호의 정본은 DB 에 저장된 값이고
      (`state_domain.thread_ensure_ticket_no`), 공식이 아니다. 공식으로 다시 계산하면
      접두 규칙이 바뀌었을 때 저장값과 갈린다. 사람에게 이미 나간 번호라 갈리면 안 된다.
    """
    subj = str(subject or "")
    if not ticket or TICKET_SUBJECT_RE.search(subj):
        return subj
    # ★ 태그 바로 뒤 괄호에 넣는다 — `[보안취약점 조치요청](SMB00024)(10.125.102.246) …`
    #   (사용자 지시 2026-08-31). 제목이 한 덩어리로 읽히고, 좌표 괄호는 그대로 남는다.
    #   ⚠️ 수집기 태그 정규식이 **괄호 첫 그룹**을 좌표로 잡으므로, 티켓 괄호를
    #      건너뛰도록 그쪽도 같이 고쳤다(`mail_inbound._TICKET_GROUP`).
    m = _TAG_HEAD_RE.search(subj)
    if m:
        return f"{subj[:m.end()]}({ticket}){subj[m.end():]}"
    # 태그가 없는 제목(스모크 테스트 등)은 예전처럼 앞에 붙인다.
    return f"[티켓 {ticket}] {subj}".strip()
