# services (github/jenkins/confluence) / safety — KEEP 안전 하중

> 루트 `SAFETY-NOTES.md` 공통 절을 분배(문구 보존). services 는 SMB/web 같은 전용 KEEP
> 차단기는 없으나 공통 read-only·scope·마스킹 하중을 그대로 따른다. SSO 로그인은 코어
> `browser_tool` 서킷브레이커(web `safety.md` 참조)의 적용을 받는다.

## 공통 (루트 SAFETY-NOTES.md)

- read-only 점검. **charter_ref 없는 점검 활동 금지.**
- PII 마스킹 — raw evidence 는 evidence_dir 격리.
- 발견한 시크릿·credential·토큰은 **능동 사용/검증 금지** — GET 으로 노출 내용 다시 읽기만(record-only).

## services 특이사항

- **MWG 프록시 우회 직결**: samsungds.net 은 프록시가 차단(403). 에이전트는 직결 접근. 프록시로그는
  discovery(누가 무엇에 접근했나) 용도일 뿐 — 별도 우회 로그인 경로를 만들지 말 것.
- **SSO 로그인**은 코어 `browser_tool(action='login')` 경유 — web `safety.md` 의 SSO 서킷브레이커
  (연속 5실패 → 세션 영구 halt, 프로세스 종료로만 리셋) 동일 적용. plugin 이 이를 우회 금지.
- 이메일/이름/사번 단순 ID-only 는 finding 아님(노이즈) — 진짜 secret/credential 또는 고가치 PII 동반 시만.

## scope

- 외부 아님 — 사내 `github.samsungds.net` / `confluence.samsungds.net` / 사내 Jenkins 만.
- github.com(외부) 호출 금지.
