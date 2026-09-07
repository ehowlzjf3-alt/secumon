"""대상(src) 축 + 개요 집계 계약 — /gw/sources · /gw/stats.

DB 없이 도는 순수 부분(파싱 SSOT·srcKey·라벨 충돌 처리)과, 라이브 DSN 이 있을 때만 도는
부분(실측 대조·srcKey 왕복·컬럼 드리프트)을 나눠 둔다.
"""
import os

import pytest

LIVE = pytest.mark.skipif(
    not os.environ.get("SECU_AGENT_PG_DSN"),
    reason="라이브 threat_hunter DSN(SECU_AGENT_PG_DSN) 필요",
)


@pytest.fixture()
def pool():
    os.environ.setdefault("GATEWAY_TOKEN", "test")
    from digisecu_gateway.config import Config
    from digisecu_gateway.db import ReadOnlyPool

    p = ReadOnlyPool(Config.load())
    p.open()
    yield p
    p.close()


# ── DB 없이: 파싱 SSOT 자체의 계약 ──────────────────────────────────────────


def test_src_expr_covers_every_domain():
    """도메인이 늘면 파싱 규칙도 같이 늘어야 한다 — 빠지면 그 도메인이 통째로 '미상' 이 된다."""
    from digisecu_gateway.domains import DOMAINS, SRC_EXPR, SRC_KIND

    assert set(SRC_EXPR) == set(DOMAINS)
    assert set(SRC_KIND) == set(DOMAINS)


def test_src_case_uses_domain_axis_not_task_type():
    """★ github 은 task_type 이 ('github','jenkins') 다.

    task_type='github' 로만 분기하면 jenkins finding 이 조용히 미상으로 흘러간다
    (app.py 의 카테고리·주차 라우트에 실재하는 선존 버그와 같은 모양)."""
    from digisecu_gateway.domains import src_case_sql

    sql = src_case_sql()
    assert "'jenkins'" in sql, "github 분기가 jenkins 를 흡수해야 한다"
    assert "'web'" in sql, "dev_web 분기가 web 을 흡수해야 한다"


def test_all_domain_task_types_dedups():
    from digisecu_gateway.domains import DOMAIN_TASK_TYPES, all_domain_task_types

    tts = all_domain_task_types()
    assert len(tts) == len(set(tts))
    for group in DOMAIN_TASK_TYPES.values():
        assert set(group) <= set(tts)


def test_report_union_projects_missing_columns_as_null():
    """4종 테이블이 균질하지 않다 — 없는 컬럼은 NULL alias 여야 하고, 그냥 SELECT 하면 안 된다."""
    from digisecu_gateway.domains import report_union_sql

    sql = report_union_sql()
    # mail_thread/dev_web_report_thread 는 owner_recipient·notified_at 이 없다.
    assert sql.count("NULL::text AS owner_recipient") == 2
    assert sql.count("NULL::double precision AS notified_at") == 2
    # 4개 테이블이 전부 들어가야 한다.
    for table in ("mail_thread", "dev_web_report_thread", "github_report_thread",
                  "confluence_report_thread"):
        assert f"FROM {table} t" in sql


def test_report_col_smb_only_columns():
    from digisecu_gateway.domains import report_col

    assert report_col("mail_thread", "recurrence_count", "integer") == "t.recurrence_count"
    assert report_col("github_report_thread", "recurrence_count", "integer") == "NULL::integer"
    assert report_col("dev_web_report_thread", "last_error_kind", "text") == "NULL::text"


def test_src_key_is_stable_and_domain_scoped():
    """같은 문자열이라도 도메인이 다르면 다른 키 — 도메인 간 우연한 충돌을 막는다."""
    from digisecu_gateway.repos.source_repo import src_key

    assert src_key("smb", "10.0.0.1") == src_key("smb", "10.0.0.1")
    assert src_key("smb", "10.0.0.1") != src_key("github", "10.0.0.1")
    assert len(src_key("smb", "10.0.0.1")) == 16
    # 미상(None)도 키를 갖는다 — 버킷을 링크할 수 있어야 한다.
    assert src_key("smb", None) == src_key("smb", "")


