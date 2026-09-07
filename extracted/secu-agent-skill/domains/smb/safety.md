# smb_tasking / safety — lockout 흐름 + SMB-specific anti-patterns

## Lockout 흐름 (reactive)

- auth 모드 호출 중 `STATUS_ACCOUNT_LOCKED_OUT` 감지 → 모듈 전역 `_AUTH_DISABLED_REASON` 자동 set.
- 이 프로세스 동안 이후 auth 모드 시도는 자동 skip (null/guest 는 계속).
- `smb_python` 도구 자체가 호출 직전 pre-check → 이미 set 이면 `ToolError(forbidden)` 반환.
- agent 가 `smb._AUTH_DISABLED_REASON` 사전 점검 X, `reset_auth_lockout_flag()` 호출 X.
- 사용자가 명확한 subnet/IP 주면 **바로** `smb_python` 호출. "잠금 상태 확인 먼저" 같은 옵션 묻기 X.
- 실제 SMB 호출에서 `STATUS_ACCOUNT_LOCKED_OUT` 응답이 오면 그때 멈춤 + 보고. retry X.
- `STATUS_LOGON_FAILURE` 는 `STATUS_ACCESS_DENIED` 와 다르다. 단일 host login 실패는
  host-scoped auth skip 으로 남기고, 여러 host 에서 반복되면 credential drift 로 보고
  전역 `_AUTH_DISABLED_REASON` 을 set 한다.

## SMB-specific anti-patterns

| ✗ 패턴 | 왜 안 되나 |
|---|---|
| `print(body)` (fetch 결과 본문 dump) | context 폭주 (≤512KB → 100K+ 토큰). python-side filter |
| `f.is_text_candidate=False` 인 거 fetch | binary — 의미 없음, 시간 낭비. 우선 메타데이터 확인 |
| `STATUS_ACCOUNT_LOCKED_OUT` 뜬 후 다른 host 시도 | 글로벌 lockout. 다 잠긴 상태. 즉시 보고 |
| `STATUS_LOGON_FAILURE` 를 `STATUS_ACCESS_DENIED` 로 해석 | 비밀번호/계정 인증 실패와 ACL 권한 없음이 섞여 retry/report 판단이 깨짐 |
| `smb.reset_auth_lockout_flag()` agent 호출 | 운영자가 풀어야지 agent 가 풀면 안 됨 |
| 같은 file 두 번 fetch | `state.file_get_metadata` 로 이전 결과 확인 |
| `state.connect()` 으로 raw SQL UPDATE | helper 함수 우회 — charter_ref / 일관성 깨짐. `state.*` helper 사용 |
| body 안 정규식 직접 작성 | `detectors.scan_text` 가 이미 secret/PII 패턴 포괄. 보조로만 추가 |
| `list(smb.list_shares(h))` / `for x in smb.list_shares(h)` | NOT iterable. `.shares` 필드 접근 |
| `list(smb.list_shares_modes(h))` / `for sa in mm` | NOT iterable. `mm.shares` 필드 접근 |
| `smb.enumerate_host(ip)` (단수) | 존재 X. **`smb.enumerate_hosts(subnet)` 복수**. subnet 받음 |
| `expand_subnet + list_shares` 256번 alive 체크 | 너무 느림. `enumerate_hosts(subnet)` TCP 445 가 정답 |
| `import socket` 으로 직접 SMB 호출 | `smb` wrapper 우회 → lockout/audit 가드 빠짐. `smb.*` 사용 |
| `timeout_seconds` 명시 안 함 | default 15s. SMB blocking → hang 위험. **subnet 단위는 60s 명시** |
| `except Exception: continue` | silent swallow → 거짓 "0건" 보고 위험. `print` 로 에러 노출 |
| 사용자에게 "잠금 점검 먼저 할까요?" 옵션 | 도망 패턴. 명확한 명령은 바로 실행 |
| `share_upsert` / `file_upsert` 등 줄임말 | 존재 X. `upsert_smb_share` / `upsert_smb_file` |
| `directory_errors` 무시 | walk 중 접근 실패 디렉터리가 있으면 coverage gap. 결과 보고의 미확인 항목에 남긴다 |
| `walk_checkpoint` 버리고 재스캔 | cap 으로 잘린 share 는 checkpoint 로 이어서 walk. 처음부터 반복하면 누락/중복 판단이 흐려진다 |
| `auth` read 라서 안전하다고 닫기 | 현재 AUTH 검증은 DSSOC 공용 검증 계정 기준이다. `auth` 로 읽히면 접근 가능 증거로 취급 |

## SMB 호출 에러 처리 패턴

```python
for h in hosts:
    try:
        mm = smb.list_shares_modes(h)
    except Exception as e:
        # ✓ print 로 노출 — silent swallow X
        print(f"  {h}: list_shares_modes {type(e).__name__}: {e}")
        continue
    # ... 정상 처리
    if smb._AUTH_DISABLED_REASON:
        # ✓ 글로벌 lockout 감지하면 break — 다른 host 시도 X
        print(f"⚠ auth locked at {h}; abort")
        break
```

## SMB walk coverage / resume

- `smb_host_sweep` 결과의 `coverage.directory_errors_total > 0` 이면 일부 디렉터리 listing 이 실패한 상태다. "전체 확인 완료"라고 쓰지 말고 `shares[].directory_errors` 를 한계로 보고한다.
- `shares[].walk_truncated=true` 이면 `shares[].walk_checkpoint` 가 다음 실행 입력이다. 같은 share 이름을 키로 해서 `walk_checkpoints={"share": checkpoint}` 형태로 넘겨 이어서 걷는다.
- checkpoint 는 파일 cap 이후 남은 현재 디렉터리 위치와 대기 디렉터리 큐만 담는다. raw 파일 본문이나 credential 은 포함하지 않는다.

## 보고 패턴 (자연 종료)

- 결과 보고는 핵심 finding + severity + 한 줄 다음 action 으로 평이하게 마무리.
- 상투적인 후속 요청 유도 문구를 반복하지 말고, 확인된 사실 / 미확인 항목 / 현재 상태를 짧게 구분한다.
- ✗ 1️⃣2️⃣3️⃣ 강제 옵션 메뉴 — 결과 보고 후에도 도망 패턴. 확인된 사실과 현재 상태만 보고.
- ✗ `state.*` 실패해도 in-memory walk 결과 있으면 그걸로 정직 보고. DB 비어있다고 "X 없음" 거짓 narration X.
