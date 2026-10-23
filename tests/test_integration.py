"""Tests with a real Home Assistant (pytest-homeassistant-custom-component), run by the GitHub workflow."""

from __future__ import annotations

import copy
from datetime import datetime

import pytest
from freezegun.api import FrozenDateTimeFactory
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from custom_components.sleek_school_schedule.const import CARD_URL, DOMAIN, STORAGE_KEY, VERSION
from custom_components.sleek_school_schedule.frontend_resource import _resources
from custom_components.sleek_school_schedule.store import DATA_STORE

TZ = "Europe/Berlin"

PLAN = {
    "slots": [
        {"id": "s1", "type": "lesson", "start": "08:00", "end": "08:45"},
        {"id": "s2", "type": "lesson", "start": "08:45", "end": "09:30"},
        {"id": "b1", "type": "break", "start": "09:30", "end": "09:45"},
        {"id": "s3", "type": "lesson", "start": "09:45", "end": "10:30"},
    ],
    "days": {"3": {"s1": "Maths", "s3": "Art"}},  # Thursday; s2 is a free period
    "afternoon": {"3": [{"name": "Care", "start": "13:00", "end": "16:00"}]},
}


def local(text: str) -> datetime:
    """'2026-10-15 08:00' in Berlin time (a Thursday)."""
    return datetime.fromisoformat(text).replace(tzinfo=dt_util.get_time_zone(TZ))


async def move_to(hass: HomeAssistant, freezer: FrozenDateTimeFactory, text: str) -> None:
    freezer.move_to(local(text))
    async_fire_time_changed(hass, local(text))
    await hass.async_block_till_done()


@pytest.fixture
async def entry(hass: HomeAssistant, hass_storage: dict, freezer: FrozenDateTimeFactory) -> MockConfigEntry:
    await hass.config.async_set_time_zone(TZ)
    freezer.move_to(local("2026-10-15 07:00"))
    entry = MockConfigEntry(domain=DOMAIN, title="Emma", data={"name": "Emma"}, unique_id="emma")
    entry.add_to_hass(hass)
    hass_storage[STORAGE_KEY] = {"version": 1, "key": STORAGE_KEY, "data": {"plans": {entry.entry_id: copy.deepcopy(PLAN)}}}
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def state(hass: HomeAssistant, entry: MockConfigEntry, key: str):
    entity_id = er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_{key}")
    return hass.states.get(entity_id)


async def test_sensors_follow_the_day(hass: HomeAssistant, entry: MockConfigEntry, freezer) -> None:
    assert entry.state is ConfigEntryState.LOADED
    assert state(hass, entry, "current").state == "Free"
    assert state(hass, entry, "next").state == "Maths"
    assert state(hass, entry, "next").attributes["starts_at"] == local("2026-10-15 08:00").isoformat()
    assert dt_util.parse_datetime(state(hass, entry, "lesson_end").state) == local("2026-10-15 10:30")
    assert dt_util.parse_datetime(state(hass, entry, "pickup").state) == local("2026-10-15 16:00")

    await move_to(hass, freezer, "2026-10-15 08:00")
    current = state(hass, entry, "current")
    assert current.state == "Maths"
    assert current.attributes == current.attributes | {"type": "lesson", "lesson": 1, "start": "08:00", "end": "08:45"}

    await move_to(hass, freezer, "2026-10-15 08:45")
    assert state(hass, entry, "current").state == "Free period"
    assert state(hass, entry, "current").attributes["type"] == "free_period"

    await move_to(hass, freezer, "2026-10-15 09:30")
    assert state(hass, entry, "current").state == "Break"

    await move_to(hass, freezer, "2026-10-15 14:00")
    assert state(hass, entry, "current").state == "Care"
    assert state(hass, entry, "next").state == "Free"  # next lesson is today only

    await move_to(hass, freezer, "2026-10-16 00:00")  # Friday: nothing planned
    assert state(hass, entry, "current").attributes["type"] == "none"
    assert state(hass, entry, "pickup").state == "unknown"


