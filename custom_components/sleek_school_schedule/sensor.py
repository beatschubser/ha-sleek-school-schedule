"""Sensors: current lesson, next lesson, end of lessons, pickup time."""

from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_change
from homeassistant.util import dt as dt_util

from .const import DOMAIN, ENTRY_BREAK, ENTRY_FREE, ENTRY_NONE, SIGNAL_UPDATED, VERSION
from .logic import Entry, Status, status


def _fmt(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities(
        [
            CurrentSensor(entry),
            NextSensor(entry),
            LessonEndSensor(entry),
            PickupSensor(entry),
        ]
    )


class _Base(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    key = ""

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_{self.key}"
        self._attr_translation_key = self.key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Sleek School Schedule",
            model="Timetable",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
        )
        self._status: Status | None = None

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_track_time_change(self.hass, self._tick, second=0))
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_UPDATED.format(self._entry.entry_id), self._refresh
            )
        )
        self._recalc()

    @callback
    def _tick(self, _now: datetime) -> None:
        self._refresh()

    @callback
    def _refresh(self) -> None:
        self._recalc()
        self.async_write_ha_state()

    @callback
    def _recalc(self) -> None:
        store = self.hass.data[DOMAIN]
        self._status = status(store.get(self._entry.entry_id), dt_util.now())
        self._update()

    def _text(self, entry: Entry | None) -> str:
        """Subject name, or a translated word for breaks, free periods and 'nothing'."""
        words = self.hass.data[DOMAIN].strings.get("sensor", {})
        if entry is None:
            return words.get("none", "none")
        if entry.type == ENTRY_BREAK:
            return words.get("break", "Break")
        if entry.type == ENTRY_FREE:
            return words.get("free_period", "Free period")
        return entry.name

    @staticmethod
    def _attrs(entry: Entry | None) -> dict:
        # Attribute names and the type value are language independent (for automations)
        if entry is None:
            return {"type": ENTRY_NONE}
        return {
            "type": entry.type,
            "lesson": entry.number,
            "start": _fmt(entry.start),
            "end": _fmt(entry.end),
        }

    def _update(self) -> None:
        raise NotImplementedError


class CurrentSensor(_Base):
    key = "current"
    _attr_icon = "mdi:school"

    def _update(self) -> None:
        cur = self._status.current
        self._attr_native_value = self._text(cur)
        self._attr_extra_state_attributes = self._attrs(cur)


class NextSensor(_Base):
    key = "next"
    _attr_icon = "mdi:skip-next"

    def _update(self) -> None:
        nxt = self._status.next
        self._attr_native_value = self._text(nxt)
        attrs = self._attrs(nxt)
        if nxt:
            start = dt_util.start_of_local_day() + timedelta(minutes=nxt.start)
            attrs["starts_at"] = start.isoformat()
        self._attr_extra_state_attributes = attrs


class LessonEndSensor(_Base):
    key = "lesson_end"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:bell-ring"

    def _update(self) -> None:
        self._attr_native_value = self._status.lesson_end


class PickupSensor(_Base):
    key = "pickup"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:car-child-seat"

    def _update(self) -> None:
        self._attr_native_value = self._status.pickup
