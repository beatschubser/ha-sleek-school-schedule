"""Sleek School Schedule integration for Home Assistant."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_URL,
    DOMAIN,
    SIGNAL_UPDATED,
    SIGNAL_UPDATED_ANY,
    STORAGE_KEY,
    STORAGE_VERSION,
    VERSION,
    default_plan,
)
from . import frontend_resource, websocket_api
from .i18n import async_load_strings

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


class PlanStore:
    """Persists all timetables in .storage/sleek_school_schedule."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.plans: dict[str, dict] = {}
        self.strings: dict = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.plans = data.get("plans", {})

    def get(self, entry_id: str) -> dict:
        if entry_id not in self.plans:
            self.plans[entry_id] = default_plan()
            self._store.async_delay_save(self._data, 1)
        return self.plans[entry_id]

    async def async_set(self, entry_id: str, plan: dict) -> None:
        self.plans[entry_id] = plan  # already a validated copy
        await self._store.async_save(self._data())
        async_dispatcher_send(self.hass, SIGNAL_UPDATED.format(entry_id))
        async_dispatcher_send(self.hass, SIGNAL_UPDATED_ANY, entry_id)

    async def async_remove(self, entry_id: str) -> None:
        if self.plans.pop(entry_id, None) is not None:
            await self._store.async_save(self._data())

    def _data(self) -> dict:
        return {"plans": self.plans}


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    store = PlanStore(hass)
    await store.async_load()
    store.strings = await async_load_strings(hass)
    hass.data[DOMAIN] = store

    websocket_api.async_register(hass)

    if hass.http is not None:
        await frontend_resource.async_register_static(hass)

        async def _register_card(_hass: HomeAssistant) -> None:
            try:
                ok = await frontend_resource.async_ensure_resource(hass)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Could not register the timetable card as dashboard resource")
                ok = False
            if not ok:
                # YAML dashboards: fallback, resource may have to be added manually
                from homeassistant.components.frontend import add_extra_js_url

                add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")
                _LOGGER.warning(
                    "Dashboard resources are not in UI mode. Add '%s' as JavaScript module "
                    "if the timetable card does not load",
                    CARD_URL,
                )

        async_at_started(hass, _register_card)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data[DOMAIN].get(entry.entry_id)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    store: PlanStore | None = hass.data.get(DOMAIN)
    if store:
        await store.async_remove(entry.entry_id)
    # Last child removed: clean up the dashboard resource
    remaining = [e for e in hass.config_entries.async_entries(DOMAIN) if e.entry_id != entry.entry_id]
    if not remaining:
        try:
            await frontend_resource.async_remove_resource(hass)
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Resource could not be removed", exc_info=True)
