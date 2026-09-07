# smb_tasking / snippets — 검증된 코드 카탈로그

각 스니펫은 그대로 `smb_python(code=..., timeout_seconds=60)` 에 박으면 됨. 본문 수정 최소화.

---

## subnet_2_turn — 신규 subnet 점검 (필수 패턴)

⚠ **/24 = 30~90초 SMB I/O**. 한 turn 안에 다 박으면 100% timeout. 반드시 2 turn 분리.

### Turn 1 — discovery (DB persist)

```python
TARGET = "192.0.2.0/24"   # ← 운영자가 지정한 subnet 으로 교체

# 1) subnet 풀 등록 (중복 OK)
state.smb_target_add(subnet=TARGET, added_by="operator")

# 2) scan 사이클 시작 (upsert_smb_share 가 scan_id 요구)
scan_id = state.scan_start("smb", [TARGET])

# 3) alive host 식별 (자격증명 무관, ~5초)
hosts = smb.enumerate_hosts(TARGET)
print(f"alive: {len(hosts)} hosts on {TARGET}")

# 4) host 마다 3 모드 share 탐색 + DB upsert
share_ids = []
errors = []
for h in hosts:
    try:
        mm = smb.list_shares_modes(h)
    except Exception as e:
        errors.append(f"{h}: list_shares_modes {type(e).__name__}: {e}")
        continue
    for sa in mm.shares:                          # ✓ mm.shares 가 iterable
        if not sa.any_read:
            continue
        null_ok = sa.modes.get("null", {}).get("read", False)
        guest_ok = sa.modes.get("guest", {}).get("read", False)
        auth_ok = sa.modes.get("auth", {}).get("read", False)
        op, sid = state.upsert_smb_share(
            scan_id, TARGET, h, sa.share,
            null_login_ok=null_ok, guest_login_ok=guest_ok, auth_login_ok=auth_ok,
            share_read=sa.any_read, share_write=sa.any_write,
        )
        share_ids.append((sid, h, sa.share, op))
    if smb._AUTH_DISABLED_REASON:
        print(f"⚠ auth locked at {h}; null/guest 만 계속")
        break

# 5) scan 종료
state.scan_finish(
    scan_id,
    alive_total=len(hosts),
    accessible_total=len(share_ids),
    new_count=sum(1 for _, _, _, op in share_ids if op == "new"),
    closed_count=0,
)
print(f"discovery 완료: {len(share_ids)}개 share DB 등록")
if errors:
    print(f"errors ({len(errors)}):")
    for e in errors[:5]:
        print(f"  {e}")
```

호출: `smb_python(code=<above>, timeout_seconds=60)`.

### Turn 2 — walk + scan (Turn 1 의 DB pending share 활용)

```python
shares = state.shares_pending_listing_review(min_suspicious=0, limit=5)
print(f"walk 대상: {len(shares)} share")

for s in shares:
    try:
        files = list(smb.walk_share(s['host'], s['share'], max_files=200))
    except Exception as e:
        print(f"  {s['host']}/{s['share']}: walk err {type(e).__name__}: {e}")
        continue
    cands = [f for f in files if f.is_text_candidate and f.size <= 512*1024]
    hits_total = 0
    for f in cands:
        status, body = smb.fetch_file(f.host, f.share, f.path, max_bytes=512*1024)
        if status != "text":
            continue
        r = detectors.scan_text(body, label=f.path, include_document_signals=True)
        if r.hits:
            hits_total += len(r.hits)
            # 본문 print X — hits 요약만
            for hit in r.hits[:3]:
                print(f"  HIT {s['host']}/{s['share']}/{f.path}: "
                      f"{hit.category}/{hit.kind} {hit.masked}")
    print(f"  {s['host']}/{s['share']}: {len(files)} files, {hits_total} hits")
```

호출: `smb_python(code=<above>, timeout_seconds=60)`. share 5개 × 200 files × fetch ≈ 30~60s.

### 핵심 규칙

- ✗ 한 turn 안에 enumerate + list_shares_modes + walk + scan 다 박기 → 100% timeout
- ✗ `timeout_seconds` 명시 안 함 (default 15s 는 SMB 작업엔 짧음)
- ✗ `expand_subnet` + `list_shares` 256번 (alive 체크 대용) — 너무 느림. **`enumerate_hosts` (TCP 445) 가 정답**.
- ✗ DB persist (`upsert_smb_share`) 건너뛰기 → Turn 2 가 결과 활용 못 함
- ✗ `except Exception: continue` silent swallow — 반드시 print 로 노출
- ✓ Turn 1 discovery, Turn 2 walk+scan 분리 + 각 `timeout_seconds=60`

