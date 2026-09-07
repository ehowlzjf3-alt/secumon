---
name: smb
description: SMB tasking entry — 안전 룰 + end-to-end 흐름 + resource 가이드. 본 도구 호출 시 반드시 가장 먼저 view.
domain: smb
when_to_use: operator 가 SMB 작업 (subnet 등록 / discovery / walk / fetch+scan / finding 박기) 시작 전. 모호하면 무조건 먼저 view.
triggers: smb; share; shares; 공유; 공유폴더; 파일서버; 파일 서버; 서브넷; subnet; 445; walk_share; re:\b\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}\b
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# smb_tasking — entry

이 skill 은 entry. 상세는 **resources** 로 분리:

| resource | 내용 | 언제 |
|---|---|---|
| `api.md` | `smb` / `state` / `detectors` 시그니처 — 정확한 함수 이름 / 인자 | sandbox 코드 작성 **직전** |
| `schema.md` | DB 테이블 컬럼 | DB 조회 / 영속 |
| `snippets.md` | 검증된 스니펫 (subnet 2-turn, share batch, hit persist) | 코드 시작점 |
| `safety.md` | lockout 흐름 / SMB-specific anti-patterns | 막힘 / 에러 처리 |

로드: `skill(action='view', name='smb_task', resource='api.md')`.

## ⚠ 절대 추측 금지 (라이브에서 반복 사고)

함수 이름 / 인자 추측은 즉시 traceback 으로 잡힘:
- ✗ `state.upsert_smb_scan(...)` (존재 X — 실제 `state.upsert_smb_share`)
- ✗ `add_file_hits(host, share, path, hits)` (실제 `(file_id, hits)`)
- ✗ `smb.enumerate_host(ip)` 단수 (실제 `enumerate_hosts(subnet)` 복수)
- ✗ `for x in smb.list_shares(h)` / `for sa in mm` (둘 다 NOT iterable — `.shares` 필드)

**sandbox 코드 작성 직전 `view resource='api.md'` 호출 — entry 만 보고 함수 추측 X**. API 부정확하면 turn 낭비.

## 노출 namespace

`smb_python` 은 전체 Python 자유 (import OK). 자동 바인딩:
- `smb` — agent_types.smb. SMB I/O 는 이 모듈 통과 강력 권장 — lockout / audit / 인증 mode 가드 다 들어있음.
- `state` — DB helper.
- `detectors` — scan_text.

그 외 stdlib / 3rd-party 는 직접 `import` 하면 됨 (`import re`, `import json`, `import socket` 등).

**주의**: `smb` 우회해서 `import socket` 으로 직접 SMB 호출하면 lockout / audit 가드 빠진다. 이유가 분명할 때만.

---

## 0. 안전 핵심 (먼저 읽고 코드 시작)

**자격증명**: env `SMB_USERNAME` / `SMB_PASSWORD` (web 프로세스가 .env 자동 로드 — agent 가 따로 설정 X).

**3 인증 모드**:
1. **null** = `("", "")` — 익명. anonymous-allowed share 식별.
2. **guest** = `("thisuserisjustguestnotreal", "")` — 존재하지 않는 user + 빈 pw → 서버가 guest fallback.
3. **auth** = env credentials — 사내 도메인.

**AUTH 권한 해석**: `auth` read 는 안전 판정 근거가 아니다. 현재 AUTH 검증은 DSSOC 공용 검증 계정 기준이므로, `auth` 로 읽히는 공유 폴더는 접근 가능 공유로 보고 본문/경로/권한을 검토한다. null/guest 가 막혔어도 `auth` 로 읽히면 "안전"으로 닫지 않는다.

**핵심 함수 선택** (자세한 시그니처는 `api.md`):
- 신규 share discovery + 권한 측정 → `smb.list_shares_modes(host)` 3모드 다 시도 (권장).
- 기존 share walk + fetch → `smb.walk_share` / `smb.fetch_file` (auth-then-guest 자동).
- subnet alive 체크 → `smb.enumerate_hosts(subnet)` (TCP 445, ~5s, 자격증명 무관).
- IP 담당자 조회 → `smb_owner_lookup(ips=[host])` 로 Splunk asset lookup 결과를
  `asset_owner` 캐시에 저장. Finding report와 담당자 메일 발송 기능은 이 캐시를 사용한다.