def test_masked_label_always_carries_suffix():
    """★ 1차 구분 — 마스킹이 라벨을 바꿨으면 **충돌 여부와 무관하게** 접미를 붙인다.

    "충돌했을 때만" 으로 하면 그 판정이 페이지 안에서만 이뤄져서, 같은 대상이 페이지 크기에
    따라 접미가 붙었다 안 붙었다 한다(라이브에서 실제로 그랬다).
    원문이 그대로 살아남은 라벨(IP·평범한 repo 경로)은 건드리지 않는다."""
    from digisecu_gateway.repos.source_repo import _SUFFIX, _to_item

    masked = _to_item(
        {"domain": "github", "src": "org/ghp_deadbeefdeadbeefdeadbeef1234", "src_key": "a1b2c3d4e5f60718",
         "findings": 1, "open_findings": 1, "critical": 0, "high": 0}, True)
    assert masked.src is not None and masked.src.endswith(f" ·{'a1b2c3d4e5f60718'[:_SUFFIX]}")
    assert "«마스킹»" in masked.src

    plain = _to_item(
        {"domain": "smb", "src": "10.0.0.1", "src_key": "ffffffffffffffff",
         "findings": 1, "open_findings": 1, "critical": 0, "high": 0}, True)
    assert plain.src == "10.0.0.1", "마스킹이 안 걸린 라벨은 그대로 둔다"


def test_remaining_collision_escalates_not_merges():
    """★ 2차 방어 — 접미까지 겹치면 키 전체로 늘린다. **병합하지 않는다**.

    서로 다른 대상 둘을 한 줄로 합치면 조치가 한쪽으로만 간다."""
    from digisecu_gateway.models import SourceItem
    from digisecu_gateway.repos.source_repo import _disambiguate

    def item(key: str, src: str) -> SourceItem:
        return SourceItem(domain="github", srcKind="repo", src=src, srcKey=key,
                          findings=1, openFindings=1, critical=0, high=0)

    # 접미 6자리가 같은(=사실상 불가능하지만) 두 대상
    items = [item("abcdef0000000001", "«마스킹» ·abcdef"),
             item("abcdef0000000002", "«마스킹» ·abcdef"),
             item("eeee5555ffff6666", "10.0.0.1")]
    _disambiguate(items)
    assert items[0].src == "«마스킹» ·abcdef0000000001"
    assert items[1].src == "«마스킹» ·abcdef0000000002"
    assert items[0].src != items[1].src
    assert items[2].src == "10.0.0.1", "충돌하지 않은 라벨은 건드리지 않는다"


def test_thread_state_vocab_is_closed():
    """미지의 threadState 는 조용히 전체를 내지 않고 거부해야 한다(fail-closed)."""
    from digisecu_gateway.repos.source_repo import _THREAD_STATE_SQL

    # ★ `ready`(발송 대기) 추가 2026-09-01 — 운영자가 실제로 클릭하는 칸이다.
    #   어휘를 닫아 두는 이유는 그대로다: 미지의 값이 오면 조용히 전체를 내면 안 된다.
    assert set(_THREAD_STATE_SQL) == {
        "none", "reported", "ready", "awaiting", "replied", "closed",
    }


def test_thread_state_uses_any_thread_not_latest():
    """★ 한 대상에 스레드가 여럿이다(smb 231 대상에 509 스레드).

    최신 하나의 status 로 거르면, 답장을 기다리는 대상이 더 새 스레드에 가려 사라진다."""
    from digisecu_gateway.repos.source_repo import _THREAD_STATE_SQL

    for key in ("ready", "awaiting", "replied", "closed"):
        assert "_n" in _THREAD_STATE_SQL[key], f"{key} 는 집계 카운트로 걸러야 한다"
        assert "thread_status" not in _THREAD_STATE_SQL[key]


def test_stats_never_reports_resolved_from_weekly():
    """★ 기존 performance().resolved 는 사실상 false_positive 만 센다 — 그걸 '처리' 로 쓰면 거짓말이다.

    stats 의 weekly 는 유입만 낸다(resolved 는 항상 0)."""
    import inspect

    from digisecu_gateway import stats_service

    src = inspect.getsource(stats_service._weekly)
    assert "resolved=0" in src


# ── 라이브: 실측 대조 ────────────────────────────────────────────────────────


@LIVE
def test_src_key_sql_matches_python(pool):
    """★ SQL 판과 Python 판이 어긋나면 /gw/findings?srcKey= 가 조용히 0건을 낸다."""
    from digisecu_gateway.repos.source_repo import src_key, src_key_sql

    for domain, raw in (("smb", "12.25.122.146"), ("github", "org/repo"),
                        ("confluence", "DSSOC"), ("dev_web", "example.net")):
        row = pool.fetch_one(f"SELECT {src_key_sql('%s', '%s')} AS k", [domain, raw])
        assert row["k"] == src_key(domain, raw), f"{domain}/{raw} 키 불일치"