---

## pending_share_batch — discovery 직후 walk + scan

v3.44 H6: **`shares_pending_listing_review` 는 walk 이미 끝난 share 만 반환** (이름 함정).
discovery 직후 walk 가 필요한 share 는 `shares_discovered_not_walked()` 사용.

helper 매핑:
- `shares_discovered_not_walked(subnet?, limit)` — `status='pending'` (walk 대기)
- `shares_pending_listing_review(min_suspicious, limit)` — `status='walked'` + review 대기
- `shares_overview(status='walked')` — 일반 조회

```python
# v3.44 H6: discovery 끝나고 walk 단계
shares = state.shares_discovered_not_walked(subnet='12.25.145.0/24', limit=20)
print(f"shares to walk: {len(shares)}")
batch_summary = []

# v3.42 F1-c: **share-level try/except 필수** — 한 share 가 raise 해도 batch 가 죽으면 안 됨.
# v3.46 E1+E2: **column 이름 = `s['id']`** (`share_id` 함정 X). **walk_share lazy generator** — 반드시
#             `list(walk_share(...))` 즉시 소비. 점진 iteration 첫 next() timeout 이 outer except 안 잡힘.
# v3.46 E3: dead host fast-skip — `smb.tcp_alive(host, timeout=0.8)` 로 0.8s probe. dead 면 SMB 15s 기다리지 마.
for s in shares:
    if smb._AUTH_DISABLED_REASON:
        print(f"⚠ auth locked — abort batch at {len(batch_summary)}/{len(shares)}")
        break
    # v3.46 E3: alive 사전 검사 — dead 면 즉시 skip
    if not smb.tcp_alive(s['host'], timeout=0.8):
        print(f"  ! {s['host']} unreachable (TCP 445), skip")
        batch_summary.append({'share_id': s['id'], 'error': 'unreachable'})
        continue

    try:
        # v3.46 E2: list(...) 즉시 소비 — lazy generator 의 첫 next() 가 outer except 안 잡히는 함정 회피.
        files = list(smb.walk_share(s['host'], s['share'], max_files=200, max_depth=4))
        candidates = [f for f in files if f.is_text_candidate and f.size <= 512*1024]
        findings = []
        for f in candidates:
            try:
                status, body = smb.fetch_file(f.host, f.share, f.path, max_bytes=512*1024)
                if status != 'text':
                    continue
                result = detectors.scan_text(body, label=f.path, include_document_signals=True)
                if result.hits:
                    # F1-b: Hit dataclass 그대로 넘김 (boilerplate 없음)
                    state.add_file_hits(f.file_id, list(result.hits))
                    state.file_record_scan(f.file_id, hits_count=len(result.hits))
                    findings.append((f, result.hits))
            except Exception as fe:
                print(f"  ! file {f.path} fail: {type(fe).__name__}: {fe}")
                continue

        sev = 'high' if any(h.category == 'secret'
                            for _, hits in findings for h in hits) else 'low'
        print(f"  {s['host']}/{s['share']}: {len(files)} files, "
              f"{len(findings)} hit-files, severity={sev}")
        batch_summary.append({'share_id': s['id'], 'severity': sev,
                              'findings': len(findings)})
    except Exception as se:
        # share 단위 실패 — batch 는 다음 share 로
        print(f"  ! share {s['host']}/{s['share']} fail: {type(se).__name__}: {se}")
        batch_summary.append({'share_id': s['id'], 'error': str(se)})
        continue

print(f"\nDONE: {len(batch_summary)} shares processed "
      f"({sum(1 for x in batch_summary if 'error' in x)} errors)")
```

호출: `smb_python(code=..., timeout_seconds=60)`.

---

## single_share_deep — 운영자 지정 share 깊이 분석

```python
share_id = 42  # ← 운영자가 지정한 ID 로 교체
share = state.share_get(share_id)
files = state.files_for_share(share_id)
print(f"{share['host']}/{share['share']}: {len(files)} files")

# 의심 + 본문 받은 적 있는 거 우선
suspicious = [f for f in files
              if f.get('suspicious_name') and f.get('fetch_status') == 'text']
print(f"  suspicious+text: {len(suspicious)}")
```

---

## hit_persist — DB 영속 + verdict

