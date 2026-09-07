---
name: web
domain: web
description: Web exposure, vulnerability, and sensitive-info tasking.
when_to_use: Web/domain tasking, attack-surface discovery, public or internal web exposure review.
triggers: web, 웹, 사이트, 도메인, 홈페이지, url, http://, https://, web tasking, web-tasking
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# web_tasking

> **resources** (재배치 시 분리): `api.md`(도구·agent_type 시그니처) · `schema.md`(web_target_domain
> 테이블) · `snippets.md`(endpoint sweep·scope assert·SPL) · `safety.md`(SSO 서킷브레이커·
> url_safety KEEP 하중). 안전 계약 본문은 같은 디렉터리의 `safety.md` 다 —
> `skill(action='view', ...)` 로는 열 수 없다(web 도메인엔 `skills/` 디렉터리가 없어
> 탐색 경로에 잡히지 않는다). 파일로 직접 읽어라.

Web tasking is not just vulnerability scanning. It is a scoped, passive-first
review of exposed attack surface, sensitive data flow, and exploitable web
behavior. Every claim must pass semantic validation before it is reported as a
finding.

## 위협모델 — 사내(internal), 외부 노출 아님 (중요)

대상 cdep 사이트는 **사내망 전용** (MWG 프록시 뒤, 인터넷 비노출). 그러므로:
- finding 을 **"외부 인터넷에 노출", "외부 공격자가..."** 로 쓰지 마라 — **틀린 framing**.
- 실제 위협 = **인가받지 않은 내부 사용자 / 탈취된 사내 계정 / 측면이동(insider)** 이
  인증·인가 없이(또는 부적절한 권한으로) 민감 데이터·기능에 접근할 수 있는가.
- 표현: "외부에 노출됨" ❌ → "**인증/인가 없이 사내망에서 접근 가능**" ✅.
  "외부 공격자" ❌ → "**내부 위협 행위자(미인가 사용자/탈취 계정)**" ✅.
- 따라서 "사내망이라 안전" 도 틀림 — 사내망 안에서 인증 없이 보이면 그게 finding 이다.

## Scope

- Stay within the user-authorized domain, subdomain, or CIDR scope.
- External domains found in links, scripts, SSO, CSP, redirects, or API hosts are
  attack-surface references only. Do not probe them offensively without explicit
  authorization.
- Do not use discovered credentials, log in, pivot, or escalate privileges
  without a separate approval.
- Store and report sensitive values only in masked form.

## Mandatory Tool Pattern

1. **`browser_query`/`browser_action` 으로 실제 페이지를 렌더해서 확인하라 — 모든 대상 필수
   (정책 A, 아래 Deep-dive).** SPA 가 인증 없이 데이터를 보여주는지는 브라우저로만 확인된다.
2. Use `web_resource_probe` before claiming a resource exists, is exposed, or
   contains sensitive information.
3. Use `web_fetch` for a bounded follow-up fetch when a specific URL needs body
   inspection.
   - **동일 패턴 대량 처리 (sampling cap):** 같은 종류의 후보가 여러 개일 때
     (예: splunk/로그에서 나온 `?n=<토큰>` 류 공유 URL 수십 개, 같은 호스트의
     동일 endpoint 변형) — **전수 web_fetch 금지.** 대표 **2~3개만** `web_fetch`
     로 본문 실증하고, **나머지는 `web_resource_probe` (배치·경량)** 로 접근가능
     여부(status/content-type)만 확인해라. finding 은 "동일 패턴 N건, 표본 M건
     실증 — 전부 무인증 접근 가능" 식으로 **일괄 1건** 기록. 같은 종류를 수십 번
     fetch+scan+browser 하는 건 느리고 중복이다 (한 종류 = 1 finding 원칙과 동일선상).
4. Use `web_vuln_probe` only after resource semantics are clear. Treat its
   output as probe evidence, not as final judgment.
5. Use `submit_finding` only for confirmed evidence. Use informational severity
   or a normal text report for inconclusive observations.
   confirmed finding 을 제출할 때는 `risk_narrative`(4부: 데이터 정체/발견 방법/악용 경로·왜
   위험/확인 방법)도 같이 채워라 — 발견 맥락이 살아있을 때가 가장 정확하다. 값 아닌 유형만(마스킹).

Do not rely on `HEAD`, HTTP `200`, body length, or response-size change alone.

### ⛔ 키워드 매칭만으로 finding 금지 (실제 사고 — #27)

