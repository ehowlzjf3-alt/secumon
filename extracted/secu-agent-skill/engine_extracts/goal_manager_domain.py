"""goal_manager 에서 적출한 도메인 batch goal 분류기/continuation 빌더.

goal 문자열 분류 헬퍼(is_*_goal 등)는 여전히 쓰인다. v3.88: 도메인 batch 드라이버는
`register_fanout_adapter`(domains/*/application/fanout.py) + 독립 collector 로 재부착됐고,
구 `RalphController._smb_subnet_phase`/`ralph_domain_phases.py` depth-first 드라이버는 제거됨.
"""

_WEB_BATCH_MARKERS = (
    "web-batch", "웹배치", "웹 사이트", "웹사이트", "웹 점검", "웹점검",
    "cdep", "web_target", "web tasking", "websites",
)


def is_web_batch_goal(goal_text: str) -> bool:
    """goal 이 '오늘 발견된 웹 사이트 전부 점검' 류 batch 인지 판정.

    True 면 checklist judge 를 우회하고 단일타깃 driver(continuation 이 pending 1개씩
    주입, 완료=pending 0)로 돈다. 마커 기반 휴리스틱 + pending 존재 여부와 함께 사용."""
    t = (goal_text or "").lower()
    return any(m.lower() in t for m in _WEB_BATCH_MARKERS)


WEB_SINGLE_TARGET_TEMPLATE = (
    "[web 점검 — 이번 turn 대상 1개, 끝까지 파라]\n"
    "지금 이 사이트 **하나만** 깊게 점검한다. 다른 사이트로 넘어가거나 목록을 직접 순회하지 "
    "마라 — 남은 대상은 다음 turn 에 시스템이 1개씩 준다. **이 사이트는 서두르지 말고 "
    "끝까지 물고 늘어져라.**\n\n"
    "대상: **{domain}**  (target_id={target_id}, event_count={event_count})\n"
    "남은 pending: {remaining}개\n\n"
    "**목표는 '실제 정보'를 찾는 것이다 — 키워드/메뉴/라벨이 아니라 진짜 데이터.**\n"
    "  계정·인증정보(토큰/세션/비번) · 개인정보(이름/사번/연락처 레코드) · 공정정보"
    "(실제 LOT/wafer/recipe/수율 '값') · 경영정보(매출/단가/계약 '값') · 시스템장악"
    "(DB쿼리/관리기능/코드실행). 메뉴에 'Lot' 글자가 있는 건 아무 의미 없다 — 그 Lot 의 "
    "**실제 레코드가 인증 없이 보이는지**가 핵심이다.\n\n"
    "절차:\n"
    "1) `web_site_sweep(target_id={target_id})` — 코드가 navigate·로그인·라우트 snapshot·"
    "scan·표준/ API probe 를 자동 수행하고 디지스트를 준다 (시작점).\n"
    "2) **deepdive — 진짜 데이터에 도달할 때까지 직접 파라 (필수, sweep 만으론 부족):**\n"
    "   - 디지스트의 `route_inventory`/`api_samples`/`probes` 에서 **데이터를 줄 만한 곳**"
    "(목록·표·상세·API·다운로드)을 골라 `browser_action(navigate/click)` / `web_fetch` 로 "
    "**실제로 열어 데이터가 나오는지 확인**. 메뉴/목록이면 항목을 **클릭해서 상세/데이터까지** 들어가라.\n"
    "   - 노출 openapi/swagger 있으면 그 **GET 엔드포인트를 실제 호출**해 레코드가 반환되는지 봐라.\n"
    "   - 결과를 분류: (a) 인증 없이 **실제 레코드가 보임** → 노출 (b) **403/401/로그인/빈값** "
    "→ 보호됨(노출 아님) (c) 못 가봄 → 더 파라.\n"
    "3) `submit_finding` — **실제로 본 데이터 레코드(마스킹)를 preview/masked 에 담아서만**. "
    "키워드·메뉴·용어 매칭만으론 절대 금지. 증거 없으면 finding 아니다.\n"
    "   - **단순 ID(이메일/이름/사번)만 노출은 finding 아님** — 비밀번호/토큰/세션 등 크리덴셜, "
    "또는 주민번호/카드/공정·경영 데이터가 함께 있어야 보고.\n"
    "   - **1개 찾았다고 멈추지 마라. 같은 분류 여러 건은 1종류로 친다** "
    "(예: API 엔드포인트 노출 3개 = 1종류). 이 사이트에서 **서로 다른 분류의 위협을 3종류 이상** "
    "찾아라. 분류: ①계정/인증정보 ②개인정보 ③공정정보 ④경영정보 ⑤시스템장악(취약점/RCE/관리기능) "
    "⑥API/엔드포인트 노출 ⑦설정오류/노출파일. **한 분류만 여러 개 모으지 말고** 다른 분류·데이터 경로를 "
    "계속 확인해 3종류 이상 채우거나 더 이상 없음을 확인할 때까지.\n"
    "4) **종료 조건(아래 중 하나 충족해야 set_status + end_turn):**\n"
    "   - ✅ 서로 다른 분류 3종류 이상 확보, 또는 가능한 데이터 경로·분류를 다 뒤졌는데 더 없음 → "
    "submit 한 것 보고 후 `tasked`(finding_count=N).\n"
    "   - ✅ 실제 민감 데이터를 확보해 submit_finding 함 → `tasked`(finding_count=N).\n"
    "   - ✅ 주요 데이터 경로(목록/상세/API/다운로드)를 다 시도했고 전부 403/401/로그인/빈값/"
    "없음으로 **'보호됨/데이터 없음'을 확인** → `tasked`(finding_count=0, reason='데이터 경로 "
    "전부 보호됨/없음 — 확인 내역 요약').\n"
    "   - ✅ 접속/인증 자체가 불가 → `skipped`.\n"
    "   - ❌ '메뉴에 키워드 있더라' 만 보고 끝내는 것 = 실패. 데이터까지 안 가봤으면 더 파라.\n"
    "5) `web_target_set_status(target_id={target_id}, ...)` 후 종료. 깊이 규칙은 web_tasking "
    "skill 참고(`skill(action='view', name='web_tasking')`).\n"
)


