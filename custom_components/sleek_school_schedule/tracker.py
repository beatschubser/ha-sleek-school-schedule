"""Keeps the current status of one timetable up to date."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from homeassistant.core import CALLBACK_TYPE, HassJob, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_point_in_time
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_PLAN_UPDATED, SIGNAL_REFRESH
from .logic import Status, next_change, status
from .store import PlanStore


class ScheduleTracker:
    """Current status of one child's timetable, shared by its sensors.

    Instead of recalculating every minute, the tracker works out when the status
    can change next (start or end of an entry, or midnight) and wakes up exactly then.
    It also recalculates when the plan is saved or the time zone or language changes.
    """

    def __init__(self, hass: HomeAssistant, store: PlanStore, entry_id: str) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.status = Status()
        self._store = store
        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[CALLBACK_TYPE] = []
        self._unsub_timer: CALLBACK_TYPE | None = None
        self._job = HassJob(self.async_refresh, f"{DOMAIN} {entry_id}", cancel_on_shutdown=True)

    @property
    def plan(self) -> dict:
        return self._store.get(self.entry_id)

    @callback
    def async_start(self) -> None:
        self._unsubs = [
            async_dispatcher_connect(self.hass, SIGNAL_PLAN_UPDATED.format(self.entry_id), self.async_refresh),
            async_dispatcher_connect(self.hass, SIGNAL_REFRESH, self.async_refresh),
        ]
        self.async_refresh()

    @callback
    def async_stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs = []
        self._cancel_timer()

    @callback
    def async_add_listener(self, update: Callable[[], None]) -> CALLBACK_TYPE:
        """Call update() after every recalculation; returns a function to remove the listener."""
        self._listeners.append(update)

        @callback
        def remove() -> None:
            self._listeners.remove(update)

        return remove

    @callback
    def async_refresh(self, _now: datetime | None = None) -> None:
        now = dt_util.now()
        plan = self.plan
        self.status = status(plan, now)
        self._cancel_timer()
        self._unsub_timer = async_track_point_in_time(self.hass, self._job, next_change(plan, now))
        for update in list(self._listeners):
            update()

    @callback
    def _cancel_timer(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
