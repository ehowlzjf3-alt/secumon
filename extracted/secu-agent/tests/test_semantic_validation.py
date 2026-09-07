from __future__ import annotations


def test_robots_html_fallback_is_rejected():
    from secu_agent.agent.semantic_validation import validate_web_resource

    root = "<html><title>SPA</title><script src='/js/app.js'></script></html>"
    result = validate_web_resource(
        url="https://example.com/robots.txt",
        status=200,
        headers={"content-type": "text/html"},
        body=root,
        root_body=root,
        method="GET",
    )

    assert result["semantic_status"] == "rejected"
    assert result["semantic_type"] == "spa_fallback"
    assert "root" in result["reason"].lower() or "html" in result["reason"].lower()


def test_valid_robots_txt_is_confirmed():
    from secu_agent.agent.semantic_validation import validate_web_resource

    result = validate_web_resource(
        url="https://example.com/robots.txt",
        status=200,
        headers={"content-type": "text/plain"},
        body="User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n",
        root_body="<html>home</html>",
        method="GET",
    )

    assert result["semantic_status"] == "confirmed"
    assert result["semantic_type"] == "robots_txt"


def test_head_only_success_is_inconclusive():
    from secu_agent.agent.semantic_validation import validate_web_resource

    result = validate_web_resource(
        url="https://example.com/.env",
        status=200,
        headers={"content-type": "text/plain"},
        body="",
        root_body=None,
        method="HEAD",
    )

    assert result["semantic_status"] == "inconclusive"
    assert "GET" in result["required_actions"][0]


def test_env_html_body_is_rejected_not_exposed():
    from secu_agent.agent.semantic_validation import validate_web_resource

    result = validate_web_resource(
        url="https://example.com/.env",
        status=200,
        headers={"content-type": "text/html"},
        body="<html><body>app shell</body></html>",
        root_body="<html><body>app shell</body></html>",
        method="GET",
    )

    assert result["semantic_status"] == "rejected"
    assert result["semantic_type"] == "spa_fallback"


def test_sensitive_signal_scan_masks_process_and_business_info():
    """v3.82 U3a: 도메인 어휘 시그널은 register_sensitive_term_signal 등록형 —
    메커니즘은 등록한 모킹 사전으로 검증.

    generic 신호(pii/credential/attack_surface)는 등록 없이도 동작해야 한다.
    """
    from secu_agent.agent import semantic_validation as sv

    sv.register_sensitive_term_signal(
        "semiconductor_process", kind="process_keyword_context",
        terms=("recipe", "wafer"),
    )
    sv.register_sensitive_term_signal(
        "business_confidential", kind="business_keyword_context",
        terms=("revenue", "pricing"),
    )

    text = """
    Contact owner kim@example.com.
    FAB line recipe parameter LOT_ID=ABCD1234 wafer defect yield report.
    Q3 revenue forecast and customer pricing margin are attached.
    API_TOKEN=abcd1234secret
    https://api.internal.example.com/v1/orders
    """

    try:
        signals = sv.scan_sensitive_signals(text, location="https://example.com/app.js")
    finally:
        assert sv.unregister_sensitive_term_signal("semiconductor_process") is True
        assert sv.unregister_sensitive_term_signal("business_confidential") is True
    categories = {signal["category"] for signal in signals}

    assert {"pii", "credential", "semiconductor_process", "business_confidential", "attack_surface"} <= categories
    serialized = "\n".join(signal["masked"] for signal in signals)
    assert "abcd1234secret" not in serialized
    assert "kim@example.com" not in serialized


def test_sensitive_signal_scan_generic_signals_without_domain_terms():
    """도메인 사전 부재(빈 tuple) 시에도 generic 신호는 정상 동작."""
    from secu_agent.agent.semantic_validation import scan_sensitive_signals

    signals = scan_sensitive_signals(
        "owner kim@example.com API_TOKEN=abcd1234secret",
        location="https://example.com/app.js",
    )
    categories = {signal["category"] for signal in signals}
    assert {"pii", "credential"} <= categories


def test_mask_sensitive_text_uses_canonical_scan_mask_for_pii_urls_and_json_creds():
    from secu_agent.agent.semantic_validation import mask_sensitive_text

    password = "plain-password-value"
    token = "url-token-value-12345"
    sig = "url-signature-value-67890"
    text = (
        '{"name":"Jane Doe","phone":"010-1234-5678",'
        '"address":"129 Samsung-ro, Yeongtong-gu, Suwon-si, Gyeonggi-do",'
        f'"password":"{password}",'
        f'"callback":"https://user:pass@host.example/p?token={token}&sig={sig}&q=ok"}}'
    )

    masked = mask_sensitive_text(text)
    assert "Jane Doe" not in masked
    assert "010-1234-5678" not in masked
    assert "129 Samsung-ro, Yeongtong-gu, Suwon-si, Gyeonggi-do" not in masked
    assert password not in masked
    assert "user:pass@" not in masked
    assert token not in masked
    assert sig not in masked


def test_sensitive_signal_scan_masks_credential_url_signal_fields():
    from secu_agent.agent.semantic_validation import scan_sensitive_signals

    token = "url-token-value-12345"
    sig = "url-signature-value-67890"
    url = f"https://user:pass@host.example/p?token={token}&sig={sig}&q=ok"
    signals = scan_sensitive_signals(url, location=url)
    serialized = "\n".join(
        f"{signal['masked']} {signal['location']} {signal['context']}"
        for signal in signals
    )

    assert "user:pass@" not in serialized
    assert token not in serialized
    assert sig not in serialized


def test_sensitive_signal_scan_uses_config_secret_parser():
    from secu_agent.agent.semantic_validation import scan_sensitive_signals

    raw_secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    text = f"""
    <project><clientSecret>{raw_secret}</clientSecret></project>
    env:
      - name: DB_PASSWORD
        value: {raw_secret}
    """

    signals = scan_sensitive_signals(text, location="https://example.com/config.xml")
    kinds = {signal["kind"] for signal in signals if signal["category"] == "credential"}
    serialized = "\n".join(
        f"{signal['masked']} {signal['context']}" for signal in signals
    )

    assert "generic_secret_xml_element" in kinds
    assert "generic_named_env_value" in kinds
    assert raw_secret not in serialized
