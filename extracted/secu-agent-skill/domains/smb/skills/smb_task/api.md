# smb_tasking / api — 모듈 시그니처 reference

sandbox 코드 작성 전 **반드시 view** — 함수 이름 / 인자 정확히. 추측 X.

## `smb` 모듈 (`secu_agent.agent_types.smb`)

```python
smb.expand_subnet(spec: str) -> list[str]
  # CIDR 또는 단일 IP 펼침. /22 보다 큰 prefix 거부 (안전).

smb.tcp_alive(host: str, port: int = 445, timeout: float = 0.8) -> bool
  # 445 단순 체크.

smb.enumerate_hosts(subnet: str, *, concurrency: int = 64) -> list[str]
  # ★ subnet 단위 alive scan — 자격증명 무관, ~5초.
  # /24 → 256 IP 동시 TCP 445 체크 → alive 만 반환.
  # **subnet 점검의 첫 호출은 항상 이거**. expand_subnet + list_shares 로 256번 시도하지 마라.

smb.list_shares_modes(host: str, *, modes=("null","guest","auth")) -> SmbHostMultiMode
  # ★ 권장. 3 모드 순차 시도 + 각 share 의 (read, write) 권한 비트 측정.
  # 반환 객체 (NOT iterable — 필드 접근):
  #   mm.host             # str
  #   mm.login_errors     # dict[mode, err_str]. 성공 모드는 missing.
  #   mm.shares           # list[ShareAccess]  ← iterable
  #     sa.share          # str (share name)
  #     sa.modes          # dict[mode, {'read': bool, 'write': bool}]
  #     sa.any_read       # bool (어떤 모드든 read 가능)
  #     sa.any_write      # bool
  # 사용 예:
  #   mm = smb.list_shares_modes('10.0.0.1')
  #   for sa in mm.shares:                # ✓ mm.shares 가 iterable
  #       if sa.any_read:
  #           null_ok = sa.modes.get('null', {}).get('read', False)
  #           # ...
  #   # NOT: for sa in mm   ← TypeError
  # auth 모드에서 ACCOUNT_LOCKED_OUT 시 _AUTH_DISABLED_REASON 자동 set.
  # 권한 해석: auth read 는 DSSOC 공용 검증 계정 기준 접근 가능 증거로 보고
  # 안전으로 닫지 않는다.

smb.list_shares(host: str) -> SmbHostShares
  # [legacy] 단일 session, auth-then-guest fallback. 권한 측정 X.
  # 새 코드는 list_shares_modes 권장. 그래도 쓸 때:
  # ⚠⚠⚠ 반환은 **NOT iterable** — `list(res)` / `for x in res` 절대 X (TypeError).
  # 반드시 `.shares` 필드 접근.
  # 필드:
  #   res.host       # str
  #   res.shares     # list[str] (share 이름 리스트)  ← iterable
  #   res.error      # str | None (login 실패면 set)
  # ✓ 사용 예:
  #   res = smb.list_shares('10.0.0.1')
  #   if res.error:
  #       print('login fail:', res.error)
  #   else:
  #       for name in res.shares:                # ✓ res.shares
  #           print(name)
  # ✗ 절대 X (라이브에서 반복 사고):
  #   list(smb.list_shares(h))                   # TypeError
  #   for s in smb.list_shares(h): ...           # 같음
  #   try: list(...) except Exception: continue  # silent swallow + 거짓 보고

smb.walk_share(host: str, share: str, *, max_files: int|None = 1000,
               max_depth: int = 4) -> Iterator[SmbFile]
  # BFS, share-root 기준 path. SmbFile(host, share, path, size, is_text_candidate).
  # v3.72 (b): max_files=None → 무제한(전수 walk, share당 캡 절단 없음).
  #   "전수/끝까지" 요청 시 사용. 평소 triage 는 200~1000 으로 bound 유지.
  # 내부적으로 auth (env 자격증명) 시도 후 실패 시 guest 폴백 — 단일 session.

smb.fetch_file(host: str, share: str, path: str, *, max_bytes: int)
        -> tuple[status, body_or_msg]
  # status: 'text' | 'empty' | 'binary' | 'denied' | 'not_found' | 'error'
  # text 일 때만 body 가 실제 utf-8 본문. binary 면 본문 X.

smb._AUTH_DISABLED_REASON: str | None
  # 글로벌 lockout flag. STATUS_ACCOUNT_LOCKED_OUT 시 자동 set.
  # smb_python 이 pre-check — 이미 set 이면 도구 자체 거부.

smb.reset_auth_lockout_flag() -> None
  # 운영자가 lockout 해제 확인 후 명시적 reset. **agent 가 호출 X**.
```

