"""WebSocket API for the card."""

from __future__ import annotations

import copy

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_UPDATED_ANY, SLOT_TYPES, WEEKDAYS
from .logic import to_min

TIME = vol.Match(r"^([01]\d|2[0-3]):[0-5]\d$")

SLOT_SCHEMA = vol.Schema(
    {
        vol.Required("id"): vol.All(str, vol.Length(min=1, max=32)),
        vol.Required("type"): vol.In(SLOT_TYPES),
        vol.Required("start"): TIME,
        vol.Required("end"): TIME,
    }
)

ENTRY_SCHEMA = vol.Schema(
    {
        vol.Required("name"): vol.All(str, vol.Length(max=60)),
        vol.Required("start"): TIME,
        vol.Required("end"): TIME,
    }
)

PLAN_SCHEMA = vol.Schema(
    {
        vol.Required("slots"): vol.All([SLOT_SCHEMA], vol.Length(max=40)),
        vol.Required("days"): {vol.In(WEEKDAYS): {str: vol.All(str, vol.Length(max=60))}},
        vol.Optional("afternoon", default={}): {vol.In(WEEKDAYS): vol.All([ENTRY_SCHEMA], vol.Length(max=10))},
    }
)


def _validate(plan: dict) -> dict:
    plan = PLAN_SCHEMA(copy.deepcopy(plan))
    for day in WEEKDAYS:
        items = []
        for e in plan["afternoon"].get(day, []):
            name = e["name"].strip()
            if not name:
                continue
            if to_min(e["start"]) >= to_min(e["end"]):
                raise vol.Invalid(f"End must be after start ({name})")
            items.append({"name": name, "start": e["start"], "end": e["end"]})
        plan["afternoon"][day] = sorted(items, key=lambda x: to_min(x["start"]))
    ids = set()
    for slot in plan["slots"]:
        if to_min(slot["start"]) >= to_min(slot["end"]):
            raise vol.Invalid(f"End must be after start ({slot['id']})")
        if slot["id"] in ids:
            raise vol.Invalid("Duplicate slot id")
        ids.add(slot["id"])
    # drop orphaned and empty cells
    for day in WEEKDAYS:
        cells = plan["days"].get(day, {})
        plan["days"][day] = {k: v.strip() for k, v in cells.items() if k in ids and v.strip()}
    return plan


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list)
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_save)
    websocket_api.async_register_command(hass, ws_subscribe)


@websocket_api.websocket_command({vol.Required("type"): "sleek_school_schedule/subscribe"})
@callback
def ws_subscribe(hass, connection, msg):
    """Notifies cards about every saved change (live update)."""

    @callback
    def forward(entry_id: str) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"entry_id": entry_id}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_UPDATED_ANY, forward)
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): "sleek_school_schedule/list"})
@callback
def ws_list(hass, connection, msg):
    entries = hass.config_entries.async_entries(DOMAIN)
    connection.send_result(
        msg["id"],
        [{"entry_id": e.entry_id, "title": e.title} for e in sorted(entries, key=lambda e: e.title)],
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "sleek_school_schedule/get", vol.Required("entry_id"): str}
)
@callback
def ws_get(hass, connection, msg):
    if hass.config_entries.async_get_entry(msg["entry_id"]) is None:
        connection.send_error(msg["id"], "not_found", "Timetable not found")
        return
    connection.send_result(msg["id"], hass.data[DOMAIN].get(msg["entry_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sleek_school_schedule/save",
        vol.Required("entry_id"): str,
        vol.Required("plan"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(hass, connection, msg):
    if hass.config_entries.async_get_entry(msg["entry_id"]) is None:
        connection.send_error(msg["id"], "not_found", "Timetable not found")
        return
    try:
        plan = _validate(msg["plan"])
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    await hass.data[DOMAIN].async_set(msg["entry_id"], plan)
    connection.send_result(msg["id"], plan)
