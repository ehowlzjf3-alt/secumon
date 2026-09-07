"""v3.79 ③: SMB office/문서 내용 스캔 — docx/xlsx/pptx/hwpx 텍스트 추출.

갭: _TEXT_EXTENSIONS 에 문서 포맷이 전무 + fetch_file 의 NUL 휴리스틱이 zip 기반
office 문서를 'binary' 로 분류 → 사내 공유폴더의 가장 민감한 캐리어(직원명단.xlsx,
계정정보.docx, hwp)가 영영 내용 스캔에서 빠짐 (라이브: 미스캔 6,934 전부 text후보 아님).

수정: stdlib zipfile 로 OOXML/OWPML(zip+xml) 텍스트 추출 — 의존성 0.
- _is_text_candidate: 문서 확장자도 후보로.
- _classify_fetched(path, raw): fetch 후처리 순수함수 분리(SMB 세션 없이 테스트).
  문서면 추출 텍스트로 status='text', zip-bomb 가드, 실패 시 기존 binary 휴리스틱.
"""
from __future__ import annotations

import io
import zipfile


def _zip_bytes(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in members.items():
            z.writestr(name, content)
    return buf.getvalue()


# ---- 후보 판정 ----

def test_doc_extensions_are_text_candidates():
    from domains.smb.plugin.agent_types.smb import _is_text_candidate
    for fn in ("직원명단.xlsx", "계정정보.docx", "발표.pptx", "보고서.hwpx", "스캔본.pdf"):
        assert _is_text_candidate(fn) is True, fn


def test_plain_binary_extensions_still_not_candidates():
    from domains.smb.plugin.agent_types.smb import _is_text_candidate
    for fn in ("photo.jpg", "lib.dll", "setup.exe"):
        assert _is_text_candidate(fn) is False, fn


def test_image_extensions_are_vision_candidates_not_text():
    from domains.smb.plugin.agent_types.smb import _is_text_candidate, is_image_candidate
    assert _is_text_candidate("대강당 사이드 배너_1.jpg") is False
    assert is_image_candidate("대강당 사이드 배너_1.jpg") is True
    assert is_image_candidate("screen.PNG") is True


# ---- 문서 텍스트 추출 ----

def test_extract_docx_text():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    raw = _zip_bytes({
        "word/document.xml": (
            "<w:document><w:body><w:p><w:r>"
            "<w:t>주민번호 880101-1234567 포함</w:t>"
            "</w:r></w:p></w:body></w:document>"
        ),
    })
    text = _extract_document_text("계정정보.docx", raw)
    assert text is not None
    assert "880101-1234567" in text
    assert "<w:t>" not in text  # 태그 제거됨


def test_extract_xlsx_shared_strings():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    raw = _zip_bytes({
        "xl/sharedStrings.xml": (
            "<sst><si><t>password=agent_type2</t></si>"
            "<si><t>사번 12345678</t></si></sst>"
        ),
        "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
    })
    text = _extract_document_text("직원명단.xlsx", raw)
    assert text is not None
    assert "password=agent_type2" in text
    assert "12345678" in text


def test_extract_pptx_slide():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    raw = _zip_bytes({
        "ppt/slides/slide1.xml": "<p:sld><a:t>대외비 공정 레시피</a:t></p:sld>",
    })
    text = _extract_document_text("발표.pptx", raw)
    assert text is not None and "대외비 공정 레시피" in text


def test_extract_hwpx_section():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    raw = _zip_bytes({
        "Contents/section0.xml": "<hs:sec><hp:t>연락처 010-1234-5678</hp:t></hs:sec>",
    })
    text = _extract_document_text("보고서.hwpx", raw)
    assert text is not None and "010-1234-5678" in text


def test_extract_simple_pdf_literal_text_without_dependency():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    raw = (
        b"%PDF-1.4\n"
        b"1 0 obj <<>> stream\n"
        b"BT /F1 12 Tf 72 720 Td (password=agent_type2 endpoint=https://app.example/login) Tj ET\n"
        b"endstream endobj\n%%EOF"
    )
    text = _extract_document_text("credential.pdf", raw)
    assert text is not None
    assert "password=agent_type2" in text
    assert "https://app.example/login" in text


def test_render_pdf_pages_ignores_non_pdf_bytes():
    from domains.smb.plugin.agent_types.smb import render_pdf_pages_as_images
    assert render_pdf_pages_as_images(b"not a pdf") == []


def test_extract_non_doc_extension_returns_none():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    raw = _zip_bytes({"any.xml": "<a>x</a>"})
    assert _extract_document_text("archive.zip", raw) is None  # 일반 zip 은 대상 아님
    assert _extract_document_text("photo.jpg", b"\xff\xd8\xff\xe0" + b"\x00" * 64) is None


def test_extract_corrupt_zip_returns_none():
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    assert _extract_document_text("a.docx", b"PK\x03\x04corrupt-not-a-zip") is None


def test_extract_zip_bomb_member_guard():
    """압축 헤더가 거대 원본크기를 주장하는 멤버는 스킵 — 메모리 폭탄 방지."""
    from domains.smb.plugin.agent_types.smb import _extract_document_text
    # 60MB 의 'A' — 압축률 높아 zip 자체는 작음. 멤버 크기 가드에 걸려야.
    raw = _zip_bytes({
        "word/document.xml": "<w:t>safe-marker</w:t>",
        "word/huge.xml": "A" * (60 * 1024 * 1024),
    })
    text = _extract_document_text("x.docx", raw)
    # 추출은 성공하되(safe 부분), 거대 멤버는 통째로 들어가지 않음
    assert text is not None and "safe-marker" in text
    assert len(text) <= 1_100_000  # 총 추출 상한(1M chars + 여유)


# ---- fetch 후처리 분류 (순수함수) ----

def test_classify_fetched_docx_becomes_text():
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    raw = _zip_bytes({"word/document.xml": "<w:t>aws_secret_access_key=abcd1234</w:t>"})
    status, body = _classify_fetched("비밀.docx", raw)
    assert status == "text"
    assert "aws_secret_access_key=abcd1234" in body


def test_classify_fetched_pdf_becomes_text():
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    raw = b"%PDF-1.4\nBT (aws_secret_access_key=abcd1234) Tj ET\n%%EOF"
    status, body = _classify_fetched("비밀.pdf", raw)
    assert status == "text"
    assert "aws_secret_access_key=abcd1234" in body


def test_classify_image_pdf_points_to_pdf_inspect():
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    status, body = _classify_fetched("스캔본.pdf", b"%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF")
    assert status == "binary"
    assert "smb_inspect_pdf" in body


def test_classify_fetched_plain_text_unchanged():
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    status, body = _classify_fetched("a.txt", "id=root\npw=1234\n".encode())
    assert status == "text" and "pw=1234" in body


def test_classify_fetched_binary_unchanged():
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    status, body = _classify_fetched("x.dll", b"MZ" + b"\x00" * 100)
    assert status == "binary"


def test_classify_fetched_empty_unchanged():
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    status, body = _classify_fetched("a.txt", b"")
    assert status == "empty" and body == ""


def test_classify_fetched_truncated_docx_falls_back_to_binary():
    """max_bytes 절단으로 zip 이 깨진 문서 — 추출 실패 시 기존 binary 휴리스틱."""
    from domains.smb.plugin.agent_types.smb import _classify_fetched
    full = _zip_bytes({"word/document.xml": "<w:t>" + "x" * 10000 + "</w:t>"})
    raw = full[: len(full) // 2]  # central directory(끝부분) 소실 — 확실한 절단
    status, _ = _classify_fetched("big.docx", raw)
    assert status == "binary"  # 추출 실패 → mojibake text 방지, binary 강등
