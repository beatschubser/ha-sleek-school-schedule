"""Storage of all timetables in .storage/sleek_school_schedule, keyed by config entry id."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.util.hass_dict import HassKey

from .const import DOMAIN, SIGNAL_CHANGED, SIGNAL_PLAN_UPDATED, STORAGE_KEY, STORAGE_VERSION
from .logic import default_plan, normalize_plan

DATA_STORE: HassKey[PlanStore] = HassKey(f"{DOMAIN}_store")


class PlanStore:
    """Loads all plans once at startup; every save is written to disk immediately."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._plans: dict[str, dict] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self._plans = {entry_id: normalize_plan(plan) for entry_id, plan in data.get("plans", {}).items()}

    def get(self, entry_id: str) -> dict:
        """Plan of a child; a new child gets the default time grid."""
        if entry_id not in self._plans:
            self._plans[entry_id] = default_plan()
            self._store.async_delay_save(self._data, 1)
        return self._plans[entry_id]

    async def async_set(self, entry_id: str, plan: dict) -> None:
        """Save a validated plan and notify sensors and cards."""
        self._plans[entry_id] = plan
        await self._store.async_save(self._data())
        async_dispatcher_send(self.hass, SIGNAL_PLAN_UPDATED.format(entry_id))
        async_dispatcher_send(self.hass, SIGNAL_CHANGED, entry_id)

    async def async_remove(self, entry_id: str) -> None:
        if self._plans.pop(entry_id, None) is not None:
            await self._store.async_save(self._data())

    def _data(self) -> dict:
        return {"plans": self._plans}
