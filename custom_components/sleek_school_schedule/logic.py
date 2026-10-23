"""Pure timetable logic (no Home Assistant imports, tested by tests/test_logic.py).

A plan looks like this (all times "HH:MM", weekdays 0 = Monday ... 6 = Sunday):

    {
        "slots": [{"id": "s1", "type": "lesson", "start": "08:00", "end": "08:45"}, ...],
        "school_days": [0, 1, 2, 3, 4],
        "days": {"0": {"s1": "Maths", ...}, ...},          # subject per weekday and slot
        "afternoon": {"0": [{"name": "Care", "start": "13:00", "end": "16:00"}], ...},
    }
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .const import (
    ALL_DAYS,
    DEFAULT_SCHOOL_DAYS,
    ENTRY_AFTERNOON,
    ENTRY_BREAK,
    ENTRY_FREE,
    ENTRY_LESSON,
    SLOT_BREAK,
    SLOT_LESSON,
)

# ---------------------------------------------------------------------------
# Plan data
# ---------------------------------------------------------------------------


def default_plan() -> dict:
    """Typical time grid as a starting point for a new child."""
    grid = [
        (SLOT_LESSON, "08:00", "08:45"),
        (SLOT_LESSON, "08:45", "09:30"),
        (SLOT_BREAK, "09:30", "09:45"),
        (SLOT_LESSON, "09:45", "10:30"),
        (SLOT_LESSON, "10:30", "11:15"),
        (SLOT_BREAK, "11:15", "11:30"),
        (SLOT_LESSON, "11:30", "12:15"),
        (SLOT_LESSON, "12:15", "13:00"),
    ]
    slots = [
        {"id": f"s{i}", "type": slot_type, "start": start, "end": end}
        for i, (slot_type, start, end) in enumerate(grid, start=1)
    ]
    return normalize_plan({"slots": slots})


def normalize_plan(plan: dict) -> dict:
    """Fill in missing parts (in place) so the rest of the code can rely on the shape.

    Plans saved before version 2.3 have no "school_days" and only Monday to Friday.
    """
    plan.setdefault("slots", [])
    plan.setdefault("school_days", list(DEFAULT_SCHOOL_DAYS))
    days = plan.setdefault("days", {})
    afternoon = plan.setdefault("afternoon", {})
    for day in ALL_DAYS:
        days.setdefault(str(day), {})
        afternoon.setdefault(str(day), [])
    return plan


def to_min(value: str) -> int:
    """'08:45' -> 525 (minutes since midnight)."""
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def fmt_min(minutes: int) -> str:
    """525 -> '08:45'."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# ---------------------------------------------------------------------------
# One day
# ---------------------------------------------------------------------------


@dataclass
class Entry:
    """A time span on one day.

    name is the subject or activity; empty for breaks and free periods
    (the sensors show a translated word for those, based on the type).
    """

    name: str
    type: str
    number: int | None  # lesson number, counted by start time; None for breaks and afternoon
    start: int  # minutes since midnight
    end: int


@dataclass
class DayInfo:
    entries: list[Entry]  # sorted by time; breaks and free periods only between the first and last lesson
    lesson_end: int | None  # end of the last lesson (None if there are only afternoon entries)
    last: int  # end of the day including the afternoon (pickup time)


def day_info(plan: dict, weekday: int) -> DayInfo | None:
    """Schedule of a weekday (0 = Monday), or None if there is nothing on that day."""
    if weekday not in plan.get("school_days", DEFAULT_SCHOOL_DAYS):
        return None
    key = str(weekday)
    subjects = plan.get("days", {}).get(key, {})
    slots = sorted(plan.get("slots", []), key=lambda s: to_min(s["start"]))

    def subject(slot: dict) -> str:
        return (subjects.get(slot["id"]) or "").strip()

    lessons = [s for s in slots if s["type"] == SLOT_LESSON and subject(s)]
    afternoon = [
        a
        for a in plan.get("afternoon", {}).get(key, [])
        if (a.get("name") or "").strip() and to_min(a["start"]) < to_min(a["end"])
    ]
    if not lessons and not afternoon:
        return None

    lesson_numbers = {
        s["id"]: number
        for number, s in enumerate((s for s in slots if s["type"] == SLOT_LESSON), start=1)
    }

    entries: list[Entry] = []
    lesson_end = None
    if lessons:
        lesson_start = min(to_min(s["start"]) for s in lessons)
        lesson_end = max(to_min(s["end"]) for s in lessons)
        for slot in slots:
            start, end = to_min(slot["start"]), to_min(slot["end"])
            # Breaks and empty lessons only count between the first and last lesson
            inside = lesson_start <= start and end <= lesson_end
            if slot["type"] == SLOT_BREAK:
                if inside:
                    entries.append(Entry("", ENTRY_BREAK, None, start, end))
            elif subject(slot):
                entries.append(Entry(subject(slot), ENTRY_LESSON, lesson_numbers[slot["id"]], start, end))
            elif inside:
                entries.append(Entry("", ENTRY_FREE, lesson_numbers[slot["id"]], start, end))

    for a in afternoon:
        entries.append(Entry(a["name"].strip(), ENTRY_AFTERNOON, None, to_min(a["start"]), to_min(a["end"])))

    entries.sort(key=lambda e: (e.start, e.end))
    return DayInfo(entries=entries, lesson_end=lesson_end, last=max(e.end for e in entries))


# ---------------------------------------------------------------------------
# State at a point in time
# ---------------------------------------------------------------------------


@dataclass
class Status:
    current: Entry | None = None
    next: Entry | None = None  # later today only
    lesson_end: datetime | None = None
    pickup: datetime | None = None


def status(plan: dict, now: datetime) -> Status:
    """State at a point in time (now must be local and timezone-aware)."""
    info = day_info(plan, now.weekday())
    if info is None:
        return Status()

    minute = now.hour * 60 + now.minute
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return Status(
        current=next((e for e in info.entries if e.start <= minute < e.end), None),
        # breaks and free periods are never "next"
        next=next(
            (e for e in info.entries if e.type not in (ENTRY_BREAK, ENTRY_FREE) and e.start > minute),
            None,
        ),
        lesson_end=None if info.lesson_end is None else midnight + timedelta(minutes=info.lesson_end),
        pickup=midnight + timedelta(minutes=info.last),
    )


def next_change(plan: dict, now: datetime) -> datetime:
    """The next moment the status can change: start or end of an entry today, otherwise midnight.

    The sensors are recalculated exactly then instead of every minute.
    """
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    minute = now.hour * 60 + now.minute
    info = day_info(plan, now.weekday())
    boundaries = sorted({b for e in info.entries for b in (e.start, e.end)}) if info else []
    upcoming = next((b for b in boundaries if b > minute), None)
    if upcoming is not None:
        return midnight + timedelta(minutes=upcoming)
    return midnight + timedelta(days=1)
