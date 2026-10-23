"""WebSocket commands used by the card and its editor."""

from __future__ import annotations

import copy
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import ALL_DAYS, DEFAULT_SCHOOL_DAYS, DOMAIN, SIGNAL_CHANGED, SLOT_TYPES, VERSION
from .logic import normalize_plan, to_min
from .store import DATA_STORE

# Limits against accidental or malicious huge plans
MAX_SLOTS = 40
MAX_AFTERNOON_ENTRIES = 10
MAX_NAME_LENGTH = 60

TIME = vol.Match(r"^([01]\d|2[0-3]):[0-5]\d$")
DAY_KEY = vol.In([str(d) for d in ALL_DAYS])
NAME = vol.All(str, vol.Length(max=MAX_NAME_LENGTH))

SLOT_SCHEMA = vol.Schema(
    {
        vol.Required("id"): vol.All(str, vol.Length(min=1, max=32)),
        vol.Required("type"): vol.In(SLOT_TYPES),
        vol.Required("start"): TIME,
        vol.Required("end"): TIME,
    }
)

AFTERNOON_SCHEMA = vol.Schema({vol.Required("name"): NAME, vol.Required("start"): TIME, vol.Required("end"): TIME})

PLAN_SCHEMA = vol.Schema(
    {
        vol.Required("slots"): vol.All([SLOT_SCHEMA], vol.Length(max=MAX_SLOTS)),
        vol.Optional("school_days", default=list(DEFAULT_SCHOOL_DAYS)): vol.All(
            [vol.In(ALL_DAYS)], vol.Length(min=1)
        ),
        vol.Required("days"): {DAY_KEY: {str: NAME}},
        vol.Optional("afternoon", default={}): {DAY_KEY: vol.All([AFTERNOON_SCHEMA], vol.Length(max=MAX_AFTERNOON_ENTRIES))},
    }
)


def _check_times(items: list[dict], label: Any) -> None:
    """Every item ends after it starts and does not overlap another one (order does not matter)."""
    previous_end = None
    for item in sorted(items, key=lambda i: to_min(i["start"])):
        if to_min(item["start"]) >= to_min(item["end"]):
            raise vol.Invalid(f"End must be after start ({label(item)})")
        if previous_end is not None and to_min(item["start"]) < previous_end:
            raise vol.Invalid(f"Times overlap ({label(item)})")
        previous_end = to_min(item["end"])


def validate_plan(plan: dict) -> dict:
    """Check a plan from the editor and return a cleaned copy (trimmed names, no empty entries)."""
    plan = normalize_plan(PLAN_SCHEMA(copy.deepcopy(plan)))
    plan["school_days"] = sorted(set(plan["school_days"]))

    ids = [slot["id"] for slot in plan["slots"]]
    if len(ids) != len(set(ids)):
        raise vol.Invalid("Duplicate slot id")
    _check_times(plan["slots"], lambda slot: slot["id"])

    for day in list(plan["days"]):
        # drop empty cells and cells of deleted slots
        cells = plan["days"][day]
        plan["days"][day] = {slot_id: text.strip() for slot_id, text in cells.items() if slot_id in ids and text.strip()}

    for day, items in list(plan["afternoon"].items()):
        items = [{**item, "name": item["name"].strip()} for item in items if item["name"].strip()]
        _check_times(items, lambda item: item["name"])
        plan["afternoon"][day] = sorted(items, key=lambda item: to_min(item["start"]))
    return plan


@callback
def async_register(hass: HomeAssistant) -> None:
    for command in (ws_version, ws_subscribe, ws_list, ws_get, ws_save):
        websocket_api.async_register_command(hass, command)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/version"})
@callback
def ws_version(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Version of the running integration; the card compares it with its own after updates."""
    connection.send_result(msg["id"], {"version": VERSION})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Tells open cards which child changed (plan saved, child added, renamed or removed)."""

    @callback
    def forward(entry_id: str) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"entry_id": entry_id}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_CHANGED, forward)
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list"})
@callback
def ws_list(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """All children, sorted by name."""
    entries = sorted(hass.config_entries.async_entries(DOMAIN), key=lambda e: e.title)
    connection.send_result(msg["id"], [{"entry_id": e.entry_id, "title": e.title} for e in entries])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get", vol.Required("entry_id"): str})
@callback
def ws_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hass.config_entries.async_get_entry(msg["entry_id"]) is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Timetable not found")
        return
    connection.send_result(msg["id"], hass.data[DATA_STORE].get(msg["entry_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/save", vol.Required("entry_id"): str, vol.Required("plan"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hass.config_entries.async_get_entry(msg["entry_id"]) is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Timetable not found")
        return
    try:
        plan = validate_plan(msg["plan"])
    except vol.Invalid as err:
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, str(err))
        return
    await hass.data[DATA_STORE].async_set(msg["entry_id"], plan)
    connection.send_result(msg["id"], plan)
