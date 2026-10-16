"""Constants for the Sleek School Schedule integration."""

DOMAIN = "sleek_school_schedule"
VERSION = "2.1.0"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

FRONTEND_URL = "/sleek_school_schedule_files"
CARD_URL = f"{FRONTEND_URL}/sleek-school-schedule-card.js"

SIGNAL_UPDATED = "sleek_school_schedule_updated_{}"
SIGNAL_UPDATED_ANY = "sleek_school_schedule_updated"

CONF_NAME = "name"

# Slot types in the time grid
SLOT_LESSON = "lesson"
SLOT_BREAK = "break"
SLOT_TYPES = (SLOT_LESSON, SLOT_BREAK)

# Entry types reported by the sensors (attribute "type")
ENTRY_LESSON = "lesson"
ENTRY_BREAK = "break"
ENTRY_FREE = "free_period"
ENTRY_AFTERNOON = "afternoon"
ENTRY_NONE = "none"

WEEKDAYS = ("0", "1", "2", "3", "4")  # Mon-Fri

LANGUAGES = ("en", "de", "fr", "nl", "es", "it", "pl")
DEFAULT_LANGUAGE = "en"


def default_plan() -> dict:
    """Typical time grid as a starting point."""
    raw = [
        ("lesson", "08:00", "08:45"),
        ("lesson", "08:45", "09:30"),
        ("break", "09:30", "09:45"),
        ("lesson", "09:45", "10:30"),
        ("lesson", "10:30", "11:15"),
        ("break", "11:15", "11:30"),
        ("lesson", "11:30", "12:15"),
        ("lesson", "12:15", "13:00"),
    ]
    return {
        "slots": [
            {"id": f"s{i}", "type": t, "start": s, "end": e}
            for i, (t, s, e) in enumerate(raw, start=1)
        ],
        "days": {d: {} for d in WEEKDAYS},
        "afternoon": {d: [] for d in WEEKDAYS},
    }
