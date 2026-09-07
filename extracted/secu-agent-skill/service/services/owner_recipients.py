"""담당자 수신자 해석 — 키 목록·사내 판정·파싱·DSSOC 기본값의 단일 출처.

## 왜 모았나

같은 개념이 네 층에 복사돼 있었고 **이미 갈라져 있었다**(실측 2026-08-24):

| 대상 | 사본 | 상태 |
|---|---|---|
| `_is_internal_owner_email` | 4 (scanner·reporter·github/routes·confluence/api) | 내용 동일 |
| `_owner_recipient_list` | 4 | **두 판본으로 갈림** ↓ |
| `_iter_recipient_values` | 3 | 내용 동일 |
| `_csv` | 6 | 내용 동일 |
| 담당자 키 목록 | 2 (github 17 · confluence 16, 공통 8) | 도메인별로 정당하게 다름 |
| `dssoc@samsung.com` | 10곳 하드코딩 | — |

★ `_owner_recipient_list` 의 갈림이 실제 버그였다:
  application(scanner·reporter) 은 `_iter_recipient_values` 로 **dict·중첩까지 재귀**하고,
  webapp(routes·api) 은 list/tuple/set **한 겹만** 펼쳐 dict 를 못 봤다.
  수신자 값이 `{"email": ...}` 이면 메일은 나가는데 운영자 화면엔 "수신자 없음" 으로 보인다.
  ⚠️ 방향을 주의하라. 재귀 판본이 "더 본다" 가 아니다 — dict 에서 **아는 키 8개만** 보고
  나머지를 버린다. 실제로는 `{"primary": "a@…"}` 를 메일 경로가 놓치고 화면이 건졌다.
  → 정본은 **합집합**이다(iter_recipient_values 주석의 표 참조).

## 키 목록은 합치지 않는다 — 나란히 둔다

도메인 고유 키는 정당하게 고유하다(github 이 `page_owner_email` 을 뒤질 이유가 없다).
합치면 오히려 틀린다. 대신 `COMMON + 도메인별` 로 한 파일에 두어 **갈라진 게 보이게** 한다.
지금까지는 700줄 떨어진 두 함수라 대조가 불가능했고, 그래서 github 신 스캐너가
`author_email` 쓰기를 멈춘 걸 아무도 못 알아챘다.

⚠️ 생산자(스캐너·제출 도구)가 키 이름을 바꾸면 **여기도 같이 고쳐라.** 한쪽만 고치면
런타임 검증이 없어 조용히 담당자 0건이 된다.
"""
from __future__ import annotations

import os
import re
from email.utils import getaddresses
from typing import Any

#: 사내 메일 도메인. 이것과 서브도메인만 담당자로 인정한다.
INTERNAL_MAIL_DOMAIN = "samsung.com"

#: 담당자로 취급하지 않는 local part — 발송 대상이지 책임자가 아니다.
#: ⚠️ 여기 넣는 것은 "담당자 아님" 이지 "발송 금지" 가 아니다. 둘을 섞지 마라.
NON_OWNER_LOCALPARTS = ("dssoc",)

#: DSSOC 기본 수신자. 10곳에 흩어져 있던 리터럴의 단일 출처.
DSSOC_DEFAULT = "dssoc@samsung.com"

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")

# dict 안에서 주소가 들어 있을 만한 자리. 값이 중첩 구조로 오는 경우가 있다.
_NESTED_KEYS = ("email", "mail", "address", "recipient", "recipients",
                "owner_email", "owner_emails")

# ── 담당자 키 목록 ────────────────────────────────────────────────────────────
#: 4도메인 공통.
COMMON_KEYS: tuple[str, ...] = (
    "recipient", "recipients",
    "owner_email", "owner_emails",
    "maintainer_email", "maintainer_emails",
    "contact_email", "contact_emails",
)

