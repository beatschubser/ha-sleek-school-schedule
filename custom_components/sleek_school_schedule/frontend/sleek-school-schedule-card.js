/* Sleek School Schedule card for Home Assistant (loaded automatically by the integration).
 * The card only displays. Editing happens in the card editor (edit dashboard > open card).
 * Texts: frontend/i18n/<language>.json, English is the fallback for missing keys.
 */

const VERSION = "2.2.0-beta.1";
const I18N_URL = "/sleek_school_schedule_files/i18n/";
const LANGUAGES = ["en", "de", "fr", "nl", "es", "it", "pl"];
const DAYS = [0, 1, 2, 3, 4]; // Monday to Friday
const WS = "sleek_school_schedule";
const APPEARANCES = ["auto", "light", "dark"]; // auto = follow the Home Assistant theme

/* ---------------- Translations ---------------- */

const i18nCache = {};

const pickLanguage = (hass) => {
  const raw = String(hass?.locale?.language || hass?.language || "en").toLowerCase().replace("_", "-");
  if (LANGUAGES.includes(raw)) return raw;
  const base = raw.split("-")[0];
  return LANGUAGES.includes(base) ? base : "en";
};

const deepMerge = (target, source) => {
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) target[k] = deepMerge({ ...(target[k] || {}) }, v);
    else target[k] = v;
  }
  return target;
};

const fetchLanguage = async (lang) => {
  const res = await fetch(`${I18N_URL}${lang}.json?v=${VERSION}`);
  if (!res.ok) throw new Error(`${lang}: HTTP ${res.status}`);
  return res.json();
};

/** Strings of a language merged over English (missing keys fall back to English). */
const loadStrings = (lang) =>
  (i18nCache[lang] ||= (async () => {
    let strings = {};
    try {
      strings = await fetchLanguage("en");
      if (lang !== "en") strings = deepMerge(strings, await fetchLanguage(lang));
    } catch (e) {
      console.warn("sleek-school-schedule-card: translations could not be loaded", e);
    }
    return strings;
  })());

/** Translate "section.key", replacing {placeholders}. */
const tr = (strings, key, vars = {}) => {
  const text = key.split(".").reduce((o, k) => (o ? o[k] : undefined), strings);
  return String(text ?? key).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");
};

/** Locale for formatting (weekday names), also for languages without translation file. */
const pickLocale = (hass) => {
  const raw = String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([raw]).length ? raw : "en";
  } catch (e) {
    return "en";
  }
};

/** Weekday names from the browser (Intl), so they need no translation. */
const dayName = (lang, day, style) => {
  // 1 January 2024 was a Monday
  const name = new Intl.DateTimeFormat(lang, { weekday: style }).format(new Date(2024, 0, 1 + day)).replace(/\.$/, "");
  return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toMin = (t) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return h * 60 + m;
};
const fromMin = (m) => {
  m = Math.max(0, Math.min(23 * 60 + 59, m));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const parseTime = (v) => {
  const m = String(v || "").trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};
const sessionGet = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch (e) {
    return null;
  }
};
const sessionSet = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
  } catch (e) {
    /* storage blocked: nothing to remember */
  }
};
const uid = () => "s" + Math.random().toString(36).slice(2, 10);
const hue = (s) => {
  let h = 7;
  for (const c of s.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
const sortSlots = (slots) => [...slots].sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end));
const cellText = (plan, day, slot) => ((plan.days?.[String(day)] || {})[slot.id] || "").trim();
const pmItems = (plan, day) =>
  ((plan.afternoon || {})[String(day)] || [])
    .filter((e) => (e.name || "").trim() && parseTime(e.start) && parseTime(e.end))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
const matchChild = (c, want) => c.entry_id === want || c.title.toLowerCase() === String(want).toLowerCase();

/** Lesson bounds like in the backend: first to last filled lesson of the day. */
function bounds(plan, day) {
  const lessons = plan.slots.filter((s) => s.type === "lesson" && cellText(plan, day, s));
  if (!lessons.length) return null;
  return {
    first: Math.min(...lessons.map((s) => toMin(s.start))),
    last: Math.max(...lessons.map((s) => toMin(s.end))),
  };
}

/* =====================================================================
 * Card (display only)
 * ===================================================================== */

class SleekSchoolScheduleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._plans = {};
    this._children = [];
  }

  static getConfigElement() {
    return document.createElement("sleek-school-schedule-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    if (this._hass) this._load();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._load();
      this._subscribe();
    } else if (this._s && pickLanguage(hass) !== this._lang) {
      this._loadStrings().then(() => this._render());
    }
  }

  async _loadStrings() {
    this._lang = pickLanguage(this._hass);
    this._locale = pickLocale(this._hass);
    this._s = await loadStrings(this._lang);
  }

  t(key, vars) {
    return tr(this._s, key, vars);
  }

  getCardSize() {
    return 7;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._render(), 30000);
    if (this._hass) this._subscribe();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearTimeout(this._focusTimer);
    this._unsubscribe();
  }

  /** Tap a subject: highlight the same subject everywhere, dim the rest. */
  _setFocus(key) {
    clearTimeout(this._focusTimer);
    this._focus = key || null;
    if (this._focus) this._focusTimer = setTimeout(() => this._setFocus(null), 20000);
    this._applyFocus();
  }

  _applyFocus() {
    const grid = this.shadowRoot.querySelector(".grid.view");
    if (!grid) return;
    grid.classList.toggle("focusing", !!this._focus);
    grid.querySelectorAll(".cell[data-key]").forEach((el) => el.classList.toggle("match", el.dataset.key === this._focus));
  }

  /** Live update whenever a timetable is saved anywhere. */
  async _subscribe() {
    if (this._unsub || !this._hass?.connection) return;
    this._unsub = this._hass.connection
      .subscribeMessage(() => this._load(), { type: `${WS}/subscribe` })
      .catch(() => (this._unsub = null));
    // "ready" fires after every reconnect, e.g. when Home Assistant restarted after an update
    this._onReady = () => this._checkVersion();
    this._hass.connection.addEventListener?.("ready", this._onReady);
    this._checkVersion();
  }

  async _unsubscribe() {
    const p = this._unsub;
    this._unsub = null;
    if (this._onReady) this._hass?.connection?.removeEventListener?.("ready", this._onReady);
    this._onReady = null;
    if (p) (await p)?.();
  }

  /** A newer integration is running than this card code (page still open from before the update). */
  async _checkVersion() {
    let version;
    try {
      ({ version } = await this._hass.callWS({ type: `${WS}/version` }));
    } catch (e) {
      return; // integration not restarted yet (command unknown)
    }
    const outdated = version !== VERSION && !sessionGet(`sss-reloaded-${version}`);
    if (outdated !== !!this._outdated) {
      this._outdated = outdated ? version : null;
      this._render();
    }
  }

  _reloadPage() {
    sessionSet(`sss-reloaded-${this._outdated}`, "1"); // reload at most once per version
    location.reload();
  }

  async _load() {
    if (!this._s) await this._loadStrings();
    try {
      let list = await this._hass.callWS({ type: `${WS}/list` });
      if (this._config.child) list = list.filter((c) => matchChild(c, this._config.child));
      this._children = list;
      if (!list.find((c) => c.entry_id === this._active)) this._active = list[0]?.entry_id;
      const plans = await Promise.all(list.map((c) => this._hass.callWS({ type: `${WS}/get`, entry_id: c.entry_id })));
      this._plans = Object.fromEntries(list.map((c, i) => [c.entry_id, plans[i]]));
      this._error = null;
    } catch (e) {
      this._error = e?.message || String(e);
    }
    this._render();
  }

  /** "light" or "dark" forces the colors, anything else follows the theme. */
  _appearance() {
    return ["light", "dark"].includes(this._config.appearance) ? `mode-${this._config.appearance}` : "";
  }

  get _plan() {
    return this._plans[this._active];
  }

  _render() {
    if (!this._s) return;
    let body;
    if (this._error) body = `<div class="msg err">${esc(this.t("card.error"))}: ${esc(this._error)}</div>`;
    else if (!this._children.length)
      body = this._config.child
        ? `<div class="msg">${esc(this.t("card.child_not_found", { name: this._config.child }))}</div>`
        : `<div class="msg">${esc(this.t("card.no_timetables"))}</div>`;
    else if (!this._plan) body = `<div class="msg">${esc(this.t("card.loading"))}</div>`;
    else body = this._renderView();

    const update = this._outdated ? `<button class="update" data-reload>${esc(this.t("card.update_available"))}</button>` : "";
    this.shadowRoot.innerHTML = `<style>${BASE_STYLE}${VIEW_STYLE}</style><ha-card class="${esc(this._appearance())}" lang="${this._lang}">${update}${this._renderHeader()}${body}</ha-card>`;
    this.shadowRoot.querySelector("[data-reload]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._reloadPage();
    });
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._active = el.dataset.tab;
        clearTimeout(this._focusTimer);
        this._focus = null;
        this._render();
      })
    );
    // Tapping a subject (lessons only, not the afternoon) highlights it; anything else resets
    this.shadowRoot.querySelector("ha-card").addEventListener("click", (e) => {
      const key = e.target.closest(".cell.filled[data-key]")?.dataset.key;
      this._setFocus(key && key !== this._focus ? key : null);
    });
    this._applyFocus();
  }

  _renderHeader() {
    if (this._children.length > 1)
      return `<div class="head"><div class="tabs">${this._children
        .map((c) => `<button class="tab ${c.entry_id === this._active ? "active" : ""}" data-tab="${esc(c.entry_id)}">${esc(c.title)}</button>`)
        .join("")}</div></div>`;
    return `<div class="head"><div class="title">${esc(this._config.title || this._children[0]?.title || this.t("card.name"))}</div></div>`;
  }

  _renderView() {
    const plan = this._plan;
    const slots = sortSlots(plan.slots);
    const now = new Date();
    const today = (now.getDay() + 6) % 7; // 0 = Monday
    const minute = now.getHours() * 60 + now.getMinutes();
    const b = today < 5 ? bounds(plan, today) : null;

    // only show rows that are used on at least one day
    const used = slots.map((s) => s.type !== "break" && DAYS.some((d) => cellText(plan, d, s)));
    const firstUsed = used.indexOf(true);
    const lastUsed = used.lastIndexOf(true);
    const hasPm = DAYS.some((d) => pmItems(plan, d).length);
    if (firstUsed < 0 && !hasPm)
      return `<div class="msg">${esc(this.t("card.empty"))}</div>`;
    const rows = firstUsed < 0 ? [] : slots.filter((s, i) => i >= firstUsed && i <= lastUsed && (s.type === "break" || used[i]));

    // highlight breaks only between the first and last lesson (as in the backend)
    const isNow = (s) =>
      b &&
      toMin(s.start) <= minute &&
      minute < toMin(s.end) &&
      (s.type !== "break" || (toMin(s.start) >= b.first && toMin(s.end) <= b.last));
    const progress = (s) => Math.round(((minute - toMin(s.start)) / (toMin(s.end) - toMin(s.start))) * 100);

    let html = `<div class="grid view"><div class="corner"></div>`;
    html += DAYS.map((d) => `<div class="dayhead ${d === today ? "today" : ""}">${esc(dayName(this._locale, d, "short"))}</div>`).join("");

    for (const s of rows) {
      if (s.type === "break") {
        const active = isNow(s);
        html += `<div class="time break"></div>`;
        html += `<div class="breakrow ${active ? "now" : ""}"><span>${esc(this.t("card.break"))}</span>${
          active ? `<i class="bar" style="width:${progress(s)}%"></i>` : ""
        }</div>`;
        continue;
      }
      html += `<div class="time ${s.type}"><span class="t">${esc(s.start)}<br>${esc(s.end)}</span></div>`;
      for (const d of DAYS) {
        const txt = cellText(plan, d, s);
        const active = d === today && isNow(s) && txt;
        const cls = ["cell", s.type, txt ? "filled" : "empty", d === today ? "todaycol" : "", active ? "now" : ""].join(" ");
        const style = txt ? `style="--h:${hue(txt)}"` : "";
        const key = txt ? ` data-key="${esc(txt.toLowerCase())}"` : "";
        html += `<div class="${cls}" ${style}${key} title="${esc(txt)}"><span>${esc(txt)}</span>${
          active ? `<i class="bar" style="width:${progress(s)}%"></i>` : ""
        }</div>`;
      }
    }

    // Afternoon: entries with their own times per day
    if (hasPm) {
      html += `<div class="time pmtime"></div>`;
      for (const d of DAYS) {
        const items = pmItems(plan, d);
        if (!items.length) {
          html += `<div class="cell empty pmempty ${d === today ? "todaycol" : ""}"></div>`;
          continue;
        }
        html += `<div class="pm">${items
          .map((e) => {
            const st = toMin(e.start);
            const en = toMin(e.end);
            const cur = d === today && st <= minute && minute < en;
            return `<div class="item ${cur ? "now" : ""}" style="--h:${hue(e.name.trim())}">
              <span class="n">${esc(e.name)}</span><span class="t">${esc(e.start)}-${esc(e.end)}</span>${
                cur ? `<i class="bar" style="width:${progress(e)}%"></i>` : ""
              }</div>`;
          })
          .join("")}</div>`;
      }
    }
    return html + `</div>`;
  }
}

