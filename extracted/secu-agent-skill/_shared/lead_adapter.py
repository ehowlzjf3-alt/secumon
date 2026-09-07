"""리드 도메인 어댑터 — 도구 이름은 고정, 구현만 도메인이 채운다 (Phase 2a).

## 왜 어댑터인가

사용자 원칙 ②(각 도메인의 구현방법은 동일해야 한다)를 리드 층에서 지키는 방법이다.
리드 도구 **이름·입출력 스키마는 5개로 고정**하고(`_shared/lead_tools.py`), 큐를
어떻게 읽고 닫는지만 도메인이 공급한다. 코어 `register_task_toolset` provider 패턴과
같은 결이고, 검토원 계약(`_shared/inspect_contract.py`)과 대칭이다.

이렇게 안 하면 리드도 4~5벌이 되고, 마스킹 경계도 그만큼 늘어난다 — 경계가 여러 개면
그중 하나가 조용히 새는 것이 이 프로젝트의 반복된 실패 양상이다.

## 어댑터가 공급하는 것

| 필드 | 쓰이는 도구 | 계약 |
|---|---|---|
| `list_targets` | `list_targets` | **read-only**. claim 하지 않는다. |
| `target_detail` | `target_detail` | **본문 없음** — 목록·경로·크기·상태만. |
| `scan_summary` | `target_hit_summary` | **본문 없음** — 건수·카테고리·`masked` 모양만. |
| `run_verb` | `verify` | **닫힌 동사** — 좌표 in, 닫힌 enum out. 값·본문 없음. |
| `delegate_input` | `delegate_inspect` | 타깃 row → 검토원 `agents/*.md` input dict |
| `set_status` | `set_target_status` | 큐 닫기. 리드가 큐 소유자다. |
| `statuses` | `set_target_status` | **닫힌 enum** — 도메인마다 다르다. |

⚠️ `target_detail` 이 본문을 돌려주면 마스킹으로도 못 막는다(시크릿 없는 본문은
마스커가 통과시킨다). 어댑터를 쓰는 쪽이 아니라 **어댑터가** 이 계약을 진다.
같은 이유로 `scan_summary` 는 `line_preview` 를 **SELECT 하지 않는다** — 컬럼을 안
읽는 것이 그 약속의 이행이다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True, slots=True)
class LeadAdapter:
    """도메인 하나의 리드 배관.

    domain: 리드 task_type 의 접두어이자 `ctx.metadata["lead_domain"]` 값.
    inspect_agent: `delegate_inspect` 가 spawn 할 `agents/<name>.md` 이름.
    statuses: `set_target_status` 가 받는 닫힌 상태 집합.
    queue_label: 프롬프트/오류 메시지에 쓰는 사람이 읽을 큐 이름.
    """

    domain: str
    inspect_agent: str
    statuses: tuple[str, ...]
    queue_label: str
    list_targets: Callable[..., list[dict[str, Any]]]
    target_detail: Callable[[int], dict[str, Any] | None]
    # ★ required 다(기본값 없음). 새 도메인이 눈 없이 조용히 출시되면 리드가 또
    #   목록만 보고 판단하게 된다 — 그게 v3.98 이전의 실패 양상이었다.
    #   볼 게 없는 큐는 `{"source": "none", "note": …}` 를 **명시적으로** 돌려준다.
    scan_summary: Callable[..., dict[str, Any]]
    # 닫힌 동사 실행기. required — 못 하는 동사는 `lead_verbs.unsupported(...)` 로
    # **명시적 미지원**을 돌려준다(조용한 no-op 금지). 계약은 `_shared/lead_verbs.py`.
    run_verb: Callable[..., dict[str, Any]]
    delegate_input: Callable[[int, str | None], dict[str, Any]]
    set_status: Callable[..., dict[str, Any]]
    # ★ 이 큐에서 "아직 볼 게 남은" 상태들. required — 기본값을 두면 안 된다.
    #
    #   2026-08-26 실측으로 데인 자리다. 러너가 `status="pending"` 하나로 통일해서
    #   물었는데, smb 의 판정대기는 `walked`/`listing_reviewed` 라 리드가 **영원히
    #   idle** 이었다. 큐에 일이 있는데 "깨끗함" 으로 읽힌 것이다.
    #
    # ⚠️ 이건 claim 술어의 **근사치**다. 실제 claim 은 상태만 보지 않는다:
    #     dev_web/github   pending OR (tasked/skipped/error AND last_task_at 오래됨)
    #     confluence       cycle_key=현재주차 AND cycle_scanned_at IS NULL
    #     → 즉 종결처럼 보이는 상태도 **주기가 돌면 다시 열린다**(confluence 는 25건이
    #       전부 skipped 인데 평면 레인이 하루 255번 돌았다).
    #   그래서 주기 재개형 큐에서는 이 목록이 거의 전 상태가 되고, probe 는 사실상
    #   "테이블이 비었나" 만 걸러낸다. 그게 맞는 동작이다 — 무엇이 지금 due 인지는
    #   리드가 `list_targets` 로 보고 판단한다. 비용 통제는 probe 가 아니라 **간격**이다.
    #
    #   틀리는 방향도 다르다: 좁게 잡으면 리드가 할 일을 건너뛰고(조용히 나쁘다),
    #   넓게 잡으면 LLM 런 한 번을 헛돈다(시끄럽고 안전하다). 넓게 잡아라.
    claimable_statuses: tuple[str, ...]


_ADAPTERS: dict[str, LeadAdapter] = {}


def register_lead_adapter(adapter: LeadAdapter) -> None:
    """도메인 어댑터 등록 (멱등 — 같은 이름 재등록은 덮어쓰기가 아니라 no-op).

    `plugin/bootstrap.py` 의 `_register_idempotent` 와 같은 시맨틱이라, 플러그인
    이중 로드가 있어도 조용히 다른 객체로 바뀌지 않는다.
    """
    if adapter.domain in _ADAPTERS:
        return
    _ADAPTERS[adapter.domain] = adapter


def unregister_lead_adapter(domain: str) -> bool:
    return _ADAPTERS.pop(domain, None) is not None


def get_lead_adapter(domain: str) -> LeadAdapter | None:
    return _ADAPTERS.get(domain)


def lead_adapter_names() -> tuple[str, ...]:
    return tuple(sorted(_ADAPTERS))