def build_web_continuation_prompt(next_row: dict, *, remaining: int) -> str:
    """단일타깃 continuation. next_row = web_targets_pending()[0]."""
    return WEB_SINGLE_TARGET_TEMPLATE.format(
        domain=next_row.get("domain", "?"),
        target_id=next_row.get("id", "?"),
        event_count=next_row.get("event_count", "?"),
        remaining=remaining,
    )


# ============================================================
# v3.60 — smb-batch 단일 host driver (web-batch 대응)
# ============================================================

_SMB_BATCH_MARKERS = (
    "smb-batch", "smb배치", "공유폴더 전부", "파일서버 전부", "발견된 host 전부",
    "발견된 호스트 전부", "모든 share", "smb host", "smb tasking batch", "모든 호스트",
)


def is_smb_batch_goal(goal_text: str) -> bool:
    """goal 이 '발견된 host 전부 점검' 류 SMB batch 인지 판정.

    True 면 checklist judge 우회하고 단일 host driver(claim 1개씩, 완료=pending_hosts 0)."""
    t = (goal_text or "").lower()
    return any(m.lower() in t for m in _SMB_BATCH_MARKERS)


SMB_SINGLE_HOST_TEMPLATE = (
    "[SMB 점검 — 이번 turn 대상 host 1개, 끝까지 파라]\n"
    "지금 이 host **하나만** 깊게 점검한다. 다른 host 로 넘어가거나 목록을 직접 순회하지 "
    "마라 — 남은 host 는 다음 turn 에 시스템이 1개씩 준다.\n\n"
    "대상 host: **{host}**  (subnet={subnet}, 점유 share {share_count}개)\n"
    "남은 pending host: {remaining}개\n\n"
    "절차:\n"
    "1) `smb_host_sweep(host='{host}')` — 코드가 3 인증모드 enumerate·readable share walk·"
    "text 파일 fetch·scan 및 이미지 후보 표시를 자동 수행하고 digest 를 준다 (시작점).\n"
    "2) **deepdive — 진짜 민감 데이터에 도달할 때까지 직접 파라 (필수):** digest 의 "
    "`scan_hits`/`image_candidates`/`coverage` 에서 의심 파일·share 를 골라 `smb_python`(walk/fetch/scan 자유), "
    "`smb_fetch_file`, `smb_inspect_image(analyze=True)` 로 **실제 내용 확인**. scan_hit/image 후보는 단서일 뿐 — 실제 크리덴셜/주민번호/"
    "공정데이터(LOT/recipe/수율 값)/경영데이터가 들어있는지 본문으로 확인.\n"
    "   - ⚠️ READ-ONLY. 지원 이미지(JPG/PNG/GIF/WebP)는 vision 으로 읽고, 그 외 binary 는 본문 받지 마라. STATUS_LOCKED_OUT/LOGON_FAILURE 보면 즉시 멈춰라.\n"
    "   - ⚠️ AUTH read 는 안전이 아니다. ACL/권한 증거에 `shaneee.baek` 가 명시된 경우만 개인 권한으로 보고, 없으면 부서/전사 그룹에 열린 접근으로 취급해 검토한다.\n"
    "3) `submit_finding(task_type='smb', ...)` — **실제로 본 데이터(마스킹)** 를 근거로만. "
    "파일명·share명 매칭만으론 금지. 같은 분류 여러 건은 1종류로 친다.\n"
    "4) **종료 조건:** 민감 데이터 확보→submit 후 `triaged_completed` / 접근가능 share 다 봤는데 "
    "위협 없음→`triaged_completed`(finding 0) / 접속·인증 자체 불가→`triaged_errored` 또는 `ignored`.\n"
    "5) `smb_host_set_status(host='{host}', status='triaged_completed'|'triaged_errored'|'ignored', "
    "hits_count=N)` 후 종료(end_turn). 깊이 규칙은 `skill(action='view', name='smb_task')` 참고.\n"
)


