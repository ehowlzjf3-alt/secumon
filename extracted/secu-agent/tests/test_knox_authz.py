"""Knox 설정 로드 + authorize 게이트 (방/charter/singleID/self → 무응답)."""
from __future__ import annotations

import textwrap

from secu_agent.knox.client import KnoxMessage
from secu_agent.knox.config import KnoxConfig, RoomConfig, authorize, load_config


def _room_cfg() -> KnoxConfig:
    return KnoxConfig(rooms={
        "room-A": RoomConfig(
            chatroom_id="room-A", charter_ref="CHG-1", agent_type="smb",
            allowed_singleids={"shaneee.baek"}, approval_mode="ask",
        ),
    })


def _global_cfg() -> KnoxConfig:
    return KnoxConfig(
        allowed_singleids={"shaneee.baek"},
        default_agent_type="agent",
        default_approval_mode="ask",
    )


def _msg(chatroom_id="room-A", single="shaneee.baek") -> KnoxMessage:
    return KnoxMessage.from_raw({
        "chatroomId": chatroom_id, "msgid": 1, "text": "hi",
        "sender_profile": {"singleID": single},
    })


# ------------------------------- 방별 설정 ----------------------------------
def test_authorize_allows_room_member():
    room = authorize(_msg(), _room_cfg(), own_singleid="th-bot")
    assert room is not None and room.charter_ref == "CHG-1"


def test_authorize_disallowed_sender_in_configured_room_is_silent():
    assert authorize(_msg(single="someone.else"), _room_cfg(), own_singleid="th-bot") is None


def test_authorize_self_message_is_skipped():
    assert authorize(_msg(single="th-bot"), _room_cfg(), own_singleid="th-bot") is None


def test_authorize_missing_singleid_is_silent():
    m = KnoxMessage.from_raw({"chatroomId": "room-A", "msgid": 2, "text": "x"})
    assert authorize(m, _room_cfg(), own_singleid="th-bot") is None


def test_authorize_room_without_charter_still_allows():
    # charter 는 control 채널 게이트가 아니다(점검 레벨에서 처리) — 조작 허용자면 통과.
    cfg = KnoxConfig(rooms={
        "room-A": RoomConfig("room-A", "", "smb", {"shaneee.baek"}),
    })
    assert authorize(_msg(), cfg, own_singleid="th-bot") is not None


# ------------------------------- 전역 allowlist ------------------------------
def test_global_allows_listed_user_in_any_room():
    room = authorize(_msg(chatroom_id="any-room"), _global_cfg(), own_singleid="th-bot")
    assert room is not None
    assert room.agent_type == "agent"
    assert room.chatroom_id == "any-room"


def test_global_silent_for_unlisted_user():
    assert authorize(_msg(single="intruder"), _global_cfg(), own_singleid="th-bot") is None


def test_global_allows_without_charter():
    # charter 없이도 조작 허용자면 통과(charter 는 선택적 감사 태그).
    cfg = KnoxConfig(allowed_singleids={"shaneee.baek"})
    assert authorize(_msg(), cfg, own_singleid="th-bot") is not None


def test_empty_config_is_silent():
    assert authorize(_msg(), KnoxConfig(), own_singleid="th-bot") is None


def test_room_config_overrides_global():
    # 방별 설정이 있으면 그 방 규칙이 우선 — 전역 허용자라도 방 규칙에 없으면 막힘.
    cfg = KnoxConfig(
        rooms={"room-A": RoomConfig("room-A", "CHG-1", "smb", {"only.this.guy"})},
        allowed_singleids={"shaneee.baek"},
    )
    assert authorize(_msg(single="shaneee.baek"), cfg, own_singleid="th-bot") is None


# ------------------------------- yaml 로드 -----------------------------------
def test_load_config_global_form(tmp_path):
    p = tmp_path / "knox_rooms.yaml"
    p.write_text(textwrap.dedent("""
        allowed_singleids: ["shaneee.baek"]
        default_agent_type: "agent"
        default_approval_mode: "ask"
    """), encoding="utf-8")
    cfg = load_config(p)
    assert cfg.allowed_singleids == {"shaneee.baek"}
    assert cfg.default_agent_type == "agent"
    assert not cfg.is_empty()


def test_load_config_room_form(tmp_path):
    p = tmp_path / "knox_rooms.yaml"
    p.write_text(textwrap.dedent("""
        rooms:
          "205186313073722368":
            charter_ref: "CHG-2026-0042"
            agent_type: "smb"
            allowed_singleids: ["shaneee.baek", "cw871126.lee"]
    """), encoding="utf-8")
    cfg = load_config(p)
    a = cfg.rooms["205186313073722368"]
    assert a.agent_type == "smb"
    assert a.allowed_singleids == {"shaneee.baek", "cw871126.lee"}
    assert a.approval_mode == "ask"


def test_load_config_missing_file_is_empty(tmp_path):
    cfg = load_config(tmp_path / "nope.yaml")
    assert cfg.is_empty()