**`web_task_scan` / 페이지 소스 키워드 매칭은 lead(단서)일 뿐, 단독으로 절대 submit_finding
하지 마라.** SPA 는 i18n 라벨·라우트명·JS 번들에 "반도체/공정/매출" 같은 키워드 문자열이
박혀있어서, **실제 화면이 "권한 없음"/로그인인데도 키워드가 매칭**된다 (#27 의 plam 사이트가
정확히 이 오탐 — 키워드만 보고 high finding 올렸으나 실제론 접근 불가).

규칙:
- 키워드 hit → **반드시 `browser_query` 로 그 화면을 실제 렌더**해서 *인증 없이 그 데이터가
  화면에 보이는지* 확인. 권한 없음 / 로그인 / 빈 화면 / 에러면 → **finding 아님 (drop)**.
- `masked`/`preview` 에 `"semiconductor process keyword context"` 같은 **플레이스홀더 금지**.
  실제 관찰한 값(마스킹된 필드명·파일명·레코드·화면 텍스트)이 없으면 제출하지 마라.
- summary 에 구체 사례(아래 finding 섹션의 "좋은 예")가 없으면 그 finding 은 미완성이다.

**이건 코드로 강제된다**: `submit_finding(task_type='web')` 은 대상 호스트를
`browser_action(navigate)` / `browser_query` 로 실제 열어본 기록이 없으면 거부된다
(`web finding 거부 — 대상 호스트(...)를 browser 로 실제 열어본 기록이 없다`). 그러니
사이트마다 **먼저 browser 로 접속**해서 화면을 확인한 다음 finding 을 제출하라.

## 자동화 워크플로우 (v3.53 web_target_domain)

사용자가 "웹 점검 시작" / "오늘 cdep 점검" / 비슷한 자연어 트리거 → 다음 3 step 자동:

### Step 1 — 적재 + goal 등록
```
run_web_discovery(siem_filter='cdep.samsungds.net')
```
- splunk SPL 자동 실행 → 오늘 day_bucket 에 활성 사이트 upsert.
- 결과 narration: `"discovered 181 sites for 2026-05-26 (new=158, existing=23) — event range 1~11545"`.
- 같은 날 재호출 OK — UNIQUE(domain, day_bucket) 으로 dedup.

**적재 직후 `goal` 도구로 목표를 등록하라** — 그래야 web-batch driver 가 켜진다:
```
goal(action='set', text='[web-batch] 오늘 cdep 웹 사이트 전부 점검')
```
- 인자는 `text` (goal 본문) 만. `action='set'`. **`max_turns` 는 주지 마라 (생략=0=무제한).**
- **`[web-batch]` 또는 "웹 점검/cdep/웹 사이트" 가 들어가면 시스템이 단일타깃 driver 로 돈다**:
  매 turn 시작 시 **다음 pending 사이트 1개만** 자동 주입된다 (너는 목록을 직접 순회하지 않는다).
  judge 우회 — 완료 판정은 코드가 `web pending == 0` 으로 결정론적으로 한다.
- turn 캡 없음 — pending=0 으로 완료되거나 사용자가 ESC/멈출 때까지 계속.
- **`run_web_discovery` + `goal(set)` 까지만 하고 그 턴은 종료하라.** 그 다음부터 시스템이
  매 턴 대상 1개씩 준다. `web_targets_pending` 로 목록을 직접 받아 순회하지 마라 (그 도구는
  web-batch 에선 의도적으로 안 줬다 — 직접 루프 돌면 한 턴에 여러 사이트를 얕게 처리하고
  deepdive 를 건너뛰게 된다).

### Step 2 — 사이트당 `web_site_sweep` (한 turn = 한 사이트)

web-batch driver 가 매 turn **딱 한 사이트**(`target_id`, `domain`)를 준다. 그 한 사이트만:

