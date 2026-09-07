# SOAR 콘솔 — 검증 대기 목록

리뷰 가능한 환경이 아닐 때 밀어붙이면서, **사람이 직접 확인해야 하는 것**만 여기 모은다.
코드로 자동 검증한 것은 여기 없다(테스트가 대신 지킨다). 여기 있는 것은 전부
"내가 확인할 수 없었던 것" 이거나 "확인은 했지만 사용자 판단이 필요한 것" 이다.

작성 시작 2026-08-23. 항목을 처리하면 지우지 말고 `[x]` + 확인 결과를 남긴다.

---

## A. 사람이 실행해야 하는 것 (prod 게이트)

- [x] **`sql/001`~`004` 전량 적용 + 게이트웨이 롤 전환 완료** (2026-08-23)
  롤 `digisecu_gw_ro` 신규 생성(비밀번호는 `openssl rand -hex 24` 무작위 — 대화·로그 미출력).
  게이트웨이 env 를 `.env.gateway`(600, gitignore)로 분리했다.
  ⚠️ `SECU_AGENT_PG_DSN` 은 엔진이 **쓰기**에 쓰는 것과 같은 키 이름이라, 저장소 공통 `.env` 에
  넣으면 엔진이 읽기전용 롤로 붙어 죽는다. 파일을 나눈 이유가 그것이다.

  실행 확인:
  - 접속 유저 `digisecu_gw_ro` · 세션 `transaction_read_only=on`
  - 부여 19개(finding_lifecycle·큐/스레드 11 + pipeline 2 + quality VIEW 1 + asset_owner + 재검증 4)
  - **차단 확인(42501)**: `smb_credential` `finding_index` `screenshot` `mail_message`
  - **쓰기 차단(25006)**
  - `ownerLookup=ok` · `remediationLookup=ok` · 집계 수치 전환 전후 동일
  - 게이트웨이 테스트 **278 통과** — 이제 실제 권한 경계 위에서 돈다(전엔 슈퍼유저라 안 밟았다)

  ⚠️ `sql/001` 을 재적용하면 4b 리셋이 SELECT 를 전량 회수하므로 002·003·004 를 **반드시 다시** 실행.
  ⚠️ 비밀번호를 잃으면 001 을 새 값으로 다시 돌리면 된다(`ALTER ROLE` 로 갱신되는 멱등 스크립트).

- [ ] **`web/.env.local` 의 `VITE_RUN_SINCE` 비우기 (다른 환경)**
  이 파일은 gitignore 대상이라 커밋에 안 들어간다. 비어 있지 않으면 기본 모수가 그 기간으로
  좁혀지고, 같은 숫자가 화면마다 다른 뜻이 된다(서버 total vs 필터 걸린 목록).

- [x] **게이트웨이 재기동** — 완료. 새 라우트 + 새 롤로 기동 중(:8091).

---

## B. 라이브 화면에서 눈으로 봐야 하는 것

- [ ] **담당자 노출 범위** — `/gw/sources` 응답에 담당자 **실명·부서·사내 메일**이 실려 나간다.
  기존 `ReportThreadItem.ownerRecipient` 와 같은 정책(사내 ACL 사이트라 허용)이지만,
  목록 화면에 대량으로 뜨는 건 처음이다. 실제 화면을 보고 이 범위가 맞는지 판단 필요.

- [ ] **조치 현황 표의 "조치 완료" 근거가 도메인마다 다른 것** — 화면에 `remediationBasis` 를
  어떻게 드러낼지. 지금 설계는 열 하나에 숫자를 담고 근거를 툴팁/작은 글씨로 붙이는 안이다.
  같은 열에 다른 뜻의 숫자가 들어가는 건 사용자 확인이 필요한 판단이다.

- [x] **밀도** — 1440/1280/1024 세 폭에서 확인. 가로 넘침 0(문서·본문 둘 다), 표가 깨지지 않는다.
  1024 에서는 대상 열이 좁아져 truncate 가 많아지지만 읽을 수는 있다. (2026-08-23)

