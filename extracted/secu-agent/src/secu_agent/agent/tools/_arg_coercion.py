"""OpenAI-compat 약모델 tool-arg 보정 헬퍼 (submit_verdict → 공용 승격).

gpt-oss/gauss 등 일부 모델이 object/array 인자를 JSON **문자열**로 직렬화해
보내 pydantic container 필드 검증이 실패하는 흔한 패턴의 보정. 원래
submit_verdict 전용이었으나 submit_finding 도 같은 벽(gauss 가 `finding` 객체를
문자열화 → TaskFinding 검증 실패 → repeat_error_halt)에 부딪혀 공용화했다.

per-field `field_validator(..., mode="before")` 배선으로만 쓴다 — tool-arg
decode 경계 일괄 적용은 '{'-접두 평문 필드 오검출 위험이 있어 하지 않는다.
"""
from __future__ import annotations

import ast
import json


def _coerce_json_container(v: object) -> object:
    """문자열로 직렬화된 JSON list/dict를 실제 container로 되돌린다.

    '['/'{'로 시작하는 문자열만 시도(평문 문자열은 그대로 두어 오검출 방지).
    json.loads 실패 시 ast.literal_eval(Python-repr 리터럴) 재시도, 그래도
    실패하면 원문 보존 — coercion 은 절대 새 실패를 만들지 않는다(검증은 pydantic).
    """
    if isinstance(v, str):
        s = v.strip()
        if s[:1] in ("[", "{"):
            try:
                return json.loads(s)
            except (ValueError, TypeError):
                try:
                    return ast.literal_eval(s)
                except (ValueError, SyntaxError):
                    return v
    return v


def _coerce_str_list(v: object) -> object:
    """list[str] 필드 전용 — 어떤 문자열이 와도 절대 검증 실패하지 않게 보정.

    gpt-oss가 reasoning 등을 Python-repr 리스트 문자열로 보내는데, 원소에
    아포스트로피('publish' 등)가 섞이면 json/ast 둘 다 파싱 실패한다. 그 경우
    원문을 단일 원소 리스트로 감싸 errored를 막는다(내용은 보존). 파싱되면 그대로.
    """
    if not isinstance(v, str):
        return v
    parsed = _coerce_json_container(v)
    if isinstance(parsed, list):
        return parsed
    s = v.strip()
    if len(s) >= 2 and s[0] == "[" and s[-1] == "]":  # 깨진 list 리터럴 → 바깥 괄호만 제거
        s = s[1:-1].strip()
    return [s] if s else []
