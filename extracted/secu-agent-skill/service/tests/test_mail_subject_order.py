"""메일 제목 순서 — 대상은 맨 뒤 (사용자 결정 2026-09-01)."""
from __future__ import annotations

import pytest


def test_대상은_제목_맨_뒤에_온다():
    """받는 사람이 먼저 봐야 하는 것은 "무엇을 해야 하나" 다. 메일함에서 제목이 잘릴 때
    앞부분이 살아남는다."""
    from _shared.mail_subject import compose_subject

    out = compose_subject("[보안취약점 조치요청](12.23.37.227)", "공유폴더 접근권한 관리")

    assert out == "[보안취약점 조치요청] 공유폴더 접근권한 관리 (12.23.37.227)"


def test_티켓번호는_라벨_뒤에_찍힌다(tmp_db):
    """★ 회신 매칭 1차 키다. 대상이 뒤로 갔다고 티켓까지 뒤로 가면 안 된다 —
    사람이 제목을 잘라 답장해도 앞부분이 남는 쪽에 있어야 한다."""
    from _shared.mail_subject import compose_subject
    from service import state_domain as sd

    # ⚠️ `stamp_subject_with` 는 **티켓 문자열**을 받는다. 스레드에서 찍을 때는
    #    저장된 번호를 쓰는 `stamp_subject_for_thread` 가 정본이다(둘을 헷갈리면
    #    `(80)` 같은 번호가 제목에 나간다 — 처음 이 테스트가 그랬다).
    _, thread_id = sd.mail_thread_upsert(
        finding_id=1, host="12.23.37.227", share_id=None,
        subject_tag="[보안취약점 조치요청](12.23.37.227)", severity="high",
        recipient=None, status="reported",
    )
    subject = compose_subject("[보안취약점 조치요청](12.23.37.227)", "공유폴더 접근권한 관리")
    stamped = sd.stamp_subject_for_thread(subject, "smb", int(thread_id))

    import re
    assert re.match(r"^\[보안취약점 조치요청\]\(SMB\d{5,}\) ", stamped), stamped
    assert stamped.rstrip().endswith("(12.23.37.227)")


@pytest.mark.parametrize(
    ("subject", "expected"),
    [
        # 현 형태 — 대상이 맨 뒤
        ("RE: [보안취약점 조치요청](SMB00080) 공유폴더 접근권한 관리 (12.23.37.227)",
         ("smb", "[보안취약점 조치요청](12.23.37.227)")),
        # ⚠️ 옛 형태 — 이 형식으로 나간 메일의 답장이 아직 온다. 계속 읽어야 한다.
        ("[보안취약점 조치요청](12.23.37.227) 공유폴더 접근권한 관리",
         ("smb", "[보안취약점 조치요청](12.23.37.227)")),
        ("[GitHub 보안취약점 조치요청](GH00552) 소스코드 시크릿 조치 요청 (org/repo)",
         ("github", "[GitHub 보안취약점 조치요청](org/repo)")),
        ("[Dev Web 보안취약점 조치요청] 개발 웹 접근통제 조치 (host.samsungds.net)",
         ("dev_web", "[Dev Web 보안취약점 조치요청](host.samsungds.net)")),
    ],
)
def test_수신_분류는_두_형태를_모두_읽는다(subject, expected):
    from service.collector.mail_inbound import classify_subject_tag_from_subject

    assert classify_subject_tag_from_subject(subject) == expected


def test_티켓번호만_있는_괄호는_대상이_아니다():
    """⚠️ 제목 끝이 티켓 번호면 그건 좌표가 아니다 — 그걸 대상으로 읽으면 매칭이 어긋난다."""
    from service.collector.mail_inbound import classify_subject_tag_from_subject

    assert classify_subject_tag_from_subject("[보안취약점 조치요청] 조치 요청 (SMB00080)") is None


