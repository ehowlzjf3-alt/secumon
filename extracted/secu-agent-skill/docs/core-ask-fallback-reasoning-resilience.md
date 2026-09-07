# CORE-ASK: FallbackLLMClient 가 reasoning-delta 를 "출력 시작"으로 세지 않도록 (gauss 500 완전 커버)

> digisecu 세션 발신. gauss 스트리밍 간헐 500(`'async for' … got NoneType`, LiteLLM 서버측) 조사 후속.
> **스킬측 1차 수정은 이미 반영**(워커 `_build_client` 가 `SA_CHAT_PROFILE_CHAIN` 폴백 체인 사용,
> gauss-o32→gauss-o41→gpt-oss). 이 CORE-ASK 는 그 폴백의 **커버리지 구멍**을 코어에서 막는 건이다.

## 배경 / 구멍

`FallbackLLMClient.stream`(fallback.py)은 **첫 visible 이벤트 이후엔 폴백하지 않는다**(출력 시작 후
프로바이더 전환은 assistant 턴을 오염시키므로 — 올바른 기본값). 판정 기준은 `emitted_any`인데,
**모든** non-`StreamError` 이벤트가 이를 True 로 만든다(fallback.py:57; 폴백 가능 조건 검사는 :48).
검증된 이벤트 타입(types.py): 커밋=`StreamTextDelta`(29)·`StreamToolUseStart`(46)·`StreamToolUseDelta`(53)·
`StreamToolUseStop`(60); 비커밋=`StreamReasoningDelta`(35)·`StreamUsage`(66)·`StreamMessageStop`(81).
internal_gateway 가 실제 yield 하는 것: StreamTextDelta(333)·StreamReasoningDelta(339)·StreamToolUseStop(354)·
StreamMessageStop(356) + `_process_tool_call_delta` 경유 ToolUseStart/Delta.

그런데 gauss/gpt-oss 같은 reasoning 모델은 `StreamReasoningDelta`(reasoning_content 채널)를 **먼저**
대량으로 흘린다. 그리고 코어 주석(internal_gateway.py:335)이 명시하듯 **reasoning 은 frontend/DB/
next-turn context 어디에도 안 들어간다**(비영속·비커밋). 즉:

- reasoning 델타가 하나라도 나온 뒤 500 이 나면 `emitted_any=True` → **폴백 안 함** → 턴이
  stream_error 로 죽는다.
- 하지만 reasoning 은 커밋 출력이 아니므로, 이 시점 프로바이더 전환은 **아무것도 오염시키지 않는다**.

관측: 라이브 confluence keyword_search 워커가 gauss stream-init 500(reasoning 전)엔 스킬 폴백으로
살지만, reasoning 시작 후 500 엔 여전히 죽는다.

## ASK: `emitted_any` 를 "커밋 출력"으로 한정

`FallbackLLMClient` 가 폴백 차단 기준을 **committed 이벤트(text delta / tool-use)** 로만 잡도록.
`StreamReasoningDelta`(및 usage-only 청크)는 emitted 로 세지 않는다 — 이들 뒤 폴백은 무손실.

스케치:
```python
# fallback.py
_COMMITTED = (StreamTextDelta, StreamToolUseStart, StreamToolUseDelta, StreamToolUseStop)
...
async for event in client.stream(request):
    if isinstance(event, StreamError):
        can_try_next = (not committed and idx < last and self._should_fallback(event))
        ...
    if isinstance(event, _COMMITTED):   # reasoning/usage 는 제외
        committed = True
    yield event
```
정확한 이벤트 분류는 코어 재량(StreamEvent 타입은 코어 소유). 핵심 계약: **reasoning-only 구간의
retryable 에러는 폴백 가능**, 텍스트/툴 출력이 시작된 뒤에는 기존대로 폴백 금지.

## (선택) 2차 ASK: 동일-턴 재시도

mid-content(텍스트/툴 출력 시작 후) transient 5xx 는 폴백도 불가하고 지금은 턴이 죽는다. 엔진
루프(engine.py:1080 stream_error 처리)에서 kind=transient 를 **동일 client 로 N회 재시도**(discard
partial, 같은 messages 재발행)하는 옵션. 위 1차 ASK 보다 침습적이라 분리.

## 수용 기준

1. reasoning-델타만 나온 뒤 retryable StreamError → 다음 프로파일로 폴백(단위테스트: fake client 가
   reasoning delta 1개 후 transient 에러 → 2번째 client 로 스위치).
2. text/tool 델타 이후 StreamError → 폴백 안 함(기존 동작 보존).
3. 코어 스위트 green, chat 경로(FallbackLLMClient 사용) 회귀 없음.

## 비목표

스킬 워커 배선(이미 반영) · LiteLLM 서버측 500 자체(게이트웨이팀 리포트 별건) · 정책/DB.