async def test_save_updates_sensors_and_cards(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/subscribe"})
    assert (await client.receive_json())["success"]

    plan = copy.deepcopy(PLAN)
    plan["days"]["3"]["s1"] = "  Music  "
    await client.send_json_auto_id({"type": f"{DOMAIN}/save", "entry_id": entry.entry_id, "plan": plan})
    # The card subscription announces the change ...
    assert (await client.receive_json())["event"] == {"entry_id": entry.entry_id}
    result = await client.receive_json()
    assert result["success"]
    assert result["result"]["days"]["3"]["s1"] == "Music"  # trimmed
    assert result["result"]["school_days"] == [0, 1, 2, 3, 4]
    # ... and the sensors are recalculated right away
    await hass.async_block_till_done()
    assert state(hass, entry, "next").state == "Music"

    await client.send_json_auto_id({"type": f"{DOMAIN}/get", "entry_id": entry.entry_id})
    assert (await client.receive_json())["result"]["days"]["3"]["s1"] == "Music"

    await client.send_json_auto_id({"type": f"{DOMAIN}/list"})
    assert (await client.receive_json())["result"] == [{"entry_id": entry.entry_id, "title": "Emma"}]

    await client.send_json_auto_id({"type": f"{DOMAIN}/version"})
    assert (await client.receive_json())["result"] == {"version": VERSION}


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p["slots"][1].update(start="08:30"),  # overlaps the first lesson
        lambda p: p["slots"][0].update(end="07:00"),  # ends before it starts
        lambda p: p["slots"][0].update(start="8:00"),  # not HH:MM
        lambda p: p.update(school_days=[]),
        lambda p: p["afternoon"]["3"].append({"name": "Club", "start": "15:00", "end": "17:00"}),  # overlaps Care
    ],
)
async def test_invalid_plans_are_rejected(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client, change) -> None:
    plan = copy.deepcopy(PLAN)
    change(plan)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/save", "entry_id": entry.entry_id, "plan": plan})
    response = await client.receive_json()
    assert not response["success"]
    assert response["error"]["code"] == "invalid_format"
    assert hass.data[DATA_STORE].get(entry.entry_id)["slots"] == PLAN["slots"]


async def test_saturday_as_school_day(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client, freezer) -> None:
    plan = copy.deepcopy(PLAN)
    plan["school_days"] = [0, 1, 2, 3, 4, 5]
    plan["days"]["5"] = {"s1": "Latin"}
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/save", "entry_id": entry.entry_id, "plan": plan})
    assert (await client.receive_json())["success"]

    await move_to(hass, freezer, "2026-10-17 08:10")
    assert state(hass, entry, "current").state == "Latin"


async def test_language_change(hass: HomeAssistant, entry: MockConfigEntry, freezer) -> None:
    await move_to(hass, freezer, "2026-10-15 09:35")
    assert state(hass, entry, "current").state == "Break"
    await hass.config.async_update(language="de")
    await hass.async_block_till_done()
    assert state(hass, entry, "current").state == "Pause"


async def test_card_files_and_resource(hass: HomeAssistant, entry: MockConfigEntry, hass_client_no_auth) -> None:
    client = await hass_client_no_auth()
    response = await client.get(CARD_URL)
    assert response.status == 200
    assert response.headers["Cache-Control"] == "no-cache"
    assert f'const VERSION = "{VERSION}"' in await response.text()
    assert (await client.get("/sleek_school_schedule_files/i18n/de.json")).status == 200
    for path in ("manifest.json", "const.py", "i18n/xx.json"):  # only the card and its language files
        assert (await client.get(f"/sleek_school_schedule_files/{path}")).status == 404

    resources = _resources(hass)
    assert resources is not None
    urls = [item["url"] for item in resources.async_items()]
    assert f"{CARD_URL}?v={VERSION}" in urls


async def test_remove_child(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.entry_id not in hass.data[DATA_STORE]._plans
    assert not [i for i in _resources(hass).async_items() if i["url"].startswith(CARD_URL)]


async def test_diagnostics(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    from custom_components.sleek_school_schedule.diagnostics import async_get_config_entry_diagnostics

    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["version"] == VERSION
    assert diagnostics["plan"]["days"]["3"]["s1"] == "Maths"
    assert diagnostics["next_change"] == local("2026-10-15 08:00").isoformat()