```
1) web_site_sweep(target_id=<주어진 id>)
   → 코드가 결정론적으로 전부 수행: navigate → (로그인벽이면) 로그인 → root + 발견 라우트
     snapshot → scan_text(secret/PII) → 표준 endpoint probe.
   → 구조화 디지스트 반환: pages[].scan_hits / probes / route_inventory / coverage
     (coverage.not_inspected = 미점검 라우트 명시).

2) 디지스트 판단 (여기가 너의 일):
   - pages[].scan_hits / 화면 텍스트 / probes 를 보고 **실제 노출**을 분류 — 공정정보·
     경영정보·계정/인증·개인정보·시스템장악. scan_hits 는 secret/PII 단서일 뿐, 공정/경영
     노출은 화면 텍스트로 직접 판단.
   - deepdive 필요하면(노출 API GET, 안 본 SPA 라우트, 인증영역) browser_action/
     browser_query 로 더 파라. read-only.

3) 실제 위협마다 submit_finding (한국어 위협분류 summary, 마스킹 증거).
   화면에서 확인된 것만 — 키워드 매칭만으론 금지(아래 #27).

4) web_target_set_status(target_id=<id>, status='tasked'|'skipped', finding_count=N, reason=..)
   - `tasked` = web_site_sweep 으로 조사 완료(노출 없어도 tasked, reason='no exposure').
   - `skipped` = 접속 자체 불가(디지스트 reachable=false) 또는 인증벽 로그인 실패.
   - sweep 이 browser 방문 + 내용분석을 이미 기록하므로 tasked gate 는 자연 통과한다.

5) 종료(end_turn). 남은 사이트는 다음 turn 에 시스템이 또 1개 준다.
```

**중요**:
- **한 turn = 한 사이트.** `web_targets_pending` 로 목록을 직접 받아 순회하지 마라 — driver 가
  1개씩 준다. 여러 사이트를 interleave 하지 마라(정책 B 자동 강제).
- `web_site_sweep` 이 browser deep-dive(정책 A)를 코드로 보장한다 — 사이트를 안 열고 넘어가는
  누락이 구조적으로 불가능. 너는 "더 팔지" 판단(deepdive)과 finding 분류에 집중.
- **set_status 를 빠뜨리지 마라** — 그래야 pending 이 줄고 다음 사이트로 넘어간다.
- splunk 죽었으면 (`splunk_search` 미등록/error) Step 1 에서 멈추고 알림. 추측 host 생성 X.

### Step 3 — 최종 보고
pending=0 이 되면 시스템이 자동으로 batch 완료를 보고한다
(`web 점검 batch 완료 — tasked=.. skipped=.. total=..`). 별도 순회 불필요.

## SIEM 우선 (v3.52 splunk MCP)

웹 점검 대상 host 결정 시 **splunk MCP 의 access log 가 신뢰 단일 source**. 도메인 추측 / 사용자 paste 따르지 말고, splunk 에서 **실제 트래픽 있는 사이트만 점검 대상**으로.

### 사이트 enumeration SPL (v3.52 — 라이브 검증됨)

**index**: `hq_escort_stats` / **sourcetype**: `escort_web_log` / **field**: `domain` (= 사이트). 주의: `host` 는 splunk indexer name (`kgsecush04` 등) — 우리가 원하는 사이트 아님.

**일일 unique 사이트 목록** (점검 단위로 기본):
```spl
index=hq_escort_stats sourcetype=escort_web_log
earliest=-1d@d latest=@d cdep.samsungds.net
| dedup domain | table domain
```
- 2026-05-25 기준 cdep 하루 unique 181 사이트, 총 13,697 events.
- diff-data 등 한 사이트가 트래픽 80%+ 차지하는 케이스 흔함 — count 도 같이 보면 우선순위 결정에 유용.

**Top-N 우선 점검** (사용자 많은 = 노출 시 영향 큰 곳 먼저):
```spl
index=hq_escort_stats sourcetype=escort_web_log
earliest=-1d@d latest=@d cdep.samsungds.net
| stats count by domain | sort -count | head 20
```

**N일 누적 unique site** (스코프 결정용):
```spl
index=hq_escort_stats sourcetype=escort_web_log
earliest=-7d@d latest=@d cdep.samsungds.net
| stats dc(domain) as unique_sites_7d
```

### 워크플로우
1. splunk_search 로 `dedup domain | table domain` → 실제 활성 사이트 목록 확보
2. 그 목록 안의 site 만 `web_resource_probe` / `web_fetch` / standard endpoint sweep (아래 섹션)
3. **목록 외 hostname 절대 호출 X** — fake 변형, 명명 패턴 추측, "비슷한 이름 있을 거" 다 금지 (v3.47)
4. splunk 결과의 host 가 사용자 paste 와 다르거나 더 많으면 — splunk 가 정답. paste 는 sample 일 수 있음

### splunk 죽어있을 때
`mcp_connect_failed` 로그 / `splunk_search` 가 error 반환 시 → **즉시 사용자에게 알림 + 점검 중단**. splunk 없이 추측으로 host 만들지 마라.

