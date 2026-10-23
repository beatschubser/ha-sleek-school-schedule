"""Diagnostics download (Settings > Devices & services > child > three dots), useful for bug reports."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from . import SleekConfigEntry
from .const import VERSION
from .logic import next_change


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: SleekConfigEntry) -> dict[str, Any]:
    tracker = entry.runtime_data
    now = dt_util.now()
    return {
        "version": VERSION,
        "now": now.isoformat(),
        "time_zone": hass.config.time_zone,
        "plan": tracker.plan,
        "status": asdict(tracker.status),
        "next_change": next_change(tracker.plan, now).isoformat(),
    }
