---
name: confluence
description: 사내 confluence.samsungds.net 위키 노출 점검 — 브라우저 SSO 직결. "confluence 점검" batch 시작 전 view.
domain: confluence
when_to_use: confluence(사내 위키/문서) 점검 시작 전. "confluence 점검" goal 돌리기 전에 한 번. (단순 'wiki 조회'는 secu-mcp wiki MCP — 이 스킬 아님.)
triggers: confluence; 컨플루언스; runbook; 런북
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# confluence_tasking — entry

사내 **confluence.samsungds.net** 의 위키 페이지·첨부 노출을 점검한다. github 과 동일 기조 —
**API 전사 space rolling 스윕**(토큰, 빠름) ↔ **브라우저 SSO URL**(프록시-discovered, 직결) 교대.

Runtime entrypoints:
- Web/API service: `python -m domains.services.confluence.webapp.app`
- Persistent runner: `python -m domains.services.confluence.runners.pipeline`
- One-shot agents/workers:
  - `python -m service.agents.confluence_discovery_agent` (space + SSO discovery)
  - `python -m service.agents.confluence_report_agent`
  - `python -m service.agents.confluence_recheck_agent`
  - `python -m service.agents.confluence_task_worker <evidence_dir>` (fanout worker)

## 워크플로우 — **브라우저 전용** (2026-08-26)

⚠️ **이 인스턴스의 confluence REST 는 전부 죽어 있다.** 엔드포인트별 실측:

    /rest/api/search   (CQL 스캔)       Basic 403   Bearer 429
    /rest/api/space    (space discovery) Basic 403   Bearer 429
    /rest/api/content  (page 재조회)      Basic 403   Bearer 429

    Basic  403  {"message":"Basic Authentication has been disabled on this instance."}
    Bearer 429  {"message":"속도 제한이 초과되었습니다."}

403 은 **권한 문제가 아니라 인증 방식** 문제였다 — 이 DC 는 Basic 을 껐는데
`agent_types/confluence.py::_client()` 가 `CONFLUENCE_USER` 가 설정돼 있다는 이유로
Basic 을 골랐다. 그리고 그걸 고쳐도 상시 rate-limit(429)이 남는다.

★ 그 오진이 실데이터에 쌓였다: space 25건이 전부
`"CQL search returned HTTP 403; access blocked, not assessed clean."` 로 닫혀 있었다.
**도구 선택 실패를 타깃의 속성으로 기록하면 안 된다** — 그 기록이 다시 판단 재료가 된다.

그래서 REST 도구(`confluence_task_scan`·`list_pages`·`fetch_page`·`list_attachments`·
`fetch_attachment`)는 **도구면에서 제거됐다.** 살아 있는 경로는 브라우저 하나뿐이고,
그건 이미 증명돼 있다 — keyword_search 큐가 API 도구 0개로 87건을 처리했다.

### 세 kind 모두 같은 도구를 쓴다

    space_batch     confluence_browser_search(keywords=[...], scope_space_keys=[<SPACE>])
    keyword_search  confluence_browser_search(keywords=<target.searches[].keywords>, ...)
    sso_url         web_site_sweep(domain=<url>) → 좌표 추출 → confluence_browser_search

`confluence_browser_search` 가 내부에서 SSO 로그인 1회 · 검색창(dosearchsite) ·
접근가능 page 만 방문 · `scan_text` 마스킹까지 처리한다. URL 을 직접 만들지 마라 —
키워드(+선택적 space scope)만 넘긴다.

`login_ok=false` 면 인증 실패다. 즉시 `error` 로 닫고 종료한다(재로그인 금지 — AD 잠금).

⚠️ 검색 0건은 `tasked`("봤는데 없음")다. `skipped` 는 **아예 못 본** 경우에만 쓴다.

### 리포트·재검증 — 재조회도 브라우저로 옮겼다

6. 업무 예외, 불명확 답장은 재검증 큐로 보내지 않고 대응 review/wait 상태로 둔다.
7. **재검증 unknown 냉각**: API refetch 불가 등 기술적 `unknown` 은 결과메일 없이
   `recheck_requested` 에 남기되 `retry_after` 를 기본 8시간 뒤로 예약해 즉시 재점유하지 않는다.
   재검증과 방법 안내메일 재시도는 런타임 `attempt_count` cap 으로 bounded 되며, cap 초과
   thread 는 다시 refetch/발송하지 않고 `escalated` 로 넘긴다.

  재조회 경로는 `confluence_browser_refetch.browser_fetch_recheck_text` 다
  (`reporter._fetch_recheck_text` 가 그것만 부른다 — REST import 는 파일에서 사라졌다).
  표면별로 덮는 범위가 다르다:

      page          ✅  `/pages/viewpage.action?pageId=<id>` 본문
      comment       ✅  댓글은 page 본문에 함께 렌더된다 — 같은 텍스트로 덮인다
      page_version  ✅  `&pageVersion=<N>`
      attachment    ❌  첨부 본문 추출은 브라우저로 못 한다(office/pdf 바이너리)

  ⚠️ **못 하는 것은 못 한다고 답한다.** 첨부는 `unknown` 사유를 돌려주고 위 7번
  경로로 `recheck_requested` + `retry_after` 에 남는다. "확인 못 함" 을 "조치됨" 으로
  접으면 유출이 열린 채 스레드만 닫힌다 — 조용히 틀리는 쪽이다.

  판정 기준(`_original_hit_signatures` 대조)은 안 건드렸다. 반환형이 예전과 같아서
  "무엇을 조치로 볼 것인가" 는 REST 시절과 동일하다 — 바뀐 것은 본문을 어디서 읽느냐뿐이다.

## 접근 — MWG 우회 직결 (중요)

사내 MWG 프록시는 samsungds.net 을 **차단**(실측 403). 에이전트는 프록시 우회 직결(v3.45)로 접근.
프록시로그는 **디스커버리**(누가 무슨 page 접근했나) 용도일 뿐, 실제 점검 접근은 직결.

## confluence finding 분류

① 민감 페이지·첨부 (runbook, 계정/비번 목록, 내부 시스템 설계, 망구성)
② breakglass/긴급 크리덴셜·VPN 절차 등 stale 접근정보
③ 내부 호스트/엔드포인트/API 토큰이 본문·첨부에 노출
④ 접근통제 미흡(인증 없이 열람되는 민감 space)

## 오탐 룰 (severity 강등/제외)

- placeholder/예시 값 → 제외/강등.
- 키워드 매칭만으론 finding 금지 — **브라우저로 실제 내용 본 것만** (submit_finding gate 강제).
- **이메일-only 제외**: 문서·연락처 페이지의 이메일/이름/사번 같은 단순 ID 만(secret·주민번호·카드·계좌 동반 없이) 있는 건 finding 아님. → 진짜 비밀번호·토큰·credential 또는 주민번호·카드·계좌가 함께 노출될 때만 보고.
- 전체 페이지 인용 금지 — 마스킹 스니펫 + 위치만.

## scope

외부 아님 — **사내 confluence.samsungds.net 만**.
