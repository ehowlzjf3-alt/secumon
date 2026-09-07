from secu_agent.agent.safe_probe import enrich_hits_with_safe_probes


def test_safe_probe_get_only_validation_for_credential_context():
    calls = []
    auth_calls = []

    def fake_get(url, timeout):
        calls.append((url, timeout))
        return {"result": "reachable", "status_code": 200, "elapsed_ms": 7}

    def fake_request(request, timeout):
        auth_calls.append((request["method"], request["url"], sorted((request.get("headers") or {}).keys())))
        return {"result": "reachable", "status_code": 200, "elapsed_ms": 8}

    hits = [{
        "category": "secret",
        "kind": "api_key",
        "masked": "AKIA****",
        "line_no": 2,
        "line_preview": "api_key=AKIA**** endpoint=https://api.example.com/v1 post=/tokens",
    }]
    text = "x\napi_key=secret endpoint=https://api.example.com/v1 post=/tokens\n"

    out = enrich_hits_with_safe_probes(text, hits, get_func=fake_get, request_func=fake_request)

    assert calls == [("https://api.example.com/v1", 2.0)]
    assert auth_calls == [("GET", "https://api.example.com/v1", ["X-API-Key"])]
    validation = out[0]["validation"]
    assert validation["attempted"] is True
    assert validation["post_possible"] is True
    assert validation["post_status"] == "login_only_allowed"
    assert validation["targets"][0]["method"] == "GET"
    assert validation["targets"][0]["status_code"] == 200
    assert validation["auth_attempts"][0]["type"] == "token_get"
    assert validation["auth_attempts"][0]["credential_fields"]["token_key"] == "api_key"
    assert validation["auth_attempts"][0]["credential_fields"]["token_masked"].startswith("se")
    assert validation["auth_attempts"][0]["secret_saved"] is False


def test_safe_probe_records_no_target_without_network_call():
    calls = []
    hits = [{
        "category": "secret",
        "kind": "password",
        "masked": "pw****",
        "line_no": 1,
        "line_preview": "password=pw****",
    }]

    out = enrich_hits_with_safe_probes(
        "password=secret",
        hits,
        get_func=lambda url, timeout: calls.append((url, timeout)),
    )

    assert calls == []
    assert out[0]["validation"]["attempted"] is False
    assert out[0]["validation"]["reason"] == "no_http_target_in_context"


def test_safe_probe_attempts_login_form_post_only_for_login_endpoint():
    calls = []

    def fake_get(url, timeout):
        return {"result": "reachable", "status_code": 200, "elapsed_ms": 4}

    def fake_request(request, timeout):
        calls.append(request)
        return {"result": "reachable", "status_code": 302, "elapsed_ms": 11}

    text = (
        "login_url=https://app.example.com/login\n"
        "username=alice\n"
        "pw=\"correct horse battery staple\"\n"
    )
    hits = [{
        "category": "secret",
        "kind": "generic_password_envline",
        "masked": "corr****aple",
        "line_no": 3,
        "line_preview": "pw=corr****aple",
    }]

    out = enrich_hits_with_safe_probes(text, hits, get_func=fake_get, request_func=fake_request)

    methods = [call["method"] for call in calls]
    assert methods == ["GET", "POST"]
    post = calls[1]
    assert post["url"] == "https://app.example.com/login"
    assert post["data"] == {"username": "alice", "pw": "correct horse battery staple"}
    validation = out[0]["validation"]
    assert validation["auth_attempts"][1]["type"] == "form_login_post"
    assert validation["auth_attempts"][1]["credential_fields"] == {
        "username_key": "username",
        "username": "alice",
        "password_key": "pw",
        "password_masked": "co****le",
    }
    assert validation["auth_attempts"][1]["login_result"] == "possible_success"
    assert validation["auth_attempts"][1]["secret_saved"] is False
