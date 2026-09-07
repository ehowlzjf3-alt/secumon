# CORE-ASK: 무인(run_agent) 워커의 scoped destructive-tool 사전승인

> 요청자: digisecu 스킬 세션 (secu-agent-skill / confluence browser 스캔 E2E)
> 대상: secu-agent 코어 세션
> 상태: 설계 근거 검증 완료 (진단 ALL_CONFIRMED + 적대적 안전검토). 코어 구현 요청.
> 검증: opus ultracode 워크플로우 (진단검증 / 설계옵션 / 안전 3병렬 + 종합), 전 주장 file:line 대조.

## 0. 한 줄 요약

무인 `run_agent` 워커(confluence/dev_web/smb 스캔 에이전트)가 **명시적·operator 상한·감사되는** 소수의 destructive 툴(예: 브라우저 내비게이션)을 쓸 수 있게, **기존 `ApprovalResolver` seam에 scoped `AutoApproveResolver`를 주입**하는 코어 기능을 요청합니다. 권한 결정 로직(base.py/invoker.py)은 **한 줄도 안 바꿉니다**. 기본값은 오늘과 byte-for-byte 동일(fail-closed).

## 1. 문제 (왜 필요한가)

confluence는 REST API가 관리자 정책으로 rate-limit 0 이라, **브라우저로만** 스캔 가능합니다. 브라우저 접근에는 다음이 필요합니다:
- `browser_session`(세션 시작), `browser_action`(navigate/login) — 둘 다 `is_destructive=True`.

그런데 무인 워커에서 이들이 **항상 거부**됩니다. 우회책으로 `web_site_sweep`(is_destructive=False, 내부에서 로그인+내비게이션)을 썼으나, confluence의 페이지목록 URL을 안정적으로 못 엽니다(로그인 리다이렉트가 target URL을 홈으로 덮음). 반면 **직접 `browser_action(navigate)`는 확실히 동작**함을 프리미티브로 확인했습니다. 즉 무인 워커가 최소한의 read-only 브라우저 내비게이션을 쓸 수 있으면 깔끔히 풀립니다.

## 2. 검증된 진단 (all confirmed, file:line 대조)

파이프라인 순서: **check_permission → approval(`_apply_decision_with_approval`) → abort-check → evaluate_tool_policies(C2-a, block-only) → execute.**

1. **destructive → ask**: `Tool.check_permission` 기본이 `is_destructive=True`면 `PermissionDecision(behavior="ask", reason="destructive tool")` 반환 — `agent/tools/base.py:140-146`.
2. **resolver 없으면 fail-closed**: `agent/tools/invoker.py:68-73` — `_apply_decision_with_approval`에서 `behavior=="ask"`이고 `context.approval_resolver is None`이면 `ToolError(kind="permission", "approval required: ...")`. (resolver가 있어도 `resolve()`가 None/deny면 동일하게 fail-closed — `invoker.py:89-92`.)
3. **run_agent 경로엔 resolver 없음**: `GuardedHarness`가 `ToolContext(evidence_dir, audit_log, llm_client)`만 생성 — `agent/harness/runner.py:81-85`. `approval_resolver`는 기본 None(`base.py:104`), `engine.run_query`도 미지정. resolver는 **인터랙티브 4경로에서만** 주입: `knox/bridge.py:164`, `agent/chat_repl.py:242 & 289`(Terminal), `web/routes/chat.py:1205`(WebSocket). 어느 것도 GuardedHarness에서 도달 불가.
4. **unlock 목록은 surfacing이지 approval 아님**: `agent/skills/__init__.py:367-387`의 `unlock_default_tools_for_skills`는 `context.unlocked_tools.add()`만 — 툴 노출/호출가능성에만 쓰이고(`tool_search_tool.py`, `skill_tool.py`, `engine.py:937-939`), **권한 경로엔 미참조**(invoker.py에 `unlocked_tools` 참조 없음). destructive 툴을 unlock 해도 ask 게이트 그대로. (코어 `_DEFAULT_UNLOCK_TOOLS_BY_SKILL`은 `{}`; 스킬이 `register_skill_unlock_tools`로 채움.)
5. **SA_AUTONOMOUS_TOOLS는 필요조건이지 충분조건 아님**: `invoker.py:138-150`의 `is_autonomous_tool_allowed` 조회는 `context.metadata['schedule_origin']` 하에서만, 그리고 **deny 정련**일 뿐(통과해도 그 뒤 check_permission→ask→resolver None→fail-closed). `autonomy.py:26-28`은 순수 멤버십 테스트. ⇒ **어떤 destructive 툴도 resolver 없이는 어디서도 실행 불가.** `autonomy.py:7-9` 도크스트링("그 도구만 무인 실행 허용")은 **과장 — 코어가 정정 필요**.

