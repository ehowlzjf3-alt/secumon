"""저장소 담당자 + 임직원 대장 조인 계약.

배경: github 담당자가 커밋 작성자 메일로만 붙었고, 파일 검색으로 나온 finding(다수)엔
그마저 없었다. 저장소 축 담당자(github_repo_owner)와 이름·부서·직급(employee_directory)을
조인해 붙인다. 게이트웨이는 knox 를 부르지 않으므로 **적재된 것만** 보인다.
"""
from __future__ import annotations

import pytest

from digisecu_gateway.repos import finding_repo as fr


class _Pool:
    """SQL 문자열로 어느 테이블을 묻는지 갈라 답하는 최소 풀."""

    def __init__(self, *, repo_owner=None, employee=None, deny: tuple[str, ...] = ()):
        self.repo_owner, self.employee, self.deny = repo_owner, employee, deny
        self.seen: list[str] = []

    def fetch_one(self, sql, params=None):
        self.seen.append(sql)
        for word in self.deny:
            if word in sql:
                raise RuntimeError("permission denied")   # 42501 대역
        if "github_repo_owner" in sql:
            return self.repo_owner
        if "employee_directory" in sql:
            return self.employee
        return None

    def fetch_all(self, sql, params=None):
        self.seen.append(sql)
        return []


@pytest.fixture(autouse=True)
def _reset():
    fr.reset_employee_probe()
    yield
    fr.reset_employee_probe()


_EMP = {"full_name": "Taehyun KIM", "department": "Flash PE팀(메모리)", "title": "Staff Engineer"}


def test_저장소_소유자가_커밋_작성자보다_우선한다():
    # 스레드에 커밋 작성자가 있어도 저장소 담당자를 쓴다 — 후자가 "책임지는 사람" 이다.
    pool = _Pool(repo_owner={"knox_id": "thyun.kim", "source": "repo_login"}, employee=_EMP)
    a = fr.resolve_owner(pool, task_type="github", asset="github:Org/repo/src/x.py", finding_id=1)
    assert a is not None
    assert a.email == "thyun.kim@samsung.com"
    assert a.sourceLabel == "저장소 소유자"
    assert a.confirmed is True
    assert (a.name, a.dept, a.title) == ("Taehyun KIM", "Flash PE팀(메모리)", "Staff Engineer")


def test_조직_저장소의_1위_기여자는_추정으로_표시된다():
    pool = _Pool(repo_owner={"knox_id": "thyun.kim", "source": "top_contributor"}, employee=_EMP)
    a = fr.resolve_owner(pool, task_type="github", asset="github:Org/repo/x", finding_id=1)
    assert a is not None
    # ★ 확정과 같은 칸에 넣으면 추정이 확정으로 위장한다. 라벨과 플래그 둘 다로 가른다.
    assert a.sourceLabel == "주 기여자(추정)"
    assert a.confirmed is False


def test_저장소_담당자가_없으면_커밋_작성자로_떨어진다():
    class _P(_Pool):
        def fetch_all(self, sql, params=None):
            return [{"owner_recipient": "thyun.kim@samsung.com"}]

    pool = _P(repo_owner=None, employee=_EMP)
    a = fr.resolve_owner(pool, task_type="github", asset="github:Org/repo/x", finding_id=1)
    assert a is not None
    assert a.sourceLabel == "커밋 작성자" and a.confirmed is True
    # 커밋 작성자 경로에도 이름이 붙는다(메일 local part 가 대장 키다).
    assert a.name == "Taehyun KIM"


def test_대장_권한이_없으면_이름_없이_메일만_나간다():
    """sql/005 미적용 상태. ★ 조용히 죽지 않고 예전 동작으로 떨어져야 한다."""
    pool = _Pool(repo_owner={"knox_id": "thyun.kim", "source": "repo_login"},
                 deny=("employee_directory",))
    a = fr.resolve_owner(pool, task_type="github", asset="github:Org/repo/x", finding_id=1)
    assert a is not None
    assert a.email == "thyun.kim@samsung.com"
    assert a.name is None and a.dept is None and a.title is None


def test_저장소_담당자_테이블이_없어도_500_이_되지_않는다():
    class _P(_Pool):
        def fetch_all(self, sql, params=None):
            return [{"owner_recipient": "a.kim@samsung.com"}]

    pool = _P(deny=("github_repo_owner",), employee=None)
    a = fr.resolve_owner(pool, task_type="github", asset="github:Org/repo/x", finding_id=1)
    assert a is not None and a.email == "a.kim@samsung.com"


def test_asset_이_저장소_형태가_아니면_저장소_조회를_안_한다():
    pool = _Pool(repo_owner={"knox_id": "x.y", "source": "repo_login"})
    fr.resolve_owner(pool, task_type="github", asset="github:onlyorg", finding_id=1)
    assert not any("github_repo_owner" in s for s in pool.seen)


def test_knox_id_는_메일_local_part_다():
    assert fr._knox_id("A.B@samsung.com") == "a.b"
    assert fr._knox_id("nodomain") is None
    assert fr._knox_id(None) is None
