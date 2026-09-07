"""저장소 → 담당자 해석 계약. GitHub·knox 는 대체한다(라이브 호출 없음)."""
from __future__ import annotations

import pytest

from service.services import github_owner as go
from service.services import knox_directory as kd

_EMP = kd.Employee(knox_id="thyun.kim", full_name="Taehyun KIM",
                   department="Flash PE팀(메모리)", title="Staff Engineer")
_EMP2 = kd.Employee(knox_id="donghun.yi", full_name="Donghun Yi", department="메모리Photo기술팀")


@pytest.fixture(autouse=True)
def _clear():
    kd.clear_cache()
    yield
    kd.clear_cache()


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    """★ 이 모듈의 어떤 테스트도 **실제 브라우저를 띄우면 안 된다.**

    2026-08-30 사고: `resolve_repo` 에 브라우저 경로를 API 경로 **앞에** 넣었는데,
    기존 테스트들은 `_top_contributors`(API)만 목킹하고 있었다. 그래서 목킹을 우회해
    진짜 SSO 브라우저가 떴고 **스위트가 91%에서 무한정 멈췄다**(오늘 세 번 반복).

    ⚠️ 개별 테스트가 브라우저 경로를 검사하려면 이 fixture 를 다시 monkeypatch 하면
       된다. 기본은 **소리 내서 죽는 것**이다 — 조용히 네트워크를 타면 다음에 또 멈춘다.
    """
    def _boom(*a, **kw):
        raise AssertionError(
            "테스트가 실제 브라우저 경로를 탔다 — 목킹이 빠졌다 "
            "(top_contributors_via_browser*). 네트워크를 타면 스위트가 멈춘다.")

    monkeypatch.setattr(go, "top_contributors_via_browser_many", _boom)
    monkeypatch.setattr(go, "top_contributors_via_browser", _boom)


def _knox(monkeypatch, table: dict[str, kd.Employee]):
    calls: list[str] = []

    def resolve_login(login: str):
        calls.append(login)
        return table.get(login)

    monkeypatch.setattr(go.kd, "resolve_login", resolve_login)
    # ★ 예열(lookup_many)도 막아야 한다. resolve_login 만 대체하면 resolve_and_persist 가
    #   _prewarm_repo_logins → kd.lookup_many 로 **실제 게이트웨이**를 부른다. env 가 있는
    #   기계에서는 (느리게) 통과하고 없는 기계에서는 실패한다 — 환경에 따라 갈리는 테스트다.
    monkeypatch.setattr(go.kd, "lookup_many", lambda ids: {})
    return calls


def test_저장소_소유자가_개인이면_API_를_부르지_않는다(monkeypatch):
    _knox(monkeypatch, {"donghun-yi": _EMP2})

    def boom(repo):  # noqa: ARG001
        raise AssertionError("개인 계정이면 contributors 를 부르면 안 된다")

    monkeypatch.setattr(go, "top_contributors_via_browser", lambda repo: [])
    monkeypatch.setattr(go, "_top_contributors", boom)
    owner = go.resolve_repo("donghun-yi/some-tool")
    assert owner is not None
    assert owner.source == "repo_login" and owner.is_confirmed
    assert owner.knox_id == "donghun.yi"


def test_조직_저장소는_기여자_순으로_내려간다(monkeypatch):
    # 1위가 봇·공용 계정이면 사람이 나올 때까지 내려간다.
    calls = _knox(monkeypatch, {"thyun-kim": _EMP})
    # 브라우저는 아무것도 못 준 상황 → API 폴백으로 내려간다(프로덕션 순서 그대로).
    monkeypatch.setattr(go, "top_contributors_via_browser", lambda repo: [])
    monkeypatch.setattr(go, "_top_contributors",
                        lambda repo: ["admin01", "dscrb-srv", "thyun-kim", "cy-rhee"])
    owner = go.resolve_repo("Platform-Backend/PlatformAPI")
    assert owner is not None
    assert owner.source == "top_contributor"
    # ★ 추정이다 — 확정과 구분돼야 한다.
    assert owner.is_confirmed is False
    assert calls == ["Platform-Backend", "admin01", "dscrb-srv", "thyun-kim"]