## 3. 요청 (Option C, hardened)

**기존 `ApprovalResolver` seam에 scoped·auditing `AutoApproveResolver`를 주입.** 권한 결정 파이프라인 무변경, per-run 스코프, 기본 fail-closed.

### 메커니즘 (end-to-end)
1. **`AutoApproveResolver(contract, audit)`** — 기존 `ApprovalResolver` 프로토콜(`agent/tools/approval.py:32`) 구현. `resolve(request)`는 `request.tool_name` **AND** `request.tool_input`이 명시적 per-call predicate를 만족할 때만 `ApprovalDecision(behavior='allow', reason='autonomous allowlist', updated_input=None)` 반환; 아니면 **None → 기존 fail-closed**(`invoker.py:89-90`). **모델이 준 `updated_input`은 절대 반영 안 함** — operator/스킬이 검증한 원 input이 그대로 흐름(confused-deputy 방지).
2. **action/input 스코프 predicate** (툴이름만으로는 부족). `browser_action`은 안전(navigate/read)+destructive(fill/click/press/submit)를 **한 툴에 묶음** — predicate가 action/input을 검사해 **read-only 서브셋만** 허용. never-auto-approve 목록의 툴은 생성자에서 name-reject.
3. **operator가 상한 보유**: 유효 allowlist = (per-run/스킬 선언) ∩ (operator `SA_AUTONOMOUS_TOOLS`). 스킬은 **좁힐 수만** 있고 넘을 수 없음; operator env 비면 무조건 deny. 생성자가 결과 집합 non-empty 검증, `*`/wildcard 거부, 모든 항목이 `is_destructive=True`인지 assert.
4. **`GuardedHarness.__init__`에 `autonomous_approved_tools: frozenset[str] = frozenset()`** 추가. non-empty일 때만 resolver를 `self.audit`에 바인딩해 `self.context.approval_resolver` 설정(`runner.py:81-85`). **기본 empty → resolver None → 오늘 동작 그대로.**
5. **`run_agent`(secu-agent-skill/service/agents/runtime.py)에 `autonomous_approved_tools` 파라미터** 추가·전달. confluence/dev_web 호출자는 **최소 read-only 브라우저 셋만** 전달.
6. **감사**: 모든 auto-approval은 **사람 승인과 동일 shape**의 `approval_audit`/`AuditLog` 레코드(스코프=worker/charter/skill id, 툴명, resolved input, reason, ts)를 harness의 SHA256-chained AuditLog에 기록.
7. **하위 게이트 전부 독립·downstream 유지**: `evaluate_tool_policies`(C2-a, block-only, `invoker.py:168-173`) 승인 후에도 실행돼 veto 가능; `apply_egress_gate`(수신 allowlist+redact/scan+dry-run), masking, url_safety는 ask 게이트와 별개로 그대로; `schedule_origin` deny 정련(`invoker.py:138-150`)은 그대로 둠.

### 왜 A/B 아니라 C
- **A (SA_AUTONOMOUS_TOOLS→allow)**: process-global, per-worker 스코프 불가, invoker에 두 번째 allow-branch 추가(schedule_origin 분기와 lockstep 유지 부담).
- **B (per-skill 레지스트리)**: 스킬 식별자를 ToolContext에 스레딩 + invoker allow-branch 추가.
- **C**: **권한 결정 로직 0줄 변경**, 생성자 인자로 per-run 스코프(같은 프로세스 두 워커가 다를 수 있음), 기본 fail-closed. B의 per-skill 선언을 **C의 데이터 소스**로 먹일 수 있음(스레딩 없이).

## 4. 안전 가드레일 (코어가 유지해야)

