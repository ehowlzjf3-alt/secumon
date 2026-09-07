# agent/ 컨트랙트 중앙 스펙 (v3.80 1주차-#1)

> 01 리포트 진단: "컨트랙트 철학 비일관 — 5개 메커니즘의 halt/suppress/queue/allow
> 의미가 코드 주석에만 산재, 중앙 스펙 부재". 이 문서가 그 중앙 스펙이다.
> 코드와 어긋나면 **코드가 아니라 이 문서를 의심하고 둘을 함께 고칠 것**
> (goal 전이 매트릭스만 예외 — tests/test_goal_state_transitions.py 가 일치를 강제).

## 용어

| 분류 | 의미 |
|---|---|
| **advisory** | 위반해도 벌점 없음 — reminder 주입/기록만, 캡 도달 시 무벌점 통과 |
| **escalating fail-closed** | reminder N회 후 위반 확정 → `LoopError` + `LoopCompleted(reason="contract_violation")` 로 turn 강제 종료 |
| **직접 suppression** | reminder/escalation 없이 출력 자체를 즉시 차단 (상태 변경 없음) |
| **mixed** | 조건에 따라 fail-closed 차단과 allow 가 공존 |
| **fail-closed (결과 계약)** | 결과물 누락/손상 = 실패로 판정 (성공으로 못 읽음) |

## 한눈 표 — turn 단위 컨트랙트 6종

| 메커니즘 | 트리거 | 진입점 | 캡 (QueryConfig) | 캡 도달 시 | 분류 |
|---|---|---|---|---|---|
| plan_contract | text-only 응답 + `plan_mode_active` & status ∈ {approved, executing} | `engine._build_plan_contract_reminder` → text-only 분기 | `max_plan_contract_reminders=2` | **무벌점 fall-through** (다음 컨트랙트 검사로) | advisory |
| finding_followup | text-only 응답 + 미해소 finding signal + todo 도구 등록됨 | `finding_followup.build_finding_followup_reminder` → engine text-only 분기 | `max_finding_followup_reminders=3` | `LoopError` + `contract_violation` | escalating fail-closed |
| candidate_ledger | text-only 응답 + `candidate_ledger_enforce` + 후보 seen>0 & submitted==0 & triaged==0 + `triage_candidates` 도구 등록됨 | `candidate_ledger.build_candidate_ledger_reminder` → engine text-only 분기 | `max_candidate_ledger_reminders=2` | `LoopError` + `contract_violation` | escalating fail-closed |
| execution_contract | text-only 응답 + active todo(pending/in_progress) 잔존 | `execution_contract.build_execution_contract_reminder` → engine text-only 분기 | `max_execution_contract_reminders=3` | `LoopError` + `contract_violation` | escalating fail-closed |
| turn_contract | 같은 assistant 메시지에 tool call + "사용자 응답 요구" 텍스트 공존 | `turn_contract.should_emit_text_before_tool_calls` → engine tool-call 분기 | (캡 없음) | — | 직접 suppression |
| schedule_contract | due schedule row 실행 직전 (세션 생성 전) | `schedule_contract.evaluate_schedule_fire` ← `scheduler_tick._intent_decision` | (캡 없음) | — | mixed |

공통 사실:
- 캡은 env 가 아니라 `QueryConfig` 필드 (`engine.py`; 호출부 `chat_session.py` 구성).
- text-only 분기의 검사 순서는 **plan → finding_followup → candidate_ledger →
  execution** 고정.
  reminder 주입은 user message append + 같은 turn 루프 continue (turn 카운트 소모).
- reminder 카운터는 `context.metadata` 의 `*_reminder_count` — turn 간 누적,
  세션 메타데이터 수명을 따른다.

### 메커니즘별 주의 (01 리포트 caveat 반영)

**plan_contract** — escalation 이 없다. 캡 도달 후엔 조용히 통과하고
finding/execution 검사가 이어받는다. plan 강제는 reminder 2회가 전부.