/* =====================================================================
 * Card editor (left side of the edit dialog)
 * ===================================================================== */

class SleekSchoolScheduleCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._children = [];
    this._config = {};
  }

  setConfig(config) {
    const prevChild = this._config.child;
    this._config = { ...(config || {}) };
    // Only re-render when the child selection changed (do not interrupt typing the title)
    if (this._loaded && prevChild !== this._config.child) this._selectFromConfig();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
  }

  t(key, vars) {
    return tr(this._s, key, vars);
  }

  async _load() {
    this._lang = pickLanguage(this._hass);
    this._locale = pickLocale(this._hass);
    this._s = await loadStrings(this._lang);
    try {
      this._children = await this._hass.callWS({ type: `${WS}/list` });
      this._error = null;
    } catch (e) {
      this._error = e?.message || String(e);
    }
    this._loaded = true;
    this._selectFromConfig();
  }

  _selectFromConfig() {
    const fixed = this._config.child ? this._children.find((c) => matchChild(c, this._config.child)) : null;
    const id = fixed?.entry_id || (this._children.find((c) => c.entry_id === this._editId) ? this._editId : this._children[0]?.entry_id);
    this._openPlan(id);
  }

  async _openPlan(id) {
    this._editId = id;
    this._draft = null;
    this._dirty = false;
    this._bad = null;
    this._msg = null;
    if (id) {
      try {
        const plan = await this._hass.callWS({ type: `${WS}/get`, entry_id: id });
        this._draft = this._prep(plan);
      } catch (e) {
        this._error = e?.message || String(e);
      }
    }
    this._render();
  }

  _prep(plan) {
    const d = JSON.parse(JSON.stringify(plan));
    d.slots = sortSlots(d.slots || []);
    d.days ||= {};
    d.afternoon ||= {};
    for (const day of DAYS) {
      d.days[day] ||= {};
      d.afternoon[day] ||= [];
    }
    return d;
  }

  _fireConfig() {
    const cfg = { type: this._config.type || "custom:sleek-school-schedule-card" };
    if (this._config.child) cfg.child = this._config.child;
    if (this._config.title) cfg.title = this._config.title;
    if (this._config.appearance && this._config.appearance !== "auto") cfg.appearance = this._config.appearance;
    this._config = cfg;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
  }

  /* ---------------- Rendering ---------------- */

  _render() {
    const multi = this._children.length > 1;
    let html = `<div class="wrap" lang="${this._lang}">`;

    // Card options
    html += `<div class="section">${esc(this.t("editor.card"))}</div><div class="opts">`;
    if (multi) {
      html += `<label>${esc(this.t("editor.show"))}<select data-cfg="child"><option value="">${esc(this.t("editor.all_children"))}</option>${this._children
        .map((c) => `<option value="${esc(c.title)}" ${this._config.child && matchChild(c, this._config.child) ? "selected" : ""}>${esc(c.title)}</option>`)
        .join("")}</select></label>`;
    }
    html += `<label>${esc(this.t("editor.title"))}<input data-cfg="title" value="${esc(this._config.title || "")}" placeholder="${esc(
      this._children.length === 1 ? this._children[0].title : this.t("editor.title_placeholder")
    )}"></label>`;
    html += `<label>${esc(this.t("editor.appearance"))}<select data-cfg="appearance">${APPEARANCES.map(
      (a) => `<option value="${a}" ${(this._config.appearance || "auto") === a ? "selected" : ""}>${esc(this.t(`editor.appearance_${a}`))}</option>`
    ).join("")}</select></label></div>`;

    // Timetable
    html += `<div class="section">${esc(this.t("editor.edit_timetable"))}</div>`;
    if (this._error) html += `<div class="msg err">${esc(this._error)}</div>`;
    if (!this._children.length) {
      html += `<div class="msg">${esc(this.t("card.no_timetables"))}</div>`;
    } else {
      if (multi && !this._config.child) {
        html += `<div class="tabs pick">${this._children
          .map((c) => `<button class="tab ${c.entry_id === this._editId ? "active" : ""}" data-pick="${esc(c.entry_id)}">${esc(c.title)}</button>`)
          .join("")}</div>`;
      }
      html += this._draft ? this._renderForm() : `<div class="msg">${esc(this.t("card.loading"))}</div>`;
    }
    html += `</div>`;

    this.shadowRoot.innerHTML = `<style>${BASE_STYLE}${EDIT_STYLE}</style>${html}`;
    this._bind();
  }

  _renderForm() {
    const d = this._draft;
    this._bad = this._validate();
    const slots = d.slots; // order stays as entered; overlaps are marked, never re-sorted
    const subjects = [
      ...new Set(
        [...Object.values(d.days).flatMap((x) => Object.values(x)), ...Object.values(d.afternoon).flatMap((x) => x.map((e) => e.name))]
          .map((x) => (x || "").trim())
          .filter(Boolean)
      ),
    ].sort();

    let html = `<div class="sub">${esc(this.t("editor.time_grid"))}</div><div class="slots">`;
    for (const s of slots) {
      html += `<div class="slot ${s.type}">
        <select data-slot="${s.id}" data-k="type">${["lesson", "break"]
          .map((k) => `<option value="${k}" ${k === s.type ? "selected" : ""}>${esc(this.t(`editor.${k}`))}</option>`)
          .join("")}</select>
        <input class="tm ${this._bad?.has(s.id + "start") ? "bad" : ""}" data-slot="${s.id}" data-k="start" value="${esc(s.start)}" placeholder="08:00" maxlength="5" inputmode="numeric" autocomplete="off">
        <input class="tm ${this._bad?.has(s.id + "end") ? "bad" : ""}" data-slot="${s.id}" data-k="end" value="${esc(s.end)}" placeholder="08:45" maxlength="5" inputmode="numeric" autocomplete="off">
        <button class="x" data-act="del" data-id="${s.id}" title="${esc(this.t("editor.remove"))}">×</button>
      </div>`;
    }
    html += `</div><div class="adds">
      <button data-act="add" data-type="lesson">${esc(this.t("editor.add_lesson"))}</button>
      <button data-act="add" data-type="break">${esc(this.t("editor.add_break"))}</button>
    </div>`;

    html += `<div class="sub">${esc(this.t("editor.subjects"))}</div><div class="grid editgrid"><div class="corner"></div>`;
    html += DAYS.map((d) => `<div class="dayhead">${esc(dayName(this._locale, d, "short"))}</div>`).join("");
    for (const s of slots) {
      if (s.type === "break") continue;
      html += `<div class="time ${s.type}"><span class="t" data-show="${s.id}start">${esc(s.start)}</span></div>`;
      for (const day of DAYS) {
        const v = d.days[day][s.id] || "";
        html += `<input class="cellin ${s.type}" list="subjects" data-cell="${s.id}" data-day="${day}" value="${esc(v)}" maxlength="60">`;
      }
    }
    html += `</div><datalist id="subjects">${subjects.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;

    html += `<div class="sub">${esc(this.t("editor.afternoon"))}</div><div class="pmdays">`;
    for (const day of DAYS) {
      const items = d.afternoon[day];
      html += `<div class="pmday"><div class="pmhead">${esc(dayName(this._locale, day, "long"))}</div>`;
      items.forEach((e, i) => {
        const k = `${day}-${i}`;
        html += `<div class="pmrow">
          <input data-pm="${k}" data-k="name" value="${esc(e.name)}" placeholder="${esc(this.t("editor.entry_placeholder"))}" maxlength="60" list="subjects">
          <input class="tm ${this._bad?.has("pm" + k + "start") ? "bad" : ""}" data-pm="${k}" data-k="start" value="${esc(e.start)}" placeholder="13:00" maxlength="5" inputmode="numeric" autocomplete="off">
          <input class="tm ${this._bad?.has("pm" + k + "end") ? "bad" : ""}" data-pm="${k}" data-k="end" value="${esc(e.end)}" placeholder="15:00" maxlength="5" inputmode="numeric" autocomplete="off">
          <button class="x" data-act="pmdel" data-day="${day}" data-i="${i}" title="${esc(this.t("editor.remove"))}">×</button>
        </div>`;
      });
      html += `<div class="pmfoot"><button class="add" data-act="pmadd" data-day="${day}">${esc(this.t("editor.add_entry"))}</button>${
        items.length ? `<button class="link" data-act="pmcopy" data-day="${day}">${esc(this.t("editor.copy_to_all"))}</button>` : ""
      }</div></div>`;
    }
    html += `</div>`;

    if (this._msg) html += `<div class="msg ${this._msg.err ? "err" : "ok"}">${esc(this._msg.text)}</div>`;
    html += `<div class="foot">
      <span class="state">${this._dirty ? esc(this.t("editor.unsaved")) : ""}</span>
      <button data-act="revert" ${this._dirty ? "" : "disabled"}>${esc(this.t("editor.discard"))}</button>
      <button class="primary" data-act="save" ${this._saving || !this._dirty ? "disabled" : ""}>${esc(this.t("editor.save"))}</button>
    </div>
    <div class="hint">${esc(this.t("editor.save_hint"))}</div>`;
    return html;
  }

  /* ---------------- Events ---------------- */

  _markDirty() {
    if (this._dirty) return;
    this._dirty = true;
    this._msg = null;
    const root = this.shadowRoot;
    root.querySelector(".state").textContent = this.t("editor.unsaved");
    root.querySelector("[data-act=revert]").disabled = false;
    root.querySelector("[data-act=save]").disabled = false;
    root.querySelector(".msg.ok")?.remove();
  }

  _bind() {
    const root = this.shadowRoot;

    root.querySelectorAll("[data-cfg]").forEach((el) =>
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
        this._config = { ...this._config, [el.dataset.cfg]: el.value.trim() }; // new object, the fired config stays untouched
        this._fireConfig();
        if (el.dataset.cfg === "child") this._selectFromConfig();
      })
    );

    root.querySelectorAll("[data-pick]").forEach((el) =>
      el.addEventListener("click", () => {
        if (el.dataset.pick === this._editId) return;
        if (this._dirty && !confirm(this.t("editor.discard_confirm"))) return;
        this._openPlan(el.dataset.pick);
      })
    );

    root.querySelectorAll("[data-act]").forEach((el) => el.addEventListener("click", (e) => this._onAction(e, el)));

    root.querySelectorAll("[data-slot]").forEach((el) => {
      const slot = this._draft?.slots.find((s) => s.id === el.dataset.slot);
      if (!slot) return;
      if (el.tagName === "SELECT") {
        el.addEventListener("change", () => {
          slot.type = el.value;
          this._dirty = true;
          this._render();
        });
      } else {
        el.addEventListener("input", () => {
          slot[el.dataset.k] = el.value;
          el.classList.remove("bad");
          const show = root.querySelector(`[data-show="${slot.id}${el.dataset.k}"]`);
          if (show) show.textContent = el.value;
          this._markDirty();
        });
      }
    });

    root.querySelectorAll("[data-pm]").forEach((el) => {
      const [day, i] = el.dataset.pm.split("-");
      const item = this._draft?.afternoon[day]?.[+i];
      if (!item) return;
      el.addEventListener("input", () => {
        item[el.dataset.k] = el.value;
        el.classList.remove("bad");
        this._markDirty();
      });
    });

    root.querySelectorAll("input.tm, [data-pm][data-k=name]").forEach((el) =>
      el.addEventListener("blur", () => {
        this._bad = this._validate();
        this._applyBad();
      })
    );

    root.querySelectorAll("[data-cell]").forEach((el) =>
      el.addEventListener("input", () => {
        const day = (this._draft.days[el.dataset.day] ||= {});
        day[el.dataset.cell] = el.value;
        this._markDirty();
      })
    );
  }

  async _onAction(e, el) {
    e.preventDefault();
    e.stopPropagation();
    switch (el.dataset.act) {
      case "del":
        this._draft.slots = this._draft.slots.filter((s) => s.id !== el.dataset.id);
        this._dirty = true;
        this._render();
        break;
      case "add": {
        const type = el.dataset.type;
        const ends = this._draft.slots.map((s) => parseTime(s.end)).filter((x) => x !== null);
        const start = ends.length ? Math.max(...ends.map(toMin)) : 8 * 60;
        const len = { lesson: 45, break: 15 }[type];
        this._draft.slots.push({ id: uid(), type, start: fromMin(start), end: fromMin(start + len) });
        this._dirty = true;
        this._render();
        break;
      }
      case "pmadd": {
        const items = this._draft.afternoon[el.dataset.day];
        const ends = items.map((x) => parseTime(x.end)).filter((x) => x !== null);
        const start = ends.length ? Math.max(...ends.map(toMin)) : 13 * 60;
        items.push({ name: "", start: fromMin(start), end: fromMin(start + 120) });
        this._dirty = true;
        this._render();
        this.shadowRoot.querySelector(`[data-pm="${el.dataset.day}-${items.length - 1}"][data-k=name]`)?.focus();
        break;
      }
      case "pmdel":
        this._draft.afternoon[el.dataset.day].splice(+el.dataset.i, 1);
        this._dirty = true;
        this._render();
        break;
      case "pmcopy": {
        const src = el.dataset.day;
        const others = Object.keys(this._draft.afternoon).filter((d) => d !== src && this._draft.afternoon[d].length);
        if (others.length && !confirm(this.t("editor.copy_confirm", { day: dayName(this._locale, +src, "long") }))) return;
        for (const d of DAYS) {
          if (String(d) !== src) this._draft.afternoon[d] = JSON.parse(JSON.stringify(this._draft.afternoon[src]));
        }
        this._dirty = true;
        this._render();
        break;
      }
      case "revert":
        this._openPlan(this._editId);
        break;
      case "save":
        await this._save();
        break;
    }
  }

  /** Keys of all invalid time fields (does not change anything). */
  _validate() {
    const bad = new Set();
    // Format, start < end, and every entry starts no earlier than the previous one ends
    const check = (rows) => {
      let prevEnd = null;
      let prevKey = null;
      for (const { it, k } of rows) {
        const st = parseTime(it.start);
        const en = parseTime(it.end);
        if (st === null) bad.add(k + "start");
        if (en === null) bad.add(k + "end");
        if (st === null || en === null) {
          prevEnd = null;
          continue;
        }
        if (toMin(st) >= toMin(en)) bad.add(k + "end");
        if (prevEnd !== null && toMin(st) < prevEnd) {
          bad.add(k + "start");
          bad.add(prevKey + "end");
        }
        prevEnd = toMin(en);
        prevKey = k;
      }
    };
    if (!this._draft) return bad;
    check(this._draft.slots.map((s) => ({ it: s, k: s.id })));
    for (const day of DAYS) {
      const rows = [];
      this._draft.afternoon[day].forEach((e, i) => {
        if ((e.name || "").trim()) rows.push({ it: e, k: `pm${day}-${i}` }); // empty entries are ignored
      });
      check(rows);
    }
    return bad;
  }

  /** Update markers in the existing DOM without re-rendering (keeps focus). */
  _applyBad() {
    this.shadowRoot.querySelectorAll("input.tm").forEach((el) => {
      const k = el.dataset.slot ? el.dataset.slot : `pm${el.dataset.pm}`;
      el.classList.toggle("bad", this._bad.has(k + el.dataset.k));
    });
  }

  async _save() {
    this._bad = this._validate();
    if (this._bad.size) {
      this._applyBad();
      return;
    }
    this._bad = null;
    for (const s of this._draft.slots) {
      s.start = parseTime(s.start);
      s.end = parseTime(s.end);
    }
    for (const day of DAYS) {
      this._draft.afternoon[day] = this._draft.afternoon[day]
        .filter((e) => (e.name || "").trim())
        .map((e) => ({ name: e.name.trim(), start: parseTime(e.start), end: parseTime(e.end) }));
    }
    this._saving = true;
    this._render();
    try {
      const plan = await this._hass.callWS({ type: `${WS}/save`, entry_id: this._editId, plan: this._draft });
      this._draft = this._prep(plan);
      this._dirty = false;
      this._msg = { err: false, text: this.t("editor.saved") };
    } catch (e) {
      this._msg = { err: true, text: e?.message || String(e) };
    }
    this._saving = false;
    this._render();
  }
}

/* =====================================================================
 * Styles
 * ===================================================================== */

const BASE_STYLE = `
:host { display:block; }
.msg { color:var(--secondary-text-color); padding:8px 4px; }
.msg.err { color:var(--error-color, #db4437); }
.msg.ok { color:var(--success-color, #43a047); }
.tabs { display:flex; gap:6px; flex:1; flex-wrap:wrap; }
.tab { font:inherit; font-size:1.05em; border:1px solid var(--divider-color); background:none; color:var(--primary-text-color); border-radius:18px; padding:6px 14px; cursor:pointer; }
.tab.active { background:var(--primary-color); border-color:var(--primary-color); color:var(--text-primary-color, #fff); }
.grid { display:grid; grid-template-columns: minmax(44px,auto) repeat(5, minmax(0,1fr)); gap:4px; align-items:stretch; }
.dayhead { text-align:center; font-weight:500; color:var(--secondary-text-color); padding:9px 0; font-size:1.05em; }
.time { display:flex; flex-direction:column; justify-content:center; padding:0 6px 0 2px; color:var(--secondary-text-color); font-size:.88em; line-height:1.25; font-variant-numeric:tabular-nums; }
`;

const VIEW_STYLE = `
ha-card.mode-light { color-scheme:light; --primary-text-color:#212121; --secondary-text-color:#727272; --divider-color:rgba(0,0,0,.12); --secondary-background-color:#e5e5e5; --card-background-color:#fff; --ha-card-background:#fff; --ha-card-border-color:#e0e0e0; }
ha-card.mode-dark { color-scheme:dark; --primary-text-color:#e1e1e1; --secondary-text-color:#9b9b9b; --divider-color:rgba(225,225,225,.12); --secondary-background-color:#282828; --card-background-color:#1c1c1c; --ha-card-background:#1c1c1c; --ha-card-border-color:rgba(225,225,225,.12); }
ha-card { display:block; padding: 12px 12px 14px; overflow:hidden; color:var(--primary-text-color); container-type:inline-size; }
.update { display:block; width:100%; margin:0 0 10px; padding:8px 12px; font:inherit; font-size:.92em; text-align:center; cursor:pointer; border:none; border-radius:8px; background:color-mix(in srgb, var(--primary-color) 18%, transparent); color:var(--primary-text-color); }
.head { display:flex; align-items:center; gap:8px; margin-bottom:10px; min-height:36px; }
.title { font-size:1.3em; font-weight:500; flex:1; padding-left:4px; }
.dayhead.today { background:var(--primary-color); color:var(--text-primary-color, #fff); }
.time.break { opacity:.7; }
.cell { position:relative; min-height:46px; display:flex; align-items:center; justify-content:center; text-align:center; padding:2px 4px; font-size:1.05em; overflow:hidden; }
.cell span { overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:normal; word-break:normal; hyphens:auto; -webkit-hyphens:auto; }
.cell.filled { background:hsla(var(--h), 65%, 55%, .18); }
.cell.empty { background:var(--secondary-background-color); opacity:.45; }
.cell.todaycol:not(.now) { outline:1px solid color-mix(in srgb, var(--primary-color) 35%, transparent); outline-offset:-1px; }
.cell.now { outline:2px solid var(--primary-color); outline-offset:-2px; font-weight:600; background:color-mix(in srgb, var(--primary-color) 22%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--primary-color) 20%, transparent); }
.cell.filled[data-key] { cursor:pointer; -webkit-tap-highlight-color:transparent; }
.cell, .pm .item, .breakrow { transition:opacity .2s, box-shadow .2s; }
.grid.focusing .cell:not(.match), .grid.focusing .pm .item, .grid.focusing .breakrow { opacity:.15; }
.grid.focusing .cell.match { font-weight:600; box-shadow:inset 0 0 0 2px hsl(var(--h), 55%, 50%); }
.pm { display:flex; flex-direction:column; gap:3px; }
.pm .item { position:relative; flex:1 0 auto; min-height:34px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:7px 4px 11px; box-sizing:border-box; border:1px dashed hsla(var(--h),50%,50%,.6); background:repeating-linear-gradient(135deg, hsla(var(--h),50%,55%,.14) 0 6px, hsla(var(--h),50%,55%,.06) 6px 12px); overflow:hidden; }
.pm .n { font-size:1.05em; line-height:1.2; max-width:100%; hyphens:auto; -webkit-hyphens:auto; overflow-wrap:anywhere; }
.pm .t { font-size:.8em; color:var(--secondary-text-color); font-variant-numeric:tabular-nums; margin-top:2px; }
.pm .item.now { outline:2px solid var(--primary-color); outline-offset:-2px; border-color:transparent; background:color-mix(in srgb, var(--primary-color) 22%, transparent); }
.pm .item.now .n { font-weight:600; }
.pmempty { min-height:34px; }
.bar { position:absolute; left:0; bottom:0; height:5px; background:var(--primary-color); }
.breakrow { grid-column: span 5; position:relative; display:flex; align-items:center; justify-content:center; font-size:.82em; color:var(--secondary-text-color); letter-spacing:.06em; text-transform:uppercase; min-height:16px; overflow:hidden; }
.breakrow::before, .breakrow::after { content:""; flex:1; height:1px; background:var(--divider-color); margin:0 8px; }
.breakrow.now { background:color-mix(in srgb, var(--primary-color) 18%, transparent); color:var(--primary-text-color); font-weight:600; min-height:22px; }
@container (max-width: 480px) {
  ha-card { padding:10px 8px 12px; }
  .grid { gap:3px; }
  .time { font-size:.78em; padding:0 4px 0 0; }
  .cell { font-size:.76em; padding:2px 1px; letter-spacing:-.01em; }
  .dayhead { font-size:.95em; }
  .pm .n { font-size:.72em; letter-spacing:-.01em; }
  .pm .item.now .n { font-weight:500; }
  .pm .t { font-size:.66em; }
  .pm .item { padding:5px 1px 9px; }
}
`;

const EDIT_STYLE = `
.wrap { color:var(--primary-text-color); container-type:inline-size; }
.section { font-weight:500; margin:18px 2px 10px; color:var(--primary-text-color); font-size:1.1em; }
.section:first-child { margin-top:4px; }
.sub { font-weight:500; margin:14px 2px 8px; color:var(--secondary-text-color); text-transform:uppercase; font-size:.8em; letter-spacing:.08em; }
.opts { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
.opts label { display:flex; flex-direction:column; gap:4px; font-size:.85em; color:var(--secondary-text-color); }
.pick { margin-bottom:6px; }
.slots { display:flex; flex-direction:column; gap:6px; }
.slot { display:grid; grid-template-columns: minmax(90px,140px) 70px 70px 30px; gap:6px; align-items:center; padding:4px; border-radius:8px; }
.slot.break { background:var(--secondary-background-color); }
input, select { font:inherit; font-size:1em; color:var(--primary-text-color); background:var(--card-background-color, var(--primary-background-color)); border:1px solid var(--divider-color); border-radius:6px; padding:7px 6px; min-width:0; box-sizing:border-box; width:100%; }
input.tm { text-align:center; font-variant-numeric:tabular-nums; }
input.bad { border-color:var(--error-color, #db4437); outline:1px solid var(--error-color, #db4437); background:color-mix(in srgb, var(--error-color, #db4437) 14%, var(--card-background-color, #fff)); }
input:focus, select:focus { outline:2px solid var(--primary-color); outline-offset:-1px; border-color:transparent; }
button.x { font-size:1.4em; line-height:1; background:none; border:none; color:var(--secondary-text-color); cursor:pointer; padding:2px; border-radius:50%; }
button.x:hover { color:var(--error-color, #db4437); }
.adds { display:flex; gap:6px; margin:8px 0 4px; flex-wrap:wrap; }
.adds button, .foot button { font:inherit; font-size:1em; border:1px solid var(--divider-color); background:none; color:var(--primary-text-color); border-radius:18px; padding:7px 14px; cursor:pointer; }
.foot button:disabled { opacity:.45; cursor:default; }
.editgrid .cellin { text-align:center; padding:8px 2px; }
.foot { display:flex; justify-content:flex-end; align-items:center; gap:8px; margin-top:14px; flex-wrap:wrap; }
.foot .state { flex:1; color:var(--warning-color, #ff9800); font-size:.9em; }
.foot .primary { background:var(--primary-color); border-color:var(--primary-color); color:var(--text-primary-color,#fff); }
.hint { margin-top:8px; font-size:.82em; color:var(--secondary-text-color); text-align:right; }
.pmdays { display:flex; flex-direction:column; gap:8px; }
.pmday { border:1px solid var(--divider-color); border-radius:8px; padding:8px 10px; }
.pmhead { font-weight:500; margin-bottom:6px; }
.pmrow { display:grid; grid-template-columns: minmax(80px,1fr) 66px 66px 30px; gap:6px; align-items:center; margin-bottom:6px; }
.pmfoot { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.pmfoot .add { font:inherit; font-size:.9em; border:1px solid var(--divider-color); background:none; color:var(--primary-text-color); border-radius:18px; padding:5px 12px; cursor:pointer; }
.pmfoot .link { font:inherit; font-size:.85em; border:none; background:none; color:var(--primary-color); cursor:pointer; padding:4px; }
@container (max-width: 480px) {
  .opts { grid-template-columns: 1fr; }
  .slot { grid-template-columns: 1fr 64px 64px 30px; }
  .grid { gap:3px; }
  .time { font-size:.78em; padding:0 4px 0 0; }
  .editgrid .cellin { font-size:.85em; padding:8px 1px; }
}
`;

if (!customElements.get("sleek-school-schedule-card-editor"))
  customElements.define("sleek-school-schedule-card-editor", SleekSchoolScheduleCardEditor);
if (!customElements.get("sleek-school-schedule-card")) {
  customElements.define("sleek-school-schedule-card", SleekSchoolScheduleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sleek-school-schedule-card",
    name: "Sleek School Schedule",
    description: "Timetable with the current lesson highlighted",
    preview: false,
  });
  console.info("%c SLEEK-SCHOOL-SCHEDULE-CARD %c " + VERSION + " ", "background:#03a9f4;color:#fff", "");
}
