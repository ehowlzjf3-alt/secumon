"""confluence 회신 블록.

⚠️ 문구 출처는 실제 발송 본문의 "■ 조치 방법" 이다
   (`domains/services/confluence/application/reporter.py`). 지어낸 절차가 아니다.
"""
from __future__ import annotations

CONFLUENCE_REMEDIATION_STEPS = (
    "페이지와 스페이스의 소유자를 먼저 확인한 뒤 변경해 주세요.",
    "운영 중인 자격증명이나 민감한 값은 승인된 비밀 저장소로 옮겨 주세요.",
    "연결된 페이지, 댓글, 첨부파일, 이전 버전도 함께 점검해 주세요.",
    "스페이스 공개 범위가 업무 목적에 맞는지 확인해 주세요.",
)


def confluence_reply_blocks() -> tuple:
    from _shared.reply_body import ReplyBlock, numbered_lines

    return (
        ReplyBlock(
            name="confluence_remediation_steps",
            purpose="콘텐츠 조치 절차 4단계(소유자 확인 → 비밀 저장소 이동 → 댓글·첨부·이전버전 점검 → 공개범위). 담당자가 조치 방법을 물을 때.",
            # 한 줄에 하나씩 — 사용자 지시(2026-08-31).
            html=numbered_lines("조치 방법", CONFLUENCE_REMEDIATION_STEPS),
            domains=("confluence",),
        ),
    )
