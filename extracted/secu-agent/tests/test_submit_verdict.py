

def test_module_can_actually_serialize_verdict_json() -> None:
    """★ `json.dumps` 를 쓰면서 `import json` 이 없었다 — 성공 경로 마지막 줄에서 NameError.

    모든 검증을 통과한 판정이 `verdict.json` 을 쓰는 순간 죽는다. 도구는 등록돼 있고
    (`tools/__init__.py`) 패키지 분석 task 의 종료 도구라 도달 가능한 경로다.
    임포트 하나가 빠진 것을 테스트가 못 잡은 이유는 아무도 그 줄까지 안 갔기 때문이다.
    """
    import secu_agent.agent.tools.submit_verdict as m

    assert hasattr(m, "json"), "submit_verdict 모듈에 json 바인딩이 없다"
    assert m.json.dumps({"a": 1}) == '{"a": 1}'