#: github 전용. `suppress_emails` 는 **담당자 목록이 아니다** — 탐지기가 커밋 작성자
#: 본인 메일을 유출 hit 으로 잡지 않게 드랍하는 목록이다(service_task_tools.py:989).
#: 이름이 정반대로 읽히지만, 신 스캐너 경로에서 사실상 유일한 메일 채널이라 남긴다.
GITHUB_KEYS: tuple[str, ...] = COMMON_KEYS + (
    "repo_owner_email", "repo_owner_emails",
    "security_owner_email", "security_owner_emails",
    "author_email", "committer_email", "commit_author_email",
    "last_commit_author_email",
    "suppress_emails",
)

#: confluence 전용 — 글/페이지 작성자 계열.
#: ⚠️ 2026-08-24 현재 **생산자가 이 키들을 하나도 쓰지 않는다**(스캐너 미배선).
#: 읽는 쪽만 있는 상태다 — 스캐너가 작성자를 넣기 전까지 confluence 담당자는 항상 빈다.
CONFLUENCE_KEYS: tuple[str, ...] = COMMON_KEYS + (
    "space_owner_email", "space_owner_emails",
    "page_owner_email", "page_owner_emails",
    "creator_email", "created_by_email",
    "last_modified_by_email", "last_editor_email",
)

DOMAIN_KEYS: dict[str, tuple[str, ...]] = {
    "github": GITHUB_KEYS,
    "confluence": CONFLUENCE_KEYS,
}


# ── 파싱 ──────────────────────────────────────────────────────────────────────
def csv(value: str | None) -> list[str]:
    """콤마 구분 문자열 → 항목. 빈 항목은 버린다."""
    return [p.strip() for p in str(value or "").split(",") if p.strip()]


def iter_recipient_values(value: Any) -> list[str]:
    """중첩 구조(dict/list/tuple/set)를 평평하게 편다.

    ★ dict 처리가 두 판본이 갈렸던 자리다. 실측(2026-08-24):

    | 입력 | application(메일) | webapp(화면) |
    |---|---|---|
    | `{"email": "a@…"}` | `['a@…']` | `['a@…']` |
    | `{"primary": "a@…", "backup": "c@…"}` | **`[]`** | `['a@…','c@…']` |
    | `{"owner": {"email": "a@…"}}` | **`[]`** | `['a@…']` |

    application 판본은 아는 키 8개만 보고 **나머지를 조용히 버렸다** — "더 깊이 본다" 가
    아니라 그 반대다. 그래서 실제 위험은 "화면엔 담당자가 보이는데 메일이 안 나간다" 였다.
    (다행히 라이브 `owner_recipient` 는 전부 평문 문자열이라 아직 안 터졌다.)

    → 정본은 **합집합**이다. 아는 키를 먼저 보고, 거기서 아무것도 못 얻으면 **모든 값**을
    훑는다. 어느 판본이 보던 것도 잃지 않는다.
    ⚠️ 순서가 중요하다. 아는 키를 먼저 보는 이유는 그 키들이 "여기에 주소가 있다" 는
    명시적 신호라, 같은 dict 안의 다른 주소(발신자·억제 목록 등)보다 우선해야 하기 때문이다.
    """
    if value is None:
        return []
    if isinstance(value, dict):
        out: list[str] = []
        for key in _NESTED_KEYS:
            out.extend(iter_recipient_values(value.get(key)))
        if out:
            return out
        for nested in value.values():
            out.extend(iter_recipient_values(nested))
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for item in value:
            out.extend(iter_recipient_values(item))
        return out
    return [str(value)]


def is_internal(address: str) -> bool:
    """사내 메일 주소인가. **우리 팀함은 담당자가 아니므로 제외한다.**

    ★ 예전엔 `NON_OWNER_LOCALPARTS`(=`("dssoc",)`) 리터럴만 봤다. 팀함 주소를 env 로 바꾸면
      그 주소가 **담당자로 통과한다** — 그러면 `delivery_targets` 가 mode="normal" 로
      To=팀함, Cc=팀함 을 돌려주고, "실발송 중에 DSSOC 에게만" 이라는 금지 상태가
      정상 경로로 만들어진다. 같은 드리프트를 오늘만 두 번 더 고쳤다
      (`state_domain._service_owner_recipient_hint`, 게이트웨이 `domains.is_dssoc`).
    리터럴은 백스톱으로 남긴다 — env 가 안 붙은 배포에서도 동작이 그대로여야 한다.
    """
    email = str(address or "").strip().lower()
    if not email or "@" not in email:
        return False
    local, _, domain = email.partition("@")
    if local in NON_OWNER_LOCALPARTS or is_dssoc(email):
        return False
    return domain == INTERNAL_MAIL_DOMAIN or domain.endswith(f".{INTERNAL_MAIL_DOMAIN}")


