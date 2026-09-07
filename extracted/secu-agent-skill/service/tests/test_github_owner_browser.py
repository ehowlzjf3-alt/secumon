"""저장소 담당자를 **브라우저로** 확인하는 경로.

## 왜 (2026-08-29)

`github_owner.resolve_and_persist` 는 **호출부가 0개였다.** 그래서 finding 이 가리키는
저장소 184개 중 `github_repo_owner` 에 있는 건 35개(19%)뿐이고, 콘솔 티켓 146건이
담당자 미상이었다. 함수와 테스트는 있는데 아무도 안 부르는 형태다.

배선하면서 조회 경로를 GHES API 에서 **SSO 브라우저**로 옮겼다(사용자 결정) — API 는
저장소마다 호출이 필요하고 rate-limit 백오프가 걸린 경로인데, 브라우저 세션은 이미 열려 있다.

## 실측한 화면 구조 (github.samsungds.net, 2026-08-29)

    /{repo}/commits              3,273자  'mk8-kim' / 'authored' / '3e97062'   ✓
    /{repo}/graphs/contributors    563자  'Crunching the latest data…'         ✗ 비동기
    /{repo} (메인)               1,047자  'Contributors' 라벨만                 ✗
    /orgs/{org}/people           1,172자  조직 전원 — **수신처가 될 수 없다**   ✗
"""
from __future__ import annotations

from service.services.github_owner import _authors_from_commits_text as parse

REAL_COMMITS = "\n".join([
    "Skip to content", "Navigation Menu", "EES-TC", "/", "dp", "Commit History",
    "Commits on Aug 28, 2026", "Merge pull request #162 from EES-TC/development",
    "mk8-kim", "authored", "3e97062",
    "another commit", "mk8-kim", "authored", "584b83e",
    "Commits on Aug 7, 2026", "fix something", "yoon-yoon", "authored", "888c4aa",
    "GitHub Enterprise Server 3.19.4",
])


def test_authors_come_back_most_active_first():
    """실측 화면 구조 그대로. 기여 많은 순이어야 대표 담당자가 앞에 온다."""
    assert parse(REAL_COMMITS) == ["mk8-kim", "yoon-yoon"]


def test_async_contributors_screen_yields_nothing():
    """★ `graphs/contributors` 는 GHES 가 비동기로 채운다 — 스냅샷엔 로딩 문구뿐이다.

    이 화면을 믿으면 **조용히 0건**이 된다. 빈 결과가 나오는 것 자체가 계약이다.
    """
    loading = "\n".join([
        "Contributors", "Contributions per week to development, excluding merge commits",
        "Loading", "Crunching the latest data, just for you. Hang tight…",
    ])
    assert parse(loading) == []


def test_structure_words_are_not_people():
    """⚠️ 앵커가 연속으로 오면 앞의 앵커를 로그인으로 집는다 — 적대적 테스트가 잡은 실제 버그."""
    assert parse("\n".join(["authored", "authored", "authored"])) == []
    assert parse("\n".join(["a b c", "authored", "org/repo", "authored"])) == []


def test_anchor_is_required():
    """'authored' 앵커 없이 이름만 있는 줄을 작성자로 오인하지 않는다(리뷰어·멘션)."""
    assert parse("\n".join(["mk8-kim", "committed", "3e97062"])) == []
    assert parse("\n".join(["reviewed by mk8-kim", "yoon-yoon"])) == []


def test_org_member_list_is_not_the_owner_source():
    """★ 조직 멤버 목록은 **수신처가 될 수 없다** — 조직 전원이다.

    담당자는 그 저장소를 실제로 만지는 한 사람이고, 그건 커밋 작성자에서 온다.
    이 테스트는 코드가 아니라 **결정**을 고정한다(2026-08-29).
    """
    from service.services import github_owner as go

    src = go.top_contributors_via_browser.__doc__ or ""
    assert "people" in src and "수신처가 될 수 없다" in src


