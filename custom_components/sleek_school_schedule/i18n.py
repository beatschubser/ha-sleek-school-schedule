"""Shared translations for sensor values and notifications.

Uses the same JSON files as the card (frontend/i18n/<lang>.json) so every
language lives in exactly one file.
"""

from __future__ import annotations

import json
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import DEFAULT_LANGUAGE, LANGUAGES

I18N_DIR = Path(__file__).parent / "frontend" / "i18n"


def _pick(language: str | None) -> str:
    lang = (language or "").lower().replace("_", "-")
    if lang in LANGUAGES:
        return lang
    base = lang.split("-")[0]
    return base if base in LANGUAGES else DEFAULT_LANGUAGE


def _load(lang: str) -> dict:
    with open(I18N_DIR / f"{lang}.json", encoding="utf-8") as fh:
        return json.load(fh)


async def async_load_strings(hass: HomeAssistant) -> dict:
    """Strings in the system language of Home Assistant, English as fallback."""
    lang = _pick(hass.config.language)

    def _read() -> dict:
        strings = _load(DEFAULT_LANGUAGE)
        if lang != DEFAULT_LANGUAGE:
            _deep_update(strings, _load(lang))
        return strings

    return await hass.async_add_executor_job(_read)


def _deep_update(target: dict, source: dict) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_update(target[key], value)
        else:
            target[key] = value