def build_smb_continuation_prompt(host_row: dict, *, remaining: int) -> str:
    """단일 host continuation. host_row = smb_host_claim_next() 결과."""
    return SMB_SINGLE_HOST_TEMPLATE.format(
        host=host_row.get("host", "?"),
        subnet=host_row.get("subnet", "?"),
        share_count=len(host_row.get("share_ids") or []),
        remaining=remaining,
    )


# ============================================================
# v3.76 — SMB depth-first: subnet 하나씩 discover→walk→scan→보고 끝내고 다음.
# (전체 sweep 먼저 X. host 전용 smb-batch 와 달리 discovery 까지 묶어 subnet 단위로.)
# ============================================================

_SMB_SUBNET_SWEEP_MARKERS = (
    "smb-subnet-sweep", "smb-full-sweep", "smb 전수", "smb전수", "subnet 하나씩",
    "서브넷 하나씩", "한 서브넷씩", "한 subnet씩", "subnet 깊이", "smb depth", "smb-deep",
    "전체 smb 대상", "전체 smb 점검", "db에 있는 전체 smb",
)

_SMB_SUBNET_SWEEP_COMPOSITE_MARKERS = (
    "pending subnet",
    "subnet discovery",
    "subnet/host/share",
    "subnet 큐",
    "서브넷 큐",
    "미스윕 subnet",
    "미스윕 서브넷",
    "등록된 오피스 smb",
    "readable host/share",
    "readable share sweep",
)


def is_smb_subnet_sweep_goal(goal_text: str) -> bool:
    """subnet depth-first SMB 점검 판정 — discover→walk→scan→보고를 subnet 하나씩.

    True 면 _smb_subnet_phase 로 라우팅(pending share 다 소진해야 다음 subnet discover).
    dispatch 에서 is_smb_batch_goal(host 전용)보다 **먼저** 체크한다."""
    t = (goal_text or "").lower()
    if any(m.lower() in t for m in _SMB_SUBNET_SWEEP_MARKERS):
        return True
    # 자연어 goal이 "[smb-full-sweep]" marker 없이 들어와도 subnet 큐/discovery가
    # 명시되면 generic judge가 아니라 depth-first DB driver가 truth source 여야 한다.
    return "smb" in t and any(m.lower() in t for m in _SMB_SUBNET_SWEEP_COMPOSITE_MARKERS)


SMB_SUBNET_DISCOVERY_TEMPLATE = (
    "[SMB depth-first — 이번 turn: subnet 1개 discovery]\n"
    "지금은 walk 할 pending share 가 없다 → **다음 미스윕 subnet 1개만** discover 한다.\n"
    "  `smb_subnet_sweep(subnet='{subnet}')` — 코드가 그 subnet 을 enumerate(TCP445) → "
    "readable share matrix → DB upsert → 진척 mark 까지 결정론적으로 한다 (walk/finding 안 함).\n"
    "- 끝나면 바로 end_turn. **직접 여러 subnet 돌리지 마라** — 다음 턴부터 시스템이 그 "
    "subnet 의 host 를 1개씩 walk/scan/보고 시키고, 그 subnet 을 다 본 뒤에야 다음 subnet 을 준다.\n"
    "- 남은 미스윕 subnet {remaining}개. (depth-first: 한 subnet 끝까지 → 다음.)\n"
)


