"""LLMClient ABC. 구현은 internal_gateway.py 등 어댑터가 채움."""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from secu_agent.agent.llm.types import LLMRequest, StreamEvent


class LLMClient(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]: ...