## `state` 모듈 SMB helpers

> 🔁 **v3.82 U3d**: 도메인 DB 접근은 이제 `service.state_domain` 모듈(skill repo
> `service/state_domain.py`)이다 — python_exec 의 `state` 자동 바인딩에서 도메인
> 함수(smb_*/asset_owner/scan/sweep-target)가 **제거됨**. 코어 잔존분
> (finding_*/memory_* 등)만 `state` 에 남는다. 예:
>
> ```python
> from service import state_domain
> host = state_domain.smb_host_claim_next(session_id=sid)        # host 단위 claim
> op, share_id = state_domain.upsert_smb_share(scan_id, subnet, host, share)
> state_domain.smb_hosts_summary()                               # 진행률 집계
> ```
>
> 아래 시그니처의 `state.X` 표기는 모두 `state_domain.X` 로 읽을 것.

> ⚠ 함수명 **정확히**. `state.share_upsert` / `state.file_upsert` 로 줄여 부르지 마라 — AttributeError. 실제 이름은 `upsert_smb_share` / `upsert_smb_file`.

```python
# ─── scan 사이클 (DB persist 하려면 scan_id 필요) ──────────────
state.scan_start(kind: str, subnets: list[str]) -> int      # scan_id
state.scan_finish(scan_id, *, alive_total, accessible_total,
                  new_count, closed_count) -> None

# ─── subnet 풀 + 점진 스윕 추적 (v3.72 — subnet 하나씩, 40만 IP 한방 금지) ─
state.smb_target_add(subnet, *, note=None, charter_ref=None,
                     added_by=None) -> int                  # subnet_id
state.smb_target_list(*, enabled_only=False) -> list[dict]
state.subnets_pending_sweep(*, limit=1) -> list[dict]
  # enabled + swept_at NULL. 기본 limit=1 — 한 개씩 꺼내 점진 스윕/재개.
state.subnet_mark_swept(subnet, *, scan_id=None, hosts_found=0,
                        shares_found=0) -> None   # per-subnet commit
state.subnets_sweep_overview() -> {total, swept, pending}

# ─── 조회 ──────────────────────────────────────────────────────
# v3.44 H6: discovery→walk 단계 별 helper 명확히 구분
state.shares_discovered_not_walked(*, subnet=None, limit=50) -> list[dict]
  # status='pending' (walk 대기) share — discovery 직후 walk batch 입력
state.shares_pending_listing_review(*, min_suspicious=5,
                                     limit=1) -> list[dict]
  # ⚠ 이미 walked + listing_review 안 한 share만. discovery 만 된 share 는 X
  #   discovery 직후 walk 가 필요하면 shares_discovered_not_walked 사용.
state.files_for_share(share_id, *, limit=1000) -> list[dict]
state.files_pending_scan(*, share_id=None, limit=200, max_size=None) -> list[dict]
  # v3.72 (b): is_text_candidate=1 + **scan_status IS NULL**. host/share JOIN 포함.
  #   정렬: suspicious_name DESC, size ASC (의심 먼저, 작은 것부터).
  #   ⚠ 이걸 직접 돌리지 마라 — `smb_scan_share` 도구가 세션 하나로 훑는다.
  #     파일마다 smb.fetch_file 을 부르면 로그인이 파일 수만큼 일어난다.
state.count_files_pending_scan(*, share_id=None, max_size=None) -> int
  # 남은 개수. 목록 길이로 세지 마라 — limit 에 잘려 "남은 것 없음" 거짓말이 된다.
state.file_record_scan_skipped(file_id, *, reason) -> None
  # 시도했지만 못 읽은 파일 표식(scan_status='skipped:<reason>'). 'scanned' 로 적으면 거짓말.
state.asset_owner_get(ip) -> dict | None
  # Splunk asset lookup 기반 IP 담당자 캐시. 반환:
  # {ip, user_id, user_name, user_dept, email, source, updated_at}
state.asset_owner_upsert(ip, *, user_id=None, user_name=None,
                         user_dept=None, email=None,
                         source="splunk") -> dict
  # 보통 직접 호출하지 말고 smb_owner_lookup tool 사용. email 미지정 시
  # user_id@samsung.com 으로 계산.
state.share_files_filtered(share_id, *, offset, limit,
                           suspicious_only=False, hits_only=False,
                           ext=None, path_contains=None,
                           review_status=None) -> {total, items}
state.hits_for_file(file_id) -> list[dict]
state.file_get_metadata(file_id) -> dict

# ─── 발견 영속 (NOT share_upsert / file_upsert) ────────────────
state.upsert_smb_share(scan_id, subnet, host, share, *,
                       null_login_ok: bool|None = None,
                       guest_login_ok: bool|None = None,
                       auth_login_ok: bool|None = None,
                       auth_credential_id: int|None = None,
                       share_read: bool = False,
                       share_write: bool = False) -> tuple[str, int]
  # 반환: (op, share_id) — op='new' 또는 'updated'

state.upsert_smb_file(share_id, path, *,
                      size: int, is_text_candidate: bool,
                      suspicious_name: bool) -> int          # file_id

state.file_record_fetch(file_id, *, fetch_status,
                        file_read, file_write=None) -> None
state.file_record_scan(file_id, *, hits_count) -> None

state.add_file_hits(file_id, hits)
  # hits = list[Hit dataclass] (그대로 OK, v3.42 F1-b)
  # 또는 list[dict]: [{'category':..., 'kind':..., 'masked':...,
  #                    'line_no':..., 'line_preview':...}, ...]
  # ※ key 이름은 'line_preview' (이전 'preview' 아님 — v3.42 통일)
state.add_file_hit_manual(file_id, *, category, kind, masked,
                          line_no, line_preview, verdict='confirmed')
state.file_hit_set_verdict(hit_id, *, verdict, confidence=None,
                            note=None)

# ─── Review ────────────────────────────────────────────────────
state.file_set_review(file_id, *, severity, summary,
                      tags=None, note=None, overwrite=False)
state.file_set_note(file_id, *, note, tags=None)
state.share_set_listing_review(share_id, review: dict)
  # review = {severity, summary,
  #           top_findings: [{file_id, reason}],
  #           follow_up_actions: [...]}
```

