"""submit_finding(서술형) 경로 github 시크릿 게이트 — category 축 등록형 judge 계약.

배경: 게이트가 스캔 경로 두 곳에만 붙어 있어 LLM 이 직접 부르는 `submit_finding` 경로는
무방비였다. 코어 계약은 값 형상만 봐서 테스트 픽스처/.env.example/벤더 SDK 오탐이
통과했다(#18788 #18823 #18693). 여기서 고정하는 것:

  ① github secret hit 이 실제로 게이트를 탄다
  ② **github 아닌 task_type 은 절대 타지 않는다**(confluence 보호 — 계약의 핵심)
  ③ 통과 시 None 을 돌려 코어 값-형상 계약이 이어서 판정한다(약화 금지)
  ④ bootstrap 이 실제로 등록한다
"""
from __future__ import annotations

import pytest

from plugin.github_secret_evidence_judge import judge_secret_hit


class _Hit:
    def __init__(self, *, category="secret", kind="database_url_with_password",
                 masked="post****5432", location="", preview=""):
        self.category = category
        self.kind = kind
        self.masked = masked
        self.location = location
        self.preview = preview


class _Finding:
    def __init__(self, task_type="github"):
        self.task_type = task_type
        self.summary = "요약"


GH = "https://github.samsungds.net"


# ── ① 실측 오탐 3건이 거부되는가 ─────────────────────────────────────────
@pytest.mark.parametrize("kind,location", [
    ("database_url_with_password",
     f"{GH}/mira-eom/mirror-headroom/blob/main/tests/test_search_compressor.py#L60"),
    ("google_api_key",
     f"{GH}/NeuralGraphics/NSD_DB/blob/main/Engine/Plugins/Runtime/Firebase/"
     "Source/ThirdParty/IOS/include/FIROptions.h"),
    ("database_url_with_password",
     f"{GH}/jong-hun-lee/gitdiagram/blob/main/.env.example"),
])
def test_measured_false_positives_are_rejected(kind, location):
    judgment = judge_secret_hit(_Finding(), _Hit(kind=kind, location=location))
    assert judgment is not None
    assert judgment.should_persist is False


# ── ② confluence/기타 task_type 은 절대 타지 않는다 ──────────────────────
@pytest.mark.parametrize("task_type", ["confluence", "smb", "dev_web", "web", ""])
def test_non_github_task_types_fall_back_to_core(task_type):
    """⚠️ 계약의 핵심. secret_gate 는 `.md`/`docs/` 를 코드·문서 경로로 제외하는데
    confluence 근거는 위키 본문이라 전량 사라진다."""
    hit = _Hit(location="wiki/운영-가이드.md", kind="generic_password_assignment")
    assert judge_secret_hit(_Finding(task_type), hit) is None


def test_confluence_wiki_page_would_die_if_gate_leaked():
    """게이트가 confluence 에 새면 어떻게 되는지 대조 — 규칙 자체는 이 경로를 죽인다."""
    from domains.services.github.application import secret_gate
    assert secret_gate.is_reportable_secret(
        "generic_password_assignment", "abcd****wxyz", "wiki/운영-가이드.md") is False
    # 그래서 judge 가 task_type 으로 먼저 빠져나가야 한다(위 테스트).


# ── ③ 통과 시 None — 코어 계약이 이어서 판정(약화 금지) ──────────────────
@pytest.mark.parametrize("kind,location", [
    ("github_pat", f"{GH}/o/r/blob/main/src/main.py"),
    ("private_key_block", f"{GH}/LCP-Mendix/sampleapp-hospital/blob/main/"
                          "javasource/ds_simplesaml/onelogin/saml2/util/Util.java"),
    ("database_url_with_password", f"{GH}/NEWSVOC/etl/blob/master/"
                                   "servicehub_mcp_server/.env.dev"),
])
def test_real_exposures_fall_through_to_core_contract(kind, location):
    """None = "할 말 없음". 거부가 아니라 **코어 값-형상 계약으로 넘긴다**는 뜻이다.

    KEEP 판정된 진짜(#18333 `Util.java`)와 실측 정탐(#18697 `.env.dev`)이 여기 있다.
    """
    assert judge_secret_hit(_Finding(), _Hit(kind=kind, location=location)) is None