@pytest.mark.parametrize(
    ("given", "expected"),
    [("김명규", "김명규님"), ("김명규님", "김명규님"), ("", "담당자님"),
     ("이수현 책임님", "이수현 책임님")],
)
def test_호칭은_한_번만_붙는다(given, expected):
    """★ 실기동에서 회신에 **`김명규님님,`** 이 찍혀 나갔다(2026-09-01).

    본문 조립기 네 곳이 전부 `f"{name}님,"` 로 무조건 붙이는데, 담당자 이름이 이미
    `김명규님` 으로 오는 경우가 있다. 규칙을 네 곳에 두면 한 곳만 고쳐진다.

    ⚠️ 문구 결함은 테스트가 아니라 **나간 메일**에서 드러난다 — 그래서 규칙을 한 곳에
       두고 여기서 고정한다.
    """
    from _shared.mail_subject import address_name

    assert address_name(given) == expected


def test_조립기가_그_규칙을_쓴다():
    """★ 함수만 만들고 호출부를 안 바꾸면 아무것도 안 고쳐진다(이 저장소의 단골 형태)."""
    import inspect

    from service.services import remediation_mail as rm

    for fn in (rm.build_how_to, rm.build_confirmed):
        src = inspect.getsource(fn)
        assert "{name}님," not in src, f"{fn.__name__} 이 호칭을 직접 붙인다"


def test_회신_수신처_판정은_한_곳이다(monkeypatch):
    """★ 2026-09-01 사고. 같은 판정이 **두 벌** 있었다(`reply_targets` · smb 의
    `_reply_targets`). 제한을 공용 쪽에만 걸었더니 smb 답장이 그대로 실제 담당자에게
    나갔다(09:09:30).

    사용자 지적: "공용러너인데 왜 또 따로 막아" — 맞다. 두 곳을 각각 막는 게 아니라
    결정 지점을 **하나로** 만드는 게 답이다. smb 는 이제 공용 함수를 위임해 쓴다.
    """
    monkeypatch.setenv("SA_REPLY_RECIPIENT_ONLY", "dssoc@samsung.com,shaneee.baek@samsung.com")

    from domains.smb.plugin.tools.smb_reply_tools import _reply_targets
    from service.services.remediation_mail import reply_targets

    msg = {"mail_from": "성예찬 <ycc.sung@samsung.com>",
           "mail_to": "dssoc@samsung.com", "mail_cc": None}

    smb = _reply_targets(msg)
    assert smb["recipients"] == ["dssoc@samsung.com", "shaneee.baek@samsung.com"]
    assert "ycc.sung@samsung.com" not in smb["recipients"] + smb["cc"]

    to, cc = reply_targets(msg)
    assert to == ["dssoc@samsung.com", "shaneee.baek@samsung.com"]
    assert "ycc.sung@samsung.com" not in to + cc


def test_제한이_없으면_평소대로_상대에게_간다(monkeypatch):
    """⚠️ 임시 제한이다. 환경변수를 지우면 즉시 원래 동작이어야 한다 —
    안 그러면 회신이 조용히 팀함에만 쌓인다."""
    monkeypatch.delenv("SA_REPLY_RECIPIENT_ONLY", raising=False)

    from domains.smb.plugin.tools.smb_reply_tools import _reply_targets

    out = _reply_targets({"mail_from": "성예찬 <ycc.sung@samsung.com>",
                          "mail_to": "dssoc@samsung.com", "mail_cc": None})
    assert out["recipients"] == ["ycc.sung@samsung.com"]
    # ★ 합치면서 같이 고쳐진 것 — 정책은 "담당자(To) + DSSOC(Cc)" 인데 smb 판정은
    #   DSSOC 를 양쪽에서 빼기만 해서 우리 팀함에 회신 사본이 안 남았다.
    assert "dssoc@samsung.com" in out["cc"]


