"""Tests for the timetable logic (no Home Assistant needed).

Run: python3 tests/test_logic.py   (or with pytest)
"""

import importlib.util
import sys
import types
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent.parent / "custom_components" / "sleek_school_schedule"

# Load const.py and logic.py as a package without importing Home Assistant
_pkg = types.ModuleType("sss")
_pkg.__path__ = [str(BASE)]
sys.modules["sss"] = _pkg


def _load(name):
    spec = importlib.util.spec_from_file_location(f"sss.{name}", BASE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"sss.{name}"] = module
    spec.loader.exec_module(module)
    return module


const = _load("const")
logic = _load("logic")
TZ = ZoneInfo("Europe/Berlin")


def at(day: int, hour: int, minute: int) -> datetime:
    """day: 0 = Monday 12 Oct 2026."""
    return datetime(2026, 10, 12 + day, hour, minute, tzinfo=TZ)


def sample_plan() -> dict:
    plan = const.default_plan()  # s1..s8: 8:00, 8:45, break 9:30, 9:45, 10:30, break 11:15, 11:30, 12:15
    plan["days"]["3"] = {"s1": "Maths", "s4": "Art", "s7": "Sport"}  # Thursday
    plan["afternoon"]["3"] = [
        {"name": "Care", "start": "13:00", "end": "16:00"},
        {"name": "Basketball", "start": "16:00", "end": "17:15"},
    ]
    plan["afternoon"]["4"] = [{"name": "Care", "start": "13:00", "end": "15:00"}]  # Friday, no lessons
    return plan


def test_current_lesson_with_number():
    s = logic.status(sample_plan(), at(3, 8, 10))
    assert (s.current.name, s.current.type, s.current.number) == ("Maths", "lesson", 1)
    assert s.next.name == "Art" and s.next.number == 3


def test_break_between_lessons():
    s = logic.status(sample_plan(), at(3, 9, 35))
    assert s.current.type == "break" and s.current.name == ""


def test_empty_lesson_inside_day_is_free_period():
    s = logic.status(sample_plan(), at(3, 10, 40))
    assert s.current.type == "free_period" and s.current.number == 4
    assert s.next.name == "Sport"  # free periods and breaks are never "next"


def test_gap_before_afternoon_is_nothing():
    s = logic.status(sample_plan(), at(3, 12, 30))
    assert s.current is None
    assert s.next.name == "Care"


def test_afternoon_entries_and_pickup():
    s = logic.status(sample_plan(), at(3, 16, 30))
    assert s.current.name == "Basketball" and s.current.type == "afternoon"
    assert s.pickup.strftime("%H:%M") == "17:15"
    assert s.lesson_end.strftime("%H:%M") == "12:15"


def test_day_with_afternoon_only():
    s = logic.status(sample_plan(), at(4, 13, 30))
    assert s.current.name == "Care"
    assert s.lesson_end is None
    assert s.pickup.strftime("%H:%M") == "15:00"


def test_next_lesson_on_following_week():
    s = logic.status(sample_plan(), at(4, 18, 0))  # Friday evening
    assert s.current is None
    assert s.next.name == "Maths" and s.next_date.isoformat() == "2026-10-22"


def test_weekend_and_empty_plan():
    assert logic.status(sample_plan(), at(5, 10, 0)).current is None
    empty = logic.status(const.default_plan(), at(0, 9, 0))
    assert empty.current is None and empty.next is None and empty.pickup is None


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"{len(tests)} tests passed")