@pytest.mark.parametrize("kind,location", [
    # ⚠️ #18866 실증 — `.md` 문서에 붙여넣은 **진짜** Grafana 서비스계정 토큰
    # (`glsa_…` 전체 값 + 동작하는 curl). 스캔 경로 규칙을 쓰면 미지 kind 라
    # "문서 경로 → 제외" 분기로 떨어져 죽었다. 문서에 붙인 실토큰은 전형적 유출이다.
    ("grafana_api_token",
     f"{GH}/solpe/SolutionPE_Skill_Store/blob/main/skills/productivity/"
     "pegrafana-dashboard-creator/skill.md"),
    # 모델이 지어낸 kind 들 — detector 화이트리스트에 없다
    ("auth_token", f"{GH}/NEWSVOC/etl/blob/master/servicehub_mcp_server/.env.mail"),
    ("database_password", f"{GH}/NEWSVOC/etl/blob/master/servicehub_mcp_server/.env.dev"),
    ("internal_endpoint", f"{GH}/SLSISE/pando-insight/blob/main/apps/portal/service/.env"),
    ("generic_password_assignment",
     f"{GH}/jgarden-kim/onyx-custom/blob/main/backend/scripts/restart_containers.sh"),
])
def test_model_invented_kinds_are_not_killed_by_code_or_doc_paths(kind, location):
    """submit 경로의 kind 는 **모델이 지어낸 문자열**이라 화이트리스트가 성립하지 않는다.

    그래서 이 judge 는 스캔 경로용 `is_reportable_secret` 이 아니라
    `is_reportable_submitted_secret`(fixture/vendor 규칙만)을 써야 한다.
    값 형상 판정은 코어 `_has_hardened_credential_value` 소관이다.
    """
    assert judge_secret_hit(_Finding(), _Hit(kind=kind, location=location)) is None


def test_scan_path_rules_would_have_killed_the_grafana_leak():
    """대조군 — 왜 규칙을 나눠야 했는지 고정한다(회귀 시 이 테스트가 먼저 깨진다)."""
    from domains.services.github.application import secret_gate
    md = "skills/productivity/pegrafana-dashboard-creator/skill.md"
    assert secret_gate.is_reportable_secret("grafana_api_token", "glsa_****ed", md) is False
    assert secret_gate.is_reportable_submitted_secret("grafana_api_token", "glsa_****ed", md) is True


def test_non_secret_category_is_not_this_judges_business():
    hit = _Hit(category="pii", kind="kr_rrn", location=f"{GH}/o/r/blob/main/tests/t.py")
    assert judge_secret_hit(_Finding(), hit) is None


def test_kill_switch_disables_the_gate(monkeypatch):
    monkeypatch.setenv("SA_GITHUB_SECRET_GATE", "0")
    hit = _Hit(location=f"{GH}/o/r/blob/main/tests/test_x.py")
    assert judge_secret_hit(_Finding(), hit) is None


def test_rejection_names_the_normalized_path():
    """사유에 repo 상대경로가 보여야 워커가 무엇을 고칠지 안다."""
    hit = _Hit(location=f"{GH}/o/r/blob/main/tests/test_search_compressor.py#L60")
    judgment = judge_secret_hit(_Finding(), hit)
    assert "tests/test_search_compressor.py" in judgment.reason


# ── ④ bootstrap 등록 ────────────────────────────────────────────────────
# ⚠️ 여기서 load_runtime_env(load_plugins=True) 를 부르면 안 된다 — bootstrap 은 멱등이
# 아니라 재적재 시 `task_type toolset already registered` 로 터진다. 소스 수준으로 고정한다
# (plugin/tests/test_state_schema_registration.py 와 같은 방식).
def test_bootstrap_registers_the_secret_category_judge():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[3] / "plugin" / "bootstrap.py").read_text(
        encoding="utf-8",
    )
    # 호출 형태가 둘 — 직접 호출 / `_register_idempotent` 경유(2026-08-20 멱등화).
    assert (
        'register_category_evidence_judge("secret"' in src
        or 'register_category_evidence_judge, "secret"' in src
    ), (
        "bootstrap 이 secret category judge 를 등록하지 않는다 — "
        "submit_finding 경로가 다시 무방비가 된다"
    )
    assert "plugin/github_secret_evidence_judge.py" in src


def test_registered_judge_is_dispatched_by_core_judge_task_finding():
    """등록 시 코어 `judge_task_finding` 이 실제로 이 judge 를 먼저 소비하는지 —
    배선 계약을 코어 함수 레벨에서 확인한다(등록/해제는 이 테스트가 직접 관리)."""
    from secu_agent.agent.evidence_judgment import (
        judge_task_finding,
        register_category_evidence_judge,
        unregister_category_evidence_judge,
    )
    from secu_agent.agent.schema.finding import TaskFinding

    already = False
    try:
        register_category_evidence_judge("secret", judge_secret_hit)
    except ValueError:
        already = True  # 세션에서 bootstrap 이 이미 등록함 — 그대로 쓴다
    try:
        finding = TaskFinding(
            task_id="task-gh-1", task_type="github", severity="high",
            summary="테스트 픽스처의 DB URL",
            hits=[{
                "category": "secret",
                "kind": "database_url_with_password",
                "masked": "post*************************2/db",
                "location": f"{GH}/o/r/blob/main/tests/test_x.py#L60",
                "preview": 'DATABASE_URL = "post***2/db"',
            }],
        )
        assert judge_task_finding(finding).should_persist is False
    finally:
        if not already:
            unregister_category_evidence_judge("secret")