@LIVE
def test_sources_parse_matches_direct_count(pool):
    """파싱 결과가 SQL 직접 집계와 같은지 — 도메인별 대상 종수."""
    from digisecu_gateway.domains import DOMAINS, all_domain_task_types, domain_case_sql, src_case_sql
    from digisecu_gateway.repos import source_repo

    tts = all_domain_task_types()
    ph = ", ".join(["%s"] * len(tts))
    rows = pool.fetch_all(
        f"WITH b AS (SELECT {domain_case_sql()} AS domain, {src_case_sql()} AS src "
        f"FROM finding_lifecycle WHERE task_type IN ({ph})) "
        f"SELECT domain, COUNT(DISTINCT src) AS n, COUNT(*) FILTER (WHERE src IS NULL) AS unparsed "
        f"FROM b WHERE domain IS NOT NULL GROUP BY domain",
        list(tts),
    )
    direct = {str(r["domain"]): (int(r["n"]), int(r["unparsed"])) for r in rows}
    for d in DOMAINS:
        n, unparsed = direct.get(d, (0, 0))
        expected = n + (1 if unparsed else 0)  # 미상은 1급 버킷 1개로 센다
        assert source_repo.list_sources(pool, domain=d, limit=1).total == expected, d


@LIVE
def test_unparsed_src_is_kept_as_bucket(pool):
    """★ 파싱 실패를 버리면 총계가 조용히 줄어든다 — smb 에 host 없는 asset 이 실재한다."""
    from digisecu_gateway.repos import source_repo

    items = source_repo.list_sources(pool, domain="smb", limit=500).items
    nulls = [i for i in items if i.src is None]
    if nulls:  # 실측상 존재하지만, 데이터가 정리되면 0 일 수 있다
        assert len(nulls) == 1, "미상은 도메인당 하나의 버킷으로 접힌다"
        assert nulls[0].findings > 0
        assert nulls[0].srcKey, "미상 버킷도 링크 가능해야 한다"


@LIVE
def test_src_key_roundtrip_counts_match(pool):
    """★ 계획 검증 2번 — /gw/sources 의 건수와 /gw/findings?srcKey= 의 total 이 같아야 한다."""
    from digisecu_gateway.repos import finding_repo, source_repo

    for it in source_repo.list_sources(pool, limit=5).items:
        got = finding_repo.list_findings(pool, src_key=it.srcKey, limit=1)
        assert got.total == it.findings, f"{it.domain}/{it.src} {it.findings} != {got.total}"


@LIVE
def test_sources_never_leak_raw_src(pool):
    """응답에 원문 src 가 아니라 마스킹 라벨이 나가야 한다(redact 통과)."""
    from digisecu_gateway.masking import redact
    from digisecu_gateway.repos import source_repo

    for it in source_repo.list_sources(pool, limit=40).items:
        if it.src is None:
            continue
        base = it.src.split(" ·")[0]  # 충돌 접미 제거
        assert redact(base) == base, f"마스킹 안 된 라벨: {base!r}"


@LIVE
def test_report_thread_new_columns_exist(pool):
    """스키마 드리프트 — 새로 투영하는 컬럼이 4종 테이블에 실제로 있는지(LIMIT 0)."""
    from digisecu_gateway.domains import DOMAIN_TABLES, report_col

    for dt in DOMAIN_TABLES.values():
        t = dt.report_thread_table
        pool.fetch_all(
            f"SELECT first_reported_at, attempt_count, cycle_keys, last_reason, "
            f"{report_col(t, 'recurrence_count', 'integer')} AS recurrence_count, "
            f"{report_col(t, 'last_error_kind', 'text')} AS last_error_kind "
            f"FROM {t} t LIMIT 0"
        )


@LIVE
def test_stats_domain_sum_matches_totals(pool):
    from digisecu_gateway import stats_service

    s = stats_service.stats(pool)
    assert s.totals.findings == sum(d.findings for d in s.domains)
    assert s.totals.sources == sum(d.sources for d in s.domains)
    assert s.week and s.week.count("-W") == 1, f"주차 형식이 cycle_key 와 달라졌다: {s.week}"


