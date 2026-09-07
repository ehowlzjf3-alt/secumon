---
name: anti_patterns
description: 실제 라이브 검증에서 발견된 ✓/✗ 행동 박물관 — 같은 실수 방지용
domain: core
when_to_use: 항상 한 번씩 떠올려라. 도구 호출 직전 ✗ 패턴 자기검열.
---

# anti_patterns — ✓/✗ 박물관

운영에서 발견한 실제 실패 케이스. 새 LLM 모델 와도 같은 실수 막기 위해 누적한다.

## 정량 의도 매칭

사용자가 수량 / 범위 명시했으면 반드시 그 범위.

- ✓ "10개 도메인 review" → `list_pending_shares(limit=10)` 또는 골라서 `run_smb_review_pending(limit=10)`
- ✗ "10개 도메인 review" → `run_smb_review_pending()` (limit 무시, 전체 돌림)

- ✓ "처음 5개만 walk 해줘" → `run_smb_walk(share_ids=[처음 5개])`
- ✗ "처음 5개만 walk 해줘" → `run_smb_walk(share_ids=[전체 50개])`

## scope 인식 — DB 풀 전체 vs 일부

- ✓ "N개 subnet 중 일부만" → 명확히 받은 subset 만 `run_smb_discovery(subnets=[...])`
- ✗ "subnet 한 번 훑어" → `run_smb_discovery(subnets=null)` 으로 **N개 전체**, 시간 폭발

대용량 작업 직전엔 어떤 scope 인지 한 줄 요약하고 들어가라.
"전체 N개 subnet, 추정 시간 ~30분, 진행할게" 같이.

## pending 0 시 자동 discovery 금지

- ✓ `list_pending_shares()` 결과 0개 → "분석 대상 없음. discovery 한 번 돌려볼까요?" 보고
- ✗ `list_pending_shares()` 결과 0개 → 운영자 동의 없이 `run_smb_discovery()` 자동 호출

운영자가 명시적으로 "스캔해" / "discovery" / "한 번 훑어" 했을 때만 discovery.

## tool 실패 → schedule 도망 금지

- ✓ tool 실패 → 원인 진단 (어떤 에러? 어떤 입력?) → 운영자에게 보고 또는 보정 후 재시도
- ✗ tool 실패 → `schedule(create)` 로 "나중에 자동 처리" 우회

막혔으면 그대로 보고. schedule 은 명시적 주기 표현 ("매시간"/"매일") 있을 때만.

## 모순된 final message

- ✓ 도구 호출했으면 결과 그대로 보고 ("X 완료, 결과: ...")
- ✓ 옵션 묻기로 결정했으면 도구 호출 X, 사용자 응답 대기
- ✗ "옵션 선택해주세요" + "이미 X 했어요" 같은 message 에 동시 출력

옵션 묻기로 결정했으면 그 메시지 보내고 turn 끝. 두 경로 동시 X.

## stub paste preview enumerate 금지

사용자가 `[User pasted N chars / M lines. paste_id="ab12cd"]` 으로 1000+ CIDR 줬을 때:

- ✓ `subnets(action="add", paste_id="ab12cd")` 한 호출. 끝.
- ✓ 다른 format 이면 `python_exec` 으로 `state.paste_get("ab12cd")` 후 처리
- ✗ stub preview/tail 만 보고 `subnets(subnets_text="<copy from preview>")` — 14개만 보이고 1596개 누락

## 회복 vs 재시도

- ✓ network timeout → 원인 (대상 host alive? credential 만료?) 진단 후 재시도 또는 보고
- ✗ network timeout → 그대로 같은 인자로 즉시 retry (실패 반복)

retry 전에 "왜 실패했나" 한 줄 가설 세우고 들어가라.

## 확인 게이트

LLM 호출 비용 / 시간이 큰 batch 는 한 번 더 확인.

- ✓ `run_smb_review_pending(limit=15)` → "15개 review 돌릴게요, 약 5분 예상" 알리고 진행
- ✗ `run_smb_review_pending(limit=200)` 무확인 호출

routine (DB write / 네트워크 IO 만) 은 게이트 X — subnets add / discovery / walk 는 그냥 호출.

## CIDR paste → 즉시 add + discovery 자동 chain ✗

사용자가 CIDR/IP 대역을 paste 했을 때, 무조건 `subnets(add)` + `run_smb_discovery` 자동 체인 X. 먼저 DB 의 검토 대기 상태 확인 후 우선순위 보고:

- ✗ 사용자 paste 즉시: `subnets(add, paste_id=...)` → `run_smb_discovery(subnets=[...])` 자동 chain. 기존 walked share 검토 대기 중인지 확인 안 함.
- ✓ paste 받으면 먼저:
  1. `list_pending_shares` 또는 `list_shares(status='walked', listing_review_status='null')` 로 검토 대기 share 확인
  2. 결과 한 줄 보고: "신규 subnet 12개, 기존 walked 검토 대기 14개. 어디부터?"
  3. 사용자 선택 후 진행

**Why**: discovery 는 시간 큰 작업 (1000+ alive host × SMB enum). 검토 대기 share 가 이미 있으면 그게 더 직접적 가치 — discovery 또 돌리면서 대기열만 키움. 사용자 의도가 신규 발견인지 검토 마무리인지 명시 안 됐으면 priority 묻기.

## SMB 점검 — 직렬 share-master 대신 sub-agent 위임 (v3.23+)

- ✓ "SMB pending 다 검토해" → operator: `agent(subagent_type="smb_agent_type", input={"task":"pending shares 다 검토"})` 한 번. sub-agent 가 smb_python 으로 walk+fetch+scan+persist 다 자유 작성.
- ✗ "SMB pending 다 검토해" → operator: `run_smb_review_pending(limit=16)` — share 마다 LLM master multi-turn 직렬, 30~80분 폭주.
- ✗ smb_agent_type 안에서 본문 직접 print — context 폭주 (≤512KB → 100K+ 토큰). python-side filter 후 요약만.
- ✗ smb_agent_type 가 `smb.reset_auth_lockout_flag()` 자동 호출 — 운영자가 직접 풀어야 함.

## 의심 파일 — 호스트 직접 까보기 절대 ✗

- ✓ `run_in_sandbox(file_path="/path/to/evil.sh", command="bash /tmp/sample")`
- ✗ `python_exec` 으로 `open(file).read()` — 호스트 LLM context 에 페이로드 노출
- ✗ "그냥 cat 으로 한 번 보자" — 페이로드 콘솔 노출 + context 오염
- ✗ `bash file.sh` 같은 직접 실행 — 사고 직행

ai-sandbox 미설치 시 = ToolError(forbidden). 우회 X. [[sandbox_usage]] 참조.

## SMB 명확한 명령 — 옵션 묻기 / lockout 사전 점검으로 도망 ✗ (v3.24)

라이브 케이스 (2026-05-14):
- 사용자: "192.0.2.0/24" (구체적 subnet 주고 점검 요청)
- agent ✗: "잠금 상태 확인 후 진행 / 다른 subnet 시도 / 특정 IP 범위 선택 중 골라주세요" — 옵션 묻기로 도망.
- agent ✓: 바로 `smb_python(...)` 으로 `state.smb_target_add(subnet="192.0.2.0/24")` + `smb.enumerate_hosts(...)` + walk + scan 끝까지.

핵심:
- 자격증명은 env 에 박힘 — agent 가 "id/비번 있나" 묻지 마라.
- lockout 은 reactive — 시도해 보고 STATUS_LOCKED_OUT 응답 오면 그때 멈춰. 사전 점검 X.
- 명확한 대상 (subnet/IP/share) 이 주어지면 추가 질문 X, 바로 도구 호출.

## skill 본문 오해 — 같은 패턴 반복 시도 ✗ (v3.24)

라이브 케이스 (session 16, 2026-05-15):
- agent: `list(smb.list_shares(host))` → TypeError ('SmbHostShares' object is not iterable)
- agent ✗: 같은 패턴 5회 반복 시도 → 다 같은 에러 → 마지막에 "옵션 1️⃣ 2️⃣ 3️⃣ 골라주세요" 로 토스
- agent ✓: 1회 fail 후 trace 보고 → `smb.list_shares(host).shares` (필드 접근) 으로 패턴 변경. 그래도 안 되면 → 운영자에게 "skill 의 list_shares API 설명 부분이 실제 반환 타입 (SmbHostShares dataclass) 과 안 맞아 보입니다 — 수정할까요? trace: [...]" 한 줄 보고.

핵심:
- API 사용 에러는 retry 가 아니라 **패턴 변경** 신호.
- 같은 인자 / 같은 호출로 즉시 retry 금지.
- 2회 이상 같은 에러 → skill 본문 점검 → 본문 자체 의심되면 운영자 보고.
- 옵션 1️⃣ 2️⃣ 3️⃣ 으로 토스하지 마라 — 명확한 명령이면 직접 디버그 후 진행하거나 정확히 차단 사유를 보고한다.

## option-toss 도망 ✗ (v3.24)

사용자가 구체적 명령 (IP/CIDR/대상 명시) 줬는데 agent 가 도구 실패 후 옵션 골라 달라고 토스:

- ✓ `192.0.2.0/24 점검` 명령 → 실행 → 일부 fail → "list_shares API 잘못 호출했음, .shares 필드로 재시도 중" 같은 narration + 재시도 tool_call
- ✗ `192.0.2.0/24 점검` 명령 → 실행 → 일부 fail → "옵션 중 골라 주세요: 1️⃣ 코드 수정 2️⃣ 다른 서브넷 3️⃣ ..."

핵심:
- 명령은 명확하다. 실패해도 옵션 토스 X — 디버그 후 진행 또는 운영자에게 정확한 보고.
- operator contract가 도망성 option-toss를 허용하지 않는다 — 토스 대신 실패 원인과 다음 실제 조치를 보고한다.

## vague 점검 요청 → 자기 추측 + 모순 narration ✗ (v3.24)

라이브 케이스 (session 1, 2026-05-15 10:12):
- user: "smb 점검하려구" (대상 명시 X)
- agent ✗: 자기 추측으로 `state.shares_pending_listing_review(limit=50)` 실행 → 0건 → 최종 text 에 두 narration 모순 동시:
  - "대상이 되는 서브넷·IP 알려주시면 바로 시작..."
  - "SMB 점검을 진행합니다. (pending share 50개를 대상으로...)"
  실제로는 아무것도 안 했는데 "50개 대상으로 진행" 거짓 narration.
- agent ✓: 도구 호출 X, 한국어 한 줄 직설: "어떤 대상부터 시작할까요? subnet (예: 192.0.2.0/24) / 단일 IP / DB pending share 검토 — 하나 알려주세요." turn 끝, 대기.

핵심:
- vague intent (점검 / 스캔 키워드만 + 대상 X) 는 명령 아님 — 짧게 묻기.
- DB 자동 검색 (`pending_listing_review` 등) 으로 대상 fabricate 금지.
- tool result 가 empty 면 그대로 보고: "0건". "50개 진행" 같은 인자값을 결과로 둔갑 X.
- 모순 narration ("묻기" + "이미 함") 동시 emit X — 한 turn 한 가지.

## walk loop 에 share-level try/except 없음 → 한 share 결함이 batch 전체 죽임 ✗ (v3.42)

라이브 케이스 (session 7, 2026-05-18 10:11):
- 12.25.140 ~ 145 까지 정상 (전부 admin share = hit 0 → bug 라인 도달 안 함)
- 12.25.146.167 의 `AI_필터링` share 의 첫 진짜 hit → `state.add_file_hits(file_id, [{'preview': h.preview, ...}])` 의 `h.preview` AttributeError (`Hit.line_preview` 가 정답)
- walk loop except 가 `walk_share` 만 감쌌고 `add_file_hits` 는 raw → AttributeError 가 share 단위 격리 없이 전체 batch 죽임
- 게다가 agent 가 assistant text 응답 0개 → 사용자 화면 "멈춤" 으로 인식

핵심 규칙:
- **walk loop 의 `for s in shares:` 안에 try/except 박기** — fetch + scan + persist 까지 전부 감싸. 한 share fail = batch 전체 멈춤 절대 X.
- **add_file_hits 는 `list[Hit]` 그대로 넘김** (v3.42 F1-b). dict 변환 안 해도 됨. 굳이 dict 면 key 는 `line_preview` (이전 'preview' 함정 — v3.42 통일).
- error 도 summary 리스트에 남겨서 final narration 에 정확한 수 (`processed=N, errors=M`) 보고.

## silent `except Exception` 으로 에러 swallow → 거짓 "0건" 보고 ✗ (v3.24)

