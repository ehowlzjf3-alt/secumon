---
name: confluence_task
description: Confluence E2E 점검 worker skill — space API batch 또는 SSO URL 1건을 스캔하고 Confluence report state를 갱신.
domain: confluence
when_to_use: confluence_space_target 또는 devops_target(service=confluence)을 fanout worker가 claim해 처리할 때.
triggers: confluence task; confluence e2e; confluence space scan; confluence sso scan
---

# confluence_task — Confluence E2E Worker

너는 Confluence E2E 파이프라인의 worker다. 입력 target은 셋 중 하나다.

- `space_batch`: `confluence_space_target`에서 claim된 space key 배치
- `keyword_search`: `confluence_search_target`에서 claim된 키워드 배치(브라우저 검색 — REST 차단 우회)
- `sso_url`: 프록시로그 기반 `devops_target(service='confluence')` URL 1건

승인된 내부 보안 점검 범위에서만 수행한다. destructive action, 권한 변경, 데이터 수정,
서비스 중단, scope 밖 접근은 금지한다. 민감 원문 전체를 출력하지 말고 마스킹된 증거와
위치만 기록한다.

## Space Batch (브라우저 전용)

⚠️ **REST 도구는 이 도메인에 없다.** 도구면에서 제거됐다(2026-08-26) — 실측:

    Basic (user+token)  403  "Basic Authentication has been disabled on this instance."
    Bearer PAT          429  "속도 제한이 초과되었습니다."

403 은 권한 문제가 아니라 **인증 방식** 문제였고, 고쳐도 상시 rate-limit 429 가 남는다.
`confluence_task_scan`·`confluence_list_pages`·`confluence_fetch_page`·
`confluence_list_attachments`·`confluence_fetch_attachment` 를 부르지 마라 — 없다.

★ 이 오진이 실제로 쌓였다: space 25건이 전부
`"CQL search returned HTTP 403; access blocked, not assessed clean."` 로 닫혀 있었다.
**"접근 불가" 가 아니라 "잘못된 문으로 두드렸다" 였다.**

1. `target.space_keys` 의 각 space 마다
   `confluence_browser_search(keywords=[...], scope_space_keys=[<space>])` 를 부른다.
   SSO 로그인은 첫 호출에서 1회, 세션은 이후 호출에 재사용된다.
   키워드는 시크릿·개인정보·경영/공정 문서를 겨냥한 것으로 고른다.
2. 반환 `login_ok` 가 false 면 인증 실패다 — 즉시
   `confluence_space_set_status(status='error', reason=<login_msg>)` 로 닫고 종료한다(재로그인 금지).
3. `candidates` 는 이미 마스킹된 hit 만 담는다. title/url 과 hit(category/kind/masked_preview)로 판단한다.
   크리덴셜/시크릿, 개인정보·인사정보 대량 노출, 경영진/사업 회의록,
   중요 공정정보(recipe/wafer/yield/설비), 무인증 노출 문서만 실제 finding 이다.
4. 확정된 실제 노출만 `submit_finding(task_type='confluence')` 으로 제출한다.
5. 끝나면 **정확히 한 번**
   `confluence_space_set_status(target_ids=<target.target_ids 전체>, status='tasked'|'skipped'|'error', finding_count=N, reason='...')`.
   정상 완료=tasked(제출 0건이어도 tasked), 로그인/권한 전부 불가=skipped, 검색 실패=error.
   ⚠️ 검색이 0건이라고 `skipped` 로 닫지 마라 — 그건 "봤는데 없음"(tasked)이다.

## Keyword Search

REST 는 이 인스턴스에서 두 겹으로 막혀 있다(Basic 403 = 인증 방식 차단, Bearer 429 =
rate-limit). 위 「Space Batch」와 같은 이유다 — `confluence_task_scan` 은 없다.
`keyword_search` target은 **`confluence_browser_search` 도구만** 쓴다(이 도구가 SSO 로그인 1회·검색창
dosearchsite·접근가능 page 방문·scan_text 마스킹을 내부 처리한다).

1. `target.searches`의 각 항목마다 `confluence_browser_search(keywords=..., scope_space_keys=...)`를 한 번씩 호출한다.
   SSO 로그인은 첫 호출에서 1회, 세션은 이후 호출에 재사용된다. `web_site_sweep`/`browser_session`/
   `browser_action`/`confluence_task_scan`은 이 kind에서 쓰지 않는다.
2. 반환 JSON의 `login_ok`가 false면 인증 실패다 — 즉시 `confluence_search_set_status(status='error', reason=<login_msg>)`로 닫고 종료한다(재로그인 금지).
3. `candidates`는 이미 마스킹된 hit만 담는다. 각 후보를 hit(category/kind/masked_preview)와 title/url로 판단한다.
   크리덴셜/시크릿, 개인정보·인사정보 대량 노출, 경영진/사업 회의록, 중요 공정정보(recipe/wafer/yield/설비),
   무인증 노출 문서만 실제 finding이다.
4. 확정된 실제 노출만 `submit_finding(task_type='confluence')`으로 제출한다. target은 해당 page url이다.
5. 끝나면 **정확히 한 번** `confluence_search_set_status(target_ids=<target.target_ids 전체>, status='tasked'|'skipped'|'error', finding_count=N, reason='...')`로 닫는다.
   정상 완료=tasked(제출 0건이어도 tasked), 로그인/권한 전부 불가=skipped, 검색 실패=error.

## SSO URL (브라우저 전용)

1. `web_site_sweep(domain='<url>')` 를 호출한다.
2. URL 또는 sweep digest 에서 space key(`/display/SPACE`, `/spaces/SPACE`, `spaceKey=SPACE`)나
   검색어(`/search?text=...`, `/dosearchsite.action?queryString=...`)가 보이면
   `confluence_browser_search(keywords=[<검색어 또는 page title 조각>], scope_space_keys=[<SPACE>])` 로 확인한다.
   ⚠️ REST 경로(`confluence_task_scan` 등)는 **없다**. 위 「Space Batch」의 이유와 같다.
3. 로그인벽, 권한없음, 빈 화면, 단순 연락처 페이지는 finding 이 아니다.
4. 실제 민감 페이지·첨부·credential·내부 endpoint 가 보일 때만 `browser_*` 로 재확인한다.
5. 실제 노출만 `submit_finding(task_type='confluence')` 으로 제출한다.
   target 은 조사한 URL, `hit.location` 은 발견 위치다.
6. 끝나면 반드시 `devops_target_set_status(target_id=..., status='tasked'|'skipped'|'error', finding_count=N, reason='...')`.

## False Positive Rules

- 이메일/이름/사번 같은 단순 ID만 있으면 제외한다.
- placeholder, sample, changeme, dummy token은 제외하거나 severity를 낮춘다.
- 키워드 매칭, 파일명, URL 힌트만으로 finding을 제출하지 않는다.
- 전체 페이지나 첨부 내용을 복사하지 않는다.
- Confluence asset은 `confluence:SPACE:page_id` 또는 `https://confluence.samsungds.net/...` 형태로 남겨 domain report가 space 기준으로 dedup할 수 있게 한다.
