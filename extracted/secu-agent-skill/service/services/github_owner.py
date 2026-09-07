"""저장소 → 담당자 해석.

github finding 은 대상이 **저장소**인데 담당자가 커밋 작성자 메일로만 붙어 왔고, 그마저
파일 검색으로 나온 finding(이번 주차 81건 중 74건)엔 아예 없다. 커밋을 훑은 게 아니라
특정 시점 파일 내용을 읽은 것이라 작성자 개념이 없기 때문이다.

## 두 갈래 (실측 2026-08-23, finding 보유 저장소 637개)

1. **저장소 소유자가 개인 계정** — `donghun-yi/foo` 의 `donghun-yi` 가 곧 사람이다.
   GitHub 로그인은 `.` 을 못 써서 `-` 로 치환돼 있으니 되돌려 knox 로 확인한다.
   API 호출이 **0회**다. 243개(38%)가 여기서 나온다. `source="repo_login"`.

2. **조직 저장소** — GHES 에 담당자 개념이 없다. 실측:
   `collaborators` 404(토큰 권한 없음) · `CODEOWNERS` 부재 ·
   `orgs/{org}/members?role=admin` 은 **99명 전원**(SLSI-APSW·Pixel).
   유일하게 쓸모 있는 신호가 `contributors` 다 — 기여 수로 정렬돼 온다.
   `Platform-Backend/PlatformAPI` 는 1위가 `thyun-kim` 이고 README 가
   "managed by thyun.kim" 이라 교차검증됐다. 128개 중 73개가 여기서 나온다.
   `source="top_contributor"`.

⚠️ **둘은 확신도가 다르다.** 1은 소유자 그 자체이고 2는 추정이다. `source` 를 그대로
   저장해 화면·메일이 그 차이를 드러낼 수 있게 한다 — 합치면 추정이 확정으로 위장한다.

합계 582/637(91%). 남는 55개는 기여자 0(방치된 템플릿 저장소)·404·파트너 계정
(`@partner.sec.co.kr` — 사내 메일이 아니라 통보 대상이 아니다)이다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from service.services import knox_directory as kd

#: 1위만 보면 봇·공용 계정에 걸린다(`admin01`·`*-bot`·`*-srv`). 상위 몇 명까지 내려가며 사람을 찾는다.
_CONTRIBUTOR_DEPTH = 3
_CONTRIBUTOR_PAGE = 5


@dataclass(frozen=True, slots=True)
class RepoOwner:
    repo: str
    login: str
    source: str                      # repo_login | top_contributor
    employee: kd.Employee

    @property
    def knox_id(self) -> str:
        return self.employee.knox_id

    @property
    def is_confirmed(self) -> bool:
        """저장소 소유자 본인인가(추정이 아닌가)."""
        return self.source == "repo_login"


def repo_login(repo: str) -> str:
    """`org/name` → `org`. 소유자 세그먼트."""
    return str(repo or "").strip().split("/", 1)[0]


def _from_login(repo: str, login: str, source: str) -> RepoOwner | None:
    emp = kd.resolve_login(login)
    return RepoOwner(repo=repo, login=login, source=source, employee=emp) if emp else None


def _top_contributors(repo: str) -> list[str]:
    """기여 수 내림차순 로그인. 실패·없음이면 빈 리스트.

    ⚠️ 301 을 따라간다 — 저장소 이름이 바뀌면 GHES 가 새 경로를 준다(`SLSI-APSW/poweranalyzer`
    가 실제로 301 이었다). 안 따라가면 조용히 "기여자 없음" 이 된다.
    """
    from domains.services.github.plugin.agent_types import github as gh

    with gh._client() as c:
        r = c.get(f"/repos/{repo}/contributors", params={"per_page": _CONTRIBUTOR_PAGE})
        if r.status_code == 301:
            moved = str((r.json() or {}).get("url") or "")
            target = moved.split("/repos/", 1)[-1] if "/repos/" in moved else ""
            if not target:
                return []
            r = c.get(f"/repos/{target}/contributors", params={"per_page": _CONTRIBUTOR_PAGE})
        if r.status_code != 200:
            return []
        body = r.json()
    if not isinstance(body, list):
        return []
    return [str(x.get("login") or "").strip() for x in body if x.get("login")]


#: 개인 계정 네임스페이스 — `donghun-yi` 처럼 경로가 곧 계정이다(브라우저 불필요).
_PERSONAL_NS_RE = __import__("re").compile(r"^[a-z0-9]+[-][a-z0-9]+$")

#: 커밋 페이지에서 한 저장소당 볼 작성자 수. 상위 몇 명이면 담당자 판정에 충분하다.
_BROWSER_AUTHOR_LIMIT = 8

#: 커밋 화면의 **구조어** — 로그인 자리에 와도 사람이 아니다.
_COMMIT_PAGE_WORDS = frozenset({
    "authored", "committed", "verified", "unverified", "Loading", "History",
})


def _authors_from_commits_text(text: str) -> list[str]:
    """GHES 커밋 화면의 렌더 텍스트 → 기여 많은 순 로그인.

    실측한 줄 구조(2026-08-29, `github.samsungds.net/EES-TC/dp/commits`):

        [25]='mk8-kim'  [26]='authored'  [27]='3e97062'
        [92]='yoon-yoon' [93]='authored' [94]='888c4aa'

    로그인 바로 다음 줄이 `authored` 다. 그 앵커로만 잡는다 — 화면의 다른 이름
    (리뷰어·멘션)을 작성자로 오인하지 않기 위해서다.

    ⚠️ `graphs/contributors` 는 쓸 수 없다. GHES 가 비동기로 채워서 스냅샷 시점엔
       "Crunching the latest data…" 뿐이다(실측 563자). 그 화면을 믿으면 조용히 0건이 된다.
    """
    lines = [l.strip() for l in str(text or "").splitlines() if l.strip()]
    freq: dict[str, int] = {}
    order: list[str] = []
    for i, line in enumerate(lines[:-1]):
        if lines[i + 1] != "authored":
            continue
        login = line
        # 로그인은 한 토큰이다. 커밋 제목이 앵커 앞에 오는 일은 없지만 방어한다.
        if not login or " " in login or "/" in login or len(login) > 64:
            continue
        # ⚠️ 앵커가 연속으로 오면(`authored` / `authored`) 앞의 앵커를 로그인으로 집는다.
        #    구조어를 로그인으로 쓰지 않는다 — 적대적 테스트가 이걸 잡았다.
        if login in _COMMIT_PAGE_WORDS:
            continue
        if login not in freq:
            order.append(login)
        freq[login] = freq.get(login, 0) + 1
    return sorted(order, key=lambda l: (-freq[l], order.index(l)))[:_BROWSER_AUTHOR_LIMIT]


async def _authors_via_browser_async(repo: str) -> list[str]:
    """열려 있는 브라우저 세션에서 커밋 화면 하나를 읽는다. **루프를 만들지 않는다.**"""
    from domains.services.github.plugin.tools import github_browse_tool as gb

    host = gb._github_web_host()
    name = str(repo or "").strip()
    if not host or "/" not in name:
        return []
    url = f"https://{host}/{name}/commits"
    page, err = await gb._ensure_session_logged_in(host, return_to=url)
    if err is not None:
        return []
    body, _final = await gb._goto_text(page, url, 30000, require_host=host)
    return _authors_from_commits_text(body or "")


def top_contributors_via_browser_many(repos: list[str]) -> dict[str, list[str]]:
    """여러 저장소를 **한 이벤트 루프**에서 읽는다 — SSO 로그인 1회, 세션 재사용.

    ⚠️⚠️ 저장소마다 `asyncio.run` 을 부르면 안 된다. 브라우저 세션은 **처음 만든 루프**에
    묶여 있어서, 두 번째 호출부터 그 세션을 쓸 수 없고 매번 로그인을 다시 시도한다.
    2026-08-29 실측: 그렇게 돌렸더니 1건 처리 후 11분간 멈춰 있었다(부모 프로세스
    utime=0 — 브라우저를 기다리는 중). 배치는 반드시 이 함수를 쓴다.
    """
    import asyncio

    async def _run() -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for repo in repos:
            try:
                out[repo] = await _authors_via_browser_async(repo)
            except Exception:  # noqa: BLE001 — 하나가 실패해도 나머지는 읽는다
                out[repo] = []
        return out

    try:
        return asyncio.run(_run())
    except Exception:  # noqa: BLE001
        return {r: [] for r in repos}


def top_contributors_via_browser(repo: str) -> list[str]:
    """SSO 브라우저로 커밋 화면을 열어 작성자 로그인을 얻는다. 실패면 빈 리스트.

    ★ 2026-08-29 사용자 결정: GHES API 대신 브라우저로 확인한다. API 는 저장소마다
      호출이 필요하고 rate-limit 백오프가 걸린 경로다. 브라우저는 SSO 세션을 재사용한다.

    ⚠️ **조직 멤버 목록(`/orgs/{org}/people`)을 쓰지 않는다.** 그건 조직 전원이라
       수신처가 될 수 없다 — 담당자는 그 저장소를 실제로 만지는 한 사람이다.
    ⚠️ 한 건짜리다. 여러 건이면 `top_contributors_via_browser_many` 를 써라 —
       루프를 매번 새로 만들면 세션이 죽는다(위 함수 주석).
    """
    return top_contributors_via_browser_many([repo]).get(repo, [])


def resolve_repo(repo: str, *, allow_api: bool = True) -> RepoOwner | None:
    """한 저장소의 담당자. 개인 계정 → 조직 기여자 순.

    `allow_api=False` 면 GitHub API 를 안 부른다(개인 계정 판정만) — 대량 처리에서
    API 호출을 통제하고 싶을 때.
    """
    name = str(repo or "").strip()
    if "/" not in name:
        return None
    owner = _from_login(name, repo_login(name), "repo_login")
    if owner is not None:
        return owner
    if not allow_api:
        return None
    # ★ 브라우저 먼저. 저장소마다 API 를 부르면 rate-limit 백오프에 걸리는 경로이고,
    #   SSO 세션은 이미 열려 있다(2026-08-29 사용자 결정).
    for login in top_contributors_via_browser(name)[:_CONTRIBUTOR_DEPTH]:
        found = _from_login(name, login, "top_contributor")
        if found is not None:
            return found
    # 브라우저가 아무것도 못 줬을 때만 API. 둘 다 실패하면 담당자 미상(DSSOC 로 간다).
    for login in _top_contributors(name)[:_CONTRIBUTOR_DEPTH]:
        found = _from_login(name, login, "top_contributor")
        if found is not None:
            return found
    return None


def persist(owner: RepoOwner) -> None:
    """해석 결과를 DB 에 남긴다 — 게이트웨이는 knox 를 못 부르므로 여기 없으면 화면에 이름이 안 뜬다."""
    from service import state_domain as state

    emp = owner.employee
    state.employee_directory_upsert(
        emp.knox_id, full_name=emp.full_name, department=emp.department,
        en_department=emp.en_department, title=emp.title,
        employee_number=emp.employee_number,
    )
    state.github_repo_owner_upsert(
        owner.repo, knox_id=emp.knox_id, login=owner.login, source=owner.source,
    )


def resolve_and_persist(repos: list[str], *, allow_api: bool = True) -> dict[str, Any]:
    """여러 저장소를 해석해 적재하고 집계를 돌려준다.

    한 저장소가 실패해도 나머지는 진행한다 — 다만 **집계에 남긴다**(조용한 0건 금지).
    """
    counts = {"repo_login": 0, "top_contributor": 0, "unresolved": 0, "error": 0}
    names = [r for r in dict.fromkeys(str(x or "").strip() for x in repos) if r]
    _prewarm_repo_logins(names)
    for repo in names:
        try:
            owner = resolve_repo(repo, allow_api=allow_api)
        except Exception:  # noqa: BLE001 — 한 건 실패로 배치를 죽이지 않는다
            counts["error"] += 1
            continue
        if owner is None:
            counts["unresolved"] += 1
            continue
        persist(owner)
        counts[owner.source] += 1
    return counts


def _prewarm_repo_logins(repos: list[str]) -> None:
    """소유자 세그먼트 후보를 **한 세션에** 몰아서 조회해 캐시를 채운다.

    ★ 이걸 안 하면 저장소마다 MCP 세션을 새로 연다. 637개면 초기화 왕복만 수백 초라
    배치가 사실상 안 끝난다 — 조용히 느린 게 아니라 타임아웃으로 죽는다.
    조직 저장소의 기여자는 미리 알 수 없어 예열 대상이 아니다(저장소별 API 가 선행).
    """
    cands: list[str] = []
    for repo in repos:
        if "/" in repo:
            cands.extend(kd.knox_id_candidates(repo_login(repo)))
    if cands:
        kd.lookup_many(cands)


# ── 파이프라인 스텝 ─────────────────────────────────────────────────────────
#
# ⚠️ 2026-08-29 이전에 `resolve_and_persist` 는 **호출부가 0개**였다. 함수도 테스트도
#    있는데 아무도 안 불러서, finding 이 가리키는 저장소 193개 중 담당자가 있는 건
#    36개(19%)뿐이었고 콘솔 티켓 146건이 "담당자 미상" 이었다. 아래가 그 호출부다.

#: 한 tick 에서 브라우저로 열 조직 저장소 수. 브라우저가 한 건에 ~25초라 상한을 둔다 —
#: 없으면 한 tick 이 20분씩 걸려 파이프라인의 다른 스텝을 굶긴다.
_OWNER_PASS_ORG_LIMIT = 20


def _finding_repos() -> list[str]:
    """finding 이 가리키는 저장소 목록.

    ⚠️ asset 형식이 **섞여 있다** — `https://host/ORG/REPO/...`(200) 와
       `github:ORG/REPO/...`(7). 한쪽만 보는 추출식을 쓰면 조용히 3건만 잡힌다
       (2026-08-29 에 실제로 그랬다). 둘 다 벗겨낸다.
    """
    from service import state_domain as state

    with state.connect() as c:
        rows = c.execute(
            "SELECT DISTINCT split_part(p,'/',1)||'/'||split_part(p,'/',2) AS repo FROM ("
            # ⚠️ **정규식에 `?` 를 쓰지 마라.** 상태 계층이 `?` 를 바인딩 자리표시자로
            #    바꾼다 — `https?` 라고 썼더니 URL 형태(571건)가 통째로 안 벗겨져
            #    저장소가 **3개**만 나왔다(2026-08-31 실측, 물음표 빼니 518개).
            #    에러도 안 난다. 위 주석의 "조용히 3건" 이 바로 이 형태다.
            "  SELECT regexp_replace(regexp_replace(asset,'^https{0,1}://[^/]+/',''),'^github:','') AS p"
            "  FROM finding_lifecycle WHERE task_type LIKE 'github%'"
            ") q WHERE p <> '' AND split_part(p,'/',2) <> ''"
        ).fetchall()
    out = []
    for r in rows:
        v = str(r["repo"] or "").strip()
        if "/" in v and not v.endswith("/"):
            out.append(v)
    return sorted(set(out))


#: 사내 메일 도메인 — **정확히** 이것만. `@KORCO102160.samsungds.net` 같은 호스트명
#: 하위도메인은 기계 계정이라 제외된다(실측: `snp@KORCO102160...`·`root@khdeepfindw01...`).
_INTERNAL_MAIL_DOMAINS = frozenset({"samsung.com", "samsungds.net"})

#: 사람이 아닌 로컬파트. 점이 없는 것도 함께 거른다(사내 ID 는 `이름.성` 꼴이다).
_MACHINE_LOCALS = frozenset({
    "root", "admin", "jenkins", "git", "build", "ci", "svc", "service", "noreply",
})


def commit_author_ids(repo: str, *, limit: int = 10) -> list[str]:
    """커밋 작성자 메일 → Knox ID 후보(기여 많은 순서 = 커밋 최신순).

    ## 왜 이 경로가 필요한가 (2026-09-01 실측)

    저장소 이름이 개인 계정이 아니면(조직 저장소) 지금까지 **브라우저로 커밋 화면을
    열어** 상위 기여자를 읽었다. SSO 세션이 필요하고 배치당 20건이라 179개를 푸는 데
    아홉 번을 돌려야 했다.

    그런데 커밋 API 가 **작성자 메일을 그대로 준다** — `keunho.yuk@samsungds.net`.
    그 로컬파트를 Knox 로 확인하면 부서까지 나온다(표본 6개 중 5개 성공).
    브라우저가 필요 없다.

    ⚠️ 기계 계정이 섞인다: `root@khdeepfindw01.samsungds.net`·`snp@KORCO102160...`.
       도메인을 **정확히** 사내 두 개로 제한하고(호스트명 하위도메인 배제),
       로컬파트에 점이 없거나 알려진 서비스 계정이면 버린다.
    ⚠️ 파트너 메일(`@partner.sec.co.kr`)은 통보 대상이 아니다 — 도메인 제한이 걸러낸다.
    """
    from domains.services.github.plugin.agent_types import github as gh

    out: list[str] = []
    try:
        with gh._client() as c:
            r = c.get(f"/repos/{repo}/commits", params={"per_page": int(limit)})
            if r.status_code != 200:
                return []
            body = r.json()
    except Exception:  # noqa: BLE001 — 조회 실패는 담당자 미상이지 오류가 아니다
        return []
    if not isinstance(body, list):
        return []
    for item in body:
        author = ((item or {}).get("commit") or {}).get("author") or {}
        email = str(author.get("email") or "").strip().lower()
        if "@" not in email:
            continue
        local, _, domain = email.partition("@")
        if domain not in _INTERNAL_MAIL_DOMAINS:
            continue
        if "." not in local or local in _MACHINE_LOCALS:
            continue
        if local not in out:
            out.append(local)
    return out


def _from_commit_author(repo: str) -> RepoOwner | None:
    """커밋 작성자 메일로 담당자를 찾는다. 없으면 None."""
    for knox_id in commit_author_ids(repo)[:_CONTRIBUTOR_DEPTH]:
        try:
            emp = kd.lookup(knox_id)
        except Exception:  # noqa: BLE001
            emp = None
        if emp:
            return RepoOwner(repo=repo, login=knox_id, source="commit_author", employee=emp)
    return None

def run_owner_pass(*, org_limit: int | None = None) -> dict[str, Any]:
    """담당자 없는 finding 저장소를 해석해 적재한다. 카운터를 돌려준다.

    개인 저장소는 경로가 곧 계정이라 Knox 조회만으로 끝난다(브라우저 불필요).
    조직 저장소만 커밋 화면을 연다 — **한 배치, 한 이벤트 루프**여야 세션이 재사용된다.
    """
    from service import state_domain as state

    repos = _finding_repos()
    todo = [r for r in repos if not state.github_repo_owner_get(r)]
    personal = [r for r in todo if _PERSONAL_NS_RE.match(r.split("/", 1)[0])]
    org = [r for r in todo if r not in set(personal)]
    limit = _OWNER_PASS_ORG_LIMIT if org_limit is None else int(org_limit)
    org_batch = org[:max(0, limit)]

    counts = {
        "repos": len(repos), "already": len(repos) - len(todo), "todo": len(todo),
        "personal": len(personal), "org": len(org), "org_attempted": len(org_batch),
        "resolved_repo_login": 0, "resolved_top_contributor": 0,
        "resolved_commit_author": 0, "unresolved": 0,
        "org_deferred": len(org) - len(org_batch),
    }

    for repo in personal:
        try:
            owner = _from_login(repo, repo_login(repo), "repo_login")
        except Exception:  # noqa: BLE001 — 담당자 미상은 진행 가능한 상태다(DSSOC 로 간다)
            owner = None
        if owner is not None:
            counts["resolved_repo_login"] += 1
            persist(owner)
            continue
        # ★ 로그인이 Knox 에 없어도 **커밋 작성자 메일**이 답을 갖고 있는 경우가 있다
        #   (실측: `bwbw-kim` 은 Knox 에 없는데 프로필·커밋에 사내 메일이 있었다).
        owner = _from_commit_author(repo)
        if owner is None:
            counts["unresolved"] += 1
            continue
        counts["resolved_commit_author"] = counts.get("resolved_commit_author", 0) + 1
        persist(owner)

    # ★ 조직 저장소도 **브라우저 전에** 커밋 메일을 먼저 본다. API 한 번이면 되고
    #   SSO 세션이 필요 없다 — 배치 상한(20)에 묶이던 179건이 여기서 상당수 풀린다.
    org_left: list[str] = []
    for repo in org:
        owner = _from_commit_author(repo)
        if owner is None:
            org_left.append(repo)
            continue
        counts["resolved_commit_author"] = counts.get("resolved_commit_author", 0) + 1
        persist(owner)
    # 커밋 메일로 못 푼 것만 비싼 브라우저 경로로 넘긴다.
    org_batch = org_left[:max(0, limit)]
    counts["org_attempted"] = len(org_batch)
    counts["org_deferred"] = len(org_left) - len(org_batch)

    if org_batch:
        authors = top_contributors_via_browser_many(org_batch)
        for repo in org_batch:
            owner = None
            for login in authors.get(repo, [])[:_CONTRIBUTOR_DEPTH]:
                try:
                    owner = _from_login(repo, login, "top_contributor")
                except Exception:  # noqa: BLE001
                    owner = None
                if owner is not None:
                    break
            if owner is None:
                counts["unresolved"] += 1
                continue
            counts["resolved_top_contributor"] += 1
            persist(owner)
    return counts
