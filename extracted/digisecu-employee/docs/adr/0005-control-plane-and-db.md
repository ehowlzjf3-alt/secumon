# ADR 0005 — 컨트롤플레인 언어 + DB 경계: TS Express + 별도 Postgres DB

- 상태: Accepted (M0)
- 관련: §3-3, DISCOVERY-AND-DECISIONS §7

## 맥락
컨트롤플레인 언어(TS Express vs Python FastAPI)와 DB 배치(단일 DB vs 스코프 분리)를 결정. 확인된 제약: secu-agent-skill `state_domain`이 **엔진 코어와 같은 Postgres·같은 DB**를 쓰고 코어 `connect()` 풀을 재사용(도메인 DB 물리 배치는 이미 고정). `state_domain`이 도메인 28테이블의 유일 접근 경로.

## 결정
- 컨트롤플레인 = **TS Express**(zod 계약을 프론트와 직접 공유, ADR 0001 정합).
- DB = 같은 Postgres 서버에 **컨트롤플레인 전용 별도 DB/schema**(Employee/Task/Approval/AuditLog/Secret).
- 도메인 상태는 이 DB에 두지 않고 `state_domain` 유일 경로(M4 Python read 게이트웨이)로만 접근.

## 근거
- Drizzle 마이그레이션이 엔진+스킬 공유 도메인 DB의 28테이블을 절대 건드리지 않도록 물리 분리.
- 논리적 접근 경로 분리(§3-3)는 물리 배치와 무관하게 유지: 컨트롤플레인 테이블 = Drizzle 리포지토리, 도메인 테이블 = state_domain.

## 결과
- 커넥션: 컨트롤플레인은 자체 DB DSN(`CONTROL_PG_DSN`), 도메인 게이트웨이는 엔진/스킬 DB URL.
- 물리적으로 같은 Postgres 인스턴스라도 DB/schema가 다르므로 마이그레이션·백업 경계 명확.
