"""사내 DRM 래퍼 — 왜 못 읽었는지 구분해 남긴다.

## ⚠️⚠️ DRM 은 안전하다는 뜻이 아니다 (사용자, 2026-08-30)

사내에서는 **AD 접속만으로 NASCA 권한이 열려 대부분 읽을 수 있다.** 그러므로 DRM 은
노출을 완화하는 통제가 아니고, 위험도를 낮추는 근거로 쓰면 안 된다.

처음에 "DRM 걸린 문서는 통제가 적용돼 위험이 낮다" 로 설계하려다 사용자가 잡았다.
이 파일은 그 **결정**을 고정한다 — 코드가 아니라 판단 기준이 다시 뒤집히는 걸 막는다.

## 실측 (2026-08-30, 라이브 SMB)

    11.106.101.210\\공유폴더  계약서·견적서 .pdf
    12.56.53.141\\SE_PART    3nm MBCFET 교안 .pdf
      → 셋 다 `<## NASCA DRM FILE - VER1.00 ##>` 로 시작
      → **파일 전체를 받아도** `%PDF-` 가 파일 어디에도 없다(위치 -1)
      → 앞부분만 읽기·상한 올리기 둘 다 무의미
"""
from __future__ import annotations

from domains.smb.plugin.agent_types import smb as m


def test_drm_wrapper_is_detected():
    assert m.is_drm_wrapped(b"<## NASCA DRM FILE - VER1.00 ##>\x00\x01\x02" * 4)


def test_real_pdf_is_not_drm():
    assert not m.is_drm_wrapped(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj")


def test_short_or_empty_bytes_do_not_crash():
    assert not m.is_drm_wrapped(b"")
    assert not m.is_drm_wrapped(b"<##")


def test_drm_is_never_described_as_safe():
    """★ 문구가 '보호됨/안전' 으로 바뀌면 판정이 조용히 뒤집힌다."""
    from service.state_domain import _UNREAD_WHY

    why = _UNREAD_WHY["drm"]
    assert "안전 아님" in why
    assert "이름·경로로 판정" in why
    for banned in ("보호되고", "안전함", "위험 낮"):
        assert banned not in why


def test_oversized_zip_family_is_routed_to_the_archive_tools():
    """크기 때문에 못 연 것은 **갈 곳이 있다** — 어디로 가라고 말해줘야 한다."""
    from service.state_domain import _UNREAD_WHY

    why = _UNREAD_WHY["too_large"]
    assert "smb_archive_index" in why and "smb_archive_scan" in why


def test_denied_is_evidence_not_noise():
    from service.state_domain import _UNREAD_WHY

    assert "판정 재료" in _UNREAD_WHY["denied"]
