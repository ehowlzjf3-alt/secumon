"""코어 스위트가 개발자 `.env` 의 `SA_PLUGINS` 에 흔들리지 않는지 (2026-08-20).

skill plugin 이 붙으면 `semiconductor_process` finding category·민감어휘 시그널·
github/confluence task_type canonicalizer 가 **전역 등록**된다. 코어 테스트 일부는
그 이름들이 미등록인 baseline(= plugin 미부착)을 검증하므로, plugin 이 붙은 채로
돌면 결과가 바뀐다.

이게 오래 안 보인 이유: plugin bootstrap 이 중복 등록 ValueError 로 중간에 죽어
뒷단계가 아예 실행되지 않았다. plugin 을 멱등으로 고쳐 끝까지 로드되자 드러났다.

격리는 `tests/conftest.py` 가 import 시점에 한다(빈 문자열 덮어쓰기 — pop 이면
뒤늦은 dotenv 로드가 되살린다). 여기서는 그 사실만 고정한다.
"""
from __future__ import annotations

import os


def test_sa_plugins_is_neutralized_by_default() -> None:
    if os.environ.get("SA_TEST_WITH_PLUGINS", "").strip().lower() in {
        "1", "true", "yes", "on",
    }:
        return  # 명시 opt-in — 이 실행은 plugin 부착이 의도된 것이다
    assert os.environ.get("SA_PLUGINS", "") == "", (
        "코어 스위트에 SA_PLUGINS 가 살아 있다 — 도메인 plugin 의 전역 등록이 "
        "코어 baseline 테스트를 오염시킨다. tests/conftest.py 의 중립화가 깨졌는지 확인할 것"
    )


def test_core_baseline_registries_are_free_of_domain_names() -> None:
    """중립화가 실제로 효과가 있는지 — 이름이 비어 있어야 한다."""
    if os.environ.get("SA_TEST_WITH_PLUGINS", "").strip().lower() in {
        "1", "true", "yes", "on",
    }:
        return
    from secu_agent.finding_taxonomy import classification_label

    assert classification_label("semiconductor_process") == "semiconductor_process", (
        "도메인 finding category 가 코어 스위트에 등록돼 있다"
    )