def build_smb_subnet_discovery_continuation(subnet: str, *, remaining: int) -> str:
    """subnet 1개 discovery continuation (depth-first 드라이버 ②단계)."""
    return SMB_SUBNET_DISCOVERY_TEMPLATE.format(subnet=subnet, remaining=remaining)


# ============================================================
# v3.61 — devops-batch 단일타깃 driver (github/confluence, 브라우저 SSO)
# ============================================================

# v3.74: devops umbrella 해체 — github/confluence 네이티브 batch. (레거시 'devops'
# 키워드는 통합 게이트에서 여전히 트리거 → 양쪽 service 다 claim.)
_GITHUB_BATCH_MARKERS = ("github", "깃헙", "깃허브")
# v3.76.2: '위키'/'wiki' 제거 — secu-mcp wiki MCP 와 충돌(wiki 조회가 confluence 점검으로
# 오인됨). confluence 점검은 명시적 'confluence'/'컨플루언스' 로만 트리거.
_CONFLUENCE_BATCH_MARKERS = ("confluence", "컨플루언스")
_GENERIC_BATCH_MARKERS = ("devops-batch", "devops배치", "데브옵스", "devops")


def is_github_batch_goal(goal_text: str) -> bool:
    t = (goal_text or "").lower()
    return any(m in t for m in _GITHUB_BATCH_MARKERS)


def is_confluence_batch_goal(goal_text: str) -> bool:
    t = (goal_text or "").lower()
    return any(m in t for m in _CONFLUENCE_BATCH_MARKERS)


def is_devops_batch_goal(goal_text: str) -> bool:
    """github/confluence/(레거시 devops) batch 통합 게이트."""
    t = (goal_text or "").lower()
    return (
        is_github_batch_goal(t)
        or is_confluence_batch_goal(t)
        or any(m in t for m in _GENERIC_BATCH_MARKERS)
    )


def batch_service_for_goal(goal_text: str) -> str | None:
    """어느 service batch 인지 — 'github'/'confluence'. 둘 다/generic 이면 None(=any claim)."""
    t = (goal_text or "").lower()
    gh = is_github_batch_goal(t)
    cf = is_confluence_batch_goal(t)
    if gh and not cf:
        return "github"
    if cf and not gh:
        return "confluence"
    return None


DEVOPS_SINGLE_TARGET_TEMPLATE = (
    "[DevOps 점검 — 이번 turn 대상 1개, 끝까지 파라]\n"
    "지금 이 URL **하나만** 깊게 점검한다. 다른 대상으로 넘어가거나 목록을 직접 순회하지 "
    "마라 — 남은 대상은 다음 turn 에 시스템이 1개씩 준다.\n\n"
    "대상: **{url}**  (service={service}, target_id={target_id})\n"
    "남은 pending: {remaining}개\n\n"
    "**브라우저 SSO 직결로 접근** (사내 MWG 우회 — 프록시 경유 시 차단됨).\n"
    "절차:\n"
    "1) `web_site_sweep(domain='{url}')` — 코드가 navigate·SSO 로그인·route snapshot·scan·"
    "probe 자동 수행 디지스트 (시작점).\n"
    "2) **deepdive — DevOps 노출에 도달할 때까지 직접 파라:** `browser_action`/`web_fetch` 로 "
    "실제 확인. **DevOps finding 분류**: ①소스코드/설정 내 시크릿·토큰·키 ②.git 노출·CI 설정"
    "(Jenkinsfile/.github)·deploy key ③confluence 민감 페이지/첨부(runbook·계정·비번·내부설계) "
    "④API 토큰 스코프·하드코딩 크리덴셜 ⑤내부 시스템정보 노출.\n"
    "3) `submit_finding(task_type='{service}', ...)` — service=github 면 'github', "
    "confluence 면 'confluence' 로 태깅하라 (절대 'devops' 로 적지 마라). "
    "**실제로 본 내용(마스킹)** 근거로만. "
    "placeholder(`${{SECRET}}`/`changeme`/example)·아카이브/샘플 repo 는 제외 또는 severity 강등.\n"
    "4) **종료 조건:** 노출 확보→submit 후 `tasked` / 접근가능 영역 다 봤는데 위협 없음→"
    "`tasked`(finding 0) / 접속·SSO 실패→`skipped`.\n"
    "5) `web_target_set_status` 가 아니라 **`devops_target_set_status(target_id={target_id}, "
    "status='tasked'|'skipped', finding_count=N, reason=...)`** 호출 후 종료(end_turn). "
    "깊이 규칙은 `skill(action='view', name='{service}_tasking')` 참고.\n"
)


