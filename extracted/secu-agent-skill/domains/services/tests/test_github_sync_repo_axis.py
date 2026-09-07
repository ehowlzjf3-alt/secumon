"""github `sync_report_threads` 의 축 — 저장소이지 finding 이 아니다.

## 왜 이 파일이 있나

통보 단위는 **저장소**인데 예전 sync 는 finding 을 `last_seen DESC LIMIT 500` 으로 잘랐다.
저장소당 finding 이 평균 21.8건이라(실측 2026-08-24) 창 500 은 저장소 85곳밖에 못 샀고,
정렬이 결정론이라 **매주 같은 500건**만 봤다 — 나머지 저장소 522곳은 열린 채로 영원히
통보 대상이 아니었다.

    열린 finding 14,348 · agent_verified 13,261 · verified 저장소 607 · 창이 덮은 저장소 85

크기 문제가 아니라 축 문제라서 창을 키우는 걸로는 못 닫는다(코드 상한 5000 이어도 저장소 절반).
아래 테스트는 **상한이 다시 들어오면 깨지도록** 짜여 있다.
"""
from __future__ import annotations

import pytest


def _agent_verification() -> dict:
    from service.services.finding_verification import make_agent_verification

    return make_agent_verification(
        method="github_unit_fixture_scan",
        source="unit_test",
        checks=("candidate_detail_collected", "detector_hits_present"),
    )


def _seed(repo: str, idx: int, *, extra_metadata: dict | None = None) -> int:
    from secu_agent import state as core_state

    metadata = {"repo": repo, "path": f".env.{idx}"}
    metadata.update(extra_metadata or {})
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset=f"github:{repo}/.env.{idx}",
        asset_kind="repository_file",
        severity="high",
        summary=f"seeded github finding {repo}#{idx}",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": metadata,
            "agent_verification": _agent_verification(),
        },
    )
    return finding_id


def test_저장소가_창_500_에_잘리지_않는다(tmp_db) -> None:
    """★ 이 파일의 본체. finding 을 600건 심되 **저장소를 600곳**으로 흩는다.

    예전 구현은 `LIMIT 500` 이라 저장소 100곳을 통째로 떨어뜨렸다. 저장소당 1건이라
    "평균 21.8건" 이라는 실측보다 훨씬 유리한 조건인데도 잘렸다는 게 요점이다.
    """
    from domains.services.github.application import scanner
    from service import state_domain as sd

    expected = {f"org/repo-{i:04d}" for i in range(600)}
    for i, repo in enumerate(sorted(expected)):
        _seed(repo, i)

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 600
    assert sync["repos_seen"] == 600
    assert sync["new"] == 600, "저장소가 조용히 떨어졌다 — 상한이 다시 들어왔는지 본다"
    # ⚠️ overview 는 **화면용**이라 limit 기본값이 100 이다(하드캡 1000). 보고 패스는
    #    `github_report_thread_claim_next` 루프라 이 상한을 타지 않는다 — 여기서만 명시한다.
    got = {
        str(row["repo"])
        for row in sd.github_report_threads_overview(limit=1000)
        if str(row.get("repo") or "").startswith("org/repo-")
    }
    assert got == expected


def test_저장소_담당자는_저장소당_한_번만_조회한다(tmp_db, monkeypatch) -> None:
    """finding 축이던 시절엔 같은 저장소를 finding 수만큼 두드렸다(평균 21.8회).

    담당자 조회는 DB + knox 임직원 대장을 탄다 — 13,261회와 607회는 다른 얘기다.
    """
    from domains.services.github.application import scanner

    for i in range(5):
        _seed("org/many", i)
    for i in range(3):
        _seed("org/few", i)

    calls: list[str] = []
    monkeypatch.setattr(scanner, "_repo_owner_recipients", lambda repo: calls.append(repo) or [])
    # ⚠️ 기록이 비면 그 자리에서 해석을 시도한다(2026-09-01) — 그건 GitHub API 를 탄다.
    #    여기서 세는 것은 **조회 횟수**이므로 해석기는 막는다.
    monkeypatch.setattr(scanner, "_resolve_repo_owner_now", lambda repo: False)

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 8
    assert sync["repos_seen"] == 2
    assert sorted(calls) == ["org/few", "org/many"], f"저장소당 1회여야 한다: {calls}"


def test_담당자_조회가_빈결과여도_재조회하지_않는다(tmp_db, monkeypatch) -> None:
    """빈 목록을 캐시 미스로 오인하면 sentinel 이 없는 것이다 — `if not repo_owner` 는 틀린다."""
    from domains.services.github.application import scanner

    for i in range(4):
        _seed("org/nobody", i)

    calls: list[str] = []
    monkeypatch.setattr(scanner, "_repo_owner_recipients", lambda repo: calls.append(repo) or [])
    # ⚠️ 기록이 비면 그 자리에서 해석을 시도한다(2026-09-01) — 그건 GitHub API 를 탄다.
    #    여기서 세는 것은 **조회 횟수**이므로 해석기는 막는다.
    monkeypatch.setattr(scanner, "_resolve_repo_owner_now", lambda repo: False)

    sync = scanner.sync_report_threads()

    assert calls == ["org/nobody"], f"빈 결과인데 재조회했다: {calls}"
    assert sync["owner_missing_count"] == 4


