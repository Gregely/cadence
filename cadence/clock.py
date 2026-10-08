"""Single source of time so tests can move the clock."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

_offset = timedelta(0)


def now() -> datetime:
    return datetime.now(timezone.utc) + _offset


def iso(dt: datetime | None = None) -> str:
    dt = dt or now()
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def advance(delta: timedelta) -> None:
    """Test helper: shift the clock forward."""
    global _offset
    _offset += delta


def reset() -> None:
    global _offset
    _offset = timedelta(0)