## Agent tool: `smb_owner_lookup`

```python
smb_owner_lookup(ips=["10.125.11.60"], persist=True, max_results=5000)
```

- 내부에서 `splunk_query`를 우선 사용하고, 없으면 `splunk_search`로 fallback.
- SPL:
  `| inputlookup LOOKUP_CONTEXT_ASSET_LIST_V2 where IP="*" | table IP,USER_ID,USER_NAME,USER_DEPT`
- 결과는 `state.asset_owner_upsert`로 저장되어 SMB finding report의 담당자 영역과
  `담당자 메일 발송` 기능에서 사용된다.
- `USER_ID`가 `kim.sec`이면 수신자는 `kim.sec@samsung.com`.

### DB persist 실패 시 — in-memory 결과로 직접 답변

upsert 호출이 AttributeError / TypeError 등 실패해도 **walk + fetch + scan 결과는 이미 메모리에 있음**. 운영자 보고는 in-memory 결과로 직접:
- `print(f'HIT {host}/{share}/{f.path}: {hit.category}/{hit.kind} {hit.masked}')` stdout 출력
- final assistant text 에서 그 stdout 값 그대로 인용 (placeholder / 추측 X)
- DB persist 실패는 별도 사실로 보고 ("DB 영속화는 함수명 불일치로 skip — finding 은 in-memory 결과")
- 같은 함수 2회 실패 → skill 의심 → 운영자에게 "skill 의 X 부분 수정할까요?" 보고

## `detectors.scan_text`

```python
result = detectors.scan_text(
    body,
    label='path/of/file',
    include_document_signals=True,
)
# result.hits: list[Hit]
# Hit: category ('secret'/'secret_heuristic'/'pii'/
#                'semiconductor_process'/'business_confidential'),
#      kind, masked, line_no, preview
# include_document_signals=True: SMB 문서용 path/title/body/classifier 신호 포함.
# scan 후 state.add_file_hits 로 박는 게 표준.
```
