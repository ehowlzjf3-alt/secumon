# 도메인 안전 하중 (엔진 CONTRACTS.md 워커 계약 8항에서 이관)

엔진 de-domain 시 CONTRACTS.md 의 도메인-특정 안전 세부를 여기로 옮김.
**efficiency-audit 에서 KEEP 확정된 하중 — 재부착 시 뒤집지 말 것.**

> **인덱스 (v3.81 재배치 후)**: 도메인 skill 번들 재배치로 아래 하중을 도메인별
> `safety.md` 에 **문구 그대로** 분배했다 — 이 파일은 인덱스로 유지(KEEP #2).
> - SMB → `domains/smb/safety.md` (lockout 흐름·claim 단위·anti-patterns)
> - web → `domains/web/safety.md` (SSO 서킷브레이커·default-cred opt-in·url_safety scope 게이트)
> - services → `domains/services/safety.md` (공통 read-only·charter·credential record-only)
> 아래 원문 절은 변경 없이 그대로 둔다(중복은 의도 — 분배본과 인덱스 양쪽 보존).

## SMB

- **`_AUTH_DISABLED_REASON`** (agent_types/smb.py, 프로세스 전역 플래그): 인증 실패/
  lockout 의심 시 세팅 — 같은 호스트 재시도 차단. 해제는
  **`reset_auth_lockout_flag()` 로 scan 사이클 시작 시에만** — **agent 호출 금지**
  (상세: `skills/smb_tasking/safety.md`).
- **file-level claim 금지** — 같은 호스트에 connection N개 = 로그인 N회 =
  account lockout 위험 (`_AUTH_DISABLED_REASON` 프로세스 전역 플래그와 충돌).
  claim 단위는 **host/subnet**.
- guest/anonymous + 운영자 등록 자격증명만. brute force 절대 금지.

## web

- **SSO 서킷브레이커** (`browser_tool.py` `_SESSION_STATE` 의
  `login_fail_streak`/`login_halted`): halt 후 in-process 복귀 경로 없음 —
  **프로세스 종료로만 리셋**. 이것이 엔진의 warm worker pool 금지 근거
  (KEEP — 코어 CONTRACTS.md 워커 계약 8항). browser_tool 은 코어 잔류라
  이 차단기 자체는 엔진에 있음. plugin 의 web 점검 도구는 이 차단기를
  우회하는 별도 로그인 경로를 만들지 말 것.
- 기본자격(default-credential) 검사는 opt-in, 기본 off (v3.79 ③-H1).
- scope 게이트/하드블록은 코어 `url_safety.py` 소유 — plugin 에서 완화 금지.

## 공통

- read-only 점검. charter_ref 없는 점검 활동 금지.
- PII 마스킹 — raw evidence 는 evidence_dir 격리.
