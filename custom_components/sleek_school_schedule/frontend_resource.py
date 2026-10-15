"""Serve the card and register it as dashboard resource (like HACS does)."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import CARD_URL, FRONTEND_URL, VERSION

_LOGGER = logging.getLogger(__name__)


async def async_register_static(hass: HomeAssistant) -> None:
    """Serves the frontend folder (card + language files) under FRONTEND_URL."""
    from homeassistant.components.http import StaticPathConfig

    folder = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths([StaticPathConfig(FRONTEND_URL, str(folder), False)])


def _resources(hass: HomeAssistant):
    lovelace = hass.data.get("lovelace")
    if lovelace is None:
        return None
    if hasattr(lovelace, "resources"):  # HA 2025.2+
        return lovelace.resources
    if isinstance(lovelace, dict):  # older versions
        return lovelace.get("resources")
    return None


async def _load(resources) -> None:
    if not getattr(resources, "loaded", True):
        await resources.async_load()
        resources.loaded = True


def _base(url) -> str:
    return str(url or "").split("?")[0]


async def async_ensure_resource(hass: HomeAssistant) -> bool:
    """Adds the resource or updates its version. False = not possible (YAML mode)."""
    resources = _resources(hass)
    if resources is None or not hasattr(resources, "async_create_item"):
        return False

    url = f"{CARD_URL}?v={VERSION}"
    await _load(resources)

    for item in resources.async_items():
        if _base(item.get("url")) == CARD_URL:
            if item["url"] != url:
                await resources.async_update_item(item["id"], {"res_type": "module", "url": url})
                _LOGGER.info("Timetable card resource updated to %s", url)
            return True

    await resources.async_create_item({"res_type": "module", "url": url})
    _LOGGER.info("Timetable card resource %s added", url)
    return True


async def async_remove_resource(hass: HomeAssistant) -> None:
    resources = _resources(hass)
    if resources is None or not hasattr(resources, "async_delete_item"):
        return
    await _load(resources)
    for item in list(resources.async_items()):
        if _base(item.get("url")) == CARD_URL:
            await resources.async_delete_item(item["id"])
