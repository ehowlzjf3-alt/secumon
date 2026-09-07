"""발송 요청 본문 — `/gw/reports/{key}/{thread_id}/body`.

★ **"발송본" 이 아니다.** 저장값은 `deliver()` 호출 전 payload 라 egress redact 이전이고,
실제로 나간 본문은 DB 어디에도 없다. 게이트웨이가 읽기 시점에 `redact()` 를 다시 걸어
내보내므로 화면 값은 실제 나간 메일보다 **더** 가려져 있다.
"""
import os

import pytest

LIVE = pytest.mark.skipif(
    not os.environ.get("SECU_AGENT_PG_DSN"),
    reason="라이브 threat_hunter DSN(SECU_AGENT_PG_DSN) 필요",
)

DOMAINS = ("smb", "github", "confluence", "dev_web")


@pytest.fixture()
def pool():
    os.environ.setdefault("GATEWAY_TOKEN", "test")
    from digisecu_gateway.config import Config
    from digisecu_gateway.db import ReadOnlyPool

    p = ReadOnlyPool(Config.load())
    p.open()
    yield p
    p.close()


# ── DB 없이 ──────────────────────────────────────────────────────────────────


def test_masking_happens_before_truncation():
    """★ 순서가 뒤집히면 토큰이 detector 임계 밑으로 짧아져 **누수한다.**

    `_clip` 은 자르기만 하고 마스킹은 호출부가 먼저 한다 — 그 계약을 코드로 고정한다.
    """
    import inspect

    from digisecu_gateway.repos import mail_body_repo as m

    for fn in (m._smb_body, m._thread_body):
        src = inspect.getsource(fn)
        assert "_clip(redact(" in src, (
            f"{fn.__name__}: 마스킹 없이 자르고 있다 — redact 를 _clip 안쪽에 둬야 한다"
        )


def test_unknown_domain_is_unavailable_not_crash():
    from digisecu_gateway.models import MailBody
    from digisecu_gateway.repos.mail_body_repo import mail_body

    out: MailBody = mail_body(None, domain="없는도메인", thread_id=1)  # type: ignore[arg-type]
    assert out.access == "unavailable"
    assert out.hasBody is False


def test_denied_and_empty_are_different_states():
    """못 읽은 것과 없는 것은 다른 뜻이다 — 화면이 갈라 그려야 한다."""
    from digisecu_gateway.models import MailBody

    assert MailBody(domain="smb", threadId=1, access="denied").hasBody is False
    assert MailBody(domain="smb", threadId=1, access="ok", hasBody=False).access == "ok"


# ── 라이브 ───────────────────────────────────────────────────────────────────


@LIVE
@pytest.mark.parametrize("domain", DOMAINS)
def test_every_domain_answers_without_error(pool, domain):
    """★ 4도메인 전부 부른다.

    처음엔 `subject_tag`/`recipient` 를 `report_col()` 에 통과시켰다가 github 에서 500 이
    났다(`report_col` 은 아는 컬럼만 받는 dict 조회라 KeyError). 스위트가 이 라우트를
    smb 로만 부르고 있어 못 잡았고 **라이브 호출에서 드러났다.**
    """
    from digisecu_gateway.domains import DOMAIN_TABLES
    from digisecu_gateway.repos import mail_body_repo

    table = DOMAIN_TABLES[domain].report_thread_table
    if domain == "smb":
        row = pool.fetch_one("SELECT id FROM mail_thread ORDER BY id LIMIT 1")
    else:
        row = pool.fetch_one(f"SELECT id FROM {table} ORDER BY id LIMIT 1")
    if not row:
        pytest.skip(f"{domain} 스레드가 없다")

    out = mail_body_repo.mail_body(pool, domain=domain, thread_id=int(row["id"]))
    assert out.domain == domain
    assert out.access in {"ok", "denied"}


@LIVE
def test_body_is_actually_redacted(pool):
    """평문 이메일이 남아 있으면 재마스킹이 안 걸린 것이다."""
    import re

    from digisecu_gateway.repos import mail_body_repo

    row = pool.fetch_one(
        "SELECT thread_id FROM mail_message WHERE direction='out' "
        "AND body_excerpt IS NOT NULL ORDER BY id DESC LIMIT 1"
    )
    if not row:
        pytest.skip("본문 있는 smb 스레드가 없다(GRANT 미적용일 수 있다)")

    out = mail_body_repo.mail_body(pool, domain="smb", thread_id=int(row["thread_id"]))
    assert out.hasBody and out.body
    leaked = re.findall(r"[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z.-]+", out.body)
    assert not leaked, f"평문 이메일이 {len(leaked)}건 남았다 — redact 가 안 걸렸다"


@LIVE
def test_missing_thread_is_empty_not_error(pool):
    from digisecu_gateway.repos import mail_body_repo

    out = mail_body_repo.mail_body(pool, domain="github", thread_id=999_999_999)
    assert out.access == "ok"
    assert out.hasBody is False
