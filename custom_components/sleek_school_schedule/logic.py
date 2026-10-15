"""Pure timetable logic (no Home Assistant dependencies, easy to test)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .const import (
    ENTRY_AFTERNOON,
    ENTRY_BREAK,
    ENTRY_FREE,
    ENTRY_LESSON,
    SLOT_BREAK,
    SLOT_LESSON,
)


def to_min(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


@dataclass
class Entry:
    """A time span on a specific day.

    name is the subject / activity; empty for breaks and free periods
    (the sensor translates those based on the type).
    """

    name: str
    type: str
    number: int | None  # lesson number, counted automatically by start time
    start: int  # minutes since midnight
    end: int


@dataclass
class DayInfo:
    last: int  # end of the day including afternoon
    lesson_end: int | None
    entries: list[Entry]  # including breaks and free periods within lessons


def day_info(plan: dict, weekday: int) -> DayInfo | None:
    """Schedule of a weekday (0 = Monday), or None if there is nothing."""
    if weekday > 4:
        return None
    key = str(weekday)
    day = plan.get("days", {}).get(key, {})
    slots = sorted(plan.get("slots", []), key=lambda s: to_min(s["start"]))

    def text(slot: dict) -> str:
        return (day.get(slot["id"]) or "").strip()

    lessons = [s for s in slots if s["type"] != SLOT_BREAK and text(s)]
    afternoon = [
        e for e in plan.get("afternoon", {}).get(key, [])
        if (e.get("name") or "").strip() and to_min(e["start"]) < to_min(e["end"])
    ]
    if not lessons and not afternoon:
        return None

    number = {
        s["id"]: i
        for i, s in enumerate((s for s in slots if s["type"] == SLOT_LESSON), start=1)
    }

    entries: list[Entry] = []
    lesson_end = None
    if lessons:
        l_first = min(to_min(s["start"]) for s in lessons)
        lesson_end = max(to_min(s["end"]) for s in lessons)
        for slot in slots:
            start, end = to_min(slot["start"]), to_min(slot["end"])
            # Breaks and empty lessons only count between the first and last lesson
            inside = l_first <= start and end <= lesson_end
            if slot["type"] == SLOT_BREAK:
                if inside:
                    entries.append(Entry("", ENTRY_BREAK, None, start, end))
            elif text(slot):
                entries.append(Entry(text(slot), ENTRY_LESSON, number.get(slot["id"]), start, end))
            elif inside:
                entries.append(Entry("", ENTRY_FREE, number.get(slot["id"]), start, end))

    for e in afternoon:
        entries.append(Entry(e["name"].strip(), ENTRY_AFTERNOON, None, to_min(e["start"]), to_min(e["end"])))

    entries.sort(key=lambda e: (e.start, e.end))
    return DayInfo(
        last=max(e.end for e in entries),
        lesson_end=lesson_end,
        entries=entries,
    )


@dataclass
class Status:
    current: Entry | None
    next: Entry | None
    next_date: date | None
    lesson_end: datetime | None
    pickup: datetime | None


def status(plan: dict, now: datetime) -> Status:
    """State at a point in time (now must be local and timezone-aware)."""
    minute = now.hour * 60 + now.minute
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    info = day_info(plan, now.weekday())

    current = None
    lesson_end = pickup = None
    if info:
        lesson_end = midnight + timedelta(minutes=info.lesson_end) if info.lesson_end is not None else None
        pickup = midnight + timedelta(minutes=info.last)
        for entry in info.entries:
            if entry.start <= minute < entry.end:
                current = entry
                break

    nxt, nxt_date = None, None
    for offset in range(0, 8):
        day = now.date() + timedelta(days=offset)
        dinfo = day_info(plan, day.weekday())
        if not dinfo:
            continue
        for entry in dinfo.entries:
            if entry.type in (ENTRY_BREAK, ENTRY_FREE):
                continue
            if offset == 0 and entry.start <= minute:
                continue
            nxt, nxt_date = entry, day
            break
        if nxt:
            break

    return Status(current, nxt, nxt_date, lesson_end, pickup)