@LIVE
def test_stats_open_findings_matches_findings_route(pool):
    """★ 계획 검증 3번 — stats 의 도메인별 openFindings 와 /gw/findings 의 total 이 같아야 한다."""
    from digisecu_gateway import stats_service
    from digisecu_gateway.domains import DOMAIN_TASK_TYPES
    from digisecu_gateway.repos import finding_repo

    s = stats_service.stats(pool)
    for d in s.domains:
        got = finding_repo.list_findings(
            pool, task_types=DOMAIN_TASK_TYPES[d.domain], status="open", limit=1)
        triaged = finding_repo.list_findings(
            pool, task_types=DOMAIN_TASK_TYPES[d.domain], status="triaged", limit=1)
        assert d.openFindings == got.total + triaged.total, d.domain


@LIVE
def test_stats_remediation_basis_is_declared(pool):
    """조치 완료를 무엇으로 셌는지 반드시 밝힌다 — 근거 없이 숫자만 내면 도메인마다 뜻이 달라진다."""
    from digisecu_gateway import stats_service

    for d in stats_service.stats(pool).domains:
        assert d.remediationBasis in ("verification_gone", "reverify_now_closed", "none")
        if d.remediationLookup == "denied":
            assert d.remediated == 0, "못 읽었으면 0 으로 위장하지 말고 denied 로만 표시한다"


@LIVE
def test_owner_lookup_reports_denial_not_absence(pool):
    """★ asset_owner GRANT 가 없으면 '담당자 없음' 이 아니라 '못 읽음' 이어야 한다."""
    from digisecu_gateway.repos import source_repo

    out = source_repo.list_sources(pool, domain="smb", limit=5)
    assert out.ownerLookup in ("ok", "denied")
    for it in out.items:
        if it.assignee is None:
            continue
        if out.ownerLookup == "denied":
            assert it.assignee.status == "lookup_denied"
        else:
            assert it.assignee.status in ("resolved", "unresolved")


@LIVE
def test_masked_label_is_page_independent(pool):
    """★ 라벨은 **어느 페이지에 실렸는지에 좌우되면 안 된다**.

    처음엔 "충돌이 났을 때만 접미를 붙인다" 로 만들었는데, 그 판정이 페이지 안에서만 이뤄져서
    같은 대상이 페이지 크기에 따라 접미가 붙었다 안 붙었다 했다(실측: dev_web 에서
    `«마스킹».cdep.samsungds.net` 하나로 35개가 접히는데 페이지가 갈리면 한쪽은 맨몸이었다).
    지금은 마스킹된 라벨엔 무조건 붙인다 — 이 테스트가 그 회귀를 잡는다."""
    from digisecu_gateway.repos import source_repo

    big = {i.srcKey: i.src for i in source_repo.list_sources(pool, limit=500).items}
    small: dict[str, str | None] = {}
    for off in (0, 100, 200, 300, 400):
        for i in source_repo.list_sources(pool, limit=100, offset=off).items:
            small[i.srcKey] = i.src
    mismatched = [k for k in big if k in small and big[k] != small[k]]
    assert not mismatched, f"페이지 크기에 따라 라벨이 달라진다: {mismatched[:3]}"


@LIVE
def test_no_label_collision_across_all_sources(pool):
    """★ 계획 검증 3번 — 전체를 훑어 라벨 중복이 남는지.

    남으면 서로 다른 두 대상이 한 줄로 보이고, 조치가 한쪽으로만 간다."""
    from digisecu_gateway.repos import source_repo

    items: list = []
    off = 0
    while True:
        page = source_repo.list_sources(pool, limit=500, offset=off)
        items += page.items
        if len(items) >= page.total or not page.items:
            break
        off += 500

    seen: dict[tuple[str, str], int] = {}
    for it in items:
        if it.src is None:
            continue
        seen[(it.domain, it.src)] = seen.get((it.domain, it.src), 0) + 1
    dups = {k: v for k, v in seen.items() if v > 1}
    assert not dups, f"라벨 충돌 {len(dups)}건: {list(dups)[:3]}"
    # srcKey 는 원문 기준이라 언제나 유일해야 한다.
    keys = [it.srcKey for it in items]
    assert len(keys) == len(set(keys)), "srcKey 중복 — 서로 다른 대상이 같은 키를 갖는다"