**Lockout 은 reactive** — agent 가 사전 점검 / `reset_auth_lockout_flag` 호출 X. `smb_python` 도구가 호출 직전 pre-check 함. `STATUS_ACCOUNT_LOCKED_OUT` 응답이 오면 그때 멈춤 + 보고. 상세는 `safety.md`.

**Read-only**: `smb` 모듈 안 fetch 만. write 호출 X.

**Context 폭주 금지**: `print(body)` 절대 X. python-side 에서 hits / 요약만 print. ≤512KB → 100K+ 토큰.

**사내망 IP 판정 X**: RFC1918 외에도 12.x.x.x / 106.x.x.x 가 사내. agent 가 직접 분류 X.

## 0-A. 대상 명시 없는 점검 요청 처리

vague 의도 ("smb 점검하려구", "스캔 좀") 만 + 구체적 대상 (subnet/IP/share id) 없을 때:

- ✗ 자기 추측으로 `state.shares_pending_listing_review` 진행 → 0건이면 거짓 narration
- ✗ 자기 추측으로 전체 subnet 풀 돌리기 → 1600+ 폭주
- ✗ 옵션 1️⃣2️⃣3️⃣ 토스 → 도망
- ✓ 한국어 한 줄 직설 질문, 도구 호출 X, turn 종료
  - 예: "어떤 대상부터 시작할까요? subnet (예: `192.0.2.0/24`) / 특정 host IP / DB pending share 검토 — 하나 알려주세요."
- 사용자 다음 메시지가 구체적 대상이면 바로 `smb_python` 진행 (no further questions).

**구체적 대상이 무엇이냐**: CIDR / 단일 IP / subnet 묶음 paste / DB id / "DB pending share 검토" 같은 명시 워크플로.

## 1. end-to-end 흐름 (요약)

```
[scan 시작]   scan_id = state.scan_start("smb", [subnet])
[발견]        smb.enumerate_hosts(subnet)
              → smb.list_shares_modes(host)
              → state.upsert_smb_share(scan_id, ..., null/guest/auth_login_ok, share_read/write)
[담당자]      smb_owner_lookup(ips=[host])  # USER_ID/USER_NAME/USER_DEPT → id@samsung.com
[탐색]        smb.walk_share(host, share)
              → state.upsert_smb_file(share_id, path, ...)
[가져오기]    smb.fetch_file(host, share, path, max_bytes=512*1024) → (status, body)
[스캔]        detectors.scan_text(body, label=path, include_document_signals=True)
              → ScanResult(hits)  # secret/PII + 공정/경영자료 신호
[영속]        state.add_file_hits(file_id, hits) + state.file_record_scan(file_id, hits_count=N)
[검토]        state.file_set_review(file_id, severity=..., summary=...)
              state.share_set_listing_review(share_id, review_dict)
[scan 종료]   state.scan_finish(scan_id, alive_total=, accessible_total=, new_count=, closed_count=0)
```

share status 전이: `pending` → `walked` → `listing_reviewed`.

PII 범위: 자동차 번호/차량 번호판만 보이는 이미지·PDF·파일명은 SMB PII finding 대상에서
제외한다. 차량번호 단독이면 `submit_finding` 하지 말고, 주민번호·카드·계좌·전화·계정정보·
공정자료·경영자료 같은 별도 민감정보가 함께 확인될 때만 그 정보 기준으로 보고한다.

## 1-B. batch 점검 (발견된 host 전부) = `smb_host_sweep` + 자동 driver ★권장

"발견된 host 전부 / 공유폴더 전부 점검" 류 batch 는 **수동 순회 금지** — `goal(set, '[smb-batch] 발견된 host 전부 점검')` 으로 시작하면 시스템(driver)이 **매 turn host 1개를 atomic claim 해서 준다** (동시 세션 중복 없음, web-batch 와 동일 구조).