# ── 배선 — 이 파일의 존재 이유 ───────────────────────────────────────────────

def test_owner_pass_is_actually_wired_into_the_runner():
    """★ `resolve_and_persist` 는 2026-08-29 까지 **호출부가 0개**였다.

    함수도 테스트도 있는데 아무도 안 불러서 finding repo 193개 중 담당자가 있는 건
    36개(19%)뿐이었고, 콘솔 티켓 146건이 "담당자 미상" 이었다. 배선이 끊기면
    같은 일이 조용히 다시 일어난다 — 그래서 **스텝 목록 자체**를 고정한다.
    """
    import inspect

    from domains.services.github.application.contracts import COMPONENT_GITHUB_OWNER
    from service.agents import github_pipeline_runner as runner

    src = inspect.getsource(runner.run_once)
    assert "COMPONENT_GITHUB_OWNER" in src, "러너 스텝 목록에서 담당자 해석이 빠졌다"
    assert "run_owner_pass" in src
    assert COMPONENT_GITHUB_OWNER in runner.DEFAULT_INTERVALS


def test_owner_pass_is_not_driven_by_the_mail_runner():
    """담당자 해석은 **도메인 러너**의 일이고, 메일 큐는 공용 러너가 돈다(2026-08-31).

    예전엔 한 러너 안에서 `OWNER` 가 `REPORT` 보다 앞이라는 **순서**로 "스레드가 만들어질
    때 수신처가 실린다" 를 보장했다. 리포트가 공용 러너로 빠지면서 그 순서 보장은 사라졌다 —
    재보니 손해는 원래 주석이 말한 그대로 **한 주기**다: `sync_report_threads` 가 매 패스
    저장소를 전량 다시 upsert 하며 `owner_recipient` 를 병합하므로, 늦게 풀린 담당자는
    다음 패스에 실린다.

    그래서 지금 지켜야 하는 것은 순서가 아니라 **분리**다 — 도메인 러너가 메일 큐를
    다시 돌면 같은 스레드를 둘이 잡는다.
    """
    import inspect

    from service.agents import github_pipeline_runner as runner

    src = inspect.getsource(runner.run_once)
    assert "COMPONENT_GITHUB_OWNER" in src, "담당자 패스는 도메인 러너에 남아 있어야 한다"
    assert "COMPONENT_GITHUB_REPORT" not in src, "메일 큐는 공용 러너가 돈다"
    assert "COMPONENT_GITHUB_RECHECK" not in src


def test_finding_repo_extraction_handles_both_asset_shapes(tmp_db):
    """⚠️ asset 이 두 형태로 섞여 있다 — 한쪽만 보면 조용히 몇 건만 잡힌다.

    ★ 2026-08-31: 이 테스트는 **소스에 정규식 문자열이 있는지**만 봤고, 그래서 정규식이
      실제로 깨진 것을 못 잡았다. `'^https?://'` 의 `?` 를 상태 계층이 **바인딩
      자리표시자**로 바꿔 URL 형태 571건이 통째로 안 벗겨졌고, 저장소가 **3개**만 나왔다
      (물음표를 빼니 518개). 에러도 안 났다 — 조용히 줄었을 뿐이다.

      그 결과 담당자 해석이 저장소 3개만 보고 끝났고, github 스레드 262건이 담당자 없이
      큐에 멈춰 있었다(발송 대기로 못 넘어간다).

    ⇒ 문자열이 아니라 **행동**을 고정한다.
    """
    from service import state_domain as sd
    from service.services import github_owner as go

    with sd.connect() as c:
        for fid, asset in (
            (9001, "https://github.samsungds.net/OrgA/repo-one/blob/main/x.py"),
            (9002, "github:OrgB/repo-two/src/y.py"),
        ):
            c.execute(
                "INSERT INTO finding_lifecycle(id, fingerprint, task_type, asset, "
                "  asset_kind, severity, summary, status, first_seen, last_seen) "
                "VALUES(?, ?, 'github_scan', ?, 'repo', 'high', '테스트', 'open', 1.0, 1.0)",
                (fid, f"fp-{fid}", asset),
            )

    repos = set(go._finding_repos())

    assert "OrgA/repo-one" in repos, "URL 형태를 못 벗기면 대부분이 조용히 빠진다"
    assert "OrgB/repo-two" in repos, "github: 접두 형태도 잡아야 한다"