@LIVE
def test_pagination_has_no_gap_or_overlap(pool):
    """★ 계획 검증 4번 — offset 으로 걸어도 행이 겹치거나 빠지지 않는다.

    `ORDER BY last_seen DESC, id DESC` 의 뒤 키(id)가 없으면 동률에서 순서가 흔들려
    같은 행이 두 페이지에 나오거나 아예 빠진다. github 은 같은 run 에서 대량 적재돼
    last_seen 동률이 많아 이 결함이 드러나는 최적 표본이다.
    (전량 40페이지 완주는 26초라 스위트에선 앞 5페이지만 — 동률 구간은 여기 다 들어온다.)"""
    from digisecu_gateway.domains import DOMAIN_TASK_TYPES
    from digisecu_gateway.repos import finding_repo

    tts = DOMAIN_TASK_TYPES["github"]
    limit, pages = 500, 5
    seen: set[int] = set()
    fetched = 0
    for p in range(pages):
        fl = finding_repo.list_findings(pool, task_types=tts, limit=limit, offset=p * limit)
        if not fl.items:
            break
        fetched += len(fl.items)
        seen.update(f.id for f in fl.items)
    assert fetched > 0
    assert len(seen) == fetched, f"페이지 간 중복 {fetched - len(seen)}건"


# ── DSSOC 신원 판정 — 정의가 두 벌이었고 둘 다 env 를 안 봤다 ──────────────────────
#
# 화면이 "이 주소가 담당자인가" 를 이걸로 가른다. 팀함 주소를 바꿨는데 판정이 안 따라오면
# 콘솔은 우리 팀함을 담당자로 그린다. 엔진 쪽에서 실제로 그랬다(2026-08-24 수정).

def test_dssoc_identity_follows_env_not_just_hardcoded_prefixes(monkeypatch) -> None:
    from digisecu_gateway.domains import is_dssoc

    # 접두 목록에 없는 주소 — env 가 없으면 담당자로 보인다.
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)
    assert is_dssoc("보안팀함@samsung.com") is False

    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "보안팀함@samsung.com")
    assert is_dssoc("보안팀함@samsung.com") is True
    assert is_dssoc("  보안팀함@SAMSUNG.com  ") is True   # 정규화
    assert is_dssoc("owner@samsung.com") is False          # 무관한 주소는 그대로


def test_dssoc_identity_reads_every_domain_env(monkeypatch) -> None:
    """도메인별 팀함을 따로 두면 그 도메인만 판정이 빠진다 — 넷을 다 본다."""
    from digisecu_gateway.domains import DSSOC_ENV_NAMES, is_dssoc

    for name in DSSOC_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "cf.team@samsung.com")
    assert is_dssoc("cf.team@samsung.com") is True


def test_dssoc_identity_keeps_the_prefix_backstop(monkeypatch) -> None:
    """env 가 안 붙은 배포에서도 팀함 계열은 잡혀야 한다(기존 동작 보존)."""
    from digisecu_gateway.domains import DSSOC_ENV_NAMES, is_dssoc

    for name in DSSOC_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    assert is_dssoc("dssoc@samsung.com") is True
    assert is_dssoc("noreply@samsung.com") is True
    assert is_dssoc("") is False
    assert is_dssoc(None) is False


def test_both_old_copies_now_resolve_to_the_same_function() -> None:
    """두 사본이 갈라지지 않는지 — 이름은 남기되 정의는 하나여야 한다."""
    from digisecu_gateway.domains import is_dssoc
    from digisecu_gateway.repos import finding_repo, workspace_repo

    assert workspace_repo._is_dssoc is is_dssoc
    assert finding_repo._is_dssoc_email is is_dssoc


# ── 대상 찾기(q) — LIKE 메타문자 이스케이프가 load-bearing ────────────────────
#
# 검색이 없으면 특정 호스트를 못 찾는다. `src` 는 마스킹 라벨이고 `srcKey` 는 불투명
# 해시라, 둘 다 타이핑으로 못 찾기 때문이다 — 그래서 원문(j.src)으로 찾는다.
#
# ⚠️ 이스케이프가 빠지면 `_` 한 글자가 **전건**을 매칭한다. 그건 "필터가 걸린 줄 아는
#    빈 필터" 라 가장 나쁜 실패 모양이다 — 사용자는 걸렀다고 믿고 전체를 본다.