### scope hallucination 정정 (v3.47 → v3.52)
session 11 에서 agent 가 "오타 변형 fake hostname" 으로 의심받았던 `jongyoun--prontend-prod`, `plam--plam-prod`, `cdep-edsmanager--edseqp-manager-prod` 등은 **splunk 검증 결과 모두 실제 사내 서비스**. 사내 명명 규칙은 외부 직관과 다름. agent 의 자가 검열은 splunk 결과 기준으로만 — 외형으로 "이상해 보임" 판단 X.

## Standard endpoint sweep (v3.51-H1)

한 host 의 위험 판단 전에 다음을 `web_resource_probe` 로 같이 시도. 단일 endpoint (특히 `/docs`) 404/403 만으로 "안전" 결론 X — FastAPI 는 `/docs` 비활성화돼도 `/openapi.json` 노출되는 경우 매우 흔함.

| 카테고리 | endpoint |
|----|----|
| API spec | `/openapi.json`, `/docs`, `/redoc`, `/api/docs`, `/swagger`, `/swagger.json`, `/swagger-ui` |
| Discovery / 메타 | `/.well-known/security.txt`, `/.well-known/openid-configuration`, `/robots.txt`, `/sitemap.xml` |
| 민감 leak | `/.env`, `/.git/config`, `/server-status`, `/actuator/health`, `/actuator/env`, `/metrics`, `/debug` |
| admin/auth | `/admin`, `/login`, `/console` |

위험도는 노출된 endpoint **개수 + 종류** 기반. `/openapi.json` 한 건이라도 안에 `/db/insertData` / `/teams/sendKnoxMessage` 같은 mutation/messaging endpoint 있으면 **High** (Medium 아님).

**민감 leak 후보(`/.env`, `/.git/config`, `/.git/HEAD`, `/actuator/env`, `/server-status` 등)는
실제 GET 해서 기대 content 가 있을 때만 finding 으로 올려라.** probe 의 status/length 만 보고
올리지 마라 — 사내 사이트는 이런 경로가 **로그인/루트로 redirect 되거나 빈 200 / HTML 을
주는** 경우가 대부분이다. 실제 fetch 결과가 아래면 **finding 아님 (드롭)**:
- 3xx redirect (로그인·루트로) / 본문 없음 / HTML·SPA 셸 / 루트와 동일 body
- 기대 마커 없음: `.git/HEAD` 는 `ref:`, `.git/config` 는 `[core]`/`repositoryformatversion`,
  `.env` 는 `KEY=value`, `actuator/env` 는 `propertySources` 가 본문에 실제로 있어야 confirmed.

**우회 금지**: content 검증을 통과 못 한 민감 leak 경로를 `attack_surface` 로 바꿔
끼워넣지 마라. "경로가 존재한다"는 것만으로 finding 만들지 말 것 — redirect/빈응답이면
그 사이트엔 그 leak 이 **없는** 것이다.

## Deep-dive — 노출 확인에서 멈추지 말고 "실제 화면에 무슨 정보가 보이는지" 확인 (v3.53-19)

**browser 탐색은 조건부가 아니라 무조건이다 (정책 A).** endpoint sweep 결과가
"아무것도 없음"이어도, HTTP probe 가 전부 404/SPA fallback 으로 떨어져도, **예외 없이
모든 대상을 브라우저로 직접 열어본다.** "이 사이트는 별 거 없어 보이니 browser 생략"
같은 triage 는 금지 — 그게 바로 adc 사례(인증 없는 한도견본 화면을 probe 가 spa_fallback
으로 탈락시켜 놓친 실제 사고)의 원인이었다.

이유: 운영팀이 알고 싶은 건 *"인증 없이 이 사이트에 접속하면 실제로 어떤 정보가 보이고
무엇을 탈취 가능한가"* 다. cdep 대상은 대부분 Vue 등 SPA — 데이터를 클라이언트에서
렌더하므로 **HTTP probe 에는 빈 셸(SPA fallback)처럼 보여도, 실제 브라우저로 열면
공정정보·한도견본·도면·개인정보 화면이 인증 없이 그대로 뜨는 경우가 흔하다.** probe 의
spa_fallback 판정은 "browser 로 보라"는 신호지 "안전하다"는 결론이 아니다.

비용보다 점검 품질이 우선이다 — 사이트가 많아도 전수 browser 탐색을 줄이지 마라.

1. **browser 로 루트 + 주요 화면을 실제 렌더.** `browser_query` / `browser_action`
   으로 루트 접속 → 로그인 벽 없이 콘텐츠가 뜨는지 확인. 네비게이션/메뉴/링크를 타고
   들어가 목록·상세·다운로드·검색 화면을 본다. SPA 라우트(`/#/...`, `/list`,
   `/samples`, `/process`, `/board`, `/download`)도 직접 열어본다.
