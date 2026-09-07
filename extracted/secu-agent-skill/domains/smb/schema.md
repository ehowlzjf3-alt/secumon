# smb_tasking / schema — DB 테이블 컬럼

## `smb_share`
- `id, host, share, status` — status ∈ {`pending`, `walked`, `listing_reviewed`, `closed`, `ignored`}
- `null_login_ok, guest_login_ok, auth_login_ok` — INT, NULL=미시도
- `share_read, share_write` — INT, 0/1
- `listing_review` — JSON ({severity, summary, top_findings, follow_up_actions})
- `listing_review_at` — TS
- `last_seen, walk_done_at, walk_file_count` — walk 완료 TS / 인덱싱된 파일 수

## `smb_file`
- `id, share_id, path, size, sha256`
- `suspicious_name` — BOOL, 파일명 패턴 매치 (`password`, `secret`, `.env`, …)
- `is_text_candidate` — BOOL, 확장자 기반 (텍스트로 fetch 시도할 가치)
- `file_read, file_write` — BOOL, 권한
- `fetch_status` — ∈ {`text`, `binary`, `empty`, `denied`, `not_found`, `error`, NULL}
- `scan_status` — ∈ {`pending`, `scanned`}
- `hits_count` — INT, scan 후 매치 개수
- `review_severity, review_summary, review_status, agent_note, agent_tags`

## `smb_file_hit`
- `id, file_id`
- `category` — ∈ {`secret`, `pii`}
- `kind` — e.g. `aws_access_key_id`, `kr_rrn`, `slack_token`, `private_key_pem`, …
- `masked, line_no, line_preview` *(v3.42 통일, 이전 'preview')*
- `agent_verdict` — ∈ {`pending`, `confirmed`, `false_positive`}

## status 전이

```
pending  ─── walk ───→ walked  ── review ──→ listing_reviewed
                                       │
                                       └── 운영자 ── ignored / closed
```

- `pending`: discovery 만 됨. walk 안 함.
- `walked`: 파일 목록 + 메타데이터 박힘. fetch+scan 일부 / 전체 가능.
- `listing_reviewed`: `share_set_listing_review` 호출돼서 severity / summary 박힘.
- `closed`: 더 이상 관심 X.
- `ignored`: false positive / 관리자가 제외.
