"""Texts for sensor values (break, free period, nothing) in the language of Home Assistant.

Uses the same JSON files as the card (frontend/i18n/<lang>.json), so every
language lives in exactly one file.
"""

from __future__ import annotations

import json
from pathlib import Path

from homeassistant.core import HomeAssistant
from homeassistant.util.hass_dict import HassKey

from .const import DEFAULT_LANGUAGE, DOMAIN, LANGUAGES

I18N_DIR = Path(__file__).parent / "frontend" / "i18n"
DATA_STRINGS: HassKey[dict] = HassKey(f"{DOMAIN}_strings")


def pick_language(language: str | None) -> str:
    """'de-CH' -> 'de'; languages without a translation file fall back to English."""
    lang = (language or "").lower().replace("_", "-")
    if lang in LANGUAGES:
        return lang
    base = lang.split("-")[0]
    return base if base in LANGUAGES else DEFAULT_LANGUAGE


def _read(lang: str) -> dict:
    with open(I18N_DIR / f"{lang}.json", encoding="utf-8") as file:
        return json.load(file)


def _deep_update(target: dict, source: dict) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_update(target[key], value)
        else:
            target[key] = value


def _read_merged(lang: str) -> dict:
    strings = _read(DEFAULT_LANGUAGE)
    if lang != DEFAULT_LANGUAGE:
        _deep_update(strings, _read(lang))  # missing keys stay English
    return strings


async def async_load_strings(hass: HomeAssistant) -> None:
    """Load the texts for the current language of Home Assistant into hass.data."""
    hass.data[DATA_STRINGS] = await hass.async_add_executor_job(_read_merged, pick_language(hass.config.language))
