"""dev_web 회신 블록 — **도메인 전용 블록이 없다.**

★ 없는 것을 지어내지 않는다. 다른 셋과 달리 dev_web 리포트에는 고정된
  "■ 조치 방법" 목록이 없다(실측 2026-08-31). 사이트마다 노출 내용이 달라
  조치 문구를 워커 LLM 이 finding 별로 쓴다(`report_json.recommended_actions`).

  그래서 회신 LLM 은 **그 티켓의 `sent.actions` 를 근거로 답을 쓴다** — 여기에
  일반론 블록을 만들어 두면, 그 티켓과 무관한 절차를 붙일 길을 여는 것이다.
  공용 블록(`_shared/reply_body`)은 그대로 쓸 수 있다.
"""
from __future__ import annotations


def dev_web_reply_blocks() -> tuple:
    return ()
