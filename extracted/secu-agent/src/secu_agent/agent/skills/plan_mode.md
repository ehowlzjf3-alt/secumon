---
name: plan_mode
description: heavy batch / 외부 영향 큰 작업 시작 전 enter_plan_mode 로 사용자 승인 받기.
domain: core
when_to_use: review limit≥10 / schedule 신규 생성 / sandbox 연쇄 호출 / 자동 walk all / task 자동화 체인 시작 시.
---

## 언제 plan mode 거치나

**ALWAYS plan mode**:
- `run_smb_review_pending(limit=N)` 에서 N ≥ 10
- `schedule(action="create", ...)` — 자동 반복 작업
- sandbox 호출이 연쇄로 2회 이상 예상되는 경우
- 새 도메인 (gh / jenkins / confluence / web) 의 batch task 첫 도입 시
- 사용자가 "전부 / 다 / all" 같은 광범위 표현 쓸 때

**SKIP plan mode**:
- 단일 file inspect / triage 1건
- discovery / walk 단발성 (네트워크 IO 만, 부수효과 작음)
- list / query / read-only 도구

## 사용 패턴

```
enter_plan_mode(
  rationale="pending share 47건 review — INETSim 평가 대상 너무 커서 분할 권장",
  steps=[
    "1. pending 47건 중 risk_score top 20 만 우선 review",
    "2. severity high 발견 시 즉시 finding 등록",
    "3. 나머지 27건은 schedule 로 매일 5건씩 자동화"
  ],
  estimated_minutes=25
)
# 사용자 승인 → 진행
... 실제 도구 호출 ...
exit_plan_mode(
  summary="20건 review 완료, severity high 3건 finding 등록",
  executed_steps=["1", "2"]  # step 3 은 별도 schedule 로 미룸
)
```

## 절대 규칙

- enter_plan_mode 호출했으면 **승인 후 진행** — 거부하면 즉시 중단 + 사용자에게 사유 묻기.
- plan mode 도중에 plan 벗어난 도구 호출 X — 새 plan 필요하면 다시 enter_plan_mode.
- exit 안 부르고 새 turn 가면 다음 사이클 사용자가 "지금 뭐 하고있어?" 헷갈림. 끝나면 반드시 exit.
- estimated_minutes 는 과장 X — 사용자 신뢰. 모르면 0 두고 rationale 에 명시.

## 관련

- [[anti_patterns]] — 무확인 batch 호출 ✗
- [[sandbox_usage]] — 연쇄 sandbox 호출 시 plan_mode 필수