2. **렌더된 화면 + XHR/fetch 응답에서 실제 데이터 식별.** 브라우저가 호출하는
   network 이벤트(API 응답)와 화면 텍스트 양쪽을 본다. 인증 없이 200 + 실제 업무
   데이터가 오면 그게 노출이다.
3. **데이터 종류 판정 + 구체 증거 캡처** (`scan_text` 로 분류). 200 + 실제 데이터면:
   - 종류: 개인정보 / 공정정보(공정명·recipe·wafer·lot·장비·수율) / 경영정보
     (매출·단가·계약·고객) / 한도견본·도면 등 자산 / 자격증명.
   - **구체 사례를 마스킹해서 캡처**: 화면/응답의 **필드·컬럼명**(`employee_id`,
     `wafer_lot`, `unit_price`), **파일·문서·메뉴명**(`한도견본_2026Q1.xlsx`,
     `공정조건서_v3.pdf`, "한도견본 조회"), **레코드 샘플**(값 마스킹: `홍**`,
     `LOT-****-0291`, `₩**,***,***`), **건수/화면명**(`목록 1,240건`, "수율 대시보드").
4. **API spec 이 같이 노출됐으면** 보조 신호로 활용 — read-only GET endpoint 를
   골라 실제 응답 확증. mutation/messaging(POST/PUT/DELETE/send*) 은 호출 X
   (스키마에 존재한다는 사실만 증거).
5. **화면/endpoint 가 많으면** 데이터 종류별 대표 1~2개씩만 실제로 확증하고, 나머지는
   "동일 패턴 N개 더 존재"로 보고 (전수 탐색 불필요).

제약 (보안):
- **read-only.** 클릭은 조회/탐색까지. 저장·삭제·전송·제출 버튼, 쓰기 API 호출 금지.
- raw 민감값 그대로 적재 X — `masked` 또는 bounded `preview` 로만.
- **이미 인증 없이 열린 것**만 확인 (= 진짜 노출). 로그인 벽이 있으면 우회 X,
  "인증 필요"로 기록. 자격증명/토큰으로 더 들어가는 건 별도 승인 사안.

## 노이즈 — finding 으로 올리지 마라

- **`robots.txt` / `sitemap.xml` 존재 자체는 finding 아님.** 거의 모든 사이트에 있는
  표준 파일. **단, Disallow 에 민감 경로(`/admin`, `/backup`, 내부 API 등)가 실제로
  적혀있어 그게 미공개 자산을 가리킬 때만** informational 로. 기본 크롤링 정책만 있으면
  보고하지 마라 (그냥 tasked 처리).
- 깨끗한 사이트는 finding 0건으로 tasked — 억지 finding 만들지 마라.

## Semantic Validation

For each interesting URL record:

- `confirmed`: the body matches the expected resource semantics.
- `inconclusive`: the response is reachable but meaning is not proven.
- `rejected`: the response is fallback, block page, unrelated HTML, or otherwise
  not the claimed resource.

Examples:

- `/robots.txt` is confirmed only if the body contains robots directives such as
  `User-agent`, `Disallow`, `Allow`, or `Sitemap`.
- `/sitemap.xml` is confirmed only if it parses as sitemap XML.
- `/.env` is confirmed only if the body contains key/value environment-style
  content. HTML means rejected.
- `/.git/config` is confirmed only if the body contains git config markers such
  as `[core]` or `repositoryformatversion`.
- `/admin` or `/login` returning HTTP `200` is not a vulnerability. Compare with
  root body and validate page-specific markers and authentication state.
- If a URL returns the same hash/body as `/`, classify it as SPA/CDN fallback.

## What To Task

### Credentials And PII

- API keys, access tokens, JWTs, OAuth client secrets, session identifiers.
- Test accounts, admin usernames, account lists, exposed auth configuration.
- Email addresses, names, phone numbers, employee identifiers, department or
  role mappings.
- Client-side config, source maps, environment files, debug bundles, stack traces.

Mask values in all reports. Include only enough context to support validation.

### Domains And Attack Surface

- `href`, `src`, `form action`, XHR/fetch, GraphQL, WebSocket, and API base URLs.
- JS bundle constants such as `baseURL`, `apiHost`, `tenant`, `issuer`,
  `callbackUrl`, `redirectUri`.
- CSP, CORS, HSTS, cookies, redirects, canonical/OpenGraph metadata, sitemap,
  robots, and TLS/certificate-derived hostnames.