**finding_followup** — `todo` 도구가 레지스트리에 없으면 빌더가 None 을 반환해
**계약 자체가 비활성**이다 (도구 구성이 곧 계약 on/off 스위치). reminder 는
deep-dive 도구 호출을 강제하고, 라이브 pivot endpoint 가 기록돼 있으면 강조한다.

**candidate_ledger** — 침묵(과소보고) 방지 문. evidence judge(submit_finding)가
"제출한 허풍"을 막는 문이라면, 이 계약은 "후보를 보고도 제출·기각 0 인 침묵"을
막는다 (gpt-oss 급 모델의 비대칭 인센티브: 제출=기각 위험, 침묵=무벌칙 → 이 문이
침묵에 벌칙을 만든다). 장부는 `metadata["candidate_ledger"]`
(seen/submitted/triaged/sources/samples): 코어 도구는 직접 기록(scan_text hit →
seen, submit_finding 성공 → submitted, triage_candidates → triaged), 도메인
plugin 은 `register_candidate_counter` 로 자기 도구 결과 counter 를 등록
(invoker 가 ToolSuccess 후 실행 — 도구 코드 0줄, 입력 deep-copy, 예외 격리).
enforce 는 `metadata["candidate_ledger_enforce"]` opt-in — **워커 cli 만 set**
(`SA_CANDIDATE_LEDGER=0` kill-switch, 계약 metadata 의 명시적 False 존중),
chat/operator 경로는 미설정이라 비발동. `triage_candidates` 미노출 toolset
(skill lockstep 전 도메인)에서도 비발동 — 이행 불가능한 요구 금지. 기각된
submit(ToolError)은 부채를 해소하지 못한다. **terminal 경로에도 동일 게이트**:
set_status 류가 terminal 인 워커(github/confluence)의 "침묵한 채 set_status(done)"
우회를 막는다 — 단 terminal 은 이미 성공한 실제 작업이므로 캡 도달 시
contract_violation 이 아니라 **완료 허용**(부채는 worker_result 지표로 부모가
판정). text-only 경로와 리마인더 캡 공유. 워커는 종료 시
`worker_result.candidates_seen/candidates_accounted` + summary 로 부모에
전파 — accounted=0 침묵은 "clean" 이 아니라 재점검 신호다.

**execution_contract** — 현재는 escalating (즉시 차단 아님). 01 #7 의
deterministic 즉시차단 모드는 opt-in 조건부 트랙으로 **미구현** —
`max_execution_contract_reminders` 의미를 바꾸는 변경은 breaking change.

**turn_contract** — escalation 없는 직접 suppression 이라 별도 분류.
UI 로 가는 `TextChunk` 만 억제하고, **history 의 assistant 메시지엔 텍스트가
보존**되며 tool 실행은 그대로 진행된다. 판정은 구조적 패턴 총 7종(한국어 위주
6종 + trailing `?` 1종)이지 품질 점수가 아니다.

**schedule_contract** — "advisory-only" 가 아니라 **mixed**:

| 조건 | reason | 판정 |
|---|---|---|
| `schedule_kind != self_wakeup` | `ready` | 항상 실행 (legacy/운영자 생성 보존) |
| active turn 진행 중 | `active_turn` | 차단 — 단 **dead parameter**: 호출부가 전달하지 않아 항상 False. 01 #6 트랙(`chat_has_active_turn` 신설) 전까지 죽은 가드 |
| `expires_at` 경과 | `expired` | 차단 (fail-closed) |
| source session 부재 | `source_missing` | 차단 (fail-closed) |
| `stale_policy=run` | `ready` | 실행 |
| `skip_if_superseded` + boundary 부재 | `source_boundary_missing` | 차단 (fail-closed) |
| `skip_if_superseded` + 이후 user 메시지 존재 | `superseded` | 차단 |
| `confirm_if_superseded` + 이후 user 메시지 존재 | `confirmation_required` | fire status **`queued`** — resume 경로 없음 (기록용 advisory) |
| 미지 `stale_policy` | `invalid_policy` | 차단 (fail-closed) |