- [x] **미상(파싱 실패) 버킷** — 눌러 들어가면 정상. 헤더가 "미상 · SMB · 미통보", 발견 14건이
  RSA 개인키·SSH 키·공정 레시피 백업 등으로 뜬다. 그중 하나는 로그인 검증까지 된 심각 건이다.
  (2026-08-23)

---

## C. 내가 확인 못 한 것 (환경 제약)

- [x] **★ `digisecu_gw_ro` 롤 부재 — 해소됨** (2026-08-23 생성·전환 완료. 아래는 발견 당시 기록.)
  `sql/001` 이 한 번도 적용된 적이 없고, **게이트웨이가 지금 `shaneee.baek`(슈퍼유저)로 붙어 있다.**
  3중 방어 중 1층(최소권한 롤)이 통째로 빠진 상태이고, 2층(세션 read-only)·3층(앱 SELECT 가드)만 돈다.
  → `sql/004` 만 따로 돌리는 건 무의미하다(받을 롤이 없어 바로 에러).
  순서: `001`(**롤 비밀번호 인자 필요 — 사용자 결정**) → `002` → `003` → `004` → gw DSN 교체 → 재기동.
  ```
  psql "$SECU_AGENT_PG_DSN" -v ON_ERROR_STOP=1 -v gw_password='...' -f gateway/sql/001_readonly_role.sql
  ```
  ↳ 남은 것: `denied` 경로(담당자 "권한 없음") 화면 재현. 지금은 GRANT 가 있어 `ok` 로만 지나간다.
     일부러 `REVOKE SELECT ON asset_owner FROM digisecu_gw_ro` 로 한 번 밟아볼 수 있다.

- [ ] **`confluence` 도메인 전반.** 리포트 스레드가 **0행**이라 조인·상태·담당자 경로가
  전부 빈 값으로만 지나갔다. 스레드가 생기면 처음 실행되는 코드 경로가 있다.

- [ ] **`jenkins` task_type.** SSOT 상 github 도메인에 속하지만 실데이터가 0건이라
  파싱 분기가 한 번도 안 돌았다. 코드로는 커버(`test_src_case_uses_domain_axis_not_task_type`).

- [ ] **동시 부하.** `/gw/stats` 는 949ms 다. `pool_max=4` 에서 여러 명이 동시에 열면
  어떻게 되는지 측정 못 했다. `statement_timeout` 5,000ms 안이라 죽지는 않는다.

- [ ] **긴 표에서 키보드로 페이지 이동.** 행이 50개면 페이지네이션까지 탭 50번이다.
  건너뛰기 수단이 없다. (탭 순서·포커스 링·링크 시맨틱 자체는 확인 완료 — 행은 전부 `<a>`,
  `div+onClick` 0개.)

---

- [ ] **★ `dev_web_report_thread.recipient` 은 **스레드가 태어날 때** DSSOC 로 채워진다** (2026-08-24)
  실측: **137행 전부** `dssoc@samsung.com`. NULL 0행, 다른 값 0행.
  상태는 `reported` 135 · `draft` 2 — **`awaiting_reply` 는 0행**이다. 즉 발송 기록 경로
  (`_report_fields`)가 쓴 게 아니라, `dev_web_submit_finding_tool._default_recipient()` 가
  **finding 제출 시점에** 넣은 값이다(DSSOC 사본 세 번째).

  파급 둘:
  - 게이트웨이 `deliveryTarget` 이 dev_web 137건 전부 "DSSOC" 로 뜬다 — 한 번도 안 보낸
    스레드까지. 화면은 기록을 정직하게 그렸고, **기록이 거짓말**이었다.
  - `dev_web/webapp/routes/targets.py:112` 의 `has_request_mail` 은
    `request_message_id or recipient` 라 **항상 True** 다. 발송 경로는 `request_message_id`
    를 명시적으로 None 으로 두므로, recipient 가 유일한 근거인데 그게 상수였다.

  → 사람 판단 필요: 과거 137행을 NULL 로 비울지(모름을 모름으로), 그대로 둘지.
     실제 수신자 기록이 어디에도 없어 **소급 복원은 불가능**하다.

