"""`web_site_sweep(target_id=…)` 은 services 워커의 함정이다 (2026-08-22).

## 무엇이 있었나

github SSO task 워커 실기동 2런에서 **매번 turn 1 이 이렇게 날아갔다**:

    web_site_sweep(domain="https://github.samsungds.net/owner/repo", target_id=1084)
      → error:validation  ("target_id=1084 없음")
    web_site_sweep(domain="github.samsungds.net/owner/repo")
      → success

`WebSiteSweepInput.target_id` 는 **`web_target_domain.id`** 다. services 도메인
(github/confluence)의 타깃 id 는 `devops_target` 에 있어서 `state.web_target_get()` 이
못 찾고 거부된다(web_site_sweep_tool.py:474-478).

모델 탓이 아니다 — 스펙이 `target_id` 를 주고 도구가 `target_id` 필드를 광고하니
같이 넘기는 게 자연스럽다. 프롬프트가 **넘기지 말라고 말한 적이 없었다.**

(원래 이 태스크는 `read_file(path:<|"|>…)` 깨진 인자를 쫓고 있었는데, 현 프로파일
deepseek→gemma 로는 **재현되지 않았다.** 대신 재현성 100% 인 이 낭비가 나왔다.)
"""
from __future__ import annotations

from pathlib import Path

import pytest

_SKILLS = Path(__file__).resolve().parents[1]
_WORKERS = {
    "github": _SKILLS / "github" / "skills" / "github_task" / "worker.md",
    "confluence": _SKILLS / "confluence" / "skills" / "confluence_task" / "worker.md",
}


@pytest.mark.parametrize("name", sorted(_WORKERS))
def test_worker_is_told_not_to_pass_target_id(name):
    t = _WORKERS[name].read_text(encoding="utf-8")
    assert "web_site_sweep" in t, "이 워커가 sweep 을 안 부르면 이 테스트는 무의미하다"
    assert "Do not pass `target_id`" in t, f"{name}: 금지가 없다"
    # 금지만 하면 왜인지 모른다 — 근거(다른 테이블)와 대체 행동(domain 만)을 같이.
    i = t.index("Do not pass `target_id`")
    tail = t[i:i + 500]
    assert "web_target_domain" in tail, f"{name}: 왜 안 되는지가 없다"
    assert "devops_target" in tail, f"{name}: 이 타깃이 어디 있는지가 없다"
    assert "`domain=` alone is enough" in tail, f"{name}: 대체 행동이 없다"


def test_the_field_really_means_a_different_table():
    """★ 이 경고의 전제 — target_id 가 web_target_domain 을 본다는 사실.

    도구가 언젠가 devops_target 도 받게 되면 이 경고는 거짓이 된다. 그때는 경고를
    지워야지 테스트를 지우면 안 된다.
    """
    import inspect

    from domains.web.plugin.tools import web_site_sweep_tool as m

    src = inspect.getsource(m.WebSiteSweepTool.execute)
    assert "web_target_get(vi.target_id)" in src, (
        "target_id 조회 경로가 바뀌었다 — 워커 프롬프트의 경고가 아직 맞는지 확인하라")
    assert "web_target_domain.id" in m.WebSiteSweepInput.model_fields["target_id"].description
