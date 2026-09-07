# digisecu-gateway (M4)

`state_domain`(물리 DB `threat_hunter`)의 **유일한 외부 sanctioned read 어댑터**. control-plane과
**별개 Python 프로세스**로, 도메인 상태를 **read-only**로 읽어 web에 3축을 공급한다:
업무/큐(queue depth) · finding[마스킹] · 워크스페이스 payload.

## 설계 불변식
- **엔진/스킬 무수정.** 게이트웨이는 스킬 `state_domain.connect()`·엔진 `secu_agent.state.connect()`나
  그 read 함수를 **호출하지 않는다**(첫 호출이 라이브 DB에 CREATE TABLE + 백필 UPDATE를 트리거하므로).
  스킬 모듈은 스키마/쿼리 **사양서**로만 참고하고, 자체 read-only 커넥션으로 파라미터라이즈드 SELECT만 발행한다.
- **read-only 3중 강제**: (1) 전용 DB role(최소권한 GRANT SELECT + REVOKE DDL/DML, `sql/001_readonly_role.sql`),
  (2) 세션 `default_transaction_read_only=on`, (3) 앱 SELECT-only 가드. + `statement_timeout`(쿼리 비용 제한).
- **마스킹 seal 존중**: finding은 저장시점 봉인 → SELECT=마스킹값. 원문(extra_json)·evidence 경로·`finding_index`는
  노출하지 않는다(evidence 존재는 `hasEvidence` 불리언만).
- **경계**: control-plane(digisecu_control)은 state_domain 미접근 유지. 게이트웨이는 도메인 응답을 control-plane으로
  프록시하지 않는다. web은 `/gw`로 **직접** 요청.

## 사전 준비
1. **전용 read-only DB role 생성**(사용자님이 직접, threat_hunter 소유자로):
   ```bash
   psql "postgresql://<admin>@<host>:5432/threat_hunter" \
        -v ON_ERROR_STOP=1 -v gw_password="강력한비밀번호" -f sql/001_readonly_role.sql
   # ★ gw_password 값에 따옴표를 넣지 마세요 — 스크립트가 :'gw_password' + %L 로 안전하게 quote 합니다
   #   (따옴표를 넣으면 실제 롤 비밀번호에 ' 문자가 포함되어 이후 평문 DSN 인증이 실패).
   # ★ ON_ERROR_STOP=1 로 CREATE ROLE/GRANT 실패 시 반쪽 ACL 상태로 진행하지 않고 중단.
   ```
2. **환경변수**(fail-closed — 없으면 기동 거부):
   - `SECU_AGENT_PG_DSN` — 위 `digisecu_gw_ro` role로 threat_hunter 접속(엔진과 **동일 DB**, 신규 DSN 만들지 말 것).
   - `GATEWAY_TOKEN` — `/gw` Bearer 토큰. (선택: `GATEWAY_HOST`=127.0.0.1, `GATEWAY_PORT`=8091)

## 실행
```bash
cd gateway
uv venv --python 3.12 .venv && . .venv/bin/activate
uv pip install -e ".[dev]"
SECU_AGENT_PG_DSN=... GATEWAY_TOKEN=... digisecu-gateway   # uvicorn 127.0.0.1:8091
```

## web 연동 (dev)
web(vite) 프록시가 `/gw`를 게이트웨이로 전달하며 **Bearer 토큰을 서버측 주입**(브라우저 미노출):
```bash
GATEWAY_TOKEN=<동일값> GATEWAY_URL=http://127.0.0.1:8091 pnpm dev:web
```
게이트웨이 미기동 시 web은 각 축을 자동으로 mock 폴백한다(빌드/렌더 무중단).

## 테스트
```bash
. .venv/bin/activate
# 무DB(가드·격리): 항상 실행
pytest tests/test_guard.py tests/test_import_isolation.py -q
# 라이브(read-only·스키마 드리프트·HTTP): DSN 주입 시
set -a; . ~/project/secu-agent/.env; set +a; GATEWAY_TOKEN=test pytest tests -q
```

## 마스킹(적대적 검증 반영)
finding의 `summary`는 submit 경로만 write-time seal이고 update(PATCH) 경로는 unsealed, `asset`은 seal이 전무하다
(엔진 자신도 read 경계 ralph_controller에서 재마스킹). 따라서 게이트웨이는 반환하는 모든 free-text 컬럼
(asset/summary/owner/ticketRef/subjectTag/label/findingSummary)을 `masking.redact()`로 **read 경계 재마스킹**한다.
이것은 **heuristic 방어망**(주민번호·SSN·자격증명URL·시크릿·이메일·고엔트로피 등 알려진 고위험 패턴)이며,
권위 있는 봉인은 여전히 엔진 write-time seal이다 — 전화번호·여권 등 신규 포맷은 미커버일 수 있다(후속 강화 여지).

## 보안 후속(하드닝 — codex/적대적 검증 반영)
read-only는 기밀성 경계가 아니다. 현재는 최소권한 role + localhost 바인드 + Bearer 토큰 + `statement_timeout`.
프로덕션에는 추가로 **제한 view/컬럼 권한/RLS · 실 authn·authz · tenant 격리**가 필요하다(현 digisecu는 로컬 세션·SSO 없음).
SELECT-only 가드는 프리픽스 정규식이라 방어심층으로 **CTE 내부 DML 스캔** 추가 여지(현재는 role+세션 read-only가 25006으로 막음).

## 결정 반영(resolved)
- **엔진 'web' 도메인**: dev_web이 재사용하는 웹점검 베이스 툴킷 → `dev_web=('dev_web','web')`로 **통합**(실데이터상 web-점검 결과는 이미 'dev_web'으로 canon 태깅).
- **strategy(수집) 스테이지**: 게이트웨이 실집계로 제공 — smb=subnet 스코프(smb_target_subnet), dev_web=미완료 web도메인(web_target_domain). 롤링수집(github/confluence)은 수집·점검이 동일 타깃 테이블이라 0.
- **workspace performance/KPI**: 실집계 — 퍼널(severity 분포)·주간추이(finding 유입/처리)·KPI를 게이트웨이가 제공.

## 남은 열린 결정(openDecisions)
- **레거시 'devops' task_type**: 데이터 0건·신규 미생성 → **무시**(잔존분 발견 시 자산기준 라우팅 재검토).
- verify 스테이지 status는 실측 기반(비종결=대기, verify=recheck/reply 계열). 도메인 확장 시 재확인.
- 성과 대시보드 resolved(처리)는 finding_lifecycle.status 기준(현재 대부분 open) — 관리 파이프라인(리포트·재검증 완료)까지 반영하려면 스레드 조인 집계로 확장 여지.
