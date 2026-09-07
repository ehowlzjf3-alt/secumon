# CORE-ASK: submit_finding `finding` 인자 JSON-문자열 coercion (워커 완주 블로커 #1)

> digisecu 세션 발신. **라이브 워커 신뢰성 최우선 블로커.** gauss 폴백으로 stream 500 을 넘긴 뒤
> 워커가 실제로 죽는 지점이 여기다. 코어에 **이미 있는 패턴**(submit_verdict)을 submit_finding 에 복제.

## 증상 (라이브 재현)

confluence keyword_search 워커(gauss-o32, 폴백체인+reasoning-delta 수정 활성):
- tool_search → confluence_browser_search(로그인+검색 성공, 후보 12개 관측) → **submit_finding ×2 전부
  `error:validation`** → 엔진 `repeat_error_halt`(같은 에러 2회) → error_crash, findings 0.
- evidence: `/tmp/confluence_e2e_evidence/20260721T084326-*/` (turns_used=4, candidates_seen=12, accounted=0).

검증 에러 원문(assistant 가 남김):
```
1 validation error for SubmitFindingInput
finding
  Input should be a valid dictionary or instance of TaskFinding
```
즉 gauss 가 `submit_finding(finding=<객체>)`의 **중첩 객체 `finding` 을 JSON 문자열로** 직렬화해 보낸다
(`finding = "{\"task_type\":\"confluence\",\"target\":\"https://...\"}"`). Pydantic 이 str→TaskFinding 실패.

## 근본 원인 = 이미 아는 OpenAI-compat 약모델 패턴

코어는 이 패턴을 **submit_verdict 에서 이미 처리**한다:
`submit_verdict.py:29 _coerce_json_container`(‘{’/‘[’ 로 시작하는 문자열만 json.loads→실패시 ast.literal_eval)
를 `field_validator(..., mode="before")(staticmethod(_coerce_json_container))` 로 배선(:124-135).
gpt-oss/gauss 등이 array/object 인자를 문자열로 넘기는 흔한 패턴 보정. **submit_finding 에는 이게 없다.**

## ASK (최소·정확)

`secu_agent/agent/tools/submit_finding.py` 의 `SubmitFindingInput`(:31-33)에 `finding` 전용 before-validator 추가:

```python
from pydantic import BaseModel, ValidationError, field_validator  # field_validator 추가(현재 미import)
# _coerce_json_container 는 submit_verdict 것을 공용 util 로 승격하거나 동일 구현을 재사용.

class SubmitFindingInput(BaseModel):
    finding: TaskFinding
    _coerce_finding = field_validator("finding", mode="before")(staticmethod(_coerce_json_container))
```

- `_coerce_json_container` 를 두 tool 이 공유하도록 **공용 헬퍼로 승격**(예: `tools/_arg_coercion.py`)하고 양쪽이 import
  하는 편이 중복 0. (submit_verdict 는 `_coerce_str_list` 도 쓰니 같이 이동 가능.)
- `finding` 은 dict 여야 하므로 `{`-접두 문자열만 coerce 하는 기존 로직으로 충분(평문 오검출 없음).

## 함의 / 범위

- 이건 **모든 도메인 워커 공통 블로커**다(전 도메인이 submit_finding 사용, gauss 가 객체 인자를 문자열화).
  smb/dev_web/github 워커를 아직 실행 못 해봤지만 같은 제출 경로라 같은 벽에 부딪힐 가능성이 높다.
- (권고) **object/array 인자를 받는 다른 terminal 도구 감사**: 같은 stringify 패턴에 취약한 tool 이 더 있는지.
  systemic 대안(tool-arg decode 경계에서 일괄 coercion)도 가능하나, ‘{’-접두 평문 필드 오검출 위험이 있어
  기존 per-field validator 방식(안전)을 권함.

## 수용 기준

1. `submit_finding(finding='{"task_type":"confluence","target":"...","...}')`(문자열) → dict 로 coerce 후 정상
   검증(단위테스트). 이미 dict 면 그대로.
2. 평문 문자열 필드 오검출 없음 · 파싱 실패 문자열은 원문 보존(기존 _coerce_json_container 계약).
3. evidence 재현 케이스: gauss confluence 워커가 submit_finding 검증 통과(제출 또는 evidence-judge 판정까지 도달).
4. 코어 스위트 green.

## 비목표

evidence judge 판정 로직(별개) · gauss 500(폴백으로 해결) · 스킬 배선.
