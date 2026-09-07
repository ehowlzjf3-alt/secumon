"""v3.81 T2: Knox Mail delivery sink — 첫 코어 sink (KEEP 채널).

transport = `knox/owner_mail.py` 의 Knox Mail MCP (JSON-RPC 2.0 over SSE,
`knox_send_email`). v3.82 U3a 에서 전송부가 web 레이어에서 knox/ 로 이동
— agent 레이어가 web 레이어를 역참조하던 의존 역전 해소.

Knox 메신저(채팅, knox/client.py 데몬 HTTP)와는 별개 채널이다.

게이트는 코어 `agent/delivery.py` 소유 — 이 어댑터는 redacted payload 를
받아 전송만 한다 (perimeter 는 deliver(), 어댑터 신뢰 불요).
"""
from __future__ import annotations

import asyncio
from typing import Any

from secu_agent.agent.delivery import DeliveryError, DeliveryPayload


class KnoxMailSink:
    sink_id = "knox_mail"
    description = "Knox Mail MCP (사내 메일 — SA_KNOX_MAIL_MCP_URL)"

    async def send(self, payload: DeliveryPayload) -> str:
        from secu_agent.knox.owner_mail import (
            OwnerMailError, _sender, send_owner_mail,
        )
        meta: dict[str, Any] = dict(payload.metadata or {})
        try:
            result = await asyncio.to_thread(
                send_owner_mail,
                sender=_sender(),
                recipients=list(payload.recipients),
                subject=payload.subject,
                content=payload.body,
                cc=list(payload.cc),
                content_type=str(meta.get("content_type") or "HTML"),
                doc_secu_type=str(meta.get("doc_secu_type") or "OFFICIAL"),
            )
        except OwnerMailError as e:
            raise DeliveryError(f"knox_mail 발송 실패: {e}") from e
        to = result.get("to") or list(payload.recipients)
        return f"knox_mail 발송 완료 — to {len(to)}명"
