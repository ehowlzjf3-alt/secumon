"""github 회신 블록.

⚠️ 문구를 **새로 쓰지 않았다.** 아래는 지금 실제로 발송되는 조치요청 메일의
   "■ 조치 방법" 문장 그대로다(`domains/services/github/application/scanner.py`).
   같은 사안에 대해 최초 메일과 회신이 다른 말을 하면 담당자가 혼란스럽다.

   드리프트는 `service/tests/test_reply_blocks_no_drift.py` 가 잡는다 —
   리포트 본문이 바뀌면 그 테스트가 실패하고 여기도 같이 고치게 된다.
"""
from __future__ import annotations

GITHUB_REMEDIATION_STEPS = (
    "노출된 토큰, 키, 비밀번호는 먼저 폐기 또는 재발급해 주세요.",
    "현재 HEAD에 남은 값은 저장소에서 제거하고 secret manager 또는 환경변수로 이동해 주세요.",
    "history-only 항목은 토큰 회전 후 필요 시 git history 정리 또는 저장소 접근 제한을 검토해 주세요.",
    "같은 값이 sibling repo, Jenkinsfile, GitHub Actions workflow, 배포 스크립트에 재사용되었는지 확인해 주세요.",
    "조치 후 본 메일 또는 시스템에서 재검증을 요청해 주세요. DS보안관제에서 HEAD 기준으로 다시 확인하겠습니다.",
)


def github_reply_blocks() -> tuple:
    from _shared.reply_body import ReplyBlock, numbered_lines

    return (
        ReplyBlock(
            name="github_remediation_steps",
            purpose="시크릿 조치 절차 5단계(폐기·재발급 → HEAD 제거 → history → 재사용 확인 → 재검증). 담당자가 '어떻게 조치하나요' 를 물을 때.",
            # 한 줄에 하나씩 — 사용자 지시(2026-08-31).
            html=numbered_lines("조치 방법", GITHUB_REMEDIATION_STEPS),
            domains=("github",),
            # 마지막 단계가 "조치 후 본 메일 또는 시스템에서 재검증을 요청해 주세요" 다 —
            # 껍데기가 회신요청을 또 붙이면 같은 부탁이 두 번 나간다.
            includes_reply_request=True,
        ),
    )
