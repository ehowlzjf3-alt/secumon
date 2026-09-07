# web_tasking / schema — DB 테이블 (stub)

> 재배치 시 신설 stub. 실제 컬럼은 엔진 `state.py` 의 web 테이블 DDL 참조
> (도메인 테이블 DDL 은 엔진 잔류 — 추출 플랜 §C.3, 재부착 시 plugin schema hook).

## web_target_domain (web-batch 큐)

| 개념 컬럼 | 의미 |
|---|---|
| `id` | target_id |
| `domain` | 사이트 호스트 |
| `day_bucket` | 적재 일자 (UNIQUE(domain, day_bucket) dedup) |
| `event_count` | splunk 트래픽 이벤트 수 (우선순위) |
| `status` | pending / in_progress(claim) / tasked / skipped / error |
| `finding_count`, `reason` | set_status 결과 |

- claim: `web_target_claim_next(session_id)` — 동시 세션 중복 방지 atomic 점유.
- 완료 판정: pending 0 (코드 결정론, judge 우회).

> TODO: 실제 컬럼명/타입을 엔진 state.py 에서 확정해 채울 것.