- CDN, object storage, package registry, build server, SSO, monitoring, or
  analytics endpoints.
- Dev/stage/test/admin paths and internal hostnames.

External references are attack-surface observations, not authorization to test.

### Internal Business-Critical Information

- Internal hostnames, private IPs, VPN/proxy names, repository URLs, build paths.
- Cloud tenant, project, bucket, registry, deployment environment, commit hash,
  source map, debug flag, runbook, incident, DR/BCP, or operations procedure.
- Project code names, product code names, customer/vendor codes, access approval
  flows, policy exceptions, security controls, and internal system architecture.

### Semiconductor Process Information

Treat semiconductor manufacturing details as high-sensitivity business data:

- Process names, process stages, recipes, parameters, wafer or lot identifiers.
- Equipment names, equipment IDs, FAB, line, cleanroom, process-area details.
- Yield, defect, binning, metrology, inspection, mask, reticle, lithography,
  etch, deposition, CMP, diffusion, or implant data.
- MES, EAP, FDC, SPC, APC, RMS, YMS, or other manufacturing-system endpoints.

Do not quote raw process data. Use masked snippets and semantic category labels.

### Business Confidential Information

- Revenue, cost, margin, pricing, quote, contract, customer, vendor, supplier,
  or supply-chain data.
- Production plan, CAPA, inventory, shipment, due date, roadmap, forecast.
- Organization, HR, evaluation, compensation, executive, strategy, investment,
  M&A, partnership, internal report, or meeting material.

Keyword hits alone are inconclusive. Confirm with surrounding context before
raising severity.

## Reporting Contract

Final reports must separate:

- Confirmed findings.
- Inconclusive observations requiring more evidence.
- Rejected observations, especially SPA fallback and block pages.
- Tool/environment failures.
- Work not performed.

Never say “exposed”, “vulnerable”, “WAF bypassed”, or “information extracted”
unless semantic validation supports it. If only status/length changed, report it
as an inconclusive response difference.

For `submit_finding`, use these categories exactly:

- `credential`: keys, tokens, JWTs, secrets, account credentials.
- `pii`: personal or employee-identifying data.
- `internal_system`: private IPs, internal hostnames, internal URLs, system names.
- `attack_surface`: scoped domains, URLs, APIs, forms, scripts, or exposed hosts.
- `semiconductor_process`: recipe, wafer, lot, equipment, FAB, yield, defect, or
  manufacturing-system information.
- `business_confidential`: pricing, forecast, customer/vendor, production plan,
  strategy, investment, HR, or management-sensitive information.
- `web_vuln`: confirmed web vulnerability or exposed resource.
- `misconfig`: configuration weakness without direct data exposure.

`credential`, `pii`, `internal_system`, `semiconductor_process`, and
`business_confidential` need masked values or bounded previews. `web_vuln`
claims need semantic resource evidence, not only status code or content length.

### finding 작성 — 위험 내용 + 권장 조치 (v3.53)

운영팀이 finding 화면(Domain Findings)에서 카드로 보고 바로 조치한다. 두 필드를
**한국어로, 구체적으로** 채워라:

- **summary** = "어떤 부분이 왜 위험한가". 무엇이 노출됐고 (asset/endpoint),
  공격자가 이를 어떻게 악용할 수 있는지 1~3문장. 예: "`/.git/config` 가 외부
  접근 가능해 저장소 구조·원격 URL·자격증명 힌트가 노출됨. 공격자가 소스 트리를
  복원해 추가 취약점을 찾을 수 있음."
- **recommended_actions** = 실행 가능한 조치 목록 (각 항목 1줄, 우선순위 순).
  추상적 ("보안 강화") X, 구체적 ("웹서버에서 `.git/` 경로 403 차단",
  "노출된 토큰 즉시 폐기 후 재발급", "WAF 에 해당 경로 패턴 추가") O.
  최소 1개, 보통 2~4개.

**summary 는 deep-dive 에서 캡처한 구체 증거를 반드시 포함하라** — "API 문서가
공개됨" 같은 표면 서술은 불충분. 운영팀이 읽고 심각도를 바로 체감할 수 있게:
- 무엇이 인증 없이 보이는가 (화면/엔드포인트 + 데이터 종류: 개인정보/공정정보/경영정보/한도견본 등)
- **구체 사례** — 마스킹된 필드·컬럼명, 파일·문서·메뉴명, 레코드 샘플, 건수
- 탈취 가능 범위 + 악용 시나리오

  나쁜 예: "`/docs` 에 API 문서가 공개되어 있습니다."
  좋은 예: "인증 없이 `https://adc--vue-prod…/#/samples` 접속 시 한도견본 목록
  1,240건이 그대로 조회됨 — 문서명(`한도견본_2026Q1_*.xlsx`), 공정명(`P**-Etch`),
  장비ID(`EQP-****`), 담당자(`홍**`) 노출. `/api/limit-samples` GET 이 인증 없이
  전체 레코드를 JSON 으로 반환. 경쟁사가 공정 capability 와 양산 품질기준을 역추정
  가능."