라이브 케이스 (session 1 시도 #2, 2026-05-15 11:11):
- enumerate_hosts 가 실제로 37대 alive 반환
- agent 코드: `for h in hosts: try: list(smb.list_shares(h)) ... except Exception: continue`
- `list(SmbHostShares)` → TypeError (skill 에 명시된 ✗ 패턴인데도 사용)
- except 가 TypeError silent swallow → 모든 host skip → `added=0`
- final assistant ✗: "탐색된 호스트가 없었으므로 ... " — 실은 37대 있는데 코드 버그로 못 본 것을 "없음" 으로 거짓 보고

핵심 규칙:
- **`except Exception:` 으로 swallow 후 silent continue X**. 에러는 print 로 노출 또는 traceback 그대로 stdout.
- **silent error 후 결과 narration 금지** — `added=0` 일 때 "host 없음" 단정 X. "코드에서 N개 host 처리 중 M개 silent skip" 같이 정직 보고.
- **skill 의 ✗ 패턴 (`list(SmbHostShares)` 같은) 한 번 본 후 즉시 ✓ 패턴 (`.shares` 필드 접근) 으로 작성**. 시도하고 잡히면 너무 늦음.

## hit 결과 추측 placeholder 채우기 ✗ (v3.24)

라이브 케이스 (session 1, 2026-05-15 11:27):
- agent 실제 stdout: `FOUND 192.0.2.10/INTERNAL_SHARE/testdata/_dictionary.json -> 2 hits`
  (tool result 에 hit 개수만, category/kind/masked 값 X)
- agent ✗ final 보고:
  | 종류 | 마스킹 |
  | AWS Access Key | `AKIA****` |
  | 내부 토큰 | `token=***` |
  → **추측 placeholder**. tool result 에 그 값 없음. 운영자가 본 거짓 정보.

핵심:
- ✓ tool result stdout 에 실제 출력된 값만 인용. 없으면 "hit 개수만 알 수 있음, 다음 turn 에서 hit 종류 조회 필요" 정직 보고.
- ✓ hit 종류 / masked 값 알고 싶으면 `state.hits_for_file(file_id)` 호출 또는 walk 코드에서 `print(f"  {hit.category}/{hit.kind} {hit.masked}")` 명시.
- ✗ `AKIA****` / `token=***` 같이 일반화된 placeholder 로 표 채우지 마라.

## DB persist 실패 후 "DB 에 저장된 X" 거짓 narration ✗ (v3.24)

라이브 케이스 (session 1, 2026-05-15 11:28):
- agent: `state.share_upsert(...)` AttributeError → 4회 반복 실패. DB 에 share / file 0건 박힘.
- 사용자: "이름만으로도 판단해 볼 수 있잖아"
- agent ✗: "현재 DB에 저장된 파일 메타데이터 중에는 .exe/.dll 가 없습니다" → **거짓** (DB 비어 있음, walk 결과는 in-memory 에 있었지만 DB persist 0건이라 session_search 가 빈 결과 줌)

핵심:
- ✗ DB persist 실패 / 안 함 → "DB 에 X 가 없다" narration X.
- ✓ "DB 영속화는 함수명 불일치로 실패 — 직전 walk 결과로 in-memory 분석 수행" 명시 보고.
- ✓ walk 결과 (`files = list(smb.walk_share(...))`) 가 in-memory 에 있으면 그 list 에서 직접 확장자 / 의심 이름 필터 가능. DB 의존 X.

## in-memory walk 결과로 직접 답변 ✓ (v3.24 권장 fallback)

DB persist 실패해도 walk 결과는 한 smb_python 호출 안 메모리에 있음. 분석 직접 가능:

```python
# share 1개 walk + in-memory 확장자 / 의심 이름 분류
files = list(smb.walk_share(host, share, max_files=500))
print(f"{host}/{share}: {len(files)} files")

# 확장자별 카운트
from collections import Counter
ext_count = Counter(f.path.rsplit('.', 1)[-1].lower() if '.' in f.path else '(none)' for f in files)
print("확장자 top 10:", ext_count.most_common(10))

# 의심 이름 매칭 (확장자 + 파일명 패턴)
SUSPICIOUS_EXT = {'exe', 'dll', 'bat', 'ps1', 'sh', 'vbs', 'js', 'jar', 'zip', 'rar', '7z', 'tar', 'gz', 'pem', 'key', 'pfx', 'p12', 'pcap'}
SUSPICIOUS_NAME = ('password', 'secret', 'credential', '비밀번호', '계정', '권한')
import re as _re
for f in files:
    p = f.path.lower()
    ext = p.rsplit('.', 1)[-1] if '.' in p else ''
    if ext in SUSPICIOUS_EXT or any(s in p for s in SUSPICIOUS_NAME):
        print(f"  SUSPICIOUS {f.path} ({f.size} bytes)")
```

- ✓ DB persist 와 무관 — `files` 리스트 자체로 분석.
- ✓ 운영자에게 "DB 에 저장 안 됐지만 in-memory 결과로 분석 — N건 의심 이름" 보고.
- ✗ "DB 메타데이터 없음" 운운하며 다시 시도하지 마라.

## 결과 보고 후 1️⃣2️⃣3️⃣ 메뉴 토스 ✗ (v3.25)

라이브 케이스 (session 1, 2026-05-15 12:09, turn 30):
- 작업 완료: 37 hosts / 7 shares / 1 finding (`192.0.2.10/INTERNAL_SHARE/testdata/_dictionary.json`, 2 secrets).
- agent final 보고 ✗:
  ```
  점검 완료. 1 finding 발견.
  다음 작업을 알려주세요:
  1️⃣ 상세 검토
  2️⃣ 범위 확대
  3️⃣ 스케줄링
  ```
  → **결과 보고 자체는 정확했지만, 끝에 강제 옵션 메뉴 박음**. 운영자에게 선택 부담 강요.

핵심:
- ✗ 작업 끝났는데 1️⃣2️⃣3️⃣ keycap 메뉴 박지 마라. 결과와 현재 상태만 보고한다.
- ✓ 자연어 종료: "점검 완료. 1 finding (host/share/path, secrets 2건). severity=high. 미확인 항목: 없음."처럼 확인된 사실과 현재 상태만 짧게 보고.
- ✓ severity / 핵심 finding / 증거 상태 — 그게 결과 보고 형식. 강제 메뉴 X.
- ✓ 정말 운영자 결정이 필요한 binary choice (e.g. "DB 에 박을까요 / 별도 finding 만 만들까요?") 면 자연어 한 줄 질문으로. 그것도 이모지 keycap X.

## 자연 종료 보고 ✓ (v3.25 권장)

```
점검 완료 — 192.0.2.0/24 / 37 hosts / 7 readable shares.

발견:
- 192.0.2.10/INTERNAL_SHARE/testdata/_dictionary.json (2 secrets, severity=high)

DB 영속: scan_id=12, shares 7건, files 1400건 upsert. finding 1건 박힘.
미확인 항목: 없음.
```

- 핵심 finding 본문 + severity 명시
- 현재 상태와 미확인 항목을 짧게 명시
- 강제 메뉴 X — 운영자가 자유롭게 다음 turn 시작

## 사용자 입력 URL/host 손상 ✗ (v3.44 H1)

라이브 케이스 (session 9, 2026-05-18 10:55):
- 사용자 입력: `diff-data--diff-data-prod.cdep.samsungds.net` (whole hostname)
- agent: 첫 `diff-data--` 를 prefix 로 오인 → `diff-data-prod.cdep.samsungds.net` 만 시도
- 사용자가 두 번 정정해서야 ("내가 준 주소 그대로 해라", "이거잖아") 인식

핵심 규칙:
- **사용자가 명시한 URL / hostname / path 그대로 사용**. `--` / `_` / digits 가 들어가도 자르거나 변형 절대 X.
- "host name 같지 않다" 느낌이 들어도 사용자 입력이 정답. 추측 정규화 (`prefix--name` → `name` 같은) X.
- 의심되면 도구 호출 전 `clarify` (또는 final message) 로 "이 URL 그대로 맞아요?" 확인. 정규화 임의로 X.

## 사용자 명시 명령 ("재시도/끝까지") 무시 ✗ (v3.44 H2)

라이브 케이스 (session 9, 11:03):
- 사용자: "성공할때까지 반복시도해"
- agent: 한 번 시도 후 403 받고 "인증 정보가 필요한 경우..." narration 으로 stop
- 명시 명령 "반복" / "끝까지" / "다양한 방법" 을 거의 무시

핵심 규칙:
- 사용자가 **"반복 / 끝까지 / 성공할때까지 / 자동 / 다 처리"** 같은 명시 의도를 주면 turn 한 번에 stop 하지 마라.
- 다른 접근 (다른 도구 / 다른 path / 다른 header 등) 을 명시적으로 시도 + 시도한 횟수 / 차단된 reason 정직 보고.
- 한 번 stop 할 때는 **"왜 더 못 가는지"** 명확히 (auth lockout 위험 / 도구 timeout / scope 차단 등). vague narration X.

## todo update 과빈도 / oscillation ✗ (v3.44 H4)

라이브 케이스 (session 9, 10:41 ~ 10:54): 같은 todo id 의 status 가 `in_progress → completed → in_progress → completed` 오가며 20회+ update. context 낭비 + DB noise.

핵심 규칙:
- **한 작업 = todo write 2회**: 시작 시 `in_progress`, 끝나면 `completed`. 그 사이 status 변경 X.
- 다음 작업 시작 전 직전 작업 `completed` 확정. 다시 `in_progress` 로 돌리는 거 절대 X (oscillation).
- 같은 turn 안에서 같은 id 의 status 가 같은 값으로 두 번 set 되면 두 번째 호출 자체 생략.

## SMB discovery 직후 잘못된 helper 로 walk 시도 → "0 결과" 거짓 보고 ✗ (v3.44 H6)

라이브 케이스 (session 9, 2026-05-18 10:47):
- discovery 끝 → share 57개 DB 에 `status='pending'` 으로 박힘
- agent 가 walk 단계에서 `state.shares_pending_listing_review(min_suspicious=0, limit=50)` 호출
- 이 helper 는 **`status='walked'` + listing_review 안 한 share** 만 반환 — pending share 0개 매치
- 결과: walk loop 진입 못 함 → `total files scanned: 0, total hits: 0` → 사용자에게 "0 발견" 거짓 보고
- 실제로는 57개 share 가 walk 대기 중이었음

helper 매핑 (헷갈리지 마):
- **`shares_discovered_not_walked(subnet=..., limit=)`** — `status='pending'` (walk 대기) → discovery 직후 walk 단계 입력
- `shares_pending_listing_review(min_suspicious, limit)` — `status='walked'` + review 대기
- `shares_overview(status=...)` — 일반 조회

핵심 규칙:
- discovery → walk 흐름: **`shares_discovered_not_walked`** 가 정답. `pending_listing_review` 호출 X.
- helper 결과 0개 받으면 "0 hit" narration 으로 바로 가지 마라 — 다른 helper 로 한 번 더 cross-check.
- DB 의 실제 share 수와 helper 반환 수가 mismatch 면 helper 이름 의심하고 docstring/api.md 다시 봐.

## walk_share = lazy generator — try 범위 함정 ✗ (v3.46 E2)

라이브 케이스 (session 10, 2026-05-18 11:47):
- 코드: `try: files_iter = smb.walk_share(host, share); except Exception as e: ...` + `for f in files_iter:` (try 밖)
- `walk_share` 호출 자체는 generator 객체만 반환 — exception 안 남
- 첫 `for f in files_iter` 의 `next()` 시점에 SMB connect timeout (15s) 발생 → try 밖이라 outer 까지 raise → 전체 batch 죽음
- 결과: dead host 1개 만나면 batch 의 나머지 share 다 skip + agent 가 "1개 host 만 시도" 거짓 보고

핵심 규칙:
- **`list(smb.walk_share(...))` 로 즉시 소비** — try 안에서. iterator 점진 소비하면 첫 timeout 못 잡음.
- 같은 함정: `smb.fetch_file`, `for f in smb.walk_*` 등 generator 반환 함수 전부.
- alive 사전 검사: `smb.tcp_alive(host, timeout=0.8)` 로 dead host 빠르게 skip — SMB 15s wait 회피.

## share row column 이름 = `id` (not `share_id`) ✗ (v3.46 E1)

라이브 케이스 (session 10, 2026-05-18 11:41):
- 코드: `share_id = sh['share_id']` → `KeyError: 'share_id'`
- `state.shares_discovered_not_walked`, `state.shares_overview`, `state.shares_pending_listing_review` 모두 `SELECT s.*` → column 이름은 **`id`**
- snippet 예제는 정확히 `s['id']` 로 적혀있는데 agent 가 임의로 변형

핵심 규칙:
- share row dict 의 share ID = **`row['id']`**. `'share_id'` 라는 key 절대 X.
- 다른 helper 결과 (예: pending shares + manual select) 가 alias 줄 수도 있지만, 표준 share row 는 `id`.
- 코드 작성 전 helper docstring + snippet 의 정확한 column 이름 확인. 추측 X.

## scope hallucination — 사용자 list 외 hostname 발명 금지 ✗ (v3.47 critical)

라이브 케이스 (session 11, 2026-05-18 11:53~12:04):
- 사용자: 13개 도메인 paste (`rftt-sibds--rftt-sibds-prod`, `fmetal-rpa--fmfdcfastapi-prod`, ..., 13개)
- agent ✗: msg 662 에서 "70+개 도메인" 으로 임의 확장 → 사용자 list 의 패턴 모방해서 **47개 가짜 hostname 생성**:
  - `plam--plam-prod` (없음)
  - `jongyoun--prontend-prod` (오타 — `frontend` → `prontend`)
  - `gukheon--clean-inform-potal-dev` (오타 — `portal` → `potal`)
  - `cdep-edsmanager--edseqp-manager-prod` (의미 모호한 조합)
  - `impdx--impdx-prod` 등
- 실제로는 13개만 사용자가 줬는데 60+ 호출 시도 → 대부분 fake DNS 못 찾음

핵심 규칙:
- **사용자가 paste 한 list 의 개수와 정확히 같은 수만큼 호출**. `len(user_input_lines) == len(tool_calls)` 자기 검열.
- "이런 패턴이면 다른 것도 있을 거" 추측 절대 X. 사내 명명 규칙 모방한 fake hostname 생성 = 가장 큰 trust 위반.
- 사용자 list 가 짧으면 짧은 대로 시작. "더 추가할까요?" 물어봐. 임의 확장 X.
- final 보고 시 "사용자가 준 N개 중 M개 완료" 정직 — N 이 사용자 입력 line 수와 일치해야.

## 사용자 입력 list 외 hostname 호출 = trust 위반 ✗ (v3.47)

라이브 case (위 #scope hallucination 의 부수):
- agent: `rftt-sibds-prod.cdep.samsungds.net` 호출 — 사용자 list 의 `rftt-sibds--rftt-sibds-prod` 의 `--rftt-sibds-` 부분 자름. H1 anti-pattern 재발.

핵심:
- **사용자 list 의 hostname string 그대로 통째로 비교** — 도구 호출 전 `if seed not in user_list: 거부`. (`--` 두 개나 긴 prefix 가 정상 사내 패턴)
- H1 ("URL 손상") + scope hallucination = **trust contract** 의 핵심. 둘 다 위반 시 모든 결과 불신.

## 표준 endpoint 한 두 개만 보고 host 안전 판단 X (v3.51-H1 critical)

라이브 케이스 (session 13, 2026-05-18 12:25~12:33):
- 대상: `fmetal-rpa--fmfdcfastapi-prod.cdep.samsungds.net` (FastAPI)
- agent ✗ (12:30): `/docs` → 404 + `/` → 200 만 보고 **"Medium, /docs 비활성화됨 — 인증 적용 가능성"** 으로 finish
- 사용자가 직접 push (12:33): "/docs 가 404 인데?" → agent 가 그제서야 `/openapi.json` 시도
- 결과: **`/openapi.json` 200 OK, 66KB, 116 endpoint 노출** — Knox Teams 메시지 발송, DB write, Brity/Cream deploy 트리거 등 **High~Critical**
- agent 단독으로는 못 잡았음. 사용자 push 없었으면 underreport.

핵심 규칙:
- **단일 endpoint (특히 `/docs`) 의 404/403 만으로 "안전" / "비활성" 결론 절대 X.**
- FastAPI / Swagger 류는 `/docs` 비활성화돼도 `/openapi.json` 그대로 노출되는 경우 매우 흔함.
- **표준 endpoint sweep 필수**: 한 host 의 위험 판단 전에 다음을 web_resource_probe 로 같이 시도 —
  - **FastAPI/REST**: `/openapi.json`, `/docs`, `/redoc`, `/api/docs`, `/swagger`, `/swagger.json`, `/api/v1`, `/api/v2`
  - **메타/discovery**: `/.well-known/security.txt`, `/.well-known/openid-configuration`, `/robots.txt`, `/sitemap.xml`
  - **민감 leak**: `/.env`, `/.git/config`, `/server-status`, `/actuator/health`, `/actuator/env`, `/metrics`, `/debug`
  - **admin/auth**: `/admin`, `/login`, `/console`
- 한 endpoint 의 응답 (200/403/404) 만으로 host 전체 판단 X. **N 개 endpoint 결과 모인 후** 종합.
- finding 위험도는 노출된 endpoint 의 **개수 + 종류 (read vs write vs deploy)** 기반. `/openapi.json` 하나만 떠도 endpoint 116개 중 `/db/insertData` / `/teams/sendKnoxMessage` 같은 것 있으면 **High** (Medium 아님).

## DB error 5회 반복 후 silent 포기 X (v3.51-H2)

라이브 케이스 (session 10, 2026-05-18 11:31~11:53):
- agent 가 SMB walk 중 sqlite `IntegrityError: UNIQUE constraint failed` 발생
- 5회 retry → 모두 같은 에러 → agent 가 **사용자에게 알림 없이** 다음 share 로 넘어감
- 결과: walk 결과 누락 + 사용자는 walk 실패한 것 모름

핵심 규칙:
- DB IntegrityError / OperationalError 가 같은 fingerprint 로 2회 반복되면 **즉시 사용자 보고**. retry 무한 X.
- v3.42 F2 의 `repeat_error_halt` 가 `ToolError` + `[error]` 마커 traceback 만 잡았는데, v3.51 부터 sqlite 예외도 같은 signature 추출.
- silent retry = trust 위반. 결과 보고에 "DB UNIQUE violation 5회 — 일부 share walk 누락" 같이 정직 보고.

## v3.47 scope hallucination 정정 (v3.52)

v3.47 에서 "agent 가 fake hostname 만들었다" 고 박은 케이스 일부는 **실제 사내 서비스**였다 — splunk MCP 로 검증 결과:

- `jongyoun--prontend-prod.cdep.samsungds.net` — 어제 80 events
- `plam--plam-prod.cdep.samsungds.net` — 어제 52 events
- `cdep-edsmanager--edseqp-manager-prod.cdep.samsungds.net` — 어제 36 events

사내 명명 규칙 (`name1--name2-env.domain`) 은 외부 직관으로 "오타 / 가짜" 같지만 진짜 존재할 수 있음. 정정된 룰:

- **외형 기반 자가 검열 금지** ("이상한 이름 = 가짜" 판단 X)
- **splunk MCP `dedup domain` 결과 = 정답**. SPL 로 확인 안 한 hostname 만 fake 의심.
- v3.47 의 "사용자 paste 외 호출 금지" 는 **splunk 결과가 source 일 땐 풀림** — splunk 가 준 host 는 paste 가 아니어도 OK.
- 단 사용자 paste 만 있고 splunk 미실행 상태에서 짧은 list 를 임의로 확장하는 건 여전히 금지.

핵심: agent 가 도메인 "추측" 으로 만든 게 아니라, 실제 사내 host 를 알고 인용한 것일 수 있음. 라이브 검증 (splunk) 없이 단정 X.

## Batch 단위 사용자 확인 ✗ (v3.53)

이전 룰 ("작업량 크면 first batch 5개 처리 후 사용자 확인") 폐기. 사용자가 명확한 점검 지시 (SMB 전수 / web 점검 시작 등) 했으면 중간 confirm 없이 끝까지.

배경: session 7~13 검토 결과 — agent 가 batch 중간에 "5/N 완료, 계속할까요?" 묻는 패턴이 라이브 흐름 끊고, 사용자가 "응" 하나 더 보내야 다음으로 진행. 사용자 입장에선 의미 없는 ack. UX 손상 + 작업 lag.

✗ **Bad — confirm 요청 (응답 대기)**:
```
[SMB walk 5 share 완료]
agent: "5/20 완료. 나머지 15개 계속 진행할까요?"  ← 사용자 응답 대기
사용자: "응"
agent: [다음 5 share]
agent: "10/20 완료. 계속할까요?"  ← 또 대기
```

✓ **Good — progress 통보 (ack 없이 다음으로 이어감)**:
```
[SMB walk 5 share 완료]
agent: "5/20 완료. finding 1건 (medium). 나머지 15개 진행 중"
[바로 다음 5 share 호출]
agent: "10/20 완료. finding 1건 (medium 누적). 나머지 10개 진행 중"
agent: "15/20 완료. finding 2건 (medium=2). 나머지 5개 진행 중"
agent: "20/20 완료. finding 3건 종합 (high=1, medium=2). 상세: ..."
사용자: [멈추고 싶었으면 ESC]
```

핵심 차이:
- **통보 (narration)**: assistant text 한 줄 + 같은 turn 안에서 다음 tool call 바로 이어감. ack 대기 X.
- **confirm (질문)**: assistant text + tool call 없이 turn 종료 → 사용자 응답 받아야 다음 진행.
- batch 간격: 5~10 단위 권장 (너무 잦으면 spam, 너무 드물면 사용자 답답).

예외 (진짜 묻는 시점):
- (a) **진짜 모호한 작업 요청**: "점검 좀" / "SMB 봐줘" — 어떤 task_type / scope 인지 불명확 → 1회 clarify
- (b) **destructive 도구 호출 직전**: bash_evidence / write 류 — approval 정책 따름

핵심: 사용자가 시작 시 scope 정했으면 자체 판단으로 끝까지. progress 는 batch 단위 통보 = 사용자가 보면서 안심하고 ESC 시점 결정 가능. confirm = 일부러 멈추는 것 = 사용자 시간 낭비.

## 이메일/라이선스 노이즈를 finding 으로 올림 ✗ (v3.78 F1)

라이브 케이스: github API 점검이 commit/파일에서 잡은 이메일을 그대로 finding 으로 올려 313 finding 중 90건이 "이메일-only". OSS 라이선스/저작권 헤더, README·AUTHORS·CONTRIBUTORS 의 연락처 이메일, commit author 이메일까지 finding 화 — 운영팀이 걸러야 할 노이즈.

✗ **Bad — 단순 ID/문서 이메일을 finding 으로**:
```
hits=[{category:pii, kind:email, masked:"ho***@samsung.com", location:"AUTHORS"}]
→ submit_finding (비밀번호·토큰·주민번호 동반 0)
→ "이메일 노출" finding 적재 ← 노이즈
```

✓ **Good — 실제 민감 노출만**:
```
- 이메일/이름/사번 단순 ID 만(secret·주민번호·카드·계좌 동반 없이) → finding 아님, 제외.
- OSS 라이선스/저작권 헤더의 예시 키·연락처, commit author 이메일 → 제외.
- 주민번호(kr_rrn)·카드(credit_card)·계좌(bank_account)·전화, 또는 진짜
  secret/credential/토큰이 함께 노출될 때만 submit_finding.
```

규칙: secret/credential/공정·경영/내부시스템/web_vuln, 또는 고가치 PII(주민번호·카드·계좌·전화)가 **하나라도** 있으면 유지. 전부 이메일/이름/사번 같은 식별자-only PII 뿐이면 노이즈 → 제외. (이메일이 진짜 secret 과 같이 있으면 그건 secret finding 으로 유지.) submit_finding gate(`judge_task_finding`) + service_task 게이트(`is_low_value_only`) 둘 다 코드로 강제하지만, 애초에 올리지 마라.
