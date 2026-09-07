"""github 브라우저 열람 tool — 무인 워커용 non-destructive 래퍼 (confluence_browser_search 미러).

배경: github_task_scan(API+GITHUB_TOKEN)은 접근가능 repo 를 스캔해 후보를 찾지만, **확인·제출 단계**가
막힌다: (1) github finding 은 정책 A(submit_finding.py:93-97, github=browser-verified task_type)로 대상
host 를 **브라우저로 연 기록**(_web_browser_hosts)이 있어야 제출 가능. (2) web_fetch(raw/blob)는 SSO 미인증
이라 404. (3) raw browser_session/browser_action 은 is_destructive → 무인 워커(runtime.run_agent,
approval_resolver 없음)에서 승인거부. confluence_browser_search 와 **동일 패턴**으로 코어 private
프리미티브(`_start_session`/`_require_page`/`_perform_login`/`_mark_web_host_visited`)를 non-destructive
tool 안에서 호출해 **SSO 로그인 1회 + same-origin read-only navigate + snapshot** 만 수행한다(코어 무수정).

경계·안전:
- **same-origin only**: github.samsungds.net(=GITHUB_BASE_URL host)만. off-host/off-origin 리다이렉트 차단.
- **read-only**: 로그인 후 navigate+snapshot 만. 편집/댓글/저장/PR/이슈 없음.
- SSO 로그인은 세션 최초 확보 시 1회(_perform_login 회로차단기가 AD lockout 방지). 방문 host 를
  _mark_web_host_visited 로 기록 → submit_finding(github) 정책 A 충족.

v3.95 컨텍스트 비용:
- 실측(2026-08-15, 타깃 684): 이 도구 반환이 **도구 반환 총량의 88%**(20회·평균 5,789 chars).
  도구 내용 자체는 ≈33k 토큰인데 청구는 `input_tokens=1,108,687` 였다 — 응답 하나가 커서가
  아니라 **모든 응답이 컨텍스트에 남아 매 턴 재전송**되기 때문이다(비용 = 응답크기 × 남은턴수).
- 엔진 stash 오프로드는 50,000 chars 초과에만 발동한다(`agent/stash.py`). 이 도구는 최대
  13,370 이라 **한 번도 안 걸렸다** — 임계 아래에서 20번 쌓인 게 문제다.
⇒ `patterns` 로 **값이 있는 줄만** 돌려준다. 워커가 필요한 건 파일 전체가 아니라 값 줄이다
  (worker.md "every hit must carry the literal exposed value"). 전체 snapshot 은 **항상**
  evidence 파일로 남기고 경로를 주므로 절단해도 증거를 잃지 않는다.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import quote, urlparse

from pydantic import BaseModel, Field

import secu_agent.agent.tools.browser_tool as bt
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess

_LOGIN_STATE: dict[str, Any] = {}

# patterns 매칭 줄의 앞뒤로 함께 줄 수 — 자리표시자/샘플 여부 판단에 최소한의 맥락이 필요하다.
_SNIPPET_CONTEXT_LINES = 3
# patterns 없이 열었을 때 inline 으로 돌려줄 상한. 전체는 evidence 파일에 있다.
_NO_PATTERN_INLINE_CHARS = 4000


def _extract_snippets(body: str, patterns: list[str]) -> tuple[list[dict[str, Any]], int]:
    """patterns 에 걸린 줄 ± context 를 스니펫으로. 반환 (snippets, 매칭줄수).

    패턴은 **리터럴**로 다룬다(대소문자 무시). 모델이 넘기는 값에 정규식 메타문자가
    섞여도(`xoxb-`·`$VAR`·`a.b`) 깨지지 않게 re.escape 한다.
    """
    lines = body.splitlines()
    wanted: set[int] = set()
    matched = 0
    compiled = [
        (p, re.compile(re.escape(p), re.IGNORECASE))
        for p in patterns
        if str(p or "").strip()
    ]
    hit_lines: list[tuple[int, str]] = []
    for idx, line in enumerate(lines):
        for raw, rx in compiled:
            if rx.search(line):
                matched += 1
                hit_lines.append((idx, raw))
                for j in range(idx - _SNIPPET_CONTEXT_LINES, idx + _SNIPPET_CONTEXT_LINES + 1):
                    if 0 <= j < len(lines):
                        wanted.add(j)
                break
    if not wanted:
        return [], 0
    # 인접/중복 구간 병합 — 같은 줄을 여러 번 실어 보내지 않는다.
    ordered = sorted(wanted)
    blocks: list[list[int]] = [[ordered[0]]]
    for n in ordered[1:]:
        if n == blocks[-1][-1] + 1:
            blocks[-1].append(n)
        else:
            blocks.append([n])
    hit_map = dict(hit_lines)
    snippets = [
        {
            "start_line": b[0] + 1,          # 1-indexed — 사람이 읽는 줄번호
            "end_line": b[-1] + 1,
            "matched": sorted({hit_map[n] for n in b if n in hit_map}),
            "text": "\n".join(lines[n] for n in b),
        }
        for b in blocks
    ]
    return snippets, matched


def _write_snapshot(body: str, ctx: ToolContext) -> str | None:
    """전체 snapshot 을 evidence_dir 에 남기고 상대경로 반환(실패 시 None).

    stash.py 와 동형 — 절단된 부분은 read_file/grep 으로 되돌아 읽을 수 있어야 한다.
    """
    evidence_dir = getattr(ctx, "evidence_dir", None)
    if not evidence_dir:
        return None
    try:
        base = Path(evidence_dir)
        out = base / "github_browse_snapshots"
        out.mkdir(parents=True, exist_ok=True)
        name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.txt"
        path = out / name
        path.write_text(body, encoding="utf-8")
        try:
            return str(path.relative_to(base.resolve()))
        except ValueError:
            return str(path)
    except OSError:
        return None


def _same_host(url: str, host: str | None) -> bool:
    if not host:
        return True
    try:
        return (urlparse(url).hostname or "").lower() == host.lower()
    except ValueError:
        return False


def _github_web_host() -> str:
    """GITHUB_BASE_URL(=API root .../api/v3) 의 host = github.samsungds.net."""
    base = os.environ.get("GITHUB_BASE_URL", "").strip()
    if not base:
        return ""
    return (urlparse(base).hostname or "").lower()


async def _goto_text(page: Any, url: str, timeout_ms: int, *, require_host: str | None) -> tuple[str | None, str]:
    """url 로 이동 후 body 텍스트 반환. 실패/off-origin 리다이렉트 시 (None, 최종url).

    goto 는 302/로그인벽으로 다른 origin 에 안착할 수 있어 이동 후 최종 page.url 이 require_host 와
    same-origin 인지 재검증한다(off-origin 유출 차단 — confluence _goto_text 와 동형).
    """
    for wait in ("networkidle", "domcontentloaded"):
        try:
            await page.goto(url, wait_until=wait, timeout=timeout_ms)
            break
        except Exception:  # noqa: BLE001
            continue
    else:
        return None, url
    try:
        final_url = page.url
    except Exception:  # noqa: BLE001
        return None, url
    if require_host is not None and not _same_host(final_url, require_host):
        return None, final_url
    try:
        return await page.inner_text("body"), final_url
    except Exception:  # noqa: BLE001
        return "", final_url


async def _ensure_session_logged_in(host: str, return_to: str) -> tuple[Any, ToolError | None]:
    """(격리 지점) 코어 browser_tool 프리미티브로 세션 확보 + DS AD SSO 로그인 1회.

    코어 private API(_start_session/_require_page/_perform_login)는 여기서만 호출한다. 이미 열린 세션이
    있으면 재사용(로그인 skip — 최초 확보 시에만 로그인). confluence _ensure_session_logged_in 미러.

    github Enterprise 특이점: 기본 로그인은 **네이티브 username/password 폼(=SAML 미지원)**이라
    `_perform_login`(ADFS 전용)이 못 알아본다. `/login?force_external=true&return_to=...` 로 진입하면
    곧장 DS AD SSO(ADFS `stsds.secsso.net`, confluence 와 동일 IdP)로 유도되고, 거기서 `_perform_login(sso)`
    가 SA_WEB_SSO_USER/PASS 를 fill 한다(라이브 검증). 인증 성공 시 return_to(대상)로 자동 복귀.
    """
    page, perr = bt._require_page()
    if perr is not None:
        ok, reason = await bt._start_session(headless=True, viewport_width=1280, viewport_height=900)
        if not ok:
            return None, ToolError(kind="execution", message=f"브라우저 세션 시작 실패: {reason}")
        page, perr = bt._require_page()
        if perr is not None:
            return None, perr
    # ★ web_site_sweep 등 다른 도구가 미리 연 **미인증** 세션이 있을 수 있으므로 "세션 존재"만으론
    # 인증 여부를 판단 못 한다. 이 프로세스에서 로그인 1회 수행 여부를 _LOGIN_STATE['logged_in']로
    # 추적한다(기존 착각: 세션 있으면 로그인 skip → sweep 세션이 미인증이라 계속 로그인 화면).
    if _LOGIN_STATE.get("logged_in"):
        return page, None
    login_url = f"https://{host}/login?force_external=true&return_to={quote(return_to, safe='')}"
    for wait in ("networkidle", "domcontentloaded"):
        try:
            await page.goto(login_url, wait_until=wait, timeout=35000)
            break
        except Exception:  # noqa: BLE001
            continue
    login_ok, login_msg = False, ""
    try:
        login_ok, login_msg, _fatal = await bt._perform_login(page, "sso")
    except Exception as e:  # noqa: BLE001
        # 자격 제출 직후 ADFS→github 리다이렉트가 execution context 를 파괴하는 레이스(정상 성공 신호).
        login_msg = f"login nav-race(성공 추정): {repr(e)[:80]}"
    # ADFS 는 자격 검증 후 github ACS 로 **SAML 응답을 auto-POST(JS)**하는 왕복이 있다. 이게
    # 끝나기 전에 반환하면 페이지가 IdP(stsds.secsso.net)에 머물러 이후 대상 navigate 가
    # 미인증 로그인 화면을 받는다. github origin 으로 돌아올 때까지(=IdP 이탈) 폴링 대기.
    landed_github = False
    for _ in range(20):  # 최대 ~20s
        try:
            await page.wait_for_load_state("networkidle", timeout=3000)
        except Exception:  # noqa: BLE001
            pass
        try:
            if _same_host(page.url, host) and not bt._is_adfs(page.url):
                landed_github = True
                break
        except Exception:  # noqa: BLE001
            pass
        try:
            await page.wait_for_timeout(1000)
        except Exception:  # noqa: BLE001
            break
    _LOGIN_STATE["ok"] = bool(login_ok) or landed_github
    _LOGIN_STATE["logged_in"] = True  # 1회 시도 완료 → 재로그인 방지(AD lockout·지연 방지)
    _LOGIN_STATE["msg"] = str(login_msg)[:200]
    return page, None


class GithubBrowseInput(BaseModel):
    url: str = Field(
        ...,
        description=(
            "열 github.samsungds.net URL(예: .../owner/repo/blob/branch/path). "
            "same-origin(github.samsungds.net)이어야 한다. read-only navigate 만 — 편집/PR/이슈 없음."
        ),
    )
    patterns: list[str] = Field(
        default_factory=list,
        description=(
            "확인하려는 값의 단서(리터럴, 대소문자 무시). 주면 **매칭된 줄 ± 앞뒤 3줄만** "
            "돌려줘 컨텍스트를 아낀다. github_task_scan 이 준 후보의 kind/마스킹값 조각을 "
            "그대로 넣어라(예: ['PROD_TOKEN','AKIA','xoxb-']). 전체 본문은 언제나 "
            "snapshot_path 파일에 있으니 필요하면 read_file/grep 으로 읽는다."
        ),
    )
    max_chars: int = Field(
        default=12000, ge=500, le=50000,
        description=(
            "patterns 매칭 결과의 최대 글자수. patterns 를 안 주면 본문 앞 4,000자만 "
            "돌려주고 전체는 snapshot_path 로 넘긴다."
        ))
    nav_timeout_ms: int = Field(default=30000, ge=3000, le=90000)


class GithubBrowseTool(Tool[GithubBrowseInput]):
    name: ClassVar[str] = "github_browse"
    domain: ClassVar[str] = "github"
    description: ClassVar[str] = (
        "github.samsungds.net URL 을 브라우저로 SSO 로그인 후 read-only 로 열고 렌더된 파일/화면의 "
        "가시 본문 snapshot 을 반환한다. github_task_scan(API) 이 찾은 후보를 실제 파일로 재확인하는 "
        "용도. web_fetch(raw/blob) 는 SSO 미인증이라 404 — 인증 파일 열람은 이 도구를 쓴다. "
        "same-origin 만(off-host 차단). 편집/PR/이슈 없음(read-only). 이 도구로 대상 host 를 연 뒤에만 "
        "submit_finding(task_type='github') 이 허용된다(정책 A)."
    )
    input_model: ClassVar[type[BaseModel]] = GithubBrowseInput
    search_hint: ClassVar[str] = "github browser sso login open file blob confirm read-only snapshot"
    # 브라우저 navigation 을 구동하지만 page 변경/쓰기 없음(read-only). confluence_browser_search·
    # web_site_sweep 과 동일하게 is_destructive 아님 → 무인 워커에서 승인거부되지 않음.
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    prompt_section: ClassVar[str] = (
        "### github_browse(url, patterns=[], max_chars=12000)\n"
        "github.samsungds.net URL 을 SSO 로그인 후 read-only 로 열어 렌더된 파일/화면 내용 반환. "
        "raw browser_session/browser_action 대신 이 도구를 쓴다(무인 워커에서 승인거부 안 됨).\n"
        "**후보 값을 확인할 땐 `patterns` 를 반드시 넘겨라** — 매칭된 줄 ± 앞뒤 3줄만 와서 "
        "컨텍스트가 절약된다(예: patterns=['PROD_TOKEN','AKIA']). 안 넘기면 앞 4,000자만 온다. "
        "어느 쪽이든 전체 본문은 `snapshot_path` 파일에 있으니 read_file/grep 으로 더 읽을 수 있다."
    )

    async def execute(self, vi: GithubBrowseInput, ctx: ToolContext) -> ToolResult:
        host = _github_web_host()
        if not host:
            return ToolError(kind="validation", message="GITHUB_BASE_URL 미설정 — github origin 없음")
        url = (vi.url or "").strip()
        if not url:
            return ToolError(kind="validation", message="url 이 비어 있음")
        if "://" not in url:
            path = url if url.startswith("/") else "/" + url
            url = f"https://{host}{path}"
        req_host = (urlparse(url).hostname or "").lower()
        if req_host != host:
            return ToolError(
                kind="forbidden",
                message=(
                    f"off-scope host {req_host!r} — same-origin only (허용 host: {host!r}). "
                    "github.samsungds.net URL 만 열 수 있다."
                ),
            )

        page, err = await _ensure_session_logged_in(host, return_to=url)
        if err is not None:
            return err

        body, final_url = await _goto_text(page, url, vi.nav_timeout_ms, require_host=host)
        if body is None:
            return ToolError(
                kind="execution",
                message=(
                    f"navigate 실패 또는 off-origin 리다이렉트(로그인 미완 가능): {url} → {final_url}. "
                    f"login_ok={_LOGIN_STATE.get('ok')} login_msg={_LOGIN_STATE.get('msg')}"
                ),
            )
        bt._mark_web_host_visited(ctx, page)

        # 전체 본문은 **항상** 파일로 남긴다 — 아래에서 뭘 잘라 보내든 증거는 보존된다.
        snapshot_path = _write_snapshot(body, ctx)

        payload: dict[str, Any] = {
            "requested_url": url,
            "final_url": final_url,
            "login_ok": _LOGIN_STATE.get("ok"),
            "login_msg": _LOGIN_STATE.get("msg"),
            "snapshot_chars": len(body),
            "snapshot_path": snapshot_path,
        }

        if vi.patterns:
            snippets, matched = _extract_snippets(body, vi.patterns)
            if snippets:
                rendered = json.dumps(snippets, ensure_ascii=False)
                while len(rendered) > vi.max_chars and len(snippets) > 1:
                    snippets = snippets[:-1]          # 뒤에서부터 버린다(첫 매칭이 보통 핵심)
                    rendered = json.dumps(snippets, ensure_ascii=False)
                payload["mode"] = "snippets"
                payload["matched_lines"] = matched
                payload["snippets"] = snippets
                payload["note"] = (
                    "patterns 매칭 줄 ± 앞뒤 3줄만 반환했다(컨텍스트 절약). 전체 본문은 "
                    "snapshot_path 에 있다 — 더 필요하면 read_file/grep 으로 읽어라."
                )
                return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
            # 매칭 0 — 패턴이 이 페이지에 없다는 것 자체가 결과다. 앞부분만 보여준다.
            payload["mode"] = "no_match"
            payload["matched_lines"] = 0
            payload["snapshot_head"] = body[:_NO_PATTERN_INLINE_CHARS]
            payload["note"] = (
                f"patterns {list(vi.patterns)!r} 가 이 페이지에 없다. 앞 "
                f"{_NO_PATTERN_INLINE_CHARS} 자만 보여준다 — 전체는 snapshot_path."
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        # patterns 미지정 — 훑어보기 용도. 앞부분만 inline, 전체는 파일로.
        head_limit = min(vi.max_chars, _NO_PATTERN_INLINE_CHARS)
        payload["mode"] = "head"
        payload["snapshot_head"] = body[:head_limit]
        payload["note"] = (
            f"patterns 를 안 줘서 앞 {head_limit} 자만 반환했다. 특정 값을 확인하려면 "
            "patterns=['<단서>'] 로 다시 부르면 해당 줄만 온다. 전체는 snapshot_path."
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
