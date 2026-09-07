# web_tasking / safety — KEEP 안전 하중 (재부착 시 뒤집지 말 것)

> 루트 `SAFETY-NOTES.md` 의 web 절을 **문구 그대로** 분배. 약화/역전 금지.
> 원본 인덱스는 루트 `SAFETY-NOTES.md` 유지.

## SSO 서킷브레이커 (KEEP — 코어 CONTRACTS.md 워커 계약 8항)

- **SSO 서킷브레이커** (`browser_tool.py` `_SESSION_STATE` 의
  `login_fail_streak`/`login_halted`): halt 후 in-process 복귀 경로 없음 —
  **프로세스 종료로만 리셋**. 이것이 엔진의 warm worker pool 금지 근거
  (KEEP — 코어 CONTRACTS.md 워커 계약 8항). browser_tool 은 코어 잔류라
  이 차단기 자체는 엔진에 있음. plugin 의 web 점검 도구는 이 차단기를
  우회하는 별도 로그인 경로를 만들지 말 것.

## 기본자격 검사 opt-in

- 기본자격(default-credential) 검사는 opt-in, 기본 off (v3.79 ③-H1).

## scope 게이트 / url_safety

- scope 게이트/하드블록은 코어 `url_safety.py` 소유 — plugin 에서 완화 금지.
  (`web_tools.py` 가 `secu_agent.agent.tools.url_safety` 를 재import 만 함 — `# noqa: F401`.
  `validate_url_safe`/`_is_internal_host`/`URLSafetyError`/`_probe_web_resources` 는 코어 잔류.)

## 공통 (루트 SAFETY-NOTES.md)

- read-only 점검. charter_ref 없는 점검 활동 금지.
- PII 마스킹 — raw evidence 는 evidence_dir 격리.
- 회로차단기: 연속 5회 로그인 실패 → 세션 내 모든 로그인 영구 중단. 남은 사이트는 skip.

## SKILL.md 내 동행 하중 (요약 — 상세는 SKILL.md 본문)

- 위협모델: 사내(internal) 노출이지 외부 인터넷 노출 아님. "외부 공격자" framing 금지.
- read-only deep-dive: 클릭은 조회/탐색까지, 저장·삭제·전송·쓰기 API 금지.
- strict scope: 사용자/splunk list 밖 hostname 호출 금지(scope hallucination 방지).
