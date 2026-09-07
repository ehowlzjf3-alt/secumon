"""회신 블록이 **실제 발송 문구**와 갈라지지 않는지 고정한다.

## 왜 이 테스트가 있나

회신 블록(`domains/*/plugin/reply_blocks.py`)의 문장은 지어낸 것이 아니라
조치요청 메일 본문에서 온 것이다. 리포트 본문만 고치고 블록을 안 고치면,
같은 사안에 최초 메일과 회신이 **다른 절차**를 말하게 된다 — 담당자 입장에서
DSSOC 가 말을 바꾼 것으로 보인다.

이 테스트가 실패하면 리포트 본문이 바뀐 것이다. 블록도 같이 고쳐라.
(smb 는 반대 방향이다 — `build_how_to` 가 블록을 **읽는다**. 거기선 출처가
 하나라 드리프트가 원천적으로 없고, 그 사실 자체를 여기서 고정한다.)
"""
from __future__ import annotations

import pytest

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def _source(rel: str) -> str:
    return (_REPO / rel).read_text(encoding="utf-8")


def test_github_block_sentences_still_in_report_body() -> None:
    from domains.services.github.plugin.reply_blocks import GITHUB_REMEDIATION_STEPS

    body = _source("domains/services/github/application/scanner.py")
    missing = [s for s in GITHUB_REMEDIATION_STEPS if s not in body]
    assert not missing, (
        "github 리포트 본문에서 사라진 문장이 있다 — 블록도 같이 고쳐라:\n  "
        + "\n  ".join(missing)
    )


def test_confluence_block_sentences_still_in_report_body() -> None:
    from domains.services.confluence.plugin.reply_blocks import CONFLUENCE_REMEDIATION_STEPS

    body = _source("domains/services/confluence/application/reporter.py")
    missing = [s for s in CONFLUENCE_REMEDIATION_STEPS if s not in body]
    assert not missing, (
        "confluence 리포트 본문에서 사라진 문장이 있다 — 블록도 같이 고쳐라:\n  "
        + "\n  ".join(missing)
    )


def test_smb_how_to_reads_the_block_not_a_copy() -> None:
    """`build_how_to` 가 블록 상수를 **읽는지** 확인한다(복사본 금지)."""
    from domains.smb.plugin.reply_blocks import SMB_HOWTO_LINUX, SMB_HOWTO_WINDOWS
    from service.services.remediation_mail import build_how_to

    assert SMB_HOWTO_WINDOWS in build_how_to(host="1.2.3.4", os_hint="windows")
    assert SMB_HOWTO_LINUX in build_how_to(host="1.2.3.4", os_hint="linux")
    # os_hint 를 모르면 둘 다 붙인다 — 기존 동작.
    both = build_how_to(host="1.2.3.4", os_hint="unknown")
    assert SMB_HOWTO_WINDOWS in both and SMB_HOWTO_LINUX in both
    # 인라인 복사본이 되살아나지 않았는지.
    src = _source("service/services/remediation_mail.py")
    assert "고급 공유" not in src, "build_how_to 에 절차 문구가 다시 인라인됐다"


def test_dev_web_registers_no_invented_block() -> None:
    """dev_web 은 고정 절차가 없다 — 일반론 블록을 만들지 않았음을 고정한다."""
    from domains.dev_web.plugin.reply_blocks import dev_web_reply_blocks

    assert dev_web_reply_blocks() == ()


def test_guidance_body_has_no_fourth_copy_of_the_steps() -> None:
    """★ github/confluence '조치방법 안내' 회신이 **세 번째 복사본**이었다.

    2026-08-31 실측: 리포트 본문(5단계)·회신 블록(5단계)·이 안내(4단계, 문구 다름).
    담당자 입장에선 DSSOC 가 같은 사안에 말을 바꾸는 것이다. 인라인 절차를 걷어내고
    블록을 읽게 했다 — 여기서 되살아나지 않는지 고정한다.
    """
    src = _source("service/agents/service_reply_guidance_agent.py")
    assert "노출된 토큰/비밀번호/키는 먼저 폐기" not in src, (
        "안내 본문에 절차 문구가 다시 인라인됐다 — 블록을 읽어라")
    assert "_github_guidance_body" not in src and "_confluence_guidance_body" not in src


def test_reply_request_is_not_asked_twice() -> None:
    """블록이 이미 회신을 요청하면 껍데기는 요청하지 않는다."""
    from _shared.reply_body import ReplyBlock, register_reply_block, render_reply

    register_reply_block(ReplyBlock(
        name="_t_asks", purpose="테스트", html="<p>조치 후 회신해 주세요.</p>",
        domains=("smb",), includes_reply_request=True))
    with_block = render_reply(domain="smb", answer="답", blocks=["_t_asks"])["html"]
    assert "본 메일에 회신" not in with_block, "회신 요청이 두 번 들어갔다"
    without = render_reply(domain="smb", answer="답")["html"]
    assert "본 메일에 회신" in without, "블록이 없으면 껍데기가 요청해야 한다"


@pytest.mark.parametrize("domain,thread", [
    ("github", {"id": 552, "repo": "org/repo"}),
    ("confluence", {"id": 41, "space_key": "OPS"}),
])
def test_guidance_body_does_not_depend_on_bootstrap(domain: str, thread: dict) -> None:
    """★ 순서 의존 회귀 — 이 함수는 자기가 쓰는 블록을 자기가 보장해야 한다.

    2026-08-31: `_guidance_body` 가 `render_reply` 를 쓰기 시작하면서 조용히
    `plugin/bootstrap.register_all()` 에 의존하게 됐다. 스위트에선 **다른 테스트가
    먼저 부트스트랩한 덕에** 통과했고, 단독으로 돌리면 RuntimeError 였다.

    이 에이전트는 LLM 도 도구도 안 쓰는 순수 코드라 부트스트랩을 부를 이유가 없다.
    (이 테스트 파일은 부트스트랩을 부르지 않으므로, 여기서 통과하면 자립한 것이다.)
    """
    from service.agents.service_reply_guidance_agent import _guidance_body

    body = _guidance_body(domain, thread, None)
    assert "조치 방법" in body
    assert "티켓" in body, "티켓 번호가 본문에 없다 — 제목이 편집돼도 붙을 근거가 사라진다"
