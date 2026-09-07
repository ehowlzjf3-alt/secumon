"""Knox 방 설정 + 인가 게이트.

Knox 는 점검 대상이 아니라 **에이전트를 조작하는 control 채널**(웹 채팅과 동격).
그래서 인가 게이트는 "누가 에이전트를 조작할 수 있나" 하나뿐 — 발신자 singleID allowlist.
(charter_ref 는 점검 *활동* 인가 개념이라 control 채널 게이트가 아니다. 실제 점검을 돌릴 때
헌트 도구/DEFAULT_CHARTER_REF 가 처리한다. 여기선 선택적 감사 태그로만 둘 수 있다.)

config/knox_rooms.yaml (SA_KNOX_ROOMS_PATH 로 override). 두 가지 허용 방식:

1) 전역 allowlist (방 무관) — 지정한 singleID 는 어느 방에서 보내든 조작 가능.

    allowed_singleids: ["shaneee.baek"]
    default_agent_type: "agent"
    default_approval_mode: "ask"
    # default_charter_ref: "CHG-..."   # (선택) 감사 태그

2) 방별 세부 설정 — chatroomId 마다 agent_type/허용자/승인모드 지정(더 엄격).

    rooms:
      "205186313073722368":
        agent_type: "agent"
        allowed_singleids: ["shaneee.baek"]
        approval_mode: "ask"
        # charter_ref: "CHG-..."        # (선택) 감사 태그

어느 게이트든 실패하면 authorize 가 None 을 돌려주고, 브릿지는 **아무 응답도 보내지
않는다(silent)**. 방별 설정이 있으면 그게 우선(전역보다 엄격하게 잠글 수 있음).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from secu_agent.knox.client import KnoxMessage

DEFAULT_APPROVAL_MODE = "ask"
DEFAULT_AGENT_TYPE = "agent"


@dataclass(slots=True)
class RoomConfig:
    chatroom_id: str
    charter_ref: str
    agent_type: str
    allowed_singleids: set[str] = field(default_factory=set)
    approval_mode: str = DEFAULT_APPROVAL_MODE


@dataclass(slots=True)
class KnoxConfig:
    rooms: dict[str, RoomConfig] = field(default_factory=dict)
    # 전역 허용 singleID — 방 미설정이어도 이 사람들은 default_charter 로 구동.
    allowed_singleids: set[str] = field(default_factory=set)
    default_charter_ref: str = ""
    default_agent_type: str = DEFAULT_AGENT_TYPE
    default_approval_mode: str = DEFAULT_APPROVAL_MODE

    def is_empty(self) -> bool:
        """허용된 게 아무것도 없으면 True(브릿지가 실행 거부)."""
        return not (self.rooms or self.allowed_singleids)


def _rooms_path(path: str | Path | None) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get("SA_KNOX_ROOMS_PATH")
    if env:
        return Path(env)
    # repo_root/config/knox_rooms.yaml — config.py → knox → secu_agent → src → root
    root = Path(__file__).resolve().parents[3]
    return root / "config" / "knox_rooms.yaml"


def load_config(path: str | Path | None = None) -> KnoxConfig:
    """방 설정 로드. 파일 없으면 빈 KnoxConfig(=모든 메시지 무응답)."""
    p = _rooms_path(path)
    if not p.exists():
        return KnoxConfig()
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    rooms_raw = raw.get("rooms") or {}
    rooms: dict[str, RoomConfig] = {}
    for cid, cfg in rooms_raw.items():
        cfg = cfg or {}
        rooms[str(cid)] = RoomConfig(
            chatroom_id=str(cid),
            charter_ref=str(cfg.get("charter_ref") or ""),
            agent_type=str(cfg.get("agent_type") or "agent"),
            allowed_singleids={str(s) for s in (cfg.get("allowed_singleids") or [])},
            approval_mode=str(cfg.get("approval_mode") or DEFAULT_APPROVAL_MODE),
        )
    return KnoxConfig(
        rooms=rooms,
        allowed_singleids={str(s) for s in (raw.get("allowed_singleids") or [])},
        default_charter_ref=str(raw.get("default_charter_ref") or ""),
        default_agent_type=str(raw.get("default_agent_type") or DEFAULT_AGENT_TYPE),
        default_approval_mode=str(
            raw.get("default_approval_mode") or DEFAULT_APPROVAL_MODE),
    )


def authorize(
    msg: KnoxMessage,
    config: KnoxConfig,
    *,
    own_singleid: str | None = None,
) -> RoomConfig | None:
    """조작 허용된 메시지면 RoomConfig, 아니면 None(=무응답).

    게이트(charter 는 게이트 아님 — 선택적 감사 태그):
      1. 자기 자신(봇)이 보낸 메시지가 아님
      2. 발신자 singleID 가 있음
      3a. 방별 설정이 있으면: 그 방 allowed_singleids 통과
      3b. 방별 설정이 없으면: 전역 allowed_singleids 통과
          (default_agent_type/default_approval_mode/default_charter_ref 로 RoomConfig 합성)
    """
    sender = msg.sender_singleid
    if own_singleid and sender == own_singleid:
        return None
    if not sender:
        return None

    room = config.rooms.get(msg.chatroom_id)
    if room is not None:
        if sender not in room.allowed_singleids:
            return None
        return room

    # 방 미설정 → 전역 allowlist 로 허용.
    if sender in config.allowed_singleids:
        return RoomConfig(
            chatroom_id=msg.chatroom_id,
            charter_ref=config.default_charter_ref,
            agent_type=config.default_agent_type,
            allowed_singleids={sender},
            approval_mode=config.default_approval_mode,
        )
    return None