### 자산당 위협이 여러 개면 전부 보고하라

한 사이트에서 서로 다른 종류의 노출이 확인되면 **각각 별도로 기록**한다. 예: adc 가
(a) API 문서 노출 + (b) 인증 없는 한도견본 조회 + (c) 개인정보 노출이면 3건이다.
- 원칙: **distinct 한 위협(데이터 종류/공격 경로가 다름) = 별도 hit**. 한 번의
  submit_finding 에 `hits` 배열로 여러 hit 을 넣어도 되고, 성격이 크게 다르면
  finding 자체를 나눠도 된다. 한 자산 = 한 건으로 뭉뚱그려 가장 심각한 것만 남기지 마라.
- 각 hit 은 `category` + `location`(실제 화면/엔드포인트 URL) + 마스킹 증거를 갖춘다.

**summary 는 "어떤 민감자산이 위험한가"를 분류해서 말하라 — 막연한 '비인가 접근 가능'
금지** (위험도가 안 와닿는다). 노출된 것을 분류로 매핑하고 무엇을 탈취/악용 가능한지 적어라:
- **개인정보**(이름·사번·연락처·이메일) / **계정·인증정보**(토큰·세션·계정목록·로그인)
- **공정정보**(recipe·wafer·lot·장비ID·수율·도면·한도견본) / **경영정보**(매출·단가·계약·고객)
- **시스템 장악**(DB 직접쿼리·관리기능·파일/코드 실행·메시지 발송)

API 스펙(openapi/swagger) 노출이면 spec 본문의 실제 엔드포인트로 **무엇을 할 수 있는지**를
분류로 환산: 예 `POST /user/save_message`→메시지 발송/개인정보, `/db/query`→DB 탈취·시스템
장악, `/export/excel`→대량 데이터 유출. "엔드포인트가 노출됨"에서 멈추지 말고 "그래서 인증
없이 **사용자 개인정보 조회·발송 + DB 직접 쿼리로 데이터 탈취·시스템 장악 가능**" 까지.

**`target` 은 항상 그 turn 에 점검 중이던 사이트로 채워라** (web_targets_pending 에서 꺼낸
domain). hit.location 이 다른 host 여도 (예: 그 사이트에서 외부 참조 발견) target 은 점검
대상 사이트다. 리포트가 "도메인(=target) / 발견 사항(=asset)" 으로 나뉘어 표시된다.

severity 는 노출 민감도 + 악용 용이성 기준. 단순 정보성은 `informational`.

## Authentication policy (v3.53-21 — 인가된 로그인 시도 허용)

로그인 벽(SSO/폼)을 만나면 **`browser_action(action='login')`** 으로 인증을 시도한다.
자격증명은 **도구가 .env 에서 직접 읽는다 — 너는 raw 비밀번호를 절대 도구 input 이나
chat 에 쓰지 마라** (DB/로그 유출 방지). 너는 `action='login'` 만 호출하면 된다.

- **SSO 페이지(ADFS / secsso / oauth2 authorize)** → `browser_action(action='login', login_mode='sso')`.
  `.env` 의 `SA_WEB_SSO_USER` / `SA_WEB_SSO_PASS` 로 **사이트당 1회만** 시도.
- **일반 로그인 폼** → `browser_action(action='login', login_mode='defaults')`.
  기본 자격(admin/admin 등) 여러 조합 시도.
- `login_mode='auto'`(기본) → SSO 페이지면 sso, 아니면 defaults 자동 선택.

**회로차단기 (lockout 방지 — 코드 강제)**:
- 연속 **5회** 로그인 실패하면 이 세션의 **모든 로그인 시도가 영구 중단**된다.
  중단 후엔 login 호출이 "회로차단기 작동" 메시지를 반환하니, 남은 사이트는 인증
  시도 없이 `skipped` 처리하고 진행하라.
- login 이 실패(ToolSuccess 지만 "로그인 실패"/"skipped 처리" 메시지)면 그 사이트는
  **재시도하지 말고** `web_target_set_status(..., 'skipped', reason='auth required')` 후 다음 사이트.