def test_finding_자체_담당자가_저장소_담당자를_이긴다(tmp_db, monkeypatch) -> None:
    """축을 바꾸면서 우선순위가 뒤집히기 쉬운 자리다. extra 가 먼저다 — 예전과 같다."""
    from domains.services.github.application import scanner
    from service import state_domain as sd

    _seed("org/mixed", 0, extra_metadata={"owner_email": "Commit Author <commit.author@samsung.com>"})
    _seed("org/mixed", 1)

    monkeypatch.setattr(
        scanner, "_repo_owner_recipients", lambda repo: ["repo.owner@samsung.com"],
    )

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 2
    assert sync["owner_recipient_count"] == 2
    # 저장소 폴백은 extra 가 비어 있던 1건에만 쓰였다.
    assert sync.get("owner_from_repo_count") == 1
    thread = sd.github_report_threads_overview(repo="org/mixed")[0]
    assert thread["owner_recipient"] is not None


def test_미검증과_범위불명은_저장소로_묶기_전에_걸러진다(tmp_db) -> None:
    """게이트 순서가 축 변경으로 흔들리면 안 된다 — verified → repo → 묶기."""
    from domains.services.github.application import scanner
    from secu_agent import state as core_state

    _seed("org/good", 0)
    core_state.finding_upsert(          # 마커 없음
        task_type="github",
        asset="github:org/unverified/.env",
        asset_kind="repository_file",
        severity="high",
        summary="no agent_verification",
        extra={"metadata": {"repo": "org/unverified"}},
    )
    core_state.finding_upsert(          # 저장소를 못 뽑는 asset
        task_type="github",
        asset="not-a-github-asset",
        asset_kind="repository_file",
        severity="high",
        summary="scope unknown",
        extra={"agent_verification": _agent_verification()},
    )

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 3
    assert sync["skipped_unverified"] == 1
    assert sync["skipped_unknown_scope"] == 1
    assert sync["repos_seen"] == 1
    assert sync["new"] == 1


def test_상한_인자를_받지_않는다() -> None:
    """★ 회귀 가드. `limit=` 이 다시 생기면 여기서 걸린다 —

    상한은 비용을 아끼지 못하면서(전량 스캔 0.16초 + finding_get 5초) 저장소를 조용히
    떨어뜨린다. 다시 넣으려면 이 테스트를 지워야 하고, 그 순간 이유를 다시 쓰게 된다.
    """
    import inspect

    from domains.services.github.application import scanner

    params = inspect.signature(scanner.sync_report_threads).parameters
    assert params == {}, f"상한 인자가 다시 생겼다: {list(params)}"


def test_담당자_기록이_없으면_그_자리에서_해석한다(tmp_db, monkeypatch) -> None:
    """★ 도메인마다 담당자를 채우는 자리가 다른데 github 만 **아무도 안 부르는 별도
    패스**에 있었다(사용자 지적 2026-09-01 "다른 도메인이랑 맞춰").

        smb         수집기가 채운다 — 상시 프로세스
        confluence  스캔이 finding 에 넣는다 — 발견 시점
        github      `github.owner` 패스 — 실행 기록이 아예 없었다

    그래서 스레드 262건이 담당자 없이 큐에 멈춰 있었다. 프로세스를 더 띄우는 대신
    **이미 매 패스 도는 자리**에서 해석한다.
    """
    from domains.services.github.application import scanner

    _seed("org/needs-owner", 0)

    tried: list[str] = []
    monkeypatch.setattr(scanner, "_repo_owner_recipients",
                        lambda repo: ["owner@samsung.com"] if repo in tried else [])
    monkeypatch.setattr(scanner, "_resolve_repo_owner_now",
                        lambda repo: tried.append(repo) or True)

    scanner.sync_report_threads()

    assert tried == ["org/needs-owner"], f"그 자리에서 해석해야 한다: {tried}"


def test_해석은_패스당_상한이_있다(tmp_db, monkeypatch) -> None:
    """⚠️ 해석은 GitHub API 를 탄다. 무제한이면 한 패스가 길어지고 rate limit 을 먹는다.
    못 한 것은 다음 패스가 집는다 — 사건이 아니라 상태를 보기 때문이다."""
    from domains.services.github.application import scanner

    for i in range(scanner._OWNER_RESOLVE_PER_PASS + 5):
        _seed(f"org/repo{i}", 0)

    tried: list[str] = []
    monkeypatch.setattr(scanner, "_repo_owner_recipients", lambda repo: [])
    monkeypatch.setattr(scanner, "_resolve_repo_owner_now",
                        lambda repo: tried.append(repo) or False)

    out = scanner.sync_report_threads()

    assert len(tried) == scanner._OWNER_RESOLVE_PER_PASS, f"상한을 넘었다: {len(tried)}"
    # ★ "0건" 이 시도 실패인지 시도조차 안 함인지 구분되게 카운터로 나간다.
    assert out["owner_resolve_attempts"] == scanner._OWNER_RESOLVE_PER_PASS
