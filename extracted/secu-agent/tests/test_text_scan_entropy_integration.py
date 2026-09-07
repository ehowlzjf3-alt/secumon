"""H7: high-entropy detector integration through scan_text/scan_file."""
from __future__ import annotations

import pytest

from secu_agent.detectors.text_scan import scan_file, scan_text


RANDOM_TOKEN = "kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT"


def _kinds(result):
    return {h.kind for h in result.hits}


def _hit_sig(result):
    return [(h.category, h.kind, h.masked, h.line_no, h.line_preview) for h in result.hits]


def test_scan_text_keeps_entropy_off_for_unstructured_default():
    text = f"internal note: keep this opaque value {RANDOM_TOKEN} for later review"

    result = scan_text(text, label="notes.txt")

    assert "high_entropy_string" not in _kinds(result)


def test_scan_text_include_entropy_finds_unkeyed_token():
    text = f'opaque_value = "{RANDOM_TOKEN}"'

    result = scan_text(text, include_entropy=True)

    hit = next(h for h in result.hits if h.kind == "high_entropy_string")
    assert hit.category == "secret_heuristic"
    assert RANDOM_TOKEN not in hit.masked
    assert RANDOM_TOKEN not in hit.line_preview


def test_scan_text_structured_label_does_not_auto_enable_entropy():
    text = f'{{"buildId":"release-2026","opaque":"{RANDOM_TOKEN}"}}'

    result = scan_text(text, label="web_response.json")

    assert "high_entropy_string" not in _kinds(result)


def test_scan_text_default_matches_explicit_entropy_off_for_shared_callers():
    text = (
        f'{{"password":"Tr0ub4dor3xKpzQ","opaque":"{RANDOM_TOKEN}",'
        '"contact":"jane.doe@samsung.com"}}'
    )

    default_result = scan_text(text, label="web_response.json")
    entropy_off = scan_text(text, label="web_response.json", include_entropy=False)

    assert _hit_sig(default_result) == _hit_sig(entropy_off)
    assert "high_entropy_string" not in _kinds(default_result)


@pytest.mark.parametrize(
    "text",
    [
        "id = 550e8400-e29b-41d4-a716-446655440000",
        "commit a1b2c3d4e5f6789012345678901234567890abcd",
        (
            '<img src="data:image/png;base64,'
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9p9s='
            '">'
        ),
        (
            "(()=>{"
            + ";".join(f'const v{i}="{RANDOM_TOKEN[:-2]}{i:02d}"' for i in range(18))
            + "})();"
        ),
        f'<script src="/assets/app.{RANDOM_TOKEN}.js"></script>',
        "jwt = eyJhbGciOiJIUzI1NiJ9.abCDefGhIjKlMnOpQrStUvWxYz012345.ZyXwVuTsRqPoNmLkJiHgFeDcBa987654",
    ],
)
def test_scan_text_include_entropy_suppresses_benign_high_entropy_shapes(text):
    result = scan_text(text, label="artifact.js", include_entropy=True)

    assert "high_entropy_string" not in _kinds(result)


def test_scan_file_explicit_entropy_finds_json_body_without_extension(tmp_path):
    body = tmp_path / "dynamic-response-body"
    body.write_text(f'{{"rows":[{{"opaque":"{RANDOM_TOKEN}"}}]}}', encoding="utf-8")

    result = scan_file(
        body,
        label="https://app.example.internal/api/session",
        include_entropy=True,
    )

    assert "high_entropy_string" in _kinds(result)
