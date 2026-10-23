"""Constants for the Sleek School Schedule integration."""

DOMAIN = "sleek_school_schedule"
VERSION = "2.3.0"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

FRONTEND_URL = "/sleek_school_schedule_files"
CARD_URL = f"{FRONTEND_URL}/sleek-school-schedule-card.js"

# Dispatcher signals
SIGNAL_PLAN_UPDATED = "sleek_school_schedule_plan_updated_{}"  # one timetable was saved (format with entry_id)
SIGNAL_CHANGED = "sleek_school_schedule_changed"  # any timetable or child changed (for the cards)
SIGNAL_REFRESH = "sleek_school_schedule_refresh"  # language or time zone of Home Assistant changed

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

# Weekdays as used in the plan: 0 = Monday ... 6 = Sunday (keys of "days" and "afternoon" are strings)
ALL_DAYS = tuple(range(7))
DEFAULT_SCHOOL_DAYS = (0, 1, 2, 3, 4)  # Monday to Friday

LANGUAGES = ("en", "de", "fr", "nl", "es", "it", "pl")
DEFAULT_LANGUAGE = "en"

