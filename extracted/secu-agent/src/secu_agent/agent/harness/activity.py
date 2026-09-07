"""Backend harness activity tracking.

The web chat route already has a UI-facing inactivity watchdog. This module is
for non-web runs (CLI, scheduler, eval) so the harness can distinguish a quiet
but healthy stream from a run that stopped producing observable progress.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable


@dataclass(frozen=True, slots=True)
class ActivitySnapshot:
    last_event: str
    seconds_since_activity: float
    event_counts: dict[str, int]


@dataclass(slots=True)
class AgentActivityTracker:
    clock: Callable[[], float] = time.monotonic
    started_at: float = field(init=False)
    last_activity_at: float = field(init=False)
    last_event: str = field(default="agent_start", init=False)
    event_counts: dict[str, int] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        now = self.clock()
        self.started_at = now
        self.last_activity_at = now

    def touch(self, event_name: str) -> None:
        self.last_event = event_name
        self.last_activity_at = self.clock()
        self.event_counts[event_name] = self.event_counts.get(event_name, 0) + 1

    def idle_seconds(self) -> float:
        return max(0.0, self.clock() - self.last_activity_at)

    def snapshot(self) -> ActivitySnapshot:
        return ActivitySnapshot(
            last_event=self.last_event,
            seconds_since_activity=self.idle_seconds(),
            event_counts=dict(self.event_counts),
        )

    def summary(self) -> dict[str, object]:
        snap = self.snapshot()
        return {
            "last_event": snap.last_event,
            "seconds_since_activity": snap.seconds_since_activity,
            "event_counts": snap.event_counts,
        }
