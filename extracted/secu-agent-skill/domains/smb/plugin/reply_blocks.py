"""smb 회신 블록.

★ 문구 출처는 `service/services/remediation_mail.py` 의 `build_how_to` 다.
  **복사하지 않았다** — 반대로 `build_how_to` 가 여기 상수를 쓰도록 뒤집었다.
  같은 절차 안내가 두 벌로 갈리면 하나만 고쳐지고 다른 하나가 남는다.

★ 2026-08-31 — 항목을 **한 줄에 하나씩** 낸다(사용자 지시). 그래서 `<ol><li>` 덩어리를
  문장 튜플로 풀었다. 문구 자체는 한 글자도 바꾸지 않았다.
"""
from __future__ import annotations

SMB_HOWTO_WINDOWS_TITLE = "Windows 공유 폴더 권한 변경"
SMB_HOWTO_WINDOWS_STEPS = (
    "해당 폴더 우클릭 → [속성] → [공유] 탭 → [고급 공유] → [권한]",
    "'Everyone' / 'Guest' 항목을 선택해 [제거]",
    "공유 목적에 맞는 계정 또는 그룹만 [추가]하고 권한(읽기/쓰기)을 최소로 설정",
    "[보안] 탭에서도 NTFS 권한의 'Everyone'/과도한 그룹을 제거",
    "익명 접근 차단: 로컬 보안 정책 → '네트워크 액세스: 익명 SID/이름 변환 허용' 사용 안 함",
)

SMB_HOWTO_LINUX_TITLE = "Linux (Samba) 공유 권한 변경"
SMB_HOWTO_LINUX_STEPS = (
    "/etc/samba/smb.conf 에서 해당 [share] 의 guest ok = no, valid users = <계정> 설정",
    "writable / read only 를 업무에 맞게 최소화",
    "파일시스템 권한(chmod/chown)으로 불필요 접근 제거",
    "testparm 로 검증 후 systemctl restart smbd",
)


def _html(title: str, steps: tuple[str, ...]) -> str:
    from _shared.reply_body import numbered_lines

    return numbered_lines(title, steps)


#: `build_how_to` 가 읽는 완성 블록(하위호환 이름).
SMB_HOWTO_WINDOWS = _html(SMB_HOWTO_WINDOWS_TITLE, SMB_HOWTO_WINDOWS_STEPS)
SMB_HOWTO_LINUX = _html(SMB_HOWTO_LINUX_TITLE, SMB_HOWTO_LINUX_STEPS)


def smb_reply_blocks() -> tuple:
    from _shared.reply_body import ReplyBlock

    return (
        ReplyBlock(
            name="smb_howto_windows",
            purpose="Windows 공유 폴더 권한 제거 절차(고급 공유 → Everyone/Guest 제거 → NTFS → 익명 차단). 담당자 서버가 Windows 일 때.",
            html=SMB_HOWTO_WINDOWS,
            domains=("smb",),
        ),
        ReplyBlock(
            name="smb_howto_linux",
            purpose="Linux Samba 공유 권한 제한 절차(smb.conf guest ok=no / valid users → testparm → 재시작). 담당자 서버가 Linux 일 때.",
            html=SMB_HOWTO_LINUX,
            domains=("smb",),
        ),
    )