@LIVE
def test_q_finds_by_raw_src_not_masked_label(pool):
    from digisecu_gateway.repos import source_repo

    hit = source_repo.list_sources(pool, q="12.25", limit=5)
    assert hit.total > 0, "원문에 존재하는 접두인데 0건 — 마스킹 라벨로 찾고 있는 것 아닌가"
    assert hit.total < source_repo.list_sources(pool, limit=1).total

    miss = source_repo.list_sources(pool, q="존재하지않는대상zzz", limit=1)
    assert miss.total == 0


@LIVE
def test_q_escapes_like_metacharacters(pool):
    """`_`·`%` 는 리터럴로 다뤄야 한다. 안 그러면 필터가 조용히 무력화된다."""
    from digisecu_gateway.repos import source_repo

    everything = source_repo.list_sources(pool, limit=1).total

    # ⚠️ `< everything` 으로 단언하면 안 된다 — 이스케이프가 빠지면 `%_%` 가 되어 **src 가
    #    NULL 인 몇 건만 빼고** 전부 매칭한다. 984 < 985 라서 통과해 버린다(처음에 그렇게
    #    썼고, 이스케이프를 지워도 통과하는 것을 보고 알았다).
    #    실측: 이스케이프 있음 143/985(14.5%) · 없음 ~984/985(99.9%) — 절반이 명확히 가른다.
    underscore = source_repo.list_sources(pool, q="_", limit=1).total
    assert underscore < everything // 2, (
        f"`_` 가 {underscore}/{everything} 건을 매칭했다 — 이스케이프가 빠져 와일드카드로 동작한다"
    )

    percent = source_repo.list_sources(pool, q="%", limit=1).total
    assert percent < everything // 2, "`%` 가 와일드카드로 동작한다"


@LIVE
def test_q_combines_with_domain_filter(pool):
    """검색이 다른 필터를 덮어쓰지 않는다 — AND 로 겹쳐야 한다."""
    from digisecu_gateway.repos import source_repo

    smb_only = source_repo.list_sources(pool, domain="smb", q="12.25", limit=1).total
    github_only = source_repo.list_sources(pool, domain="github", q="12.25", limit=1).total
    both = source_repo.list_sources(pool, q="12.25", limit=1).total
    assert smb_only + github_only <= both
    assert smb_only > 0


def test_q_length_is_capped():
    """상한이 없으면 긴 입력이 그대로 LIKE 로 간다."""
    from digisecu_gateway.repos.source_repo import _Q_MAX

    assert 0 < _Q_MAX <= 200


# ── 심각도·담당자 필터 + 정렬 노출 ──────────────────────────────────────────
#
# 실측 분포(985 대상)로 **갈리는 것만** 넣었다: critical 36(4%) · 담당자없음 190(19%).
# `notifiedAt` 은 985 중 0건이라 안 넣었다 — 신호가 없는 필터는 화면만 복잡하게 한다.

@LIVE
def test_severity_filter_narrows(pool):
    from digisecu_gateway.repos import source_repo

    everything = source_repo.list_sources(pool, limit=1).total
    crit = source_repo.list_sources(pool, severity="critical", limit=1).total
    high = source_repo.list_sources(pool, severity="high", limit=1).total

    assert 0 < crit < high < everything, f"crit={crit} high={high} 전체={everything}"


@LIVE
def test_assignee_filter_sees_both_owner_sources(pool):
    """★ 담당자는 **두 갈래**로 온다 — smb=asset_owner(이름/메일) · github=owner_recipient +
    임직원 대장. COALESCE 에서 한쪽을 빠뜨리면 그 도메인이 통째로 "담당자 없음" 이 된다.

    ⚠️ 처음엔 `none + resolved == 전체` 로 단언했는데 **그건 항상 참이다** — 두 절을 같은
       식의 여집합(IS NULL / IS NOT NULL)으로 짰기 때문이다. 한쪽 갈래를 지워도 통과한다.
       도메인별로 재야 실제로 잡힌다.

    실측 2026-08-25: smb 221/231 · github 574/640 · dev_web 0/98 · confluence 0/16.
    뒤 둘의 0 은 버그가 아니다 — dev_web 은 담당자 개념이 없고(CDEP 접근 필요),
    confluence 는 스레드가 1건뿐이고 그것도 owner 가 비어 있다.
    """
    from digisecu_gateway.repos import source_repo

    for domain, floor in (("smb", 0.5), ("github", 0.5)):
        total = source_repo.list_sources(pool, domain=domain, limit=1).total
        if total == 0:
            continue
        resolved = source_repo.list_sources(
            pool, domain=domain, assignee="resolved", limit=1,
        ).total
        assert resolved >= total * floor, (
            f"{domain}: 담당자 있음 {resolved}/{total} — 이 도메인의 담당자 갈래를 "
            "COALESCE 가 못 보고 있다"
        )

    everything = source_repo.list_sources(pool, limit=1).total
    none = source_repo.list_sources(pool, assignee="none", limit=1).total
    resolved = source_repo.list_sources(pool, assignee="resolved", limit=1).total
    assert none + resolved == everything