차단 시 fire 기록: `confirmation_required` → status `queued`, 그 외 → `skipped`
(summary 에 `reason — detail`).

## goal 상태전이 (v3.80 1주차-#2)

status 는 **bare string** (enum 금지 — 문자열 비교 호출부와 JSON 직렬화 보존,
01 #2 caveat). 명시 스펙은 `state.GOAL_STATUS_TRANSITIONS`:

```
active  → paused | done | cleared
paused  → active | done | cleared
done    → (terminal)
cleared → (terminal)
```

- **전이 보호 주체는 각 전이 함수의 단일 UPDATE WHERE guard** (autocommit, 원자).
  `validate_goal_status_transition()` 은 신규 전이 코드/스펙 질의용 — 기존 함수에
  read-modify-write 를 끼우지 않는다. SQL↔매트릭스 일치는
  `tests/test_goal_state_transitions.py` 가 강제 — 전이 함수 4종의 4×4 전수
  + `goal_set` CTE 스윕(비terminal → cleared) + zombie 복구 escape hatch.
- **rowcount=0 (반환 False) = "이미 다른 경로가 전이함"** (동시 세션·사용자
  cancel·goal tool). race 자체는 WHERE guard 가 안전하게 처리하므로 추가 조치는
  불필요하되, **침묵 금지**: ralph_controller 는 `_goal_pause_checked` /
  `_goal_mark_done_checked` 래퍼로 warning 로그를 남긴다 (이벤트/시스템노트는
  기존 동작 유지). 신규 호출부도 반환값을 버리지 말 것.
- `goal_get_active` 는 미지 status 를 error 로그로 가시화하되 row 는 그대로
  반환한다 (호출부의 `!= "active"` guard 가 paused 처럼 안전 취급).
- **복구 escape hatch**: `goal_set`/`goal_clear` 는 `NOT IN (done, cleared)`
  스윕이라 미지(손상) status 의 zombie row 도 cleared 로 회수할 수 있다 — 의도된
  복구 경로이며 매트릭스 위반이 아니다.

## goal 턴 기록 + 종료 안전장치 (v3.81 T1a)

`state.goal_record_turn(parse_fail=, progress=)` streak 시맨틱 — **None = 보존**:

| 턴 종류 | parse_fail | progress |
|---|---|---|
| judge 평가 성공 | `False` (리셋) | `flips>0 ∨ new_items` → True(리셋), 아니면 False(+1) |
| judge 에러/파싱 실패 | `True` (+1) | `None` (보존) |
| 게이트 턴 (judge_every 스킵) | `None` (보존) | `None` (보존) |

- **게이트 턴은 streak 을 건드리지 않는다.** False 로 리셋하면 judge_every>1
  에서 parse-fail 3x 탈출구가 영구 미발동 (termination_gap 원인이던 버그).
- **무진전 안전 종료**: 연속 judge 턴 `flips==0 ∧ added==0` 가
  `SA_GOAL_NO_PROGRESS_LIMIT`(기본 3, `0`=비활성 — termination_gap 재개방이므로
  운영자 명시 선택만)회 누적 시 GoalPaused. `max_turns=0`(무제한) goal 의
  in-loop 안전망. goal 도구는 checklist 를 직접 수정할 수 없으므로
  flips/added 불변 ⟹ pending 불변이 함의된다.
- **new_items dedup + 크기 상한 (audit #5)**: `apply_evaluate` 는 judge 의
  new_items 를 기존 항목/서로 간 정규화 텍스트로 dedup 하고 체크리스트를
  `SA_GOAL_CHECKLIST_MAX`(기본 100) 이하로 유지한다. `added`(=`len(new)-len(old)`,
  flip 은 in-place 라 길이 불변)가 진전 판정에 쓰인다. judge 가 같은 항목을 반복
  재방출하거나 distinct 항목을 무한 추가해 무진전 종료를 무력화하던 갭을 닫는다.
  운영자는 큰 목표를 위해 상한을 올릴 수 있다.
- 결정론 종료(claim None ∧ 활성 0)는 T1d fan-out 어댑터에서 구조 복원 —
  T1a 는 judge 무관 임시 안전종료.

## delivery egress 게이트 (v3.81 T2 — `agent/delivery.py`)

> 코어 = `deliver(sink_id, payload)` 프로토콜 + egress 게이트. sink 어댑터 =
> 등록형(`register_delivery_sink`, 중복=명시 에러) — plugin/skill 소유,
> Knox Mail(`knox/mail_sink.py`, KEEP 채널)만 코어 기본 등록.

1. **dry-run 기본.** 어떤 send 도 기본은 draft(evidence_dir) + audit 기록 —
   외부 egress 없음. 에이전트 진입점은 `deliver` 도구 (operator 전용).
2. **자율발송 4조건 (전부 충족, fail-closed):** ① sink 가
   `SA_DELIVERY_AUTOSEND_SINKS` opt-in ② `SA_DELIVERY_AUTOSEND_CHARTERS`
   설정 시 charter_ref 일치 ③ `SA_DELIVERY_RECIPIENT_ALLOW` **설정 + 전
   수신자 매칭** (미설정 = 자율발송 전면 불가 — allowlist 없는 egress 금지)
   ④ 마스킹 후 secret/PII 스캔 잔존 0 (스캐너 죽으면 scan_error 로 차단).
3. **강제 마스킹.** sink.send 는 redact(env 값 + 패턴) 통과한 payload 만
   받는다 — perimeter 는 deliver(), 어댑터 신뢰 불요. 평문 secret/PII 금지
   (유형·분류만 기술) 정책의 egress 층.
4. **검증** (owner_mail 일반화): TO 필수, 제목/본문 비공백 — 위반은
   DeliveryError (도구 validation 에러).

## v3.80 워커 계약 (구현: `agent/worker_pool.py` — Slice1)

> 풀 구현은 `agent/worker_pool.py` (Slice1 — 롤링 as-completed, **spec 당
> WorkerCompletion 정확 1개** invariant, claim 예외 시 활성 워커 drain 후
> 재전파). 결과 스키마/reader 는 `schema/worker_result.py` (Slice0d).
> 첫 소비자 = AgentTool (v3.81 T1b, k=1 dynamic subagent — 워커는
> `cli.main` 이 worker_result.json 을 모든 종료 경로에서 작성, SIGTERM
> grace 는 error_cancel 기록, 재귀는 `SA_AGENT_DEPTH`/`SA_AGENT_MAX_DEPTH`
> 로 제한). 루프 레벨 batch fan-out 은 `agent/fanout.py` (v3.81 T1d).
> 설계 원문: `docs/design/v3.81-de-domain-autonomy.md` (T1d). v3.80 원 설계 문서는 git history.

### fan-out 어댑터 계약 (v3.81 T1d — 재부착 plugin API 첫 조각)

`agent/fanout.py`: 코어 = `run_fanout` 기계 + 어댑터 레지스트리
(`register_fanout_adapter`, 중복 등록 = 명시 에러). 도메인 = `FanoutAdapter`
프로토콜 구현 4-hook 만: `claim_next / build_spec / release / summarize`.

> **plugin API 전체 표면 (v3.85 클린 플러그인 호스트).** `register_fanout_adapter`
> 는 이제 넓은 `register_*` 훅 집합의 하나다 — 워커 도구셋/실행계약, task_type 별칭,
> finding enricher/followup hint, category evidence judge/PII 정책, web 라우터/target
> 추출, timeline entity 축, index 렌더러 등. 전부 중복=명시 에러, 코어 상주 기본값도
> 같은 훅으로 부트스트랩 등록. 목록·불변식은 `docs/design/v3.85-clean-plugin-host.md`.

1. **claim 은 어댑터(부모) 단독, 순차 1회씩** — 워커는 claim 안 함 (계약 1 동일).
2. **타깃 = 1 turn**: 완료당 `goal_record_turn` 정확 1회,
   `parse_fail=None, progress=None` — **judge streak 비간섭** (T1a 표 참조).
3. **fail-closed**: invalid 결과/타임아웃/취소 = 실패 집계 +
   `release(success=False)` (어댑터가 claim 해제 → 재점검). release 예외는
   로그만 — stale reclaim 백스톱 몫.
4. **결정론 종료**: claim None ∧ 활성 0 → `report.exhausted=True` — 루프
   통합부가 judge 없이 GoalDone 을 결정론으로 박는 신호 (T1a 의 구조 복원).
5. **예산**: `max_targets`(=K_eff) 도달 시 claim 중단 = `budget_capped`
   (예산 초과 자체 불가능, F4). 취소는 cancel_event → SIGTERM 전파,
   완료 전부 yield 후 `cancelled`.
6. **컨텍스트 경계**: 부모는 FanoutReport 집계만 받는다 — 워커 transcript
   금지. UI 는 경량 `WorkerCompleted` 이벤트.
7. **완료 관측 훅(v3.90 후속)**: `register_worker_completion_observer(fn)` —
   `run_fanout` 이 completion 당 **정확 1회** `fn(target, spec, completion, ok)`
   호출(valid/invalid/missing 전부, build_spec 예외로 워커 미기동한 경우는
   제외 — completion 이 아니므로). release 와 독립, observer 예외는 log 후
   삼킴(팬아웃 흐름 무영향), 미등록 시 byte-for-byte 동일, 재등록은 idempotent.
   코어는 sink 로직/DB 를 모른다 — skill 이 `spec.env` 상관관계 id 로 자기
   read-model 에 영속(candidate 침묵 read-model 전제). `WorkerResult` 는
   additive 필드 `completion_reason`(정규화 종료 사유·`COMPLETION_REASONS`
   권고 어휘·미지값 통과) / `metrics_version`(candidate 계수 시맨틱 버전)을
   갖는다 — 구 워커는 None(하위호환), 신 필드는 `extra='forbid'` 라 구 코어가
   fail-closed → **락스텝: 코어 먼저 배포**.

1. **워커는 claim 하지 않는다.** 타깃 claim 은 부모 orchestrator 단독
   (`*_claim_next` 원자 UPDATE). 워커가 어떻게 죽든 미완료 claim 해제도 부모 몫.
2. **결과 채널은 `worker_result.json` 하나, fail-closed.** 누락/1MB 초과/파싱
   실패/스키마 위반 = 전부 실패 → 해당 타깃 claim 해제 → 재점검.
   `agent_result.json`(fail-open 보조 채널)과의 비대칭은 의도된 것.
   status 5종(`ok|error_budget|error_crash|error_cancel|timeout`), `ok`↔`rc=0`
   강제. **부모 backstop(SIGKILL)에 죽은 경우는 status 가 아니라 파일 부재
   (reader 의 `missing`)로 표현된다.**
3. **워커의 except/SIGTERM-grace 경로는 `build_worker_result` 사용 의무.**
   `WorkerResult` 직접 생성 금지 — 임의 예외 텍스트가 ValidationError 로 보고
   자체를 증발시키면 부모는 missing(crash 단정)으로 오진한다.
4. **타깃 = 1 turn 불변.** `goal_record_turn` 은 워커 완료당 정확 1회, **부모가**
   기록한다. 워커는 `chat_goal` 에 닿지 않는다.
5. **취소 시맨틱**: signal → 전 워커 SIGTERM → grace 5s (워커가 `error_cancel`
   을 기록할 기회) → SIGKILL → 부모가 미완료 claim 즉시 해제 → goal pause.
6. **컨텍스트 경계**: 부모는 워커 transcript 를 절대 받지 않는다 — summary(≤500자)
   만. 상세는 워커 evidence_dir (`sub-*/`) 에만 남는다.
7. **동시성 캡 K — 실측 기반, 고정 하드캡 아님.** 초기 설계(F12)의 "K ≤ 6
   (DB pool 10 고갈 방지)" 근거는 효율 재심사 PARTIAL-REVERSE #6 이 기각했다:
   pool max_size=10 은 **부모 전용**(워커는 별도 프로세스라 자기 풀), 진짜
   천장은 LLM rate limit / 브라우저 메모리 / PG server max_connections.
   캡은 `SA_PG_POOL_MAX_SIZE` env 화 + WorkerPool 계측 후 실측으로 정하되,
   **보수 시작 K=2** (리스크 #2).
8. **안전 하중 KEEP (뒤집지 말 것, efficiency-audit 확정)**:
   - **warm worker pool 금지** — 코어의 브라우저 서킷브레이커(`browser_tool.py`
     `_SESSION_STATE` 의 `login_fail_streak`/`login_halted`)는 halt 후
     in-process 복귀 경로가 없어 **프로세스 종료로만 리셋**된다. 워커 재사용
     시 타깃1의 차단 상태가 타깃2로 누출 → 조용한 인증 경로 누락.
     fresh-subprocess 가 의도된 격리 경계다. 도메인 plugin 도 같은 종류의
     프로세스-전역 차단기를 가질 수 있다 — 도메인별 세부와 해제 규칙은
     `secu-agent-skill/SAFETY-NOTES.md` 가 소유한다.
   - **claim 단위는 plugin 의 안전 분석이 정한다** — 인증 연결 수가 계정
     잠금(lockout)을 유발할 수 있는 도메인은 자산(호스트)보다 잘게 claim
     금지. 도메인별 확정 단위는 `secu-agent-skill/SAFETY-NOTES.md` 참조.

## 인접 안전장치 (이 문서 범위 밖 — 포인터만)

- **tool_guardrails** (`tool_guardrails.py` + engine 결합): exact-failure /
  same-tool-failure / no-progress 반복 감지 → warn → block/halt
  (`context.signal.set()`). **readonly 동일결과 livelock 을 잡는 유일한 층**
  (efficiency-audit KEEP — 제거 금지).
- **repeat_error_halt / repeat_call_halt** (engine): 동일 (tool, input) 반복 →
  `LoopCompleted(reason="repeat_error_halt"|"repeat_call_halt")`.
- **subagent backstop** (`tools/base.py`): `spawn_subagent` wall-clock 캡
  `SA_SUBAGENT_TIMEOUT_SEC`(기본 600s) — 계층은 내부 idle 120s < wall 300s <
  backstop 600s. `inherit_charter_ref` 가 부모 metadata → env
  `DEFAULT_CHARTER_REF` 순으로 charter_ref 를 상속.
- **scheduler inactivity watchdog** (`scheduler_tick`): turn 무활동 시 중단
  (`'inactivity'`), stop/cancel 이벤트 시 `'cancelled'`.
- **autonomous capability 게이트** (`agent/tools/autonomy.py` + `invoker`/
  `python_exec_tool`): `schedule_origin`(무인) 실행에서 `is_destructive` 도구와
  **python_exec(임의 코드 실행)** 는 기본 차단(fail-closed). 운영자가
  `SA_AUTONOMOUS_TOOLS`(comma-separated 도구명) allowlist 로 **명시 opt-in** 한
  도구만 무인 실행 허용 — **미설정 = 전면 차단**. 대화형(사람 있음) 실행엔 영향
  없다. delivery autosend(`SA_DELIVERY_AUTOSEND_SINKS`)와 동일한 allowlist 패턴.
  python_exec 은 `is_destructive` 대신 `check_permission` 오버라이드로
  게이팅(대화형 allow 유지, 무인만 gate) — process/memory 도구와 같은 방식.
