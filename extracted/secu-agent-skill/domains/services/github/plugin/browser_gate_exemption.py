"""정책 A(브라우저 검증) 면제 — github **API repo 스캔 레인** 한정.

## 왜 있나 (2026-08-27 실측)

코어 정책 A 는 "대상 호스트를 browser 로 실제 열어본 기록이 있어야 finding 제출 가능"
이다. SSO URL 점검에는 이게 곧 검증이다 — 화면을 열어보면 '권한 없음'인지 진짜 노출인지
바로 갈린다.

그런데 `task_type='github'` 아래에는 성격이 다른 두 레인이 있다:

    github_task_tools()  SSO URL 점검  — github_browse 있음 → 게이트 만족 가능
    github_scan_tools()  repo API 스캔 — **브라우저 도구 없음**(의도적)

스캔 레인에 브라우저를 안 주는 것은 결정이다(`toolsets.py:70`): 무인 워커에 destructive
브라우저를 주면 승인 프롬프트 앞에서 멈춘다. 그래서 스캔 워커는 게이트를 만족시킬 방법이
**원천적으로 없었다.** 게다가 코어 `_host_of` 가 스킴 없는 문자열의 첫 세그먼트를 호스트로
만들어내서, 워커는 존재하지도 않는 호스트를 열라는 요구를 받았다:

    target='DataService/hue-customization' → 게이트: "호스트(dataservice)를 열어봐라"

실측: 08-27 스캔 레인 제출 14건이 **14건 모두** 이걸로 거부됐다. 요구된 호스트 13종은
전부 github 소유자 이름이었다(`sangb-kim`, `jihyun-kang`, `rlm` …). 그리고 워커는 진짜
시크릿을 찾아놓고 "브라우저 검증이 불가능하다"며 스스로 기각하고 종료했다.

## 판단 근거를 어디에 두는가 — 여기가 핵심이다

**자산 문자열로 판단하지 않는다.** "비-URL 이면 면제" 같은 규칙은 워커가
`target="site-a"`, `location="/.env"` 라고 쓰기만 하면 브라우저 없이 통과하는 **일반
우회로**가 된다. 그러면 이 게이트의 존재 이유인 web/dev_web 이 통째로 열린다
(codex 적대검증 2026-08-27 — 첫 설계안이 이 이유로 폐기됐다).

대신 **수집 방식(provenance)** 으로 판단한다. 근거는 둘 다 **코드가 심은 것**이고
에이전트는 건드릴 수 없다:

1. `metadata['_collection_mode'] == 'api_scan'`
   `github_scan_worker` 가 실행 시작 시 `run_agent(extra_metadata=...)` 로 한 번 심는다.
   SSO 레인은 안 심는다 → SSO 는 게이트가 그대로 산다.
2. `metadata['_github_task_scan_status']` 존재
   `GithubTaskScanTool.execute` 가 실제로 API 스캔을 돌린 뒤에만 심는다. "이 실행에서
   진짜로 API 스캔이 있었다" 는 증명 — 브라우저 게이트의 `_web_browser_hosts` 와 같은
   층위의 증거다.

3. finding 이 **그 실행이 클레임한 저장소**를 가리킬 것
   `metadata['github_target']['repo']`(= `owner/repo`) 가 `finding.target` 이나 어느
   `hit.location` 안에 들어 있어야 한다. 이게 없으면 "repo A 를 스캔하고 repo B 의
   finding 을 제출" 하는 것이 면제된다(codex 적대검증). 큐가 워커에게 넘긴 저장소는
   코드가 아는 값이므로, 여기 대조하는 것은 LLM 문자열을 **믿는** 게 아니라 **강제**하는
   것이다.

셋 다여야 면제한다. 하나라도 없으면 provenance 불명이므로 **면제하지 않는다.**

## 이 면제가 증명하지 못하는 것 (정직하게)

"이 실행에서 그 저장소를 API 스캔했다" 까지는 증명하지만 "이 hit 이 그 스캔 결과에서
나왔다" 는 증명하지 못한다. 브라우저 게이트도 똑같은 한계를 갖는다("그 호스트를 열었다"만
증명하고 "이 hit 이 그 화면에서 나왔다" 는 증명 못 한다). 후보 원본과 hit 을 결정론적으로
잇는 것은 별도 과제다(후보→finding 어댑터).

또 `_github_task_scan_status` 는 값이 `error`/`skipped` 여도 심긴다 — "스캔을 시도했다"
까지만 뜻한다. 값으로 좁히지 않은 이유는 실패한 스캔에서도 부분 후보가 나올 수 있고,
그 판정은 워커의 일이기 때문이다.
"""
from __future__ import annotations

from typing import Any

_COLLECTION_MODE_KEY = "_collection_mode"
_API_SCAN_MODE = "api_scan"
_SCAN_RAN_KEY = "_github_task_scan_status"
_TARGET_KEY = "github_target"


def _claimed_repo(metadata: dict) -> str:
    target = metadata.get(_TARGET_KEY)
    if not isinstance(target, dict):
        return ""
    return str(target.get("repo") or "").strip()


def _finding_mentions(finding: Any, repo: str) -> bool:
    """finding 이 그 저장소를 가리키나 — target 과 hit.location 만 본다(summary 제외)."""
    needle = repo.lower()
    if needle in str(getattr(finding, "target", "") or "").lower():
        return True
    for hit in (getattr(finding, "hits", None) or []):
        if needle in str(getattr(hit, "location", "") or "").lower():
            return True
    return False


def github_api_scan_exempt(finding: Any, context: Any) -> bool:
    """github API repo 스캔 레인이면 브라우저 게이트 면제. 그 외 전부 False."""
    if str(getattr(finding, "task_type", "") or "") != "github":
        return False
    metadata = getattr(context, "metadata", None) or {}
    if not isinstance(metadata, dict):
        return False
    if str(metadata.get(_COLLECTION_MODE_KEY) or "") != _API_SCAN_MODE:
        return False
    if _SCAN_RAN_KEY not in metadata:
        return False
    repo = _claimed_repo(metadata)
    if not repo:
        return False
    return _finding_mentions(finding, repo)
