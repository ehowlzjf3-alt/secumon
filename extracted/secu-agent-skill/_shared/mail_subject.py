"""조치요청 메일 **제목 조립** — 4도메인 한 벌.

## 순서 (사용자 결정 2026-09-01)

    [보안취약점 조치요청](SMB00080) 공유폴더 접근권한 관리 (12.23.37.227)
    └─ 라벨 ────────────┘└ 티켓 ┘ └─ 무엇을 해야 하나 ─┘ └─ 대상 ─┘

대상(IP·저장소·스페이스·호스트)이 **맨 뒤**로 간다. 받는 사람이 제목에서 먼저 봐야 하는
것은 "무엇을 해야 하나" 이고, 어느 장비인지는 그 다음이다. 메일함 목록에서 제목이 잘릴 때
앞부분이 살아남는다.

예전 순서는 `[라벨](대상) 설명` 이었다 — 태그가 곧 라벨+대상이라 자연히 그렇게 됐다.

## ⚠️ 태그는 그대로 둔다

`subject_tag`(`[라벨](대상)`)는 **회신 매칭 2차 키**이고 스레드에 저장돼 있다. 조립 순서를
바꾼다고 저장값을 바꾸면 이미 나간 메일의 답장이 미아가 된다. 여기서는 **제목을 짤 때만**
라벨과 대상을 분리해 배치한다.

수신 쪽(`mail_inbound.classify_subject_tag_from_subject`)은 두 형태를 **모두** 읽는다 —
옛 메일(`[라벨](대상) …`)의 답장이 아직 오고 있기 때문이다.
"""
from __future__ import annotations

import re

#: `[라벨](대상)` → 라벨과 대상으로 가른다. 대상에 괄호가 들어가는 일은 없다(IP·repo·space·host).
_TAG_RE = re.compile(r"^\s*(\[[^\]]+\])\s*\(([^)]*)\)\s*$")


def split_tag(subject_tag: str) -> tuple[str, str]:
    """`[라벨](대상)` → `("[라벨]", "대상")`. 형태가 다르면 `(원문, "")`."""
    m = _TAG_RE.match(str(subject_tag or ""))
    if not m:
        return str(subject_tag or "").strip(), ""
    return m.group(1), m.group(2).strip()


def compose_subject(subject_tag: str, description: str) -> str:
    """제목을 짠다 — **대상은 맨 뒤**.

    대상을 못 가르면(형태가 다르면) 예전처럼 태그를 그대로 앞에 둔다. 제목을 못 만드는
    것보다 낫고, 티켓 번호는 어차피 라벨 뒤에 찍힌다.
    """
    head, src = split_tag(subject_tag)
    desc = str(description or "").strip()
    if not src:
        return f"{head} {desc}".strip()
    return f"{head} {desc} ({src})".strip()


#: 호칭 접미. 이름에 이미 붙어 있으면 또 붙이지 않는다.
_HONORIFICS = ("님", "귀하", "선생님", "책임님", "수석님", "프로님")


def address_name(owner_name: str) -> str:
    """수신자 호칭 — `김명규` → `김명규님`, `김명규님` → `김명규님`.

    ## 왜 (2026-09-01 실기동)

    실제로 나간 회신에 **`김명규님님,`** 이 찍혔다. 본문 조립기 네 곳이 전부
    `f"{name}님,"` 로 무조건 붙이는데, 이름 자체가 담당자 조회에서 `김명규님` 으로
    올 수 있다(또는 사람이 그렇게 넣는다).

    ⚠️ 문구는 사람이 읽는 것이다. 이런 건 테스트가 아니라 **나간 메일**에서 드러난다.
    """
    name = str(owner_name or "").strip()
    if not name:
        return "담당자님"
    return name if name.endswith(_HONORIFICS) else f"{name}님"