매 turn 워크플로우 (1 host 만):
1. `smb_host_sweep(host='<주어진 host>')` — 코드가 3모드 enumerate·readable share walk·text/PDF fetch·scan, 이미지/PDF 후보 표시를 결정론적으로 수행하고 digest 반환. (수동 walk/scan 코딩 불필요.)
2. `smb_owner_lookup(ips=['<주어진 host>'])` 로 담당자 캐시 갱신. Splunk lookup 결과의 `USER_ID`는 report/mail 수신자 `USER_ID@samsung.com` 으로 사용된다.
3. digest 의 `scan_hits`/`image_candidates`/`pdf_candidates`/`file_decisions`/`coverage` 검토 → 의심되면 `smb_python`/`smb_fetch_file`/`smb_inspect_image(analyze=True)`/`smb_inspect_pdf(analyze=True)` 로 **실제 본문 확인** (deepdive). scan_hit/image/pdf 후보는 단서일 뿐.
   - secret/credential 후보는 원문 key=value/PEM 라인에 실제 값이 있는지 확인한다. `value_present`, 필드명, 옵션명, 빈 password field, 드라이버 템플릿은 finding 이 아니다.
   - URL/host/DB/API/SMB share/admin console 과 id/pw/token 조합이 실제로 같이 있으면
     credential impact 를 두 관점으로 분리한다. ① 현재 runner 에서 승인된 도구로
     read-only 도달성(GET/healthcheck/login-form POST/metadata/list-only)을 확인하고,
     ② credential 이 발견된 PC 관점은 `smb_origin_credential_probe` 로 검증한다.
     이 도구가 source-runner 미설정/거부/장애를 반환하면 remote execution/WMI/PsExec/shell/proxy 로
     우회하지 말고 `origin_pc_validation=not_performed` 와 사유를 finding validation/risk_narrative 에 남긴다.
     임의 state-changing POST는 하지 않는다.
4. 확인된 실제 데이터만 `submit_finding(task_type='smb', ...)`. confirmed finding 제출 시 `risk_narrative`(4부: 데이터 정체/발견 방법/악용 경로·왜 위험/확인 방법)도 같이 채워라 — 값 아닌 유형만(마스킹).
5. `smb_host_set_status(host=..., status='triaged_completed'|'triaged_errored'|'ignored', hits_count=N)` 후 종료(end_turn). 남은 host 는 다음 turn 에 자동 주입.

- ✗ pending host 목록을 직접 순회 / 여러 host 한 turn 에 (driver 가 1개씩 준다)
- discovery(subnet→host 발견)는 먼저 `run_smb_discovery` 로 smb_share 채운 뒤 batch goal 시작.
- 완료 = claim 할 host 0 → driver 가 자동 종료 narration.

아래 §2~§4 의 수동 2-turn 패턴은 **단일 subnet/host ad-hoc** 작업용 (batch 아닐 때).

## 2. subnet 단위 작업 = **2 turn 분리 + timeout_seconds=60 필수**

⚠ /24 subnet 1개 = 30~90초 SMB I/O. 한 turn 안에 enumerate + list_shares_modes + walk + scan 다 박으면 100% timeout. `snippets.md` 의 `subnet_2_turn` 스니펫 그대로 사용.

- Turn 1: enumerate_hosts → list_shares_modes 3모드 → upsert_smb_share. `timeout_seconds=60` 명시.
- Turn 2: `shares_pending_listing_review(limit=5)` → walk → fetch+scan → 요약 print. `timeout_seconds=60` 명시.
- ✗ `timeout_seconds` 명시 안 함 (default 15s) → SMB blocking 으로 hang 가능. **반드시 명시**.

## 3. 시작 체크리스트

- [ ] task 명확? 모호하면 `0-A` 패턴 — 자연어 한 줄 묻기.
- [ ] 다단계? `todo` 로 계획.
- [ ] sandbox 코드 작성 전 → `skill(action='view', name='smb_task', resource='api.md')` 로 정확한 함수 이름 / 시그니처 확인. 추측 X.
- [ ] subnet 단위 → 2 turn 분리 + `timeout_seconds=60`.
- [ ] 실패 / 막히면 → `safety.md` 의 anti-patterns + lockout 흐름.

## 4. 호출 패턴 요약

```python
# 0) sandbox 코드 작성 전: api.md 확인
#    skill(action='view', name='smb_task', resource='api.md')

# 1) Turn 1 — discovery (timeout_seconds=60)
#    snippets.md 의 subnet_2_turn / turn1_discovery 스니펫

# 2) Turn 2 — walk + scan (timeout_seconds=60)
#    snippets.md 의 subnet_2_turn / turn2_walk_scan 스니펫

# 3) 보고: severity / 핵심 finding / 다음 action 한 줄 자연어. 1️⃣2️⃣3️⃣ 메뉴 X.
```
