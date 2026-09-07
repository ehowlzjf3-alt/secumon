"""4개 도메인 worker.md 의 submit 페이로드 skeleton 을 **스키마와 함께** 고정한다.

배경(2026-08-17 실측) — W34 실기동 하루치에서 워커 `repeat_error_halt` 41건 중
**35건(85%)이 판정이 아니라 서식 오류**였다. 게이트는 실행되지도 않았다:

    github  17건  2 validation errors for SubmitFindingInput
                  finding.severity  Field required
    github  10건  1 validation error  finding.hits.0.category  Field required
    dev_web  6건  dev_web_submit_finding only accepts task_type='dev_web'
    smb      2건  finding.severity  Field required

즉 워커는 진짜 노출(예: `gods/vms` 의 `private_key_block`)을 찾아놓고 **필수 필드를
빠뜨려** 제출에 실패했고, 같은 페이로드를 한 번 더 보내 halt 로 태스크를 통째로 잃었다.

worker.md 에는 *판정* 지침(무엇이 시크릿인가, 거부되면 어떻게 하나)이 길게 있었지만
**페이로드 형태를 보여주는 문장이 한 줄도 없었다.** 도구 description 이 "필수:
task_type, severity, summary, hits" 라고 적어둔 것만으로는 모델이 채우지 못한다.

이 파일이 고정하는 것은 두 가지다.

1. 각 worker.md 가 skeleton 을 갖고 있고, 그 skeleton 이 **pydantic 모델의 필수 필드를
   전부** 언급한다. → 코어 스키마에 필수 필드가 추가되면 이 테스트가 먼저 깨진다
   (worker.md 가 조용히 뒤처지는 것이 이번 손실의 구조였다).
2. 도메인 래퍼가 강제하는 `task_type` 리터럴이 skeleton 안에 있다.
   dev_web 은 `task_type != 'dev_web'` 이면 증거를 보기도 전에 거부한다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from secu_agent.agent.schema.finding import FindingHit, TaskFinding

ROOT = Path(__file__).resolve().parents[3]

# (도메인, worker.md 경로, 그 도메인이 강제하는 task_type 리터럴)
CONTRACTS = [
    ("github", "domains/services/github/skills/github_task/worker.md", "github"),
    ("dev_web", "domains/dev_web/skills/dev_web_task/worker.md", "dev_web"),
    ("smb", "domains/smb/skills/smb_task/worker.md", "smb"),
    ("confluence", "domains/services/confluence/skills/confluence_task/worker.md", "confluence"),
]


def _required(model) -> set[str]:
    """pydantic 모델의 **기본값 없는** 필드 = 빠뜨리면 validation 이 죽는 필드."""
    return {name for name, f in model.model_fields.items() if f.is_required()}


def _text(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_required_fields_are_what_we_think_they_are() -> None:
    """★ 이 테스트가 깨지면 스키마가 바뀐 것이다 — worker.md 4개를 같이 고쳐라.

    아래 아래 테스트들이 '필수 필드가 skeleton 에 있는가'를 보는데, 그 필수 목록
    자체가 조용히 늘면 worker.md 는 뒤처진 채 통과해 버린다. 그래서 목록을 못 박는다.
    """
    assert _required(TaskFinding) == {"severity", "summary"}
    assert _required(FindingHit) == {"category", "kind", "location"}


@pytest.mark.parametrize("domain,rel,task_type", CONTRACTS)
def test_worker_md_shows_a_submit_payload_skeleton(domain, rel, task_type) -> None:
    text = _text(rel)
    assert "skeleton" in text, (
        f"{domain}: worker.md 에 페이로드 skeleton 이 없다 — 워커가 필수 필드를 빠뜨린다"
    )
    assert '"hits": [{' in text, f"{domain}: skeleton 에 hits 배열 형태가 없다"


@pytest.mark.parametrize("domain,rel,task_type", CONTRACTS)
def test_skeleton_names_every_required_schema_field(domain, rel, task_type) -> None:
    """★ 실측 손실 필드: finding.severity(19건), hits[].category(10건)."""
    text = _text(rel)
    for field in sorted(_required(TaskFinding) | _required(FindingHit)):
        assert f'"{field}"' in text, (
            f"{domain}: 필수 필드 {field!r} 가 skeleton 에 없다 "
            f"— 빠뜨리면 증거를 보기도 전에 validation 으로 죽는다"
        )


@pytest.mark.parametrize("domain,rel,task_type", CONTRACTS)
def test_skeleton_pins_the_domain_task_type(domain, rel, task_type) -> None:
    """dev_web 은 task_type 이 다르면 즉시 거부한다(실측 6건)."""
    text = _text(rel)
    assert f'"task_type": "{task_type}"' in text, (
        f"{domain}: skeleton 이 task_type={task_type!r} 를 못 박지 않았다"
    )


@pytest.mark.parametrize("domain,rel,task_type", CONTRACTS)
def test_worker_md_separates_schema_error_from_evidence_rejection(domain, rel, task_type) -> None:
    """⚠️ 서식 오류에 '거부 프로토콜'(재제출 금지)을 적용하면 고칠 수 있는 걸 버린다.

    거부 프로토콜은 *증거* 거부용이다. `Field required` 는 게이트가 돌지도 않은
    것이므로 필드를 채워 **바로** 재제출하는 것이 맞고, 오류 내용이 달라지므로
    연속-동일-오류 halt 에도 걸리지 않는다.
    """
    text = _text(rel)
    assert "schema error is not an evidence rejection" in text, (
        f"{domain}: 서식 오류와 증거 거부를 구분하는 문장이 없다"
    )
    assert "Field required" in text, f"{domain}: 실제 오류 문자열이 규약에 없다"


@pytest.mark.parametrize("domain,rel,task_type", CONTRACTS)
def test_skeleton_does_not_leak_a_plausible_real_secret(domain, rel, task_type) -> None:
    """예시 값은 마스킹된 형태여야 한다 — 워커가 skeleton 을 그대로 흉내낸다."""
    text = _text(rel)
    assert "-----BEGIN" not in text.split("skeleton")[-1], (
        f"{domain}: skeleton 예시에 실제 PEM 블록 형태가 들어 있다"
    )
