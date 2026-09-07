"""SMB 조치요청 메일의 "확인된 민감 항목" — 분류·건수만, 경로·값은 절대 안 나간다.

## 왜 생겼나

메일은 `공유 폴더 3건이 열려 있다` 만 말하고 **그 안에서 무엇이 발견됐는지는 말하지 않았다.**
`all_findings` 를 계산해 놓고 `del` 로 버렸기 때문이다(경로·값을 싣지 않으려는 의도).
그 결과 담당자는 공유 안에 개인키가 있다는 사실을 모른 채 "권한 정리" 만 했다.
실측: SMB open finding 713건 중 개인키 계열 hit 73건, 크리덴셜 115건.

⇒ **분류와 건수만** 접어서 싣는다. 우선순위를 정할 만큼만 알려주고 상세는 DSSOC 문의로.

## ★ 이 파일의 본체는 누출 가드다

조치요청 메일은 전달·회신으로 퍼지고 메일함에 남는다. 경로·파일명·마스킹 값이 실리면
**메일 자체가 새 노출 경로**가 된다.
"""
from __future__ import annotations

import pytest

from service.services.sensitive_summary import (
    actions_html as _sensitive_actions_html,
    sensitive_bucket as _sensitive_bucket,
    sensitive_counts as _sensitive_counts,
    summary_html as _sensitive_summary_html,
)


def test_private_keys_are_counted_separately_from_other_credentials():
    """개인키는 secret/credential 어느 쪽에 있든 따로 센다 — 급한 정도가 다르다."""
    assert _sensitive_bucket("secret", "private_key_block") == "private_key"
    assert _sensitive_bucket("credential", "rsa_private_key") == "private_key"
    assert _sensitive_bucket("credential", "windows_local_password") == "credential"


def test_share_misconfiguration_is_not_counted():
    """공유 권한 자체는 메일 본문이 이미 다루는 주제다 — 여기서 또 세면 중복이다."""
    assert _sensitive_bucket("misconfig", "open_share_exposure") is None


def test_unknown_category_is_not_guessed():
    """모르는 분류를 억지로 접으면 없는 위험을 알리게 된다."""
    assert _sensitive_bucket("something_new", "whatever") is None


def test_counts_roll_up_by_bucket():
    hits = [
        {"category": "secret", "kind": "private_key_block"},
        {"category": "credential", "kind": "rsa_private_key"},
        {"category": "credential", "kind": "plaintext_password"},
        {"category": "misconfig", "kind": "open_share_exposure"},
        "not-a-dict",
    ]
    assert _sensitive_counts(hits) == {"private_key": 2, "credential": 1}


# ── ★ 누출 가드 ────────────────────────────────────────────────────────────

_SECRETY = (
    "private_key_block", "rsa_private_key",            # kind 이름
    "\\\\10.0.0.5\\share", "/etc/ssh/id_rsa",          # 경로
    "-----BEGIN RSA PRIVATE KEY-----", "hunter2",      # 값
)


@pytest.mark.parametrize("html_fn", [_sensitive_summary_html, _sensitive_actions_html])
def test_no_path_value_or_kind_name_reaches_the_mail(html_fn):
    html = html_fn({"private_key": 2, "credential": 5, "pii": 1,
                    "confidential": 3, "internal_system": 4})
    for needle in _SECRETY:
        assert needle not in html, f"메일에 {needle!r} 가 실렸다 — 메일이 노출 경로가 된다"


def test_summary_says_it_withholds_details():
    """상세를 뺐다는 사실을 밝힌다 — 안 밝히면 '이게 전부' 로 읽힌다."""
    html = _sensitive_summary_html({"private_key": 1})
    assert "경로와 값은 메일에 포함하지 않습니다" in html


# ── 없는 분류는 안 그린다 ─────────────────────────────────────────────────

def test_nothing_sensitive_renders_nothing():
    """민감 항목이 없으면 빈 표를 그리지 않는다 — '확인했는데 없음' 과 섞인다."""
    assert _sensitive_summary_html({}) == ""
    assert _sensitive_actions_html({}) == ""
    assert _sensitive_summary_html({"private_key": 0}) == ""


def test_only_present_categories_get_guidance():
    """없는 유형까지 나열하면 담당자가 무엇이 자기 일인지 못 고른다."""
    html = _sensitive_actions_html({"private_key": 1})
    assert "개인키" in html
    assert "개인정보" not in html
    assert "공정·기밀 문서" not in html


def test_credential_guidance_covers_rotation_and_access_logs():
    """권한을 닫아도 이미 나간 자격증명은 유효하다 — 교체와 이력 점검을 함께 말해야 한다."""
    html = _sensitive_actions_html({"private_key": 1, "credential": 1})
    assert "폐기·재발급" in html
    assert "즉시 변경" in html
    assert "접속 로그" in html or "접속 이력" in html