**워크플로우**: 사이트 navigate → snapshot 에서 로그인/SSO 화면 확인되면 →
`browser_action(action='login')` 1회 → 성공 시 deep-dive 계속, 실패 시 skipped 마킹 후 다음.
**같은 사이트 login 반복 금지** (1회 실패 = 그 사이트 skip).

### ⛔ SSO/로그인 보면 skip 전에 무조건 login 먼저 (절대 규칙)

navigate 결과가 SSO(`secsso`/`adfs`/`oauth2/authorize`) 또는 로그인 폼(`#passwordInput`,
"Login", "로그인" title)이면 → **`web_target_set_status('skipped', 'auth required')` 하기
전에 반드시 `browser_action(action='login')` 을 먼저 호출하라.** login 시도 없이 SSO 를
바로 skip 하는 것 = 위반 (인가된 계정으로 들어가서 점검하는 게 목적이다).
- 라이브 검증됨: 중앙 ADFS(stsds.secsso.net)는 `browser_action(login, mode='sso')` 로
  실제 로그인되어 앱 내부(예: "SOLID S1L 통합 플랫폼")로 들어가진다. 그러니 SSO 는
  "접근 불가"가 아니라 "로그인하면 들어가지는" 대상이다.
- login 성공 → 로그인된 상태로 deep-dive (이제 진짜 내부 데이터가 보인다).
- login 실패(폼 못 찾음/에러) → 그때만 skipped.
- 회로차단기(연속 5실패) 작동 후엔 login 이 막히니 남은 SSO 는 skip.

### Knox 로컬트레이 SSO (폼 없음) — 사전 주입 세션 (v3.67)

일부 사내 사이트(예: `*.cdep.samsungds.net`)는 **로그인 폼이 없고** Knox 로컬 트레이
(`ws://localhost:29282`)에서 토큰을 받아 `/postssoinfo` 로 넘기는 구조다. 헤드리스 점검
브라우저엔 Knox 트레이가 없어 **`browser_action(login)` 으로는 절대 인증 못 한다** — 이건
도구 한계지 너의 실수가 아니다. 이런 사이트는:
- 운영자가 **사전 인증 세션**을 `SA_WEB_SESSION_STATE`(파일 경로)로 주입해 두면, browser
  세션이 그 세션으로 시작돼 **이미 로그인된 상태**가 된다 (이때 `browser_action(login)` 은
  "주입된 세션 활성 — 로그인 스킵" 을 반환한다. 정상이다. 그대로 deep-dive 하라).
- `browser_session(action='status')` 의 `injected_session` 으로 주입 여부 확인 가능
  (mode/count 만, 값은 안 보임).
- **주입 세션이 없는데** 폼 없는 Knox-트레이 SSO 라면 → login 시도해도 폼이 없어 실패하니,
  `web_target_set_status('skipped', 'auth required — Knox local-tray SSO, 사전 세션 미주입')`
  로 마킹하고 다음. (이때 finding 0 은 "안전"이 아니라 "인증 표면 미점검" 이라고 보고하라.)

운영자 셋업(참고, 봇이 할 일 아님): 운영자가 본인 PC(Knox 트레이 있음)에서 로그인 후
세션을 export → `SA_WEB_SESSION_STATE=/경로/state.json` (Playwright storage_state) 또는
쿠키 export JSON. **비밀번호는 봇/chat 어디에도 안 들어간다 — 세션만.**

## Strict scope — 사용자 list 만 (v3.47)

**도구 호출 전 항상 자기 검열**:

```python
user_lines = [l.strip() for l in user_input.split('\n') if l.strip()]
seeds_to_scan = [...]  # 도구 호출 직전 list
assert len(seeds_to_scan) == len(user_lines), \
    f"scope 위반: 사용자 {len(user_lines)}개 vs 호출 {len(seeds_to_scan)}개"
for s in seeds_to_scan:
    assert s in user_lines, f"scope 위반: '{s}' 는 사용자 list 에 없음"
```

규칙:
- 사용자가 5개 paste → 5개만 호출. 더 추가하고 싶으면 사용자에게 물어봄.
- 사내 명명 규칙 (`name1--name2-env.domain`) 모방해서 fake hostname 만들기 **절대 금지**. dns 못 찾으면 즉시 멈춤.
- final 보고 시 "사용자 입력 N개 중 M개 완료" — N 이 paste line 수와 일치해야.
- 사용자 list 에 없는 host 호출 시 = trust contract 위반. 결과 전체 불신.