@LIVE
def test_filters_compose_with_and_not_or(pool):
    from digisecu_gateway.repos import source_repo

    crit = source_repo.list_sources(pool, severity="critical", limit=1).total
    none = source_repo.list_sources(pool, assignee="none", limit=1).total
    both = source_repo.list_sources(pool, severity="critical", assignee="none", limit=1).total
    assert both <= min(crit, none), "AND 가 아니라 OR 로 걸린다"


def test_unknown_filter_value_is_rejected_not_ignored():
    """★ 조용히 무시하면 "필터가 걸린 줄 아는" 화면이 된다 — 가장 나쁜 실패다."""
    import pytest as _pytest

    from digisecu_gateway.repos import source_repo

    for kw in ({"severity": "헛소리"}, {"assignee": "헛소리"}, {"thread_state": "헛소리"}):
        with _pytest.raises(ValueError):
            source_repo.list_sources(None, limit=1, **kw)  # type: ignore[arg-type]


def test_every_order_is_exposed_to_the_ui():
    """게이트웨이에 정렬 4종이 있는데 화면에 컨트롤이 없어 URL 로만 먹던 상태였다.

    ⚠️ 여기서 web 을 직접 못 읽으므로 서버 어휘만 고정한다 — 화면 쪽은
       `ORDER_OPTIONS`(soarMeta.ts)가 같은 키를 갖는다.
    """
    from digisecu_gateway.repos.source_repo import _ORDERS

    assert set(_ORDERS) == {"firstSeen", "findings", "critical", "lastSeen", "stale"}


def test_first_seen_is_the_default_order_vocabulary():
    """★ 목록 기본 정렬은 **발생**(first_seen)이다.

    `lastSeen` 은 뒤 run 이 같은 것을 다시 보기만 해도 갱신된다 — 오래 방치된 티켓이
    새것처럼 목록 위로 올라온다. 티켓의 나이는 처음 발견된 때다(2026-08-29 사용자 결정).
    """
    from digisecu_gateway.repos.source_repo import _ORDERS

    assert "first_seen" in _ORDERS["firstSeen"]
    assert "last_seen" not in _ORDERS["firstSeen"]


# ── threadId — 티켓 상세가 본문을 되묻는 유일한 키 (2026-08-27) ──────────────

def test_report_union_carries_thread_id_for_all_four():
    """★ 이게 없어서 티켓 상세는 발송 이력을 '언제' 까지만 그리고 '무엇을' 은 못 그렸다.

    본문 라우트(`/gw/reports/{key}/{id}/body`)는 그동안 정상 응답 중이었다 —
    빠진 것은 서버가 아니라 **계약**이었다."""
    from digisecu_gateway.domains import DOMAINS, report_union_sql

    sql = report_union_sql()
    assert sql.count("t.id::bigint AS thread_id") == len(DOMAINS), (
        "네 도메인이 전부 thread_id 를 내야 UNION 이 성립한다")


def test_to_item_maps_thread_id():
    from digisecu_gateway.repos.source_repo import _to_item

    row = {"domain": "github", "src": "org/repo", "src_key": "a1b2c3d4e5f60718",
           "findings": 1, "open_findings": 1, "critical": 0, "high": 0,
           "threads": 3, "thread_id": 4172}
    assert _to_item(row, True).threadId == 4172


def test_to_item_thread_id_absent_is_none_not_zero():
    """0 은 유효한 id 처럼 보인다 — 스레드가 없는 것과 구분해야 화면이 빈 패널을 안 연다."""
    from digisecu_gateway.repos.source_repo import _to_item

    row = {"domain": "smb", "src": "10.0.0.1", "src_key": "ffffffffffffffff",
           "findings": 1, "open_findings": 1, "critical": 0, "high": 0}
    assert _to_item(row, True).threadId is None