def build_service_batch_continuation(row: dict, *, remaining: int) -> str:
    """단일타깃 continuation. row = devops_target_claim_next() 결과.

    v3.74: task_type 은 row['service'](github/confluence)로 태깅된다 — 'devops' 아님.
    """
    return DEVOPS_SINGLE_TARGET_TEMPLATE.format(
        url=row.get("url", "?"),
        service=row.get("service", "?"),
        target_id=row.get("id", "?"),
        remaining=remaining,
    )


# 레거시 alias (ralph_controller / 기존 테스트 호환).
build_devops_continuation_prompt = build_service_batch_continuation


# v3.75 — GitHub API 전사 repo rolling 스윕 continuation (turn당 repo 배치).
GITHUB_REPO_BATCH_TEMPLATE = (
    "[GitHub API 스윕 — 이번 turn repo {n}개]\n"
    "아래 repo 를 한 번에 API 스캔하라(토큰 기반, 빠름):\n"
    "  `github_task_scan(repos=[{repos}])`\n"
    "- 코드가 hot-path 파일/커밋을 detector 로 훑어 finding 자동 적재(pivot·교차확인 자동).\n"
    "- **스캔 끝나면 반드시** `github_repo_set_status(target_ids=[{ids}], status='tasked', "
    "finding_count=발견수)` 호출(접근불가/404 repo 는 status='skipped') 후 end_turn. "
    "다음 배치는 시스템이 oldest-first 로 준다.\n"
    "- 직접 repo 목록 순회 X — 한 번도 안 본 repo 우선, 본 지 오래된 순. 남은 미스캔 {remaining}개. "
    "(SSO URL 배치와 교대 진행.)\n"
)


def build_github_repo_continuation(rows: list[dict], *, remaining: int) -> str:
    """API repo 배치 continuation. rows = github_repo_target_claim_next() 결과."""
    repos = ", ".join(str(r.get("repo", "?")) for r in rows)
    ids = ", ".join(str(r.get("id", "?")) for r in rows)
    return GITHUB_REPO_BATCH_TEMPLATE.format(
        repos=repos, ids=ids, n=len(rows), remaining=remaining,
    )


# v3.76 — Confluence API 전사 space rolling 스윕 continuation (turn당 space 배치).
CONFLUENCE_SPACE_BATCH_TEMPLATE = (
    "[Confluence API 스윕 — 이번 turn space {n}개]\n"
    "아래 space 를 한 번에 API 스캔하라(토큰 기반, 빠름):\n"
    "  `confluence_task_scan(space_keys=[{spaces}], scan_comments=True, scan_history=True)`\n"
    "- 코드가 page/comment/version/첨부를 detector 로 훑어 finding 자동 적재(pivot·교차확인 자동).\n"
    "- **스캔 끝나면 반드시** `confluence_space_set_status(target_ids=[{ids}], status='tasked', "
    "finding_count=발견수)` 호출(접근불가/404 space 는 status='skipped') 후 end_turn. "
    "다음 배치는 시스템이 oldest-first 로 준다.\n"
    "- 직접 space 목록 순회 X — 한 번도 안 본 space 우선, 본 지 오래된 순. 남은 미스캔 {remaining}개. "
    "(SSO URL 배치와 교대 진행.)\n"
)


def build_confluence_space_continuation(rows: list[dict], *, remaining: int) -> str:
    """API space 배치 continuation. rows = confluence_space_target_claim_next() 결과."""
    spaces = ", ".join(str(r.get("space_key", "?")) for r in rows)
    ids = ", ".join(str(r.get("id", "?")) for r in rows)
    return CONFLUENCE_SPACE_BATCH_TEMPLATE.format(
        spaces=spaces, ids=ids, n=len(rows), remaining=remaining,
    )


# ============================================================
# v3.79 ④: 명시적 사용자 cancel → goal pause
# ============================================================