@pytest.mark.parametrize(
    ("answer", "owner", "expected_head"),
    [
        ("성예찬님, 안녕하세요. 문의하신 경로에서…", "성예찬", "문의하신"),
        ("안녕하세요 김명규님, DS보안관제입니다. 답변드립니다.", "김명규", "DS보안관제입니다"),
        ("문의하신 경로에서 발견된 내용입니다.", "성예찬", "문의하신"),   # 인사 없으면 안 건드린다
    ],
)
def test_인사는_코드가_한_번만_넣는다(answer, owner, expected_head):
    """★ 실측 2026-09-01: **`성예찬님, 성예찬님, 안녕하세요.`** 가 그대로 나갔다.

    조립기가 `{이름}님,` 을 넣는데 LLM 이 답변 첫머리에 또 인사한다. 프롬프트로
    "인사하지 마라" 를 부탁할 수도 있지만, 부탁으로 지켜지는 것은 언젠가 깨진다 —
    코드가 걷어낸다.
    """
    from _shared.reply_body import _strip_duplicate_greeting

    assert _strip_duplicate_greeting(answer, owner).startswith(expected_head)


def test_회신_프롬프트에_어조_규칙이_있다():
    """★ 사용자 지적 2026-09-01: "메일 답변 나간 게 너무 공격적이야".

    프롬프트에 어조 지침이 **한 줄도** 없었다. 받는 사람은 대부분 자기가 만들지 않은
    공유를 물려받은 동료다 — "입사 전 폴더라 하더라도 …해 주시기 바랍니다" 같은 문장이
    그래서 나왔다.
    """
    from pathlib import Path

    for rel in ("domains/smb/skills/smb_reply_verify/worker.md",
                "domains/dev_web/skills/dev_web_reply_verify/worker.md"):
        text = Path(rel).read_text(encoding="utf-8")
        assert "어조" in text, f"{rel} 에 어조 지침이 없다"
        assert "탓하지 않는다" in text


def test_회신_프롬프트가_경로_공개_정책을_못박는다():
    """★ 2026-09-01: 같은 시스템이 30분 사이에 서로 반대로 답했다 —
    한쪽엔 `App.config` 경로와 "sa 패스워드 평문 노출" 을 다 적어 보내고,
    다른 쪽엔 "보안 정책상 상세 경로와 파일명은 안내드리지 않습니다" 를 보냈다.
    그런 정책은 **없다**. 받는 사람 입장에서 우리가 무엇을 하는지 알 수 없게 된다.

    사용자 결정: 담당자에게는 **경로·파일명·판정 종류를 밝힌다.** 값 자체는 쓰지 않는다.
    """
    from pathlib import Path

    for rel in ("domains/smb/skills/smb_reply_verify/worker.md",
                "domains/dev_web/skills/dev_web_reply_verify/worker.md"):
        text = Path(rel).read_text(encoding="utf-8")
        # ★ 2026-09-01 좁혔다: **물어본 것에 답한다.** 방법만 물은 사람에게 경로를
        #   나열하지 않는다 — 경로엔 다른 사람 이름·계정이 섞여 있다.
        assert "물어본 것에 답한다" in text, rel
        assert "방법만 물었으면" in text, rel
        assert "안내드리지 않습니다" in text, f"{rel} 에 금지 문구 경고가 없다"
        assert "값 자체" in text


def test_공감형_상투구는_본문에서_빠진다():
    """★ 사용자 결정 2026-09-01: "이렇게 공감형으로 할 필요는 없어 담백하게".

    프롬프트에도 넣었지만 오늘 어조 지침을 넣자마자 LLM 이 그 방향으로 과했다 —
    "확인에 어려움이 있으셨을 것 같습니다" 가 두 통에 다 들어갔다. 부탁은 언젠가
    깨지므로 문장째로 걷어낸다.

    ⚠️ 문장 단위로만 지운다. 사실이 든 문장은 건드리지 않는다.
    """
    from _shared.reply_body import _strip_duplicate_greeting, _strip_empathy

    raw = ("김명규님, 안녕하세요. 해당 장비가 설비 계측용으로 활용되고 있어 "
           "확인에 어려움이 있으셨을 것 같습니다.\n\n요청하신 탐지 내역을 안내드립니다.")

    out = _strip_empathy(_strip_duplicate_greeting(raw, "김명규"))

    assert out == "요청하신 탐지 내역을 안내드립니다."
    # 사실 문장은 남는다
    assert _strip_empathy("공유 폴더에서 CSV 3건이 확인되었습니다.") == \
        "공유 폴더에서 CSV 3건이 확인되었습니다."


