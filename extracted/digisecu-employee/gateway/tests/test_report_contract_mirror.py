"""`contracts/src/report.ts`(zod, SSOT) ↔ `models.py`(pydantic, 미러) 드리프트 가드.

★ 왜 필요한가: 두 파일은 쌍인데 **런타임 검증이 없다.** 한쪽만 고치면 조용히 어긋나고,
  화면은 필드가 없거나 stage 가 안 접힌 채 그려진다. 사람이 눈으로 맞추는 걸 믿지 않는다.

TS 를 파싱해서 비교한다(빌드 산출물이 아니라 소스 — dist 가 stale 이어도 잡히게).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_TS = Path(__file__).resolve().parents[2] / "contracts" / "src" / "report.ts"


@pytest.fixture(scope="module")
def ts() -> str:
    if not _TS.exists():
        pytest.skip(f"계약 원본 없음: {_TS}")
    return _TS.read_text(encoding="utf-8")


def _zod_enum(ts: str, name: str) -> list[str]:
    m = re.search(rf"export const {name} = z\.enum\(\[(.*?)\]\)", ts, re.S)
    assert m, f"{name} z.enum 을 못 찾았다"
    # ⚠️ 주석을 먼저 지운다 — 주석 안의 따옴표가 enum 값으로 잡힌다(실제로 그랬다).
    return re.findall(r'"([^"]+)"', re.sub(r"//[^\n]*", "", m.group(1)))


def _object_fields(ts: str, name: str) -> set[str]:
    m = re.search(rf"export const {name} = z\.object\(\{{(.*?)\n\}}\);", ts, re.S)
    assert m, f"{name} z.object 를 못 찾았다"
    body = re.sub(r"//[^\n]*", "", m.group(1))          # 주석 제거
    return set(re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]*):", body, re.M))


def _pydantic_fields(model) -> set[str]:
    return set(model.model_fields)


def test_stage_vocabulary_matches(ts):
    from digisecu_gateway.models import REPORT_STAGES
    assert _zod_enum(ts, "ReportStage") == list(REPORT_STAGES)


def test_terminal_stages_match(ts):
    from digisecu_gateway.models import REPORT_TERMINAL_STAGES
    m = re.search(r"REPORT_TERMINAL_STAGES[^=]*=\s*\[(.*?)\]", ts, re.S)
    assert m
    assert set(re.findall(r'"([^"]+)"', m.group(1))) == set(REPORT_TERMINAL_STAGES)


@pytest.mark.parametrize("ts_name,py_name", [
    ("ReportBodyMeta", "ReportBodyMeta"),
    ("ReportDomainRef", "ReportDomainRef"),
    ("ReportThreadDetail", "ReportThreadDetail"),
    ("PipelineComponentRun", "PipelineComponentRun"),
    ("PipelineOverview", "PipelineOverview"),
])
def test_model_fields_match(ts, ts_name, py_name):
    import digisecu_gateway.models as models
    assert _object_fields(ts, ts_name) == _pydantic_fields(getattr(models, py_name)), (
        f"{ts_name} 필드가 어긋났다 — 계약과 미러를 **같이** 고칠 것")


def test_status_map_matches_per_domain(ts):
    """도메인별 native status → stage 매핑이 양쪽 동일한가."""
    from digisecu_gateway.models import STATUS_TO_STAGE as PY
    m = re.search(r"export const STATUS_TO_STAGE[^=]*=\s*\{(.*?)\n\};", ts, re.S)
    assert m
    body = re.sub(r"//[^\n]*", "", m.group(1))
    blocks = re.findall(r"(\w+):\s*\{(.*?)\n  \}", body, re.S)
    ts_map = {d: dict(re.findall(r"(\w+):\s*\"(\w+)\"", b)) for d, b in blocks}
    assert set(ts_map) == set(PY), "도메인 목록이 어긋났다"
    for domain in sorted(ts_map):
        assert ts_map[domain] == PY[domain], f"{domain} status 매핑이 어긋났다"


def test_every_stage_is_reachable(ts):
    """정규 stage 중 아무 데서도 못 나오는 것이 없어야 한다 — 죽은 어휘 금지.

    `unknown` 만 예외다: 매핑표가 아니라 `stage_for` 의 **폴백**으로 도달한다
    (엔진이 status 를 추가했을 때 가는 자리라 표에 있으면 오히려 이상하다)."""
    from digisecu_gateway.models import REPORT_STAGES, STATUS_TO_STAGE, stage_for
    used = {s for table in STATUS_TO_STAGE.values() for s in table.values()}
    used.add(stage_for("github", "__not_a_real_status__"))
    missing = set(REPORT_STAGES) - used
    assert missing == set(), f"어디서도 못 나오는 stage: {sorted(missing)}"
    assert "unknown" not in {s for t in STATUS_TO_STAGE.values() for s in t.values()}


def test_labels_cover_every_stage(ts):
    """한국어 라벨이 빠진 stage 가 있으면 화면에 키가 그대로 노출된다."""
    from digisecu_gateway.models import REPORT_STAGES
    m = re.search(r"REPORT_STAGE_LABEL[^=]*=\s*\{(.*?)\n\};", ts, re.S)
    assert m
    labelled = set(re.findall(r"^\s{2}(\w+):", m.group(1), re.M))
    assert labelled == set(REPORT_STAGES)


# ── 리뷰 반영분 (UI 세션 지적 ①②③⑤) ──────────────────────────────────────

def test_stage_groups_match(ts):
    """목록 필터 칩 축 — 서버·클라이언트가 **같은 기준**으로 접어야 숫자가 맞는다."""
    from digisecu_gateway.models import REPORT_STAGE_GROUPS, STAGE_TO_GROUP
    # ⚠️ 반드시 _zod_enum 을 쓴다 — 인라인 정규식은 주석 속 따옴표를 값으로 잡는다(두 번 당했다).
    assert _zod_enum(ts, "ReportStageGroup") == list(REPORT_STAGE_GROUPS)

    m2 = re.search(r"export const STAGE_TO_GROUP[^=]*=\s*\{(.*?)\n\};", ts, re.S)
    assert m2
    ts_map = dict(re.findall(r"(\w+):\s*\"(\w+)\"", re.sub(r"//[^\n]*", "", m2.group(1))))
    assert ts_map == STAGE_TO_GROUP


def test_every_stage_belongs_to_exactly_one_group():
    """stage 하나가 그룹에서 빠지면 목록 칩 합계가 총계와 안 맞는다."""
    from digisecu_gateway.models import REPORT_STAGES, STAGE_TO_GROUP
    assert set(STAGE_TO_GROUP) == set(REPORT_STAGES)


def test_terminal_stages_derive_from_the_status_ssot():
    """★ 종결은 `domains.REPORT_THREAD_TERMINAL` 에서 **도출**해야 한다.

    손나열하면 `/gw/stats.closedThreads`·`/gw/sources?threadState=closed` 와 어긋나
    **같은 스레드가 화면 A 에선 종결, B 에선 진행 중**으로 보인다."""
    from digisecu_gateway.domains import REPORT_THREAD_TERMINAL
    from digisecu_gateway.models import (
        REPORT_TERMINAL_STAGES, STATUS_TO_STAGE,
    )
    any_map = {k: v for table in STATUS_TO_STAGE.values() for k, v in table.items()}
    expected = {any_map[s] for s in REPORT_THREAD_TERMINAL if s in any_map}
    assert set(REPORT_TERMINAL_STAGES) == expected


def test_partially_remediated_is_not_terminal():
    """일부 조치를 완료로 세면 조치율이 부풀려진다."""
    from digisecu_gateway.models import REPORT_TERMINAL_STAGES
    assert "partially_remediated" not in REPORT_TERMINAL_STAGES


def test_unknown_status_is_not_folded_into_error():
    """"우리가 모르는 상태" 와 "워커가 실패함" 은 다른 뜻이다."""
    from digisecu_gateway.models import stage_for
    assert stage_for("github", "some_new_engine_status") == "unknown"
    assert stage_for("github", "error") == "error"
    assert stage_for("smb", "error") == "unknown"  # smb 어휘엔 error 가 없다


def test_body_access_is_uniform_across_domains():
    """★ 2026-08-29: 4도메인이 **같은 구조**여야 한다(사용자 결정).

    그 전엔 smb 만 `denied` 였다 — 본문이 발송 시점의 `mail_message` 에만 생겼고 그
    테이블이 GRANT 밖이라, 발송 전 단계의 smb 티켓 24건이 콘솔에서 전부 빈 칸이었다.
    이제 제출 시점에 `mail_thread.report_json` 에 초안이 실린다(3도메인과 같은 자리).

    ⚠️ `denied` 어휘 자체는 남긴다 — "없음" 과 "못 읽음" 을 가르는 축은 여전히 필요하다.
    """
    from digisecu_gateway.domains import REPORT_BODY_ACCESS, REPORT_HAS_JSON
    assert set(REPORT_BODY_ACCESS) == {"smb", "github", "confluence", "dev_web"}
    assert set(REPORT_BODY_ACCESS.values()) == {"ok"}, REPORT_BODY_ACCESS
    # 읽을 수 있다고 말하려면 **읽을 컬럼이 실제로 있어야** 한다.
    assert "mail_thread" in REPORT_HAS_JSON


def test_pipeline_run_field_names_avoid_the_heartbeat_axis(ts):
    """`staleSeconds` 는 /gw/runtime/presence 의 heartbeat staleness 와 헷갈린다."""
    assert "staleSeconds" not in ts
    assert "sinceLastRunSeconds" in ts and "lastRunAt" in ts


def test_unknown_stays_separate_all_the_way_to_the_filter_chip():
    """★ stage 축에서 가른 구분이 **group 축에서도** 살아 있어야 한다.

    group 이 곧 목록 필터 칩 — 운영자가 실제로 클릭하는 면이다. 여기서 error 로 합치면
    "엔진이 status 를 추가함" 과 "워커가 죽음" 이 같은 칩 아래 섞이고, 상세를 열어야만
    구분이 보인다. stage 만 보는 테스트는 이걸 못 잡는다(실제로 못 잡았다).
    """
    from digisecu_gateway.models import group_for, stage_for
    unknown_stage = stage_for("smb", "some_new_engine_status")
    assert unknown_stage == "unknown"
    assert group_for(unknown_stage) != group_for("error")
    assert group_for(unknown_stage) == "unknown"
    assert group_for("error") == "error"


def test_group_fallback_is_unknown_not_error():
    """맵에 없는 stage 도 '실패' 로 보이면 안 된다."""
    from digisecu_gateway.models import group_for
    assert group_for("__not_a_stage__") == "unknown"