def test_multi_hyphen_login_gets_the_compacted_candidate():
    """★ Knox ID 는 앞부분에 하이픈이 없다(`bc123.kim`·`mk8.kim`).

    로그인에 하이픈이 둘 이상이면 **마지막만 `.` 이고 나머지는 원래 없던 문자**다.
    실측 2026-08-29(Knox 라이브): `js-53-lee` → `js53.lee` 가 맞는데 기존 후보
    (`js-53.lee`·`js.53-lee`) 어디에도 없어서 담당자 미상으로 떨어지고 있었다.
    """
    from service.services.knox_directory import knox_id_candidates

    assert "js53.lee" in knox_id_candidates("js-53-lee")
    assert "ysmile.song" in knox_id_candidates("y-smile-song")


def test_single_hyphen_login_is_unchanged():
    """하이픈 하나면 기존 규칙 그대로 — 새 후보를 만들지 않는다(오탐 조회 방지)."""
    from service.services.knox_directory import knox_id_candidates

    assert knox_id_candidates("woojin81-kim") == ["woojin81-kim", "woojin81.kim"]
    assert knox_id_candidates("rupin") == ["rupin"]


def test_commit_author_emails_become_knox_candidates():
    """★ 커밋 작성자 메일이 담당자를 가리킨다 — **브라우저 없이**.

    2026-09-01 실측: 조직 저장소는 GHES 에 담당자 개념이 없어 SSO 브라우저로 커밋 화면을
    열어 상위 기여자를 읽었다(배치 20건/회, 179건이면 아홉 번). 그런데 커밋 API 가
    작성자 메일을 그대로 준다 — 로컬파트를 Knox 로 확인하면 부서까지 나온다.
    한 번 돌려 **172건**이 풀렸다(브라우저 0회).

    ⚠️ 기계 계정이 섞인다. 도메인은 **정확히** 사내 두 개만(호스트명 하위도메인은
       `root@khdeepfindw01.samsungds.net` 같은 장비다), 로컬파트에 점이 없거나 알려진
       서비스 계정이면 버린다. 파트너 메일은 통보 대상이 아니다.
    """
    from service.services import github_owner as go

    def _fake_commits(emails):
        return [{"commit": {"author": {"email": e}}} for e in emails]

    class _Resp:
        status_code = 200

        def __init__(self, payload):
            self._p = payload

        def json(self):
            return self._p

    class _Client:
        def __init__(self, payload):
            self._p = payload

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, path, params=None):
            return _Resp(self._p)

    import contextlib

    payload = _fake_commits([
        "root@khdeepfindw01.samsungds.net",     # 장비 — 호스트명 하위도메인
        "snp@KORCO102160.samsungds.net",        # 장비
        "taegyu.yoo@partner.sec.co.kr",         # 파트너 — 통보 대상 아님
        "jenkins@samsung.com",                  # 서비스 계정(점 없음)
        "keunho.yuk@samsungds.net",             # ★ 사람
        "good.gil@samsung.com",                 # ★ 사람
    ])

    from domains.services.github.plugin.agent_types import github as gh

    original = gh._client
    gh._client = lambda *a, **k: _Client(payload)   # type: ignore[assignment]
    try:
        ids = go.commit_author_ids("Org/repo")
    finally:
        gh._client = original   # type: ignore[assignment]
    del contextlib

    assert ids == ["keunho.yuk", "good.gil"], f"기계·파트너 계정이 섞였다: {ids}"
