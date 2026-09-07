# CORE-ASK: 워커 완료 관측 훅 + completion_reason 스키마 승격 (additive 2건)

> digisecu 세션 발신. v3.90 candidate ledger의 후속 — **"판정은 부모/오케스트레이터에 위임"을 받는
> read-model(#1 눈)의 코어측 전제 2건**. 둘 다 additive이고, 로직/DB는 코어에 들어오지 않는다.
> **타이밍 조건: v3.90이 이미 빚진 engine-worker 이미지 재빌드 창에 같이 탑승할 것** (아래 락스텝 참조).

## 배경 (1문단)

digisecu 쪽에서 candidate 침묵 신호를 threat_hunter DB(신규 `skill_quality` 네임스페이스, 스킬 소유)로
영속해 게이트웨이 `/gw/quality/candidates` read-model을 만드는 중이다. smb/dev_web(코어 팬아웃 미경유
자체 루프)과 워커측 기록은 스킬이 자체 처리한다. 그러나 **코어 팬아웃 경유 도메인(confluence/github)의
부모측 관측**은 코어의 completion 분류 지점이 자연스러운 단일 지점이다 — invalid(worker_result 누락/
파싱실패/스키마위반) completion은 코어만 정확히 분류하기 때문. 코어는 **프로토콜(빈 훅)만 소유**하고
sink는 플러그인이 등록한다(`register_evidence_judge`/`register_candidate_counter` 전례와 동일한 결).

## ASK-1: `register_worker_completion_observer` (등록형 훅)

인터페이스 스케치 (정확한 형태는 코어 재량 — 계약만 지켜지면 됨):

```python
# secu_agent/agent/fanout.py (또는 인접 모듈)
WorkerCompletionObserver = Callable[["FanoutTarget", "WorkerSpec", "WorkerCompletion", bool], None]
# 인자: (target, spec, completion, ok)  — ok = 기존 release() 에 넘기는 success 판정과 동일 값

def register_worker_completion_observer(fn: WorkerCompletionObserver) -> None: ...
def unregister_worker_completion_observer(fn: WorkerCompletionObserver) -> bool: ...
```

계약:

1. **발화 지점**: `run_fanout`의 completion 분류 직후, `release()` 호출과 독립적으로 — completion당
   **정확히 1회**, valid/invalid(`WorkerResultInvalid`) **모두** 발화. (확인 지점: fanout.py:208-247의
   completion 루프, worker_pool.py:393-401의 result 파싱.)
2. **예외 격리**: observer 예외는 log 후 삼킴 — 팬아웃/release 흐름에 절대 영향 없음
   (candidate_counter 훅의 "deepcopy·예외 log" 전례: candidate_ledger.py:249-278).
3. **미등록 시 무변화**: observer 0개면 기존 동작과 바이트 단위 동일.
4. **의존 방향**: 코어는 스킬을 모름. DB/telemetry 로직 반입 금지. 호출은 동기, 순서/재시도 보장 없음.
5. observer가 받는 정보로 충분한 이유: 스킬 부모(adapter.build_spec)가 `spec.env["SA_ATTEMPT_ID"]`에
   상관관계 id를 심고, sink가 spec에서 도로 꺼낸다 — **코어는 attempt_id 개념을 모른다**.

## ASK-2: `WorkerResult` additive 필드

```python
# secu_agent/agent/schema/worker_result.py (ConfigDict(extra='forbid') 모델, :72-89)
completion_reason: str | None = None   # 정규화된 종료 사유 (기존: summary 문자열에만 존재)
metrics_version: int | None = None     # (선택) candidates 계수 시맨틱 버전 — 후일 단위 변경 대비
```

- **동기**: 지금 reason은 worker_result 스키마에 없어 summary 문자열 파싱뿐이고, 도메인 워커들이
  `_INCOMPLETE_REASONS` 분류표를 각자 복붙해 갖고 있다(github_task_worker.py:25-28,
  dev_web_task_worker.py:98-101). 스키마 승격으로 단일 어휘화.
- **값 어휘 권고** (코어가 상수로 소유, 미지값은 통과): `end_turn | contract_violation | max_tokens |
  cancelled | timeout | crash | no_completion | unknown`.
- **writer**: 코어 CLI 워커 경로는 `completion.reason`을 매핑해 채움. 스킬 워커측 writer는 스킬이 채움(별도 작업, digisecu측).
- **⚠️ 락스텝(v3.90과 동일 규칙)**: `extra='forbid'`라 **신 필드 쓴 결과를 구 코어 reader가
  fail-closed** 처리. → **코어 먼저 배포**. v3.90 때문에 어차피 재빌드 전까지 라이브 워커 금지
  상태이므로, **이번 재빌드 창에 같이 실리면 추가 배포 이벤트 0**. 이 창을 놓치면 별도 락스텝 필요.

## 수용 기준 (적대검증 타깃)

1. observer가 valid/invalid/missing completion 각각에서 정확히 1회 발화, 예외 삼킴+log 확인,
   미등록 시 기존 스위트 무영향(green 유지).
2. WorkerResult 왕복: 구 파일(필드 없음) → 신 코어에서 None으로 파싱, 신 파일 → 신 코어 정상,
   신 파일 → 구 코어 fail-closed(락스텝 문서화 근거) 테스트.
3. 코어 → 스킬 import 0건 유지 (의존 방향 보존).
4. 코어 전체 스위트 green.

## 비목표

DB 적재·재큐·정책 판단의 코어 반입(전부 스킬/게이트웨이 몫) · chat 경로 변경 없음 ·
FanoutReport/PlanResult 집계 변경 없음(관측은 per-completion 원본으로 충분, 합계는 소비자가 GROUP BY).
