# 진단 프로브 (재현용)

`docs/core-ask-gemma-profile-and-default.md` 의 근거를 재현하는 스크립트다.
**프로덕션 코드가 아니다** — `service/probes/`(실제 크리덴셜 검증)와 혼동하지 말 것.

## 무엇을 재는가

모델이 도구를 든 채로 "다음 행동을 도구로 호출하라"는 요구를 받았을 때,
**text/tool 델타를 하나도 안 내고 reasoning 델타만 내는 콜**(=빈-content)의 비율.

빈-content 턴은 엔진에 "텍스트-only 턴"으로 보여 계약 리마인더 캐스케이드를 태우고,
`max_candidate_ledger_reminders=2` / `max_terminal_tool_reminders=2` 이므로
**누적 3회면 `contract_violation` 으로 태스크가 죽는다.**

## 실행

```bash
export PYTHONPATH=/home/shaneee.baek/project/secu-agent-skill
export SA_ENGINE_DIR=/home/shaneee.baek/project/secu-agent
PY=/home/shaneee.baek/project/secu-agent/.venv/bin/python

# 프로파일 1개를 N회 — 이벤트 분류 상세(빈-content vs 정상)
PROBE_N=8 PROBE_PROFILE=gemma $PY docs/probes/empty_probe.py

# 게이트웨이 모델 ID 여러 개 비교 (기본: internal 4종)
PROBE_N=6 $PY docs/probes/model_probe.py
PROBE_N=6 PROBE_MODELS=internal-gemma4,internal-gausso3.2 $PY docs/probes/model_probe.py
```

`PROBE_MAX_TOKENS` 로 예산을 바꿔 "예산을 키우면 해결되나"를 확인할 수 있다
(실측: 4096→16384 로 늘리면 reasoning 델타도 정확히 4배로 늘고 빈-content 비율은 그대로).

## ⚠️ 주의

- **`external-*` 모델은 쓰지 마라.** 스캔 자극에 사내 경로/식별자가 들어가고,
  external 은 사외(OpenAI/Anthropic)로 나간다. 기본값은 internal 계열만이다.
- 프로파일당 타임아웃이 필수다. `o4-mini`·`codex`·`qwen`·`gaussO4` 는 **응답 없이
  무한 대기**해서, 타임아웃 없이 전 프로파일을 훑으면 첫 프로파일에서 영영 멈춘다.
- 자극(`empty_probe.PROMPT`)은 합성 데이터다 — 실제 repo 내용이 아니다.