def recipient_list(values: Any) -> list[str]:
    """임의 구조 → 중복 없는 사내 담당자 주소 목록(입력 순서 유지).

    `Name <a@b>` 형태와 본문에 박힌 주소를 둘 다 건진다.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in iter_recipient_values(values):
        candidates = [addr for _name, addr in getaddresses([raw]) if addr]
        candidates.extend(_EMAIL_RE.findall(raw))
        for candidate in candidates:
            email = candidate.strip().lower()
            if not is_internal(email) or email in seen:
                continue
            seen.add(email)
            out.append(email)
    return out


def from_extra(extra: dict[str, Any] | None, keys: tuple[str, ...]) -> list[str]:
    """finding 의 extra_json(+ 그 안의 metadata)에서 담당자 주소를 긁는다."""
    data = extra or {}
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    values: list[Any] = []
    for source in (data, metadata):
        for key in keys:
            values.append(source.get(key))
    return recipient_list(values)


def dssoc_recipients(*env_names: str) -> list[str]:
    """DSSOC 수신자 — env 를 순서대로 보고, 없으면 기본값.

    도메인마다 env 이름이 다르므로(GITHUB_/CONFLUENCE_/DEV_WEB_…) 이름만 받는다.
    """
    for name in env_names:
        found = csv(os.environ.get(name))
        if found:
            return found
    return [DSSOC_DEFAULT]


# ── 발송 수신처 ───────────────────────────────────────────────────────────────
#: 엔진의 자율발송 opt-in. 비어 있으면 **전부 dry-run** 이다(delivery.py:239).
AUTOSEND_SINKS_ENV = "SA_DELIVERY_AUTOSEND_SINKS"

#: `<도메인>_REMEDIATION_MAIL_MODE` 가 "담당자에게 보내라" 로 인정하는 값들.
_NORMAL_MODES = frozenset({"normal", "owner", "production", "prod"})



class DeliveryPolicyError(RuntimeError):
    """수신처 설정이 발송 상태와 모순 — 사람이 풀어야 한다."""


def autosend_enabled() -> bool:
    """자율발송이 하나라도 켜져 있는가 = **dry-run 이 아닐 수 있다**.

    sink 단위가 아니라 존재 여부로 본다. 수신처를 정하는 시점엔 어느 sink 로 갈지
    확정되지 않는데, 여기서 틀리면 담당자가 통보를 못 받는다 — **담당자를 포함하는
    쪽으로** 보수적으로 판단한다.
    """
    return bool(csv(os.environ.get(AUTOSEND_SINKS_ENV)))


#: 자동 **최초 발송**(조치요청)을 여는 스위치. 기본 꺼짐 — fail-closed.
#: ⚠️ 회신·재검증은 이 스위치와 무관하다(그쪽은 `remediation_mail.reply_targets` 를 쓴다).
INITIAL_AUTOSEND_ENV = "SA_INITIAL_REPORT_AUTOSEND"


def initial_autosend_enabled() -> bool:
    """자동 최초 발송이 열려 있는가. 기본 **닫힘**."""
    raw = str(os.environ.get(INITIAL_AUTOSEND_ENV) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def delivery_targets(
    owner_recipients: Any, *, mode_env: str, dssoc_env_names: tuple[str, ...],
    manual: bool = False,
) -> dict[str, Any]:
    """조치요청 메일 수신처. 4도메인이 같은 규칙을 쓰게 모은다.

    ## 정책 (사용자 결정 2026-08-24)

        메일은 **담당자 + DSSOC(자기 자신)** 에게 간다.
        DSSOC 에게만 보내는 것은 **드라이런 때뿐**이다.

    ## 왜 모았나 — 두 스위치가 따로 놀았다

    발송 여부는 엔진(`SA_DELIVERY_AUTOSEND_SINKS`)이, 수신처 모양은 스킬
    (`<도메인>_REMEDIATION_MAIL_MODE`, 기본 `dssoc_only`)이 각각 정했고 **둘을 잇는 게
    없었다.** 그래서 sink 를 opt-in 해 실발송이 켜져도 모드가 기본값이면 **진짜 메일이
    DSSOC 에게만** 갔다 — 화면엔 "통보 완료" 로 남고 담당자는 못 듣는다.

    ★ 모순 상태에서는 **예외를 던진다.** 조용히 담당자를 넣으면 실발송 중에 의도치 않게
      실제 사람에게 메일이 가고, 그대로 두면 담당자가 영영 못 듣는다. 둘 다 위험하므로
      추측하지 않고 멈춘다.

    반환 `mode`:
        "normal"    담당자 + DSSOC — 정상
        "no_owner"  담당자를 못 찾아 DSSOC 로만 — **정책이 아니라 사고다**
        "dry_run"   자율발송 꺼짐 — 어차피 안 나가므로 DSSOC 로만

    ⚠️ **"실발송 중인데 DSSOC 로만" 이라는 상태는 없다.** 한때 `staged`(도메인별로 실발송을
    미룬다)를 넣었다가 뺐다 — 그건 정책이 금지한 상태를 정책으로 허용하는 것이고, 지금은
    파이프라인을 드라이런으로만 올리는 단계라 필요하지도 않다. 도메인별 롤아웃이 실제로
    필요해지면 그때 **발송 여부**(자율발송)를 도메인별로 나누는 게 맞지, 수신처를 비트는 게
    아니다.
    """
    owners = recipient_list(owner_recipients or [])
    dssoc = dssoc_recipients(*dssoc_env_names)
    raw = (os.environ.get(mode_env) or "").strip().lower()
    wants_normal = raw in _NORMAL_MODES

    # ★ 최초 발송 게이트 (사용자 결정 2026-08-31)
    #
    #     수동 발송   → 실제 담당자에게 (사람이 승인했다)
    #     회신·재검증 → 모두에게 열림   (여기를 안 지나간다 — reply_targets 를 쓴다)
    #     최초 발송   → **닫힘**
    #
    # ⚠️ 위치가 중요하다. 처음엔 이 검사를 함수 **맨 앞**에 뒀는데, 그러면 아래의
    #    `DeliveryPolicyError`(모드와 자율발송이 모순인 상태를 fail-loud 로 잡는 장치)가
    #    영영 안 터진다 — 안전장치를 안전장치로 덮은 것이다(2026-08-31 스위트 10건 실패로
    #    드러났다). 기존 판정을 **먼저 다 하고**, 그 결과를 여기서 좁힌다.
    #
    # ⚠️ 기본이 닫힘이다. 열려면 `SA_INITIAL_REPORT_AUTOSEND` 를 **명시**해야 한다.
    def _apply_initial_gate(decision: dict[str, Any]) -> dict[str, Any]:
        if manual or initial_autosend_enabled():
            return decision
        # 수신처를 **비운다**. DSSOC 도 넣지 않는다 — 요구는 "제작까지만" 이고,
        # 주소가 하나라도 있으면 autosend 가 켜진 순간 실제로 나간다.
        # 빈 목록이면 어느 경로로도 못 나간다(코어가 "TO 수신자가 없습니다" 로 거부).
        return {
            "mode": "initial_closed",
            "recipients": [],
            "cc": [],
            "prior_mode": decision.get("mode"),
            "reason": (
                f"자동 최초 발송이 닫혀 있다({INITIAL_AUTOSEND_ENV} 미설정) — "
                "초안만 만들고 아무에게도 보내지 않는다. "
                "수동 발송(콘솔 승인)은 담당자에게 나간다."
            ),
        }

    if wants_normal and owners:
        return _apply_initial_gate({"mode": "normal", "recipients": owners, "cc": dssoc})
    if not autosend_enabled():
        # 어차피 안 나간다. 담당자를 못 찾았으면 그 사실이 더 중요하다.
        return _apply_initial_gate({
            "mode": "no_owner" if wants_normal else "dry_run",
            "recipients": dssoc, "cc": [],
        })
    if wants_normal:
        # 담당자를 못 찾았다. 보내긴 하되 **사유가 드러나야** 한다 —
        # 정책상 DSSOC 인 것과 담당자 해석 실패는 다른 일이다.
        return _apply_initial_gate({"mode": "no_owner", "recipients": dssoc, "cc": []})
    raise DeliveryPolicyError(
        f"{mode_env}={raw or '(미설정)'} 인데 {AUTOSEND_SINKS_ENV} 로 자율발송이 켜져 있다 — "
        "실발송 중에 DSSOC 에게만 보내면 담당자가 통보를 못 받고 화면엔 통보 완료로 남는다. "
        f"이 도메인도 통보할 것이면 {mode_env}=normal 로 두고, 아직 아니면 "
        f"{AUTOSEND_SINKS_ENV} 를 비워 드라이런으로 두라. "
        "⚠️ 4도메인이 같은 sink 를 쓰므로 다른 도메인 때문에 자율발송이 켜졌을 수 있다."
    )


#: 도메인별 DSSOC env 이름 — "이 주소가 우리 팀함인가" 를 판정할 때 넷을 다 본다.
#: ⚠️ SMB 만 보던 곳이 있었다(`mail_inbound._dssoc_sender_identities`). SMB 만 있던 시절의
#:    목록이 그대로 남은 것인데, 도메인별 팀함을 따로 두면 그 도메인 회신에서 자기 메일을
#:    못 알아본다(담당자 답장으로 오인).
DSSOC_ENV_NAMES: tuple[str, ...] = (
    "SMB_REMEDIATION_DSSOC_RECIPIENT",
    "GITHUB_REMEDIATION_DSSOC_RECIPIENT",
    "CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT",
    "DEV_WEB_REMEDIATION_DSSOC_RECIPIENT",
    "SA_DSSOC_MAIL_RECIPIENT",
)


def dssoc_addresses(extra: Any = ()) -> set[str]:
    """DSSOC 로 인정하는 주소·local part 집합(소문자).

    ★ 이건 **발송 대상 목록이 아니라 신원 판정**이다. `dssoc_recipients()` 와 목적이 반대다 —
    저건 "누구에게 보낼까", 이건 "이 주소가 우리인가". 같은 함수로 만들면 언젠가
    "제외 목록" 과 "발송 목록" 이 뒤바뀐다.

    기본값 리터럴에만 기대지 않는다 — env 로 주소를 바꾸면 판정도 따라가야 한다.
    (`state_domain._service_owner_recipient_hint` 가 env 를 안 봐서, 주소를 바꾸면 팀함이
    **담당자로 잡히던** 자리가 있었다.)
    """
    out: set[str] = {DSSOC_DEFAULT, DSSOC_DEFAULT.split("@", 1)[0]}
    values = list(iter_recipient_values(extra))
    for name in DSSOC_ENV_NAMES:
        values.extend(csv(os.environ.get(name)))
    for raw in values:
        for _n, addr in getaddresses([str(raw)]):
            if not addr:
                continue
            low = addr.strip().lower()
            out.add(low)
            if "@" in low:
                out.add(low.split("@", 1)[0])
    return {x for x in out if x}


def is_dssoc(address: Any, extra: Any = ()) -> bool:
    """이 주소가 우리 팀함인가. 담당자로 취급하면 안 되는 값이다."""
    value = str(address or "").strip().lower()
    if not value:
        return False
    if value in dssoc_addresses(extra):
        return True
    # `이름 <dssoc@…>` 형태도 판정한다.
    for _n, addr in getaddresses([value]):
        if addr and addr.strip().lower() in dssoc_addresses(extra):
            return True
    return False