def test_어조_규칙이_담백함을_요구한다():
    from pathlib import Path

    for rel in ("domains/smb/skills/smb_reply_verify/worker.md",
                "domains/dev_web/skills/dev_web_reply_verify/worker.md"):
        text = Path(rel).read_text(encoding="utf-8")
        assert "담백하게" in text, rel
        assert "인사를 쓰지 마라" in text, rel


def test_절차_안내는_본문과_분리된_카드다():
    """★ 담당자 의견(2026-09-01): "Windows/Linux 권한 변경 안내를 처음 발송되는 메일처럼
    박스나 표에 넣어서 회신되게 하면 좋겠다 — 본문이랑 분류되는 느낌으로".

    최초 조치요청 메일의 `.info-card` 와 같은 결로 낸다. 회신에는 `<style>` 을 못 쓰므로
    (일부 클라이언트가 `<head>` 밖 style 을 버린다) 인라인으로 같은 모양을 낸다.
    """
    from _shared.reply_body import numbered_lines

    out = numbered_lines("Windows 공유 폴더 권한 변경", ["폴더 우클릭", "Everyone 제거"])

    assert "border-left:4px solid" in out, "본문과 구분되는 테두리가 있어야 한다"
    assert "background:" in out
    # ★ 줄바꿈 규칙은 그대로 — 번호는 한 줄에 하나(2026-08-31 사용자 지시).
    assert out.count("<div style=\"margin:3px 0\">") == 2


def test_회신_제한_중에는_제목에_TEST_표식(monkeypatch):
    """★ 사용자 요청 2026-09-01: "dssoc랑 shaneee.baek으로만 보내는 케이스에는
    메일 구분되게 (test) 같은거 붙여주라".

    표식이 없으면 우리 팀함에서 **진짜 나간 메일과 시험분이 섞인다** — 오늘 09:09 에
    실제 담당자에게 나간 것과 그 뒤 시험분이 같은 메일함에 있다.
    """
    from service.services.remediation_mail import reply_subject

    original = "RE: [보안취약점 조치요청](SMB00037) 공유폴더 접근권한 관리 (12.3.4.5)"

    monkeypatch.setenv("SA_REPLY_RECIPIENT_ONLY", "dssoc@samsung.com")
    marked = reply_subject("[보안취약점 조치요청](12.3.4.5)", original_subject=original)
    assert "[TEST]" in marked
    # ★ RE: 접두 **뒤**에 붙는다. 앞에 붙으면 회신 매칭의 RE 계산이 흔들린다.
    assert marked.startswith("RE:(2) [TEST]")

    # ⚠️ 제한이 풀리면 표식도 사라진다 — 지우는 걸 잊어 진짜 메일에 [TEST] 가 붙으면 안 된다.
    monkeypatch.delenv("SA_REPLY_RECIPIENT_ONLY", raising=False)
    plain = reply_subject("[보안취약점 조치요청](12.3.4.5)", original_subject=original)
    assert "[TEST]" not in plain


def test_TEST_표식이_회신_매칭을_깨지_않는다(monkeypatch):
    """⚠️ 제목에 무엇을 붙이든 **티켓번호와 태그는 계속 잡혀야 한다.**"""
    from _shared.ticket_id import parse_ticket
    from service.collector.mail_inbound import classify_subject_tag_from_subject

    subject = "RE:(2) [TEST] [보안취약점 조치요청](SMB00037) 공유폴더 접근권한 관리 (12.3.4.5)"

    assert parse_ticket(subject) == ("smb", 37)
    assert classify_subject_tag_from_subject(subject) == (
        "smb", "[보안취약점 조치요청](12.3.4.5)")
