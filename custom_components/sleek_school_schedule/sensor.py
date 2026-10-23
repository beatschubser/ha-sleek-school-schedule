"""Sensors per child: current lesson, next lesson, end of lessons, pickup time."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorEntityDescription
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import SleekConfigEntry
from .const import DOMAIN, ENTRY_BREAK, ENTRY_FREE, ENTRY_NONE, VERSION
from .i18n import DATA_STRINGS
from .logic import Entry, Status, fmt_min


def entry_attributes(entry: Entry | None) -> dict[str, Any]:
    """Attribute names and the type value are English, independent of the language (for automations)."""
    if entry is None:
        return {"type": ENTRY_NONE}
    return {"type": entry.type, "lesson": entry.number, "start": fmt_min(entry.start), "end": fmt_min(entry.end)}


def next_attributes(entry: Entry | None) -> dict[str, Any]:
    attrs = entry_attributes(entry)
    if entry is not None:
        attrs["starts_at"] = (dt_util.start_of_local_day() + timedelta(minutes=entry.start)).isoformat()
    return attrs


@dataclass(frozen=True, kw_only=True)
class TimetableSensorDescription(SensorEntityDescription):
    entry_fn: Callable[[Status], Entry | None] | None = None  # sensors that show an entry (subject)
    attributes_fn: Callable[[Entry | None], dict[str, Any]] | None = None
    time_fn: Callable[[Status], datetime | None] | None = None  # timestamp sensors


SENSORS = (
    TimetableSensorDescription(
        key="current",
        translation_key="current",
        icon="mdi:school",
        entry_fn=lambda s: s.current,
        attributes_fn=entry_attributes,
    ),
    TimetableSensorDescription(
        key="next",
        translation_key="next",
        icon="mdi:skip-next",
        entry_fn=lambda s: s.next,
        attributes_fn=next_attributes,
    ),
    TimetableSensorDescription(
        key="lesson_end",
        translation_key="lesson_end",
        icon="mdi:bell-ring",
        device_class=SensorDeviceClass.TIMESTAMP,
        time_fn=lambda s: s.lesson_end,
    ),
    TimetableSensorDescription(
        key="pickup",
        translation_key="pickup",
        icon="mdi:car-child-seat",
        device_class=SensorDeviceClass.TIMESTAMP,
        time_fn=lambda s: s.pickup,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: SleekConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities(TimetableSensor(entry, description) for description in SENSORS)


class TimetableSensor(SensorEntity):
    """Reads the status from the child's ScheduleTracker; updated whenever the tracker recalculates."""

    entity_description: TimetableSensorDescription
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry: SleekConfigEntry, description: TimetableSensorDescription) -> None:
        self.entity_description = description
        self._tracker = entry.runtime_data
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Sleek School Schedule",
            model="Timetable",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._tracker.async_add_listener(self._handle_update))

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()

    @property
    def native_value(self) -> str | datetime | None:
        description = self.entity_description
        if description.time_fn:
            return description.time_fn(self._tracker.status)
        return self._text(description.entry_fn(self._tracker.status))

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        description = self.entity_description
        if description.attributes_fn is None:
            return None
        return description.attributes_fn(description.entry_fn(self._tracker.status))

    def _text(self, entry: Entry | None) -> str:
        """Subject name, or a translated word for breaks, free periods and 'nothing'."""
        words = self.hass.data[DATA_STRINGS].get("sensor", {})
        if entry is None:
            return words.get("none", "Free")
        if entry.type == ENTRY_BREAK:
            return words.get("break", "Break")
        if entry.type == ENTRY_FREE:
            return words.get("free_period", "Free period")
        return entry.name