- **기본 fail-closed**: 명시적 operator 그랜트 없으면 headless 경로는 여전히 "approval required". 새 allow는 순수 additive·opt-in, 기본 `frozenset()`.
- **operator 권위 > plugin**: 유효 그랜트는 operator env(SA_AUTONOMOUS_TOOLS/SA_DELIVERY_AUTOSEND_SINKS 패턴)로 상한. 스킬은 좁히기만. unlock/surfacing과 approval/execution은 **절대 병합 금지**.
- **action/input 단위 최소권한**: `browser_action`의 read-only 서브셋만; host_write/edit/copy/move·terminal·deliver의 위험 action은 이름으로 도달 불가.
- **모든 auto-approval 감사**: 사람 승인과 동일 레코드. 귀속·영속되는 승인 이벤트 없이 destructive 실행 없음.
- **§6 게이트 독립·downstream**: egress(수신 allowlist+redact+PII/secret scan+dry-run)·masking·url_safety는 ask 통과와 무관하게 그대로 실행. 사전승인은 **오직 'ask'만** 해제.
- **C2-a는 block-only·최종 veto**: 합성 승인 결정 뒤에도 `evaluate_tool_policies` 실행; 파이프라인에 allow-override 도입 금지.
- **프롬프트 기반 승인·모델 input 확장 금지**: 그랜트는 operator config+선언 계약에서 harness 생성 시 해석 — 모델 출력이나 스캔/공격자 제어 콘텐츠에서 절대 안 옴(§6 no prompt-marker). resolver는 모델 `updated_input` 미반영.
- **schedule_origin deny 정련 유지**: 새 allow가 이를 제거·반전하면 안 됨.
- **sub-agent 미상속**: 그랜트는 생성 worker/charter 한정, spawn된 sub-agent에 상속 안 됨(재그랜트 필요) — 스캔한 confluence 문서의 프롬프트 인젝션이 destructive 툴을 못 몰게.
- **never-auto-approve (생성자에서 hard reject)**: `deliver`/모든 egress(오직 SA_DELIVERY_AUTOSEND_SINKS+egress_gate로만); `browser_action`의 fill/click/press/submit, file_upload/form_input, credential/secret/auth 입력; terminal/run_in_sandbox 임의 명령; host_write/host_edit; file/host delete·host_move; evidence_dir 밖 host_copy; permission/ACL/config/CLAUDE.md/register_tool_policy/autonomy/egress-allowlist 변경(self-grant); enter/exit_plan_mode·안전플래그 토글; input이 모델/스캔 콘텐츠 파생인 모든 툴.

## 5. 코어가 결정할 것 (open questions)

1. **브라우저 action-level 세분화**: MVP predicate가 `browser_action`/`browser_session` input을 검사해 navigate/read만 허용? 아니면 코어가 **전용 read-only 브라우저 툴**을 노출해 툴이름 단위로 안전하게? (⚠️ `{browser_session, browser_action}` 통째 그랜트는 never-auto-approve와 충돌 — 구현 전 반드시 해소.) **참고: confluence는 `browser_action(navigate)` + SSO 로그인(`login` action은 .env 자격을 툴 내부에서 fill — 모델 input 아님)이 필요. 이 두 경우를 어떻게 predicate에 담을지 코어 판단 요청.**
2. **operator-vs-skill 권위**: SA_AUTONOMOUS_TOOLS가 하드 상한이고 per-run 리스트와 교집합? operator env 비면 스킬 선언 있어도 하드 deny? 소유 주체?
3. **per-run allowlist 데이터 소스**: B의 per-skill 레지스트리 / run_agent 인자 / 둘 다? least-privilege 리뷰 책임(스킬 저자 vs operator)?
4. **생성자 assertion**: 모든 항목 `is_destructive=True` 강제 + never-auto-approve 이름 거부? 라이브 registry 대조 시점?
5. **sub-agent 스코프 미상속** 확인.
6. **감사 스키마·저장소**: `state.py approval_audit` vs `runner.py AuditLog` — auto/human 승인 동일 쿼리 가능하게. 합성 ApprovalRequest 표현.
7. **staleness/만료**: 커밋된 per-skill 그랜트에 주기적 operator 재확인 필요? 아니면 per-deploy operator env만?
8. **도크스트링 정정 소유**: `autonomy.py:7-9` 과장 표현 정정.

## 6. 스킬측 사용 (코어 반영 후)

- `run_agent(..., autonomous_approved_tools=frozenset({...최소 read-only 브라우저 셋...}))`으로 confluence space_browser 워커 호출.
- confluence 계약을 `web_site_sweep` 우회 대신 **직접 `browser_action(navigate)` + `browser_query`(읽기)** 로 되돌림(프리미티브로 동작 확인된 방식).
- operator env(SA_AUTONOMOUS_TOOLS)에 해당 셋 등록(상한).

---
검증 워크플로우: `.../workflows/scripts/browser-autonomous-approval-core-ask-wf_c0949106-089.js` (진단검증 ALL_CONFIRMED, 설계 A/B/C 비교, 안전 적대검토). 이 문서의 file:line은 전부 대조 확인됨.
