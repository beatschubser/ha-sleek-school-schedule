# Sleek School Schedule: notes for Claude

Home Assistant custom integration plus dashboard card for school timetables.
This file carries technical context across sessions; keep it current.
This repository is public: never put personal information about the maintainer into this file or any other file.

## Repository layout

```
custom_components/sleek_school_schedule/
  __init__.py           PlanStore (.storage/sleek_school_schedule), setup, resource registration
  const.py              DOMAIN, VERSION, default_plan()
  logic.py              pure timetable logic (no HA imports), tested by tests/test_logic.py
  sensor.py             current, next, lesson_end, pickup (attributes are language neutral)
  websocket_api.py      sleek_school_schedule/{list,get,save,subscribe,version}, schema validation
  frontend_resource.py  serves the card + i18n files under /sleek_school_schedule_files (Cache-Control: no-cache), adds dashboard resource
  i18n.py               loads frontend/i18n/<lang>.json for sensor values
  config_flow.py        one config entry per child (unique_id = slug of the name)
  frontend/sleek-school-schedule-card.js   card + card editor (vanilla JS, no build step)
  frontend/i18n/<lang>.json                card, editor and sensor texts
  translations/<lang>.json, strings.json   HA dialogs and entity names
  brand/icon.png, icon@2x.png              integration icon (shown from HA 2026.3)
tests/test_logic.py     python3 tests/test_logic.py (no HA needed)
scripts/bump_version.py sets the version in manifest.json, const.py and the card
assets/                 README images (device mockups), raw/ screenshots, mockups/mockups.html, icon source
scripts/render_mockups.py renders assets/*.png from assets/raw/ via assets/mockups/*.html
```

## Design decisions (do not undo without asking)

- Data lives in `.storage/sleek_school_schedule`, keyed by config entry id; the card editor saves via WebSocket immediately (own "Save timetable" button, independent of saving the card config).
- Time grid slots: types `lesson` and `break` only, no labels; lessons are numbered automatically by start time.
- Afternoon is per day: `plan["afternoon"][day] = [{name, start, end}]`, shown as one row without a left label.
- Editor: time fields are plain text `HH:MM`; never re-sort while typing or on save. Invalid or overlapping times get a red background on blur; no error text below.
- Card: square cells, no left accent bar, tap a subject to highlight it (auto reset after 20 s), current entry with 5 px progress bar. Theme font is used (no custom font). Option `appearance` (auto/light/dark): light and dark override the theme color variables on `ha-card`, the primary color always comes from the theme.
- Sensor attribute names and the `type` value are English (`lesson`, `break`, `free_period`, `afternoon`, `none`); state texts follow the HA language.
- Languages: en (fallback), de, fr, nl, es, it, pl. Every text change must be made in **all** `frontend/i18n/*.json` and `translations/*.json`. Weekday names come from `Intl`, not from translation files.
- README images use relative paths.

## Release workflow

1. Make the change, run `python3 tests/test_logic.py` and `node --check` on the card. For UI changes render the card/editor with Playwright and look at the screenshots (light, dark, narrow).
2. Set the version with `python3 scripts/bump_version.py X.Y.Z`. Test builds: `X.Y.Z-beta.N` (become pre-releases, visible in HACS with beta enabled).
3. Commit as `Claude <noreply@anthropic.com>` with meaningful subject lines (they become the release notes) and push to `main`.
   Subject lines are short, neutral and factual (e.g. "Update README", "Editor: mark overlapping times"): describe what changed, never how or why text was written or reworded.
4. `.github/workflows/release.yml` validates (hassfest, tests, version consistency) and creates the GitHub release automatically when the manifest version changed. This session type cannot create releases or change repository settings directly; the workflow does releases, settings are changed by the maintainer.
5. `validate.yml` runs on every push; the HACS check is skipped while the repository is private.

## Lessons learned

- Home Assistant only loads an integration that has config entries (or YAML config). Migration code inside a renamed integration never runs on its own; a placeholder in the old domain with a manifest dependency is needed.
- Updates: the Lovelace resource carries `?v=VERSION` and the files are served with `Cache-Control: no-cache`, so a page reload is enough. Pages that stay open (companion app, wall panels) keep the old card code; the card compares its VERSION with `sleek_school_schedule/version` on every reconnect and shows a tap-to-reload hint (at most once per version, sessionStorage).
- HACS cannot use private repositories at all.
