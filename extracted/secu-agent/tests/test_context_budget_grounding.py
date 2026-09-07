"""컨텍스트 예산은 **실측된 모델 한계**에 근거해야 한다 (2026-08-27).

## 무엇이 있었나

압축 임계값이 60,000자였다. 그런데 서빙 모델의 실제 한계는:

    gemma (openai/Gemma4-260430)   32K·128K·256K 토큰 통과 · 512K 거부
                                   → 안전선 256,000 토큰 ≈ 1,024,000자
    deepseek-v4                    max_input 1,000,000 (게이트웨이 신고값)

**안전선의 6% 에서 압축을 걸고 있었다.** 게이트웨이 `/model/info` 가 gemma 의
max_input 을 `None` 으로 돌려주기 때문에 아무도 실제 한계를 몰랐고, 그래서 숫자가
근거 없이 보수적이었다.

그 결과 리드는 매 턴 압축을 발동시키면서 **아무것도 못 줄였다** —
리드 도구는 `COMPACTABLE_TOOLS` 에 하나도 없다(실측: 압축 가능 0개). 줄지 않는
압축을 매 턴 돌리고, 200,000자에 닿으면 슬라이딩 윈도우가 **요약이 아니라 절단**을 했다.

## 이 파일이 지키는 것

1. 압축 임계값이 다시 근거 없이 작아지지 않게
2. 슬라이딩 윈도우(절단)가 압축 임계값보다 **위**에 있게 —
   아래로 내려오면 압축이 일할 기회 없이 먼저 잘린다
"""
from __future__ import annotations

from secu_agent.agent.engine import QueryConfig

# 실측 2026-08-27. 게이트웨이는 이 값을 안 알려준다(max_input=None) — 직접 쟀다.
GEMMA_SAFE_TOKENS = 256_000
CHARS_PER_TOKEN = 4  # 대략치. 한국어는 더 나쁘므로 보수적으로 본다.


def test_sliding_window_sits_above_the_compactor():
    """★ 절단이 압축보다 먼저 오면 압축은 아무 일도 못 한다."""
    c = QueryConfig()
    assert c.sliding_window_max_chars > c.compact_char_threshold, (
        f"슬라이딩 윈도우({c.sliding_window_max_chars:,})가 압축 임계값"
        f"({c.compact_char_threshold:,}) 이하다 — 압축이 일할 기회 없이 잘린다")


def test_the_budget_is_not_absurdly_conservative():
    """근거 없이 작으면 압축이 매 턴 헛돌고, 리드처럼 압축 대상이 없는 에이전트는
    줄지도 않으면서 비용만 낸다."""
    c = QueryConfig()
    safe_chars = GEMMA_SAFE_TOKENS * CHARS_PER_TOKEN
    assert c.compact_char_threshold >= safe_chars * 0.15, (
        f"압축 임계값 {c.compact_char_threshold:,} 이 실측 안전선"
        f"({safe_chars:,}자)의 15% 미만이다 — 근거를 확인하라")


def test_the_budget_stays_inside_the_measured_limit():
    """★ 반대 방향. 절단선이 모델 한계를 넘으면 압축이 손쓰기 전에 API 가 400 을 낸다.

    출력 토큰과 reasoning 도 같은 창을 쓰므로 한계에 붙이지 않는다.
    """
    c = QueryConfig()
    safe_chars = GEMMA_SAFE_TOKENS * CHARS_PER_TOKEN
    assert c.sliding_window_max_chars <= safe_chars * 0.75, (
        f"슬라이딩 윈도우 {c.sliding_window_max_chars:,} 가 실측 안전선"
        f"({safe_chars:,}자)에 너무 가깝다 — 출력·reasoning 몫이 없다")


def test_the_measured_limit_is_written_down_where_it_is_used():
    """★ 숫자만 있고 근거가 없으면 다음 사람이 되돌린다.

    실제로 60,000 이 그랬다 — 어디서 왔는지 아무 데도 안 적혀 있었다.
    """
    import inspect

    src = inspect.getsource(QueryConfig)
    assert "256,000" in src or "256_000" in src, "실측 한계가 안 적혀 있다"
    assert "실측" in src, "이 숫자가 어디서 왔는지가 없다"
