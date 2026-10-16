"""Serve the card and register it as dashboard resource (like HACS does)."""

from __future__ import annotations

import logging
from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import CARD_URL, FRONTEND_URL, VERSION

_LOGGER = logging.getLogger(__name__)
FOLDER = Path(__file__).parent / "frontend"


class FrontendView(HomeAssistantView):
    """Serves the card and its language files.

    "Cache-Control: no-cache" makes browsers and the companion app check for a
    newer file on every load (a cheap 304 if unchanged), so updates show up
    after a normal reload instead of needing a cache reset.
    """

    url = FRONTEND_URL + "/{path:.+}"
    name = "sleek_school_schedule:frontend"
    requires_auth = False  # loaded by the browser as a module, like /local files

    def __init__(self, files: dict[str, Path]) -> None:
        self._files = files

    async def get(self, request: web.Request, path: str) -> web.StreamResponse:
        file = self._files.get(path)
        if file is None:
            raise web.HTTPNotFound()
        return web.FileResponse(file, headers={"Cache-Control": "no-cache"})


def _list_files() -> dict[str, Path]:
    """Only these files are served (no directory access)."""
    files = [FOLDER / "sleek-school-schedule-card.js", *sorted((FOLDER / "i18n").glob("*.json"))]
    return {f.relative_to(FOLDER).as_posix(): f for f in files}


async def async_register_view(hass: HomeAssistant) -> None:
    files = await hass.async_add_executor_job(_list_files)
    hass.http.register_view(FrontendView(files))


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
