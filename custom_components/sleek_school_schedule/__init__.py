"""Sleek School Schedule: school timetables with a dashboard card and sensors.

Setup overview:
- async_setup (once): load plans and texts, register WebSocket commands,
  serve the card and add it as dashboard resource.
- async_setup_entry (once per child): start the ScheduleTracker and the sensors.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_CORE_CONFIG_UPDATE, Platform
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.typing import ConfigType

from . import frontend_resource, websocket_api
from .const import DOMAIN, SIGNAL_CHANGED, SIGNAL_REFRESH
from .i18n import async_load_strings
from .store import DATA_STORE, PlanStore
from .tracker import ScheduleTracker

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type SleekConfigEntry = ConfigEntry[ScheduleTracker]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    store = PlanStore(hass)
    await store.async_load()
    hass.data[DATA_STORE] = store
    await async_load_strings(hass)

    async def _core_config_updated(_event: Event) -> None:
        # Language or time zone of Home Assistant changed: new texts, recalculate all sensors
        await async_load_strings(hass)
        async_dispatcher_send(hass, SIGNAL_REFRESH)

    hass.bus.async_listen(EVENT_CORE_CONFIG_UPDATE, _core_config_updated)

    websocket_api.async_register(hass)
    if hass.http is not None:
        await frontend_resource.async_register_view(hass)
        async_at_started(hass, frontend_resource.async_register_card)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: SleekConfigEntry) -> bool:
    tracker = ScheduleTracker(hass, hass.data[DATA_STORE], entry.entry_id)
    tracker.async_start()
    entry.runtime_data = tracker
    entry.async_on_unload(tracker.async_stop)
    entry.async_on_unload(entry.add_update_listener(_async_entry_updated))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _notify_cards(hass, entry)  # a new child shows up in open cards without reloading the page
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SleekConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    if store := hass.data.get(DATA_STORE):  # missing if the integration never started
        await store.async_remove(entry.entry_id)
    _notify_cards(hass, entry)
    if not any(e.entry_id != entry.entry_id for e in hass.config_entries.async_entries(DOMAIN)):
        # Last child removed: the dashboard resource is no longer needed
        await frontend_resource.async_remove_resource(hass)


async def _async_entry_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """The child was renamed: update the tabs in open cards."""
    _notify_cards(hass, entry)


@callback
def _notify_cards(hass: HomeAssistant, entry: ConfigEntry) -> None:
    async_dispatcher_send(hass, SIGNAL_CHANGED, entry.entry_id)