```python
# scan 결과를 DB 박기 — **가장 간결**: detectors.scan_text 의 Hit 객체 그대로 넘김 (v3.42)
result = detectors.scan_text(body, label=path, include_document_signals=True)
state.add_file_hits(file_id, list(result.hits))   # Hit dataclass 그대로 OK
state.file_record_scan(file_id, hits_count=len(result.hits))

# 또는 dict 로 직접 — key 이름 `line_preview` (v3.42 통일, 이전 'preview' 아님)
state.add_file_hits(file_id, [
    {'category': 'secret', 'kind': 'aws_access_key',
     'masked': 'AKIA****', 'line_no': 17, 'line_preview': 'export KEY=AKIA****'},
])

# LLM 이 추가 발견한 거 (regex 못 잡은 것)
state.add_file_hit_manual(
    file_id, category='secret', kind='internal_token',
    masked='token=***', line_no=42, line_preview='token=secret_xyz',
    verdict='confirmed', note='agent 본문 보고 추가 발견',
)

# share-level 요약
state.share_set_listing_review(share_id, {
    'severity': 'high',
    'summary': '3 files 에서 AWS key + internal token 발견. 즉시 rotation 필요.',
    'top_findings': [{'file_id': 100, 'reason': 'AWS access key in .env'}],
    'follow_up_actions': ['기업 보안 알림', 'share owner 통보'],
})
```

---

## bulk_subnet_paste — 신규 subnet 묶음 등록

```python
raw = '''198.51.100.0/24
198.51.100.0/24
10.12.0.0/22'''
cidrs = [l.strip() for l in raw.splitlines() if l.strip()]
added = 0
for c in cidrs:
    try:
        state.smb_target_add(subnet=c, added_by='smb_agent_type')
        added += 1
    except Exception as e:
        print(f"  skip {c}: {e}")
print(f"added {added}/{len(cidrs)} subnets")
```

---

## aggregate — 카운트 / 집계

```python
# share 별 hits_count 분포
shares = state.shares_pending_listing_review(min_suspicious=0, limit=100)
buckets = collections.Counter()
for s in shares:
    files = state.files_for_share(s['id'])
    n = sum(f['hits_count'] for f in files)
    buckets[n // 10 * 10] += 1
for k in sorted(buckets):
    print(f"  {k}-{k+9} hits: {buckets[k]} shares")
```

---

## v3.72 coverage — 전수 커버리지 (세션25 갭: 778 미스캔, share당 walk 캡 절단)

### (a) 서브넷 점진 스윕 — **절대 한 번에 X, 하나씩**
40만 IP 한방 = lockout. 대량 discovery 는 운영자 CLI(`secu-agent smb sweep-pending`)
주도가 기본. agent 가 직접 할 땐 subnet 하나씩 + 각 완료 즉시 mark (재개 기준).

```python
# 한 번에 1개만 — 끝나면 mark, 다음 turn 에 다음 1개
pend = state.subnets_pending_sweep(limit=1)
if not pend:
    print("스윕 잔여 없음"); 
else:
    sn = pend[0]['subnet']
    sid = state.scan_start("smb", [sn])
    hosts = smb.enumerate_hosts(sn)              # TCP 445 (이미 bound: /24=256)
    shares_found = 0
    for h in hosts:
        if smb._AUTH_DISABLED_REASON: break
        multi = smb.list_shares_modes(h)
        for sa in multi.shares:
            if not sa.any_read: continue
            state.upsert_smb_share(sid, sn, h, sa.share,
                share_read=sa.any_read, share_write=sa.any_write)
            shares_found += 1
    state.subnet_mark_swept(sn, scan_id=sid,
        hosts_found=len(hosts), shares_found=shares_found)  # per-subnet commit
    ov = state.subnets_sweep_overview()
    print(f"{sn} 완료 — swept={ov['swept']}/{ov['total']} pending={ov['pending']}")
```

### (b) 미스캔 잔여 mop-up — re-walk 없이 fetch+scan
```python
# 인덱싱됐는데 fetch/scan 못 한 text candidate (캡 절단분) 소진
pend = state.files_pending_scan(limit=100)   # host/share JOIN 포함
print(f"미스캔 text candidate: {len(pend)}")
for f in pend:
    if smb._AUTH_DISABLED_REASON: break
    if f['size'] and f['size'] > 512*1024: continue
    status, body = smb.fetch_file(f['host'], f['share'], f['path'], max_bytes=512*1024)
    state.file_record_fetch(f['id'], fetch_status=status, file_read=status in ('text','empty'))
    if status != 'text' or not body: continue
    res = detectors.scan_text(body, label=f['path'], include_document_signals=True)
    state.file_record_scan(f['id'], hits_count=len(res.hits))
    if res.hits: state.add_file_hits(f['id'], list(res.hits))
```

### 전수 walk (캡 절단 방지)
```python
files = list(smb.walk_share(host, share, max_files=None))  # 무제한 — "끝까지" 요청 시
```