## C-2. 다른 세션에서 받은 정정 (2026-08-23)

엔진·스킬 쪽 세션이 알려온 사실 — 내 조사 결론 하나를 고친다.

- **`github report_html` 이 0/299 인 것은 빌더 결함이 아니라 미실행이다.**
  보고·재확인 파이프라인이 6주간 정지 상태였다(사용자가 의도적으로 finding 탐지만 돌림).
  즉 "컬럼은 있는데 안 채워진다" 가 아니라 "채울 일이 안 돌았다" 다.
  → 파이프라인이 다시 돌면 저절로 채워진다. 메일 본문 미리보기의 선행조건은
  `mail_message`/`report_html` GRANT 와 마스킹 경계 재설계 쪽이지 빌더 수정이 아니다.

- 도메인별 webapp 표면이 갈라져 있다는 것도 그쪽 조사: 운영 액션(재확인 요청·담당자 재지정·
  예외 종결/반려)은 **github·confluence 에만** 있고, 메일 스레드·에이전트 관측은 **smb 에만** 있다.
  ⚠️ 그 액션들은 전부 **쓰기**라 `/gw` 로는 못 간다(게이트웨이 read-only 불변식).
  control-plane + `APPROVER_TOKEN` 배선이 선행된다.

## D. 나중에 정해야 하는 것 (파킹)

- [ ] **4도메인 메일 본문 수정·추가** — 사용자 지시로 보류(2026-08-23).
  근거는 `memory/mail-body-per-domain-gaps.md`. 착수하려면 스킬 저장소를 열어야 해서
  "엔진·스킬 무수정" 불변식에 대한 결정이 선행된다.

- [ ] **dev_web 재확인 3단 단절 복구** — 수신(POP3 태그 분기 없음)·본문(재검증 워커에
  발송 도구 없음). 스킬 저장소.
  ↳ **첫 항목("발송: 수신자 DSSOC 고정")은 진단이 틀렸었다 — 2026-08-24 해소.**
     고정돼 있던 것은 발송이 아니라 **기록**이다. `dev_web_report_agent._report_fields` 가
     `subject` 는 실제 deliver 호출에서 읽으면서 `recipient` 만 DSSOC env 에서 읽어,
     어디로 보냈든 `dev_web_report_thread.recipient` 에 DSSOC 를 적었다. 기존 테스트가
     그 조작을 단언하고 있었다(가짜 호출은 owner 에게 보내는데 통과 조건이 dssoc).
     동시에 dev_web 만 4도메인 중 `*_report_delivery_targets` 래퍼가 없어
     `thread.recipient or DSSOC[0]` 로 손수 갈랐고 Cc 는 항상 비어 있었다.

- [ ] **`dev_web_report_tools._risk_text` 버그** — `risk_narrative` 에서 `summary`/`impact` 를
  찾는데 실제 필드는 `what_is_data`/`how_discovered`/... 라 "확인 안내" 가 항상 고정 문구로
  떨어진다. 스킬 저장소.

- [ ] **쓰기 경로**(티켓 상태 변경·담당자 지정) — control-plane 에 src 단위 테이블 +
  상태전이 이력 테이블 신설 + `APPROVER_TOKEN` 배선이 선행. 사실상 별도 프로젝트.

- [ ] **메일 본문을 화면에 띄우기** — SMB 만 본문이 남고(269통), 그마저 `mail_message` 가
  GRANT 목록에 없다. 게다가 저장된 본문은 egress 마스킹 **이전** 값이라 실제 나간 메일보다
  덜 가려져 있을 수 있다. 라벨을 "발송본" 이 아니라 "발송 요청 본문" 으로 할지 결정 필요.

- [ ] **finding status 가 `open`/`false_positive` 둘뿐** — `resolved` 로 넘어간 finding 이
  하나도 없다. finding 단위 조치율을 보려면 워커가 status 를 닫아주는 배선이 먼저다.