def test_기여자_탐색은_상위_3명까지만_본다(monkeypatch):
    _knox(monkeypatch, {"zzz": _EMP})
    # 브라우저는 아무것도 못 준 상황 → 코드가 API 폴백으로 내려간다(프로덕션 순서 그대로).
    monkeypatch.setattr(go, "top_contributors_via_browser", lambda repo: [])
    monkeypatch.setattr(go, "_top_contributors", lambda repo: ["a", "b", "c", "zzz"])
    assert go.resolve_repo("Org/repo") is None


def test_allow_api_False_면_개인_계정만_판정한다(monkeypatch):
    _knox(monkeypatch, {})

    def boom(repo):  # noqa: ARG001
        raise AssertionError("allow_api=False 인데 API 를 불렀다")

    monkeypatch.setattr(go, "_top_contributors", boom)
    assert go.resolve_repo("Org/repo", allow_api=False) is None


def test_소유자_세그먼트가_없으면_None(monkeypatch):
    _knox(monkeypatch, {})
    assert go.resolve_repo("no-slash") is None
    assert go.resolve_repo("") is None


def test_배치는_한_건_실패로_죽지_않고_집계에_남긴다(monkeypatch):
    _knox(monkeypatch, {"donghun-yi": _EMP2})

    def flaky(repo):
        if repo.startswith("Boom/"):
            raise RuntimeError("GHES 500")
        return []

    monkeypatch.setattr(go, "top_contributors_via_browser", lambda repo: [])
    monkeypatch.setattr(go, "_top_contributors", flaky)
    monkeypatch.setattr(go, "persist", lambda owner: None)
    counts = go.resolve_and_persist(
        ["donghun-yi/a", "Boom/b", "Org/c", "donghun-yi/a"],
    )
    # 중복 저장소는 한 번만 센다.
    assert counts == {"repo_login": 1, "top_contributor": 0, "unresolved": 1, "error": 1}


def test_301_을_따라가지_않으면_기여자가_사라진다(monkeypatch):
    """이름이 바뀐 저장소는 301 로 온다 — 안 따라가면 조용히 '기여자 없음' 이 된다."""
    class _R:
        def __init__(self, status, body): self.status_code, self._b = status, body
        def json(self): return self._b

    seen: list[str] = []

    class _C:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, path, params=None):  # noqa: ARG002
            seen.append(path)
            if path == "/repos/Old/name/contributors":
                return _R(301, {"url": "https://gh/api/v3/repos/New/name"})
            return _R(200, [{"login": "thyun-kim", "contributions": 9}])

    # ★ sys.modules 만 갈아끼우면 안 된다. `from pkg import github` 는 이미 import 된
    #   패키지의 **속성**을 먼저 보므로, 스위트 전체를 돌 때(누가 먼저 import 한 뒤)
    #   진짜 모듈이 잡혀 _client() 가 env 를 찾다 죽는다. 단독 실행에서만 통과했다.
    #   패키지 속성 자체를 대체한다.
    import types

    # 먼저 진짜 모듈을 import 해 속성을 존재하게 만든 뒤 갈아끼운다 — 순서가 반대면
    # 스위트 안에서 누가 먼저 import 했는지에 따라 결과가 달라진다(그게 이 버그였다).
    from domains.services.github.plugin import agent_types as pkg
    from domains.services.github.plugin.agent_types import github as _real  # noqa: F401

    mod = types.ModuleType("github")
    mod._client = lambda: _C()
    monkeypatch.setattr(pkg, "github", mod)
    assert go._top_contributors("Old/name") == ["thyun-kim"]
    assert seen == ["/repos/Old/name/contributors", "/repos/New/name/contributors"]
