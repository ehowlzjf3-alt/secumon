"""memory_recall_for_share — 엔진 state 에서 이동 (v3.82 U3c, SMB scope recall).

memory_add/search 등 코어 memory_rule API 는 엔진 잔류 — recall_for_share 만
도메인(host:share scope 시맨틱)이라 state_domain 소유.
"""
from __future__ import annotations

import service.state_domain as sd
from secu_agent import state


def test_memory_recall_for_share_matches_host_and_share_and_path(tmp_db):
    """master 가 share 시작 시 부른다. 해당 host/share/path 에 매칭되는 모든 룰 반환."""
    from secu_agent import state

    # host 룰
    state.memory_add(scope="host", key="10.0.0.5",
                     rule="이 host 는 dev sandbox — informational 기본",
                     severity_hint="informational")
    # 다른 host 룰 (매칭 안 돼야 함)
    state.memory_add(scope="host", key="99.99.99.99",
                     rule="다른 host")
    # share 룰
    state.memory_add(scope="share", key="10.0.0.5:print$",
                     rule="standard driver share",
                     severity_hint="informational")
    # path_pattern 룰
    state.memory_add(scope="path_pattern", key="정유준님",
                     rule="개인 폴더 — 칩 설계 자산 가능, high default",
                     severity_hint="high")
    # global 룰
    state.memory_add(scope="global", key="*",
                     rule="모든 share — .env 파일 발견 시 본문 확인")

    rules = sd.memory_recall_for_share(
        host="10.0.0.5", share="print$",
    )
    # host + share + global = 3 (path_pattern 은 path 인자 없어 제외)
    keys = {(r["scope"], r["key"]) for r in rules}
    assert ("host", "10.0.0.5") in keys
    assert ("share", "10.0.0.5:print$") in keys
    assert ("global", "*") in keys
    assert ("host", "99.99.99.99") not in keys
    assert ("path_pattern", "정유준님") not in keys


def test_memory_recall_for_share_includes_path_pattern_when_path_given(tmp_db):
    from secu_agent import state

    state.memory_add(scope="path_pattern", key="정유준님",
                     rule="개인 폴더 high default",
                     severity_hint="high")
    state.memory_add(scope="path_pattern", key="홍길동",
                     rule="개인 폴더",
                     severity_hint="high")

    rules = sd.memory_recall_for_share(
        host="1.1.1.1", share="A",
        path_samples=["정유준님/PMIC_design.xlsx", "common/readme.txt"],
    )
    keys = {(r["scope"], r["key"]) for r in rules}
    assert ("path_pattern", "정유준님") in keys
    assert ("path_pattern", "홍길동") not in keys  # path 에 없음


