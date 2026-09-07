"""asset identity/discovery 헬퍼 — 엔진 finding_taxonomy.py 에서 이동 (v3.82 U3b).

소비자(domain_reports projection)와 함께 도메인 서비스 소유로 이동.
host_of 는 코어 finding_taxonomy 의 generic 헬퍼를 그대로 사용.
"""
from __future__ import annotations

from urllib.parse import urlparse

from secu_agent.finding_taxonomy import host_of  # noqa: F401 — 재export(구 사용처 호환)

def discovery_method(asset: str) -> str:
    """finding 의 발견 방식 — http(s) URL=SSO 브라우저, `<svc>:` prefix=API 토큰 스캔."""
    raw = str(asset or "").strip().lower()
    if raw.startswith(("http://", "https://")):
        return "sso"
    head = raw.split("/", 1)[0]
    if ":" in head:  # github:/confluence:/jenkins:/smb: …
        return "api"
    return ""


_GH_DROP_SEGS = {"raw", "blob", "tree", "refs", "heads", "-"}


def github_identity(asset: str) -> str | None:
    """github 자산을 API/SSO 폼 공통 식별자(`org/repo::파일명`)로 정규화 — 교차확인 dedup 용.

    `github:org/repo/path/file` (API) ↔ `https://github.samsungds.net/raw/org/repo/main/path/file`
    (SSO) → 둘 다 `org/repo::file`. branch/raw/blob 등 중간 세그먼트는 무시. github 아니면 None.
    """
    raw = str(asset or "").strip().lower()
    if raw.startswith("github:"):
        segs = [s for s in raw[len("github:"):].split("/") if s]
    elif raw.startswith(("http://", "https://")):
        host = (urlparse(raw).hostname or "")
        if "github" not in host:
            return None
        segs = [s for s in urlparse(raw).path.split("/") if s and s not in _GH_DROP_SEGS]
    else:
        return None
    if len(segs) < 2:
        return None
    org, repo = segs[0], segs[1]
    tail = segs[-1] if len(segs) > 2 else ""
    return f"{org}/{repo}" + (f"::{tail}" if tail else "")


def confluence_identity(asset: str) -> str | None:
    """confluence 자산을 API/SSO 폼 공통 식별자(bare 소문자 space key)로 정규화 — 교차확인 dedup 용.

    - API: `confluence:SPACE:pageid…`(v3.76 enrich) → `space`(소문자).
    - SSO: `https://confluence…/display/SPACE/Page` 또는 `…/spaces/KEY/…` → `space`(소문자).
    - space 없는 legacy `confluence:42`(CQL/page_ids 폴백) → None.
    - 비-confluence → None.

    반환값은 bare 소문자 space key — dedup(slice2)이 `confluence_identity(asset) or space_key`
    로 폴백한다. (github_identity 의 confluence 대응.)
    """
    raw = str(asset or "").strip()
    low = raw.lower()
    if low.startswith("confluence:"):
        rest = raw[len("confluence:"):]
        # confluence:SPACE:pageid[/comment/..] — 첫 세그먼트가 space key.
        head = rest.split("/", 1)[0]
        if ":" in head:
            space = head.split(":", 1)[0].strip()
            return space.lower() if space else None
        return None  # legacy confluence:42 (space 없음)
    if low.startswith(("http://", "https://")):
        host = (urlparse(raw).hostname or "").lower()
        if "confluence" not in host and "wiki" not in host:
            return None
        segs = [s for s in urlparse(raw).path.split("/") if s]
        # /display/SPACE/Page  또는  /spaces/KEY/...  → 마커 다음 세그먼트가 space.
        for i, seg in enumerate(segs):
            if seg.lower() in {"display", "spaces"} and i + 1 < len(segs):
                return segs[i + 1].lower()
        return None
    return None




def canonicalize_by_asset(task_type: str, asset: str) -> str | None:
    """구 코어 canonical_task_type 휴리스틱 — register_task_type_canonicalizer 대상.

    github/confluence/jenkins 가 host 또는 `<svc>:` prefix 로 드러나면 그 도메인,
    아니면 None(불변 — 코어 passthrough). SMB(`smb://...`)/일반 web 호스트는 매칭 안 됨.
    v3.74 'devops' umbrella 해체분: 모델이 'devops' 로 적었거나 레거시 row 인 경우
    자산기준으로 교정한다.
    """
    raw = str(asset or "").lower()
    host = host_of(asset)
    if "github" in host or raw.startswith("github:"):
        return "github"
    if "confluence" in host or "wiki" in host or raw.startswith("confluence:"):
        return "confluence"
    if "jenkins" in host or raw.startswith("jenkins:"):
        return "jenkins"
    return None
