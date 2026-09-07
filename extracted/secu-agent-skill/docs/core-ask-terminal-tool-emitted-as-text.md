# CORE-ASK: 종료 상태 도구를 "텍스트로만" 낸 워커 되돌리기 (완주 블로커 #2)

> digisecu 세션 발신. **라이브 워커 완주 최종 블로커.** ②(submit_finding coercion)와 triage coercion 은
> 라이브로 동작 확인됨 — 이제 워커가 실제로 죽는 유일한 지점이 여기다. 침묵 게이트(candidate ledger)의
> **형제 게이트**: "후보 미정산(침묵)"이 아니라 "필수 종료 도구를 **텍스트로만** 내고 끝냄".

## 증상 (라이브 재현, 정밀)

confluence keyword_search 워커(gauss-o32, 폴백+② 활성). evidence:
`/tmp/confluence_e2e_evidence/20260721T115004-88228c-*` (turns=7, tokens_in=64023).

정상 동작한 부분(전부 ✓):
1. `confluence_browser_search` 로그인+검색 성공 → 후보 11개 관측
2. `triage_candidates` **성공** — 11개 전부 정산(candidates_seen=11 == accounted=11). ← triage coercion 동작
3. `submit_finding` 1회 → `error:validation` = **정책 A(browser 검증 게이트) 정상 거부**. 워커가 마스킹
   프리뷰만 보고 성급히 제출 → `submit_finding.py:97,258` 게이트가 "대상 호스트를 browser 로 연 기록
   없음"으로 거부. **버그 아님 — 설계대로**(keyword_search 는 프리뷰 triage 만; 확정은 별개). ← ② 는
   여기서 무관하게 이미 dict 로 통과함(스키마 검증은 OK, 정책 게이트에서 걸림).

죽는 지점(❌):
- turn 7, 워커가 **최종 assistant 텍스트**로 이 JSON 을 냄:
  `{"target_ids":[1,2,3,4,5,6,7,8],"status":"tasked","findings_count":0,"reason":"All candidate pages …"}`
- 이건 필수 종료 도구 `confluence_search_set_status(...)` 의 인자 그대로다. **그러나 tool_use 호출이 아니라
  message 본문 텍스트**로 냈다(weak-model 실패모드: tool call 을 산문/JSON 으로 서술).
- engine `stop_reason=end_turn`, tool_calls 없음 → 텍스트-only 종료 캐스케이드(engine.py:1143~1226)
  진입. 후보는 이미 정산돼 candidate_ledger reminder 미발동 → **"종료 도구 미호출" reminder 가 없어**
  그대로 end_turn 수용.
- 워커 래퍼: `saw_terminal=False`(종료 도구 tool_use 미관측) → `error_crash, rc=1`
  (`confluence_task_worker.py:964-972`, `_terminal_tools_for("keyword_search")={"confluence_search_set_status"}`).

즉 **실질 작업(검색·triage·오검출 없는 판정)은 다 옳게 했는데, 완료 신호만 텍스트로 내서 error_crash.**

## 근본 원인 = 텍스트-only 종료 캐스케이드에 "종료 도구 미호출" 게이트가 없음

`engine.py:1011` `terminal_names`(워커가 metadata 로 주입, keyword_search→`confluence_search_set_status`),
`:1051` 해당 도구가 ToolSuccess 로 완료돼야 `terminal=True`. 텍스트로만 내면 영영 False.
텍스트-only 종료 캐스케이드(:1143~)는 plan / finding_followup / **candidate_ledger** / execution 4개
reminder 만 있고 → **"필수 종료 도구를 아직 안 불렀다"는 문이 없다.** candidate_ledger 가 "신호조차 안 낸
침묵"을 지키듯, 이건 **"작업은 했는데 완료 도구를 텍스트로만 낸 미종료"**를 지키는 형제 게이트가 필요.

## ASK — 옵션 2안 (추천: 1 우선, 2 보강)

### 안 1 (권장·저위험·기존 패턴 복제): 종료 도구 reminder
`engine.py` 텍스트-only 분기(execution_contract_reminder 다음, :1217 end_turn 수용 직전)에 추가:

```python
# 필수 종료 도구를 호출하지 않고 텍스트로만 끝낸 워커 되돌리기 (candidate_ledger 형제).
# opt-in: 워커 CLI 가 metadata["require_terminal_tool"]=True 설정 시에만(chat 경로 비발동).
if context.metadata.get("require_terminal_tool") and not terminal and terminal_names:
    count = int(context.metadata.get("terminal_tool_reminder_count", 0))
    if count < cfg.max_terminal_tool_reminders:
        context.metadata["terminal_tool_reminder_count"] = count + 1
        names = " 또는 ".join(sorted(terminal_names))
        messages.append(UserMessage(content=[TextBlock(text=(
            f"너의 마지막 메시지는 종료 상태 도구를 **글로 적기만** 했고 실제로 호출하지 않았다. "
            f"텍스트로 적은 JSON 은 완료로 인정되지 않는다. 지금 `{names}` 를 **도구로 호출**하라 "
            f"(예: keyword_search 는 target_ids=<전체>, status='tasked'|'skipped'|'error', "
            f"finding_count=<N>, reason=<짧게>). 정상 완료는 finding_count=0 이라도 status='tasked'."
        ))]))
        continue
    yield LoopError(message=(
        "terminal tool contract violation: required terminal status tool "
        f"({sorted(terminal_names)}) was described as text but never invoked"
    ))
    yield LoopCompleted(reason="contract_violation", total_turns=turn,
                        final_message=None, usage=cumulative_usage)
    return
```
- `cfg.max_terminal_tool_reminders`(기본 2) 추가. 순서: candidate_ledger **다음**(후보 정산 먼저, 그 후 종료).
- 워커측(digisecu 반영): confluence/github/smb task worker 가 engine 호출 시 `require_terminal_tool=True`
  주입(terminal 이 진짜 필수인 워커만). terminal_names 는 이미 넘기고 있음.

### 안 2 (보강·고신뢰·weak-model 수렴): 종료 텍스트 salvage
reminder 로도 gauss 가 "이미 끝냈다"고 믿어 계속 텍스트만 낼 수 있다. 그때를 위해:
텍스트-only + require_terminal_tool + not terminal 이고, **최종 assistant 텍스트가 엄격 JSON 이며 어떤
terminal 도구의 입력 스키마에 부합**하면(예: status/target_ids 키 존재) → 그 terminal 도구를 **1회
디스패치**(모델이 이미 낸 정답을 행동으로 전환). 파싱/검증 실패 시 안 1 reminder 로 폴백.
- 위험: 종료 의도가 아닌 텍스트 오디스패치 → 엄격 JSON + 선언된 terminal 도구 스키마 매치일 때만,
  1회 한정. `findings_count`(모델 오타) → `finding_count` 같은 키 보정도 여기서.

**추천: 안 1 먼저 머지(안전·기존 캐스케이드와 정합), 라이브에서 수렴 안 하면 안 2 추가.**

## 함의 / 범위
- **전 도메인 공통·고레버리지**: set_status 종료 워커 전부(confluence space/search, github/smb devops_target)
  가 같은 weak-model 텍스트-종료에 취약. 이 게이트 하나가 4도메인 완주를 커버.
- candidate_ledger 게이트와 **직교**(그건 "후보 미정산", 이건 "미종료"). 둘 다 opt-in metadata.
- A2A 비신뢰/폭주차단과 무충돌: reminder 는 결정론 코드, 예산(max_reminders) 상한.

## 수용 기준
1. require_terminal_tool + terminal 미호출 + 텍스트-only 종료 → 종료 도구 reminder 주입 후 continue
   (모델이 실제 tool 호출 시 terminal=True → 정상 완료). 단위테스트.
2. 기존 4개 reminder(plan/finding/ledger/execution) 회귀 없음. require_terminal_tool 미설정(chat) → 비발동.
3. reminder 예산 소진 시 contract_violation 으로 깨끗이 종료(무한 continue 없음).
4. (안 2 채택 시) 최종 텍스트가 terminal 스키마 JSON → 1회 디스패치로 terminal=True, 아니면 폴백.
5. 라이브 재현: confluence keyword_search 워커가 `saw_terminal=True` 로 완주(status=ok).
6. 코어 스위트 green.

## 비목표
- 정책 A(browser 검증) 로직 — 정상 동작, 손대지 말 것.
- keyword_search 가 finding 을 **확정**할 수 있어야 하는가(별도 설계 질문, 아래 참고) — 이 ASK 범위 밖.
- gauss 500(폴백 해결) · gateway.

## 참고 (별개 설계 질문, 이 ASK 아님)
keyword_search 워커는 `confluence_browser_search`(자체 브라우저)로 실제 검색하지만 그 방문이
`_web_browser_hosts`(코어 browser_action/browser_query 가 기록)에 안 남아 **정책 A 를 절대 만족 못 함** →
이 워커는 구조적으로 finding 확정 불가(triage 전용). 이게 의도(확정=confluence_recheck 워커)인지, 아니면
confluence_browser_search 가 방문 호스트를 `_web_browser_hosts` 에 기록해야 하는 갭인지는 digisecu 측
설계 판단. 완주 블로커와 무관하므로 분리.
