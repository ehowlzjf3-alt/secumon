# P2 — 도메인 state 스킬별 소유(네임스페이스) 계획

> ## 🟢 P1 랜딩 — 컷오버 UNBLOCKED (core v3.88 — 2026-07-13)
>
> 컷오버를 막던 **P1(코어 StatePort 어댑터)이 랜딩**됐다: 코어 `43edd88`(P1 persistence 포트&어댑터 +
> core 스키마 FULL-MOVE) · `67b8bd5`/`2b8080c`(P2 platform 네임스페이스 provision) · `ead000b`
> (R3-1 idless INSERT 판정). 계약: 코어 `docs/STATE-PORT-CONTRACT.md` + `ATTACHING-A-DOMAIN.md` §6.
> 스킬측 W2(register_schema 4종 **dormant** 등록 + platform CREATE 제거 락스텝)는 #55 로 완료.
>
> **현 상태**: 스킬 `service/state_domain.py::connect()` 는 여전히 **baseline search_path**(접근만)로
> 동작 — 네임스페이스 등록은 dormant. 남은 것은 **컷오버 실행**(§3): `connect()`→`connection("skill_<d>")`
> 전환 + 모놀리식 `_ensure_domain_schema` 제거 + 라이브 마이그레이션. 이는 **라이브 DB 를 건드리는
> 독립적·신중한 마일스톤**(#54)이며 본 문서-정리/드리프트 세션 범위 밖 — 착수 시 별도 게이트로 진행.
>
> ---

> 목표: `service/state_domain.py`의 모놀리식 28테이블 스키마를 **네임스페이스(스키마)별 소유**로 분해.
> 코어 `StatePort.register_schema(namespace, ddl)` 계약(secu-agent/docs/STATE-PORT-CONTRACT.md)에 코딩.
> **P1(코어 어댑터) 완료 전까지는 additive 준비만**(현 동작 무영향), 컷오버는 P1 후.
>
> 스코프(codex 결정, 계약 §7): 운영 SQL은 **정규화 테이블명**(`skill_smb.smb_share`) 안전. 컷오버는 점진 —
> 1단계 `SET LOCAL search_path = <ns>, platform, core, pg_catalog`(트랜잭션마다·따옴표 없이)로 기존 쿼리 무변경 동작
> 확보 → 2단계 hot-path부터 정규화. DDL은 **baseline + 순서있는 migrations 분리**(codex #5). cross-schema는 `core.finding_lifecycle` 명시.

---

## 1. 네임스페이스 → 테이블 매핑 (28테이블 실측 분류)

| 네임스페이스 | 소유 | 테이블 |
|---|---|---|
| **core** (코어 소유) | finding SSOT | finding_lifecycle, finding_index *(이미 secu_agent/state.py 소유 — 여기 재배치 대상 아님)* |
| **platform** (얇은 공유, **코어 소유**) | 횡단 운영·서비스공유(component/domain 키) | control_flag, pipeline_heartbeat, pipeline_run, service_reply_message, devops_target |
| **skill_smb** | SMB 스킬 | smb_credential, smb_share, smb_directory, smb_file, smb_file_hit, smb_target_subnet, mail_thread, mail_message, mail_reply_decision, mail_reverify_result, **scan, asset_owner, screenshot** |
| **skill_dev_web** | dev_web 스킬(web 흡수) | web_target_domain, dev_web_target, dev_web_report_thread, dev_web_recheck_result |
| **skill_github** | github 스킬 | github_repo_target, github_report_thread, github_recheck_result |
| **skill_confluence** | confluence 스킬 | confluence_space_target, confluence_report_thread, confluence_recheck_result |

합계 platform 5 + smb 13 + dev_web 4 + github 3 + confluence 3 = 28 ✓ (finding_* 2는 코어).

메모(★재귀속 2026-07-12):
- 자동추출은 platform 8이었으나 실사용 조사 결과 `scan`(SMB 네트워크 스윕)·`asset_owner`(SMB owner enrichment, ip PK=idless)·`screenshot`(SMB share/file 증거)는 **SMB 전용** → skill_smb 재귀속. platform 잔여 5는 `component`/`domain` 키의 진짜 횡단.
- `mail_*` 4종은 SMB 전용(grep: dev_web/services 미참조) → skill_smb.
- **platform은 코어 소유**(register_schema 거부) — secu-agent 부트스트랩(67b8bd5+2b8080c)이 provision. 스킬은 register 안 하고 baseline search_path로 접근만.
- finding_id는 opaque BIGINT 참조(cross-schema FK 없음) → 스키마 분리해도 조인 가능(search_path에 core 포함).

---

## 2. 분해 산출물 (도메인별 DDL 모듈)

현 `_DOMAIN_SCHEMA`(한 문자열)를 아래로 분해(additive 신규 파일, 아직 미배선):

```
domains/smb/infrastructure/schema.py         → SMB_DDL(+idless) → register_schema("skill_smb", SMB_DDL)
domains/dev_web/infrastructure/schema.py     → DEV_WEB_DDL     → register_schema("skill_dev_web", ...)
domains/services/github/infrastructure/schema.py    → GITHUB_DDL
domains/services/confluence/infrastructure/schema.py→ CONFLUENCE_DDL
service/platform_schema.py (얇은 공유)        → PLATFORM_DDL(scan/pipeline/control_flag/asset_owner/screenshot/service_reply_message/devops_target)
```

각 모듈은 자기 CREATE TABLE + CREATE INDEX + (해당 시) idless 테이블명만 소유. 기존 ALTER/백필 로직도 도메인별로 귀속.

## 3. 컷오버 (P1 후)

1. 각 도메인 bootstrap이 attach 시 `register_schema("skill_<d>", <d>_DDL)` 호출.
2. `state_domain.connect()` → `StatePort.connection("skill_<d>")`(도메인별). 공유 헬퍼는 `connection("platform")`.
3. `_ensure_domain_schema` 모놀리식 제거 → 포트의 lazy register_schema로 대체.
4. 검증: 각 도메인 테이블이 자기 스키마에 생성 + 기존 쿼리(search_path) 동작 + finding 교차조인 유지.

## 4. P1 전 지금 할 수 있는 것 (병렬 준비)
- [x] 네임스페이스 매핑 확정(위 §1).
- [x] `_DOMAIN_SCHEMA` + ALTER 블록 → **네임스페이스별 DDL-as-data 모듈** 추출(`service/state_split/{skill_smb,skill_dev_web,skill_github,skill_confluence,platform}.py`, additive·미배선). 울트라코드 5에이전트 병렬 추출.
- [x] baseline + 순서있는 migrations + 백필 + idless + cross-namespace NOTES 귀속 정리.
- [x] **결정적 검증**: ast로 원본 vs 모듈 statement 집합 대조 → **173=173, 누락0·창작0 완전일치**.
- [ ] 컷오버 diff 초안(포트 시그니처 확정 후 1:1 치환 목록) — P1 계약 확정 대기.
- 보류(P1 필요): 실제 connect()→port 치환, 모놀리식 제거, 백필 헬퍼 코드이전, 실행검증.
