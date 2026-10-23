/* Sleek School Schedule card for Home Assistant (loaded automatically by the integration).
 *
 * - SleekSchoolScheduleCard shows the timetable. It only displays; the data comes from the
 *   integration via WebSocket and is updated live when a timetable is saved anywhere.
 * - SleekSchoolScheduleCardEditor is the visual editor (edit dashboard > open card): card options
 *   plus the timetable itself, which is saved directly with its own button.
 *
 * Texts: frontend/i18n/<language>.json, English is the fallback for missing keys.
 * Weekdays are numbered like in the integration: 0 = Monday ... 6 = Sunday.
 */

const VERSION = "2.3.0-beta.2";
const WS = "sleek_school_schedule";
const I18N_URL = "/sleek_school_schedule_files/i18n/";
const LANGUAGES = ["en", "de", "fr", "nl", "es", "it", "pl"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_SCHOOL_DAYS = [0, 1, 2, 3, 4];
const APPEARANCES = ["auto", "light", "dark"]; // auto = follow the Home Assistant theme
const HIGHLIGHT_RESET_MS = 20000; // a tapped subject stays highlighted this long
// Length in minutes of new entries in the editor (lessons and breaks copy the length of the existing ones if there are any)
const DEFAULT_LENGTH = { lesson: 45, break: 15, afternoon: 120 };

/* ---------------------------------------------------------------------
 * Translations
 * --------------------------------------------------------------------- */

const i18nCache = {};

const pickLanguage = (hass) => {
  const raw = String(hass?.locale?.language || hass?.language || "en").toLowerCase().replace("_", "-");
  if (LANGUAGES.includes(raw)) return raw;
  const base = raw.split("-")[0];
  return LANGUAGES.includes(base) ? base : "en";
};

/** Locale for formatting weekday names, also for languages without a translation file. */
const pickLocale = (hass) => {
  const raw = String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([raw]).length ? raw : "en";
  } catch (e) {
    return "en";
  }
};

const deepMerge = (target, source) => {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) target[key] = deepMerge({ ...(target[key] || {}) }, value);
    else target[key] = value;
  }
  return target;
};

const fetchLanguage = async (lang) => {
  const response = await fetch(`${I18N_URL}${lang}.json?v=${VERSION}`);
  if (!response.ok) throw new Error(`${lang}: HTTP ${response.status}`);
  return response.json();
};

/** Strings of a language merged over English. A failed download is retried next time. */
const loadStrings = (lang) =>
  (i18nCache[lang] ||= (async () => {
    const english = await fetchLanguage("en");
    return lang === "en" ? english : deepMerge(english, await fetchLanguage(lang));
  })().catch((e) => {
    delete i18nCache[lang];
    console.warn("sleek-school-schedule-card: translations could not be loaded", e);
    return {};
  }));

/** Translate "section.key", replacing {placeholders}. */
const tr = (strings, key, vars = {}) => {
  const text = key.split(".").reduce((o, k) => (o ? o[k] : undefined), strings);
  return String(text ?? key).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");
};

/* ---------------------------------------------------------------------
 * Time and weekdays
 * --------------------------------------------------------------------- */

const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKDAY_SHORT_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const toMin = (t) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return h * 60 + m;
};
const fromMin = (m) => {
  m = Math.max(0, Math.min(23 * 60 + 59, m));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
/** "8.5"/"8:05" -> "08:05", null if it is not a valid time. */
const parseTime = (v) => {
  const m = String(v || "").trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};

/** Weekday name from the browser (Intl), so it needs no translation. */
const dayName = (locale, day, style) => {
  // 1 January 2024 was a Monday
  const name = new Intl.DateTimeFormat(locale, { weekday: style }).format(new Date(2024, 0, 1 + day)).replace(/\.$/, "");
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
};

/** Today's weekday and minute of the day, in the time zone chosen in the user's profile (browser or server). */
const clock = (hass) => {
  const now = new Date();
  const zone = hass?.locale?.time_zone === "server" ? hass?.config?.time_zone : null;
  if (zone) {
    try {
      const parts = {};
      const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
      for (const part of format.formatToParts(now)) parts[part.type] = part.value;
      return { day: WEEKDAY_SHORT_EN.indexOf(parts.weekday), minute: +parts.hour * 60 + +parts.minute };
    } catch (e) {
      /* unknown time zone: use the browser time */
    }
  }
  return { day: (now.getDay() + 6) % 7, minute: now.getHours() * 60 + now.getMinutes() };
};

/** First day of the week from the user's profile, otherwise from the language (0 = Monday). */
const firstWeekday = (hass, locale) => {
  const setting = WEEKDAY_KEYS.indexOf(hass?.locale?.first_weekday);
  if (setting >= 0) return setting;
  try {
    const intl = new Intl.Locale(locale);
    const first = (intl.getWeekInfo?.() || intl.weekInfo)?.firstDay; // 1 = Monday ... 7 = Sunday
    if (first) return (first + 6) % 7;
  } catch (e) {
    /* older browsers: Monday */
  }
  return 0;
};

/** Days in calendar order, starting with the first day of the week. */
const weekOrder = (days, first) => [...days].sort((a, b) => ((a - first + 7) % 7) - ((b - first + 7) % 7));

/* ---------------------------------------------------------------------
 * Plan helpers (same rules as logic.py in the integration)
 * --------------------------------------------------------------------- */

const schoolDays = (plan) => (Array.isArray(plan?.school_days) && plan.school_days.length ? plan.school_days : DEFAULT_SCHOOL_DAYS);
const sortSlots = (slots) => [...slots].sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end));
const cellText = (plan, day, slot) => ((plan.days?.[String(day)] || {})[slot.id] || "").trim();
const afternoonItems = (plan, day) =>
  ((plan.afternoon || {})[String(day)] || [])
    .filter((e) => (e.name || "").trim() && parseTime(e.start) && parseTime(e.end))
    .sort((a, b) => toMin(a.start) - toMin(b.start));

/** First and last minute of the filled lessons of a day (breaks only count in between). */
const lessonBounds = (plan, day) => {
  const lessons = plan.slots.filter((s) => s.type === "lesson" && cellText(plan, day, s));
  if (!lessons.length) return null;
  return { first: Math.min(...lessons.map((s) => toMin(s.start))), last: Math.max(...lessons.map((s) => toMin(s.end))) };
};

/* ---------------------------------------------------------------------
 * Small helpers
 * --------------------------------------------------------------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Color hue of a subject, always the same for the same name. */
const hue = (s) => {
  let h = 7;
  for (const c of s.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
const uid = () => "s" + Math.random().toString(36).slice(2, 10);
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorText = (e) => e?.message || String(e);
const matchChild = (child, wanted) => child.entry_id === wanted || child.title.toLowerCase() === String(wanted).toLowerCase();
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

/* ---------------------------------------------------------------------
 * Updates: card code and integration must have the same version
 * --------------------------------------------------------------------- */

/** Negative if version a is older than b. "2.3.0-beta.1" is older than "2.3.0". */
const compareVersions = (a, b) => {
  const parse = (v) => {
    const [main, pre = ""] = String(v).split("-");
    return { numbers: main.split(".").map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.numbers[i] || 0) !== (y.numbers[i] || 0)) return (x.numbers[i] || 0) - (y.numbers[i] || 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre || !y.pre) return x.pre ? -1 : 1; // a pre-release comes before the release
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
};

/**
 * Compares the running integration with this card code:
 * "restart" = the update was downloaded but Home Assistant still runs the old integration,
 * "reload"  = the page still runs old card code (Home Assistant was restarted after an update),
 * null      = same version (or the integration is too old to tell).
 */
const checkVersion = async (hass) => {
  let version;
  try {
    ({ version } = await hass.callWS({ type: `${WS}/version` }));
  } catch (e) {
    return null;
  }
  if (version === VERSION) return null;
  return { state: compareVersions(version, VERSION) < 0 ? "restart" : "reload", version };
};

/* =====================================================================
 * Card (display only)
 * ===================================================================== */

class SleekSchoolScheduleCard extends HTMLElement {
  constructor() {
    super();
    // The styles are added once; every render only replaces the content of ha-card
    this.attachShadow({ mode: "open" }).innerHTML = `<style>${BASE_STYLE}${VIEW_STYLE}</style><ha-card></ha-card>`;
    this._card = this.shadowRoot.querySelector("ha-card");
    this._card.addEventListener("click", (e) => this._onClick(e));
    this._onVisible = () => document.visibilityState === "visible" && this._render();
    this._config = {};
    this._children = [];
    this._plans = {};
    this._size = 7;
  }

  static getConfigElement() {
    return document.createElement("sleek-school-schedule-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    const childChanged = (config?.child || "") !== (this._config.child || "");
    this._config = config || {};
    if (!this._hass) return;
    // Title and appearance only need a new render; another child needs its data
    if (childChanged) this._load();
    else this._render();
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

  getCardSize() {
    return this._size;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    this._scheduleTick();
    document.addEventListener("visibilitychange", this._onVisible);
    if (this._hass) this._subscribe();
  }

  disconnectedCallback() {
    clearTimeout(this._tick);
    clearTimeout(this._focusTimer);
    document.removeEventListener("visibilitychange", this._onVisible);
    this._unsubscribe();
  }

  t(key, vars) {
    return tr(this._s, key, vars);
  }

  async _loadStrings() {
    this._lang = pickLanguage(this._hass);
    this._locale = pickLocale(this._hass);
    this._s = await loadStrings(this._lang);
  }

  /** Render again at every full minute (current lesson and progress bar). */
  _scheduleTick() {
    clearTimeout(this._tick);
    this._tick = setTimeout(() => {
      this._render();
      this._scheduleTick();
    }, 60000 - (Date.now() % 60000) + 50);
  }

  /* ---------------- Data ---------------- */

  /** Live update: the integration reports which child changed (saved, added, renamed, removed). */
  _subscribe() {
    if (this._unsub || !this._hass?.connection) return;
    this._unsub = this._hass.connection
      .subscribeMessage((event) => this._load(event?.entry_id), { type: `${WS}/subscribe` })
      .catch(() => (this._unsub = null));
    // "ready" fires after every reconnect, e.g. when Home Assistant restarted after an update
    this._onReady = () => this._checkVersion();
    this._hass.connection.addEventListener?.("ready", this._onReady);
    this._checkVersion();
  }

  async _unsubscribe() {
    const pending = this._unsub;
    this._unsub = null;
    if (this._onReady) this._hass?.connection?.removeEventListener?.("ready", this._onReady);
    this._onReady = null;
    if (pending) (await pending)?.();
  }

  /** Loads the children and their plans; with changedId only that plan (plus new children) is fetched again. */
  async _load(changedId) {
    if (!this._s) await this._loadStrings();
    try {
      let children = await this._hass.callWS({ type: `${WS}/list` });
      if (this._config.child) children = children.filter((c) => matchChild(c, this._config.child));
      const stale = children.filter((c) => !changedId || c.entry_id === changedId || !this._plans[c.entry_id]);
      const fetched = await Promise.all(stale.map((c) => this._hass.callWS({ type: `${WS}/get`, entry_id: c.entry_id })));
      const plans = {};
      for (const c of children) plans[c.entry_id] = this._plans[c.entry_id];
      stale.forEach((c, i) => (plans[c.entry_id] = fetched[i]));
      this._children = children;
      this._plans = plans;
      if (!children.some((c) => c.entry_id === this._active)) this._active = children[0]?.entry_id;
      this._error = null;
    } catch (e) {
      this._error = errorText(e);
    }
    this._render();
  }

  /** Shows a hint when Home Assistant has to be restarted or the page reloaded after an update. */
  async _checkVersion() {
    let update = await checkVersion(this._hass);
    if (update?.state === "reload" && sessionGet(`sss-reloaded-${update.version}`)) update = null; // reload at most once per version
    if (JSON.stringify(update) !== JSON.stringify(this._update ?? null)) {
      this._update = update;
      this._render();
    }
  }

  /* ---------------- Interaction ---------------- */

  _onClick(e) {
    if (e.target.closest("[data-reload]")) {
      sessionSet(`sss-reloaded-${this._update.version}`, "1");
      location.reload();
      return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      this._active = tab.dataset.tab;
      this._setFocus(null);
      this._render();
      return;
    }
    // Tapping a subject (lessons only, not the afternoon) highlights it everywhere; anything else resets
    const key = e.target.closest(".cell.filled[data-key]")?.dataset.key;
    this._setFocus(key && key !== this._focus ? key : null);
  }

  _setFocus(key) {
    clearTimeout(this._focusTimer);
    this._focus = key || null;
    if (this._focus) this._focusTimer = setTimeout(() => this._setFocus(null), HIGHLIGHT_RESET_MS);
    this._applyFocus();
  }

  _applyFocus() {
    const grid = this._card.querySelector(".grid.view");
    if (!grid) return;
    grid.classList.toggle("focusing", !!this._focus);
    grid.querySelectorAll(".cell[data-key]").forEach((el) => el.classList.toggle("match", el.dataset.key === this._focus));
  }

  /* ---------------- Rendering ---------------- */

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

    let update = "";
    if (this._update?.state === "reload") update = `<button class="update" data-reload>${esc(this.t("card.update_available"))}</button>`;
    if (this._update?.state === "restart") update = `<div class="update">${esc(this.t("card.restart_needed"))}</div>`;
    // "light" or "dark" forces the colors, "auto" follows the theme
    this._card.className = ["light", "dark"].includes(this._config.appearance) ? `mode-${this._config.appearance}` : "";
    this._card.lang = this._lang;
    this._card.innerHTML = `${update}${this._renderHeader()}${body}`;
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
    const days = weekOrder(schoolDays(plan), firstWeekday(this._hass, this._locale));
    const slots = sortSlots(plan.slots);
    const { day: today, minute } = clock(this._hass);
    const bounds = days.includes(today) ? lessonBounds(plan, today) : null;

    // Only rows that are used on at least one day, breaks only between used rows
    const used = slots.map((s) => s.type !== "break" && days.some((d) => cellText(plan, d, s)));
    const firstUsed = used.indexOf(true);
    const lastUsed = used.lastIndexOf(true);
    const hasAfternoon = days.some((d) => afternoonItems(plan, d).length);
    if (firstUsed < 0 && !hasAfternoon) return `<div class="msg">${esc(this.t("card.empty"))}</div>`;
    const rows = firstUsed < 0 ? [] : slots.filter((s, i) => i >= firstUsed && i <= lastUsed && (s.type === "break" || used[i]));

    // Breaks are only current between the first and last lesson (as in the integration)
    const isNow = (s) =>
      bounds &&
      toMin(s.start) <= minute &&
      minute < toMin(s.end) &&
      (s.type !== "break" || (toMin(s.start) >= bounds.first && toMin(s.end) <= bounds.last));
    const progressBar = (s) =>
      `<i class="bar" style="width:${Math.round(((minute - toMin(s.start)) / (toMin(s.end) - toMin(s.start))) * 100)}%"></i>`;

    let html = `<div class="grid view" style="--days:${days.length}"><div class="corner"></div>`;
    html += days.map((d) => `<div class="dayhead ${d === today ? "today" : ""}">${esc(dayName(this._locale, d, "short"))}</div>`).join("");

    for (const s of rows) {
      if (s.type === "break") {
        const active = isNow(s);
        html += `<div class="time break"></div>`;
        html += `<div class="breakrow ${active ? "now" : ""}"><span>${esc(this.t("card.break"))}</span>${active ? progressBar(s) : ""}</div>`;
        continue;
      }
      html += `<div class="time ${s.type}"><span class="t">${esc(s.start)}<br>${esc(s.end)}</span></div>`;
      for (const d of days) {
        const text = cellText(plan, d, s);
        const active = d === today && text && isNow(s);
        const cls = ["cell", s.type, text ? "filled" : "empty", d === today ? "todaycol" : "", active ? "now" : ""].join(" ");
        const attrs = text ? `style="--h:${hue(text)}" data-key="${esc(text.toLowerCase())}"` : "";
        html += `<div class="${cls}" ${attrs} title="${esc(text)}"><span>${esc(text)}</span>${active ? progressBar(s) : ""}</div>`;
      }
    }

    // Afternoon: one row, entries with their own times per day
    if (hasAfternoon) {
      html += `<div class="time pmtime"></div>`;
      for (const d of days) {
        const items = afternoonItems(plan, d);
        if (!items.length) {
          html += `<div class="cell empty pmempty ${d === today ? "todaycol" : ""}"></div>`;
          continue;
        }
        html += `<div class="pm">${items
          .map((e) => {
            const current = d === today && toMin(e.start) <= minute && minute < toMin(e.end);
            return `<div class="item ${current ? "now" : ""}" style="--h:${hue(e.name.trim())}">
              <span class="n">${esc(e.name)}</span><span class="t">${esc(e.start)}-${esc(e.end)}</span>${current ? progressBar(e) : ""}</div>`;
          })
          .join("")}</div>`;
      }
    }

    // Height for masonry dashboards (1 unit = 50 px): header, weekdays, lessons, breaks, afternoon
    const lessonRows = rows.filter((s) => s.type !== "break").length;
    this._size = Math.max(3, Math.round(2 + lessonRows + (rows.length - lessonRows) * 0.4 + (hasAfternoon ? 2 : 0)));
    return html + `</div>`;
  }
}

/* =====================================================================
 * Card editor (left side of the edit dialog)
 * ===================================================================== */

class SleekSchoolScheduleCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `<style>${BASE_STYLE}${EDIT_STYLE}</style><div class="wrap"></div>`;
    this._wrap = this.shadowRoot.querySelector(".wrap");
    // One listener per event type for the whole editor (the content is re-rendered often)
    this.shadowRoot.addEventListener("input", (e) => this._onInput(e));
    this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("focusout", (e) => this._onFocusOut(e));
    this._children = [];
    this._config = {};
  }

  setConfig(config) {
    const previousChild = this._config.child;
    this._config = { ...(config || {}) };
    // Only reload when the child selection changed (do not interrupt typing the title)
    if (this._loaded && previousChild !== this._config.child) this._selectFromConfig();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
  }

  t(key, vars) {
    return tr(this._s, key, vars);
  }

  /* ---------------- Data ---------------- */

  async _load() {
    this._lang = pickLanguage(this._hass);
    this._locale = pickLocale(this._hass);
    this._s = await loadStrings(this._lang);
    this._restartNeeded = (await checkVersion(this._hass))?.state === "restart";
    try {
      this._children = await this._hass.callWS({ type: `${WS}/list` });
      this._error = null;
    } catch (e) {
      this._error = errorText(e);
    }
    this._loaded = true;
    this._selectFromConfig();
  }

  _selectFromConfig() {
    const fixed = this._config.child ? this._children.find((c) => matchChild(c, this._config.child)) : null;
    const keep = this._children.some((c) => c.entry_id === this._editId) ? this._editId : this._children[0]?.entry_id;
    this._openPlan(fixed?.entry_id || keep);
  }

  async _openPlan(id) {
    this._editId = id;
    this._draft = null;
    this._dirty = false;
    this._bad = null;
    this._msg = null;
    if (id) {
      try {
        this._draft = this._prepare(await this._hass.callWS({ type: `${WS}/get`, entry_id: id }));
      } catch (e) {
        this._error = errorText(e);
      }
    }
    this._render();
  }

  /** Working copy of a plan with all parts present. */
  _prepare(plan) {
    const draft = clone(plan);
    draft.slots = sortSlots(draft.slots || []);
    draft.school_days = [...schoolDays(draft)];
    draft.days ||= {};
    draft.afternoon ||= {};
    for (const day of ALL_DAYS) {
      draft.days[day] ||= {};
      draft.afternoon[day] ||= [];
    }
    return draft;
  }

  get _days() {
    return weekOrder(this._draft.school_days, firstWeekday(this._hass, this._locale));
  }

  /** Change a card option and tell Home Assistant. Options the editor does not know (layout, visibility, ...) are kept. */
  _setOption(key, value) {
    const config = { ...this._config };
    if (value && !(key === "appearance" && value === "auto")) config[key] = value;
    else delete config[key];
    config.type ||= "custom:sleek-school-schedule-card";
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  /** The timetable was changed: mark it unsaved and render again (structural changes) or only update the footer (typing). */
  _changed({ rerender }) {
    const first = !this._dirty;
    this._dirty = true;
    this._msg = null;
    if (rerender) {
      this._render();
    } else if (first) {
      this._wrap.querySelector(".state").textContent = this.t("editor.unsaved");
      this._wrap.querySelector("[data-act=revert]").disabled = false;
      this._wrap.querySelector("[data-act=save]").disabled = !!this._restartNeeded;
      this._wrap.querySelector(".msg.ok")?.remove();
    }
  }

  /* ---------------- Rendering ---------------- */

  _render() {
    const multi = this._children.length > 1;

    // Card options
    let html = `<div class="section">${esc(this.t("editor.card"))}</div><div class="opts">`;
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
    if (this._restartNeeded) html += `<div class="msg err">${esc(this.t("card.restart_needed"))}</div>`;
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

    this._wrap.lang = this._lang;
    this._wrap.innerHTML = html;
  }

  _renderForm() {
    const d = this._draft;
    const days = this._days;
    this._bad = this._validate();
    const subjects = [
      ...new Set(
        [...Object.values(d.days).flatMap((x) => Object.values(x)), ...Object.values(d.afternoon).flatMap((x) => x.map((e) => e.name))]
          .map((x) => (x || "").trim())
          .filter(Boolean)
      ),
    ].sort();
    const timeInput = (key, value, placeholder, data) =>
      `<input class="tm ${this._bad?.has(key) ? "bad" : ""}" ${data} value="${esc(value)}" placeholder="${placeholder}" maxlength="5" inputmode="numeric" autocomplete="off">`;

    // School days
    let html = `<div class="sub">${esc(this.t("editor.school_days"))}</div><div class="days">`;
    html += weekOrder(ALL_DAYS, firstWeekday(this._hass, this._locale))
      .map((day) => {
        const on = d.school_days.includes(day);
        return `<button class="day ${on ? "on" : ""}" data-act="day" data-day="${day}" aria-pressed="${on}">${esc(dayName(this._locale, day, "short"))}</button>`;
      })
      .join("");
    html += `</div>`;

    // Time grid (order stays as entered; overlaps are marked, never re-sorted)
    html += `<div class="sub">${esc(this.t("editor.time_grid"))}</div><div class="slots">`;
    for (const s of d.slots) {
      html += `<div class="slot ${s.type}">
        <select data-slot="${s.id}" data-k="type">${["lesson", "break"]
          .map((k) => `<option value="${k}" ${k === s.type ? "selected" : ""}>${esc(this.t(`editor.${k}`))}</option>`)
          .join("")}</select>
        ${timeInput(s.id + "start", s.start, "08:00", `data-slot="${s.id}" data-k="start"`)}
        ${timeInput(s.id + "end", s.end, "08:45", `data-slot="${s.id}" data-k="end"`)}
        <button class="x" data-act="del" data-id="${s.id}" title="${esc(this.t("editor.remove"))}">×</button>
      </div>`;
    }
    html += `</div><div class="adds">
      <button data-act="add" data-type="lesson">${esc(this.t("editor.add_lesson"))}</button>
      <button data-act="add" data-type="break">${esc(this.t("editor.add_break"))}</button>
    </div>`;

    // Subjects per day
    html += `<div class="sub">${esc(this.t("editor.subjects"))}</div><div class="grid editgrid" style="--days:${days.length}"><div class="corner"></div>`;
    html += days.map((day) => `<div class="dayhead">${esc(dayName(this._locale, day, "short"))}</div>`).join("");
    for (const s of d.slots) {
      if (s.type === "break") continue;
      html += `<div class="time ${s.type}"><span class="t" data-show="${s.id}start">${esc(s.start)}</span></div>`;
      for (const day of days) {
        html += `<input class="cellin ${s.type}" list="subjects" data-cell="${s.id}" data-day="${day}" value="${esc(d.days[day][s.id] || "")}" maxlength="60">`;
      }
    }
    html += `</div><datalist id="subjects">${subjects.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;

    // Afternoon per day
    html += `<div class="sub">${esc(this.t("editor.afternoon"))}</div><div class="pmdays">`;
    for (const day of days) {
      const items = d.afternoon[day];
      html += `<div class="pmday"><div class="pmhead">${esc(dayName(this._locale, day, "long"))}</div>`;
      items.forEach((e, i) => {
        const k = `${day}-${i}`;
        html += `<div class="pmrow">
          <input data-pm="${k}" data-k="name" value="${esc(e.name)}" placeholder="${esc(this.t("editor.entry_placeholder"))}" maxlength="60" list="subjects">
          ${timeInput(`pm${k}start`, e.start, "13:00", `data-pm="${k}" data-k="start"`)}
          ${timeInput(`pm${k}end`, e.end, "15:00", `data-pm="${k}" data-k="end"`)}
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
      <button class="primary" data-act="save" ${this._saving || !this._dirty || this._restartNeeded ? "disabled" : ""}>${esc(this.t("editor.save"))}</button>
    </div>
    <div class="hint">${esc(this.t("editor.save_hint"))}</div>`;
    return html;
  }

  /* ---------------- Events ---------------- */

  _onInput(e) {
    const el = e.target;
    if (el.tagName === "SELECT") return; // handled in _onChange
    const { cfg, slot, pm, cell, k } = el.dataset;
    if (cfg) {
      this._setOption(cfg, el.value.trim());
    } else if (slot) {
      const item = this._draft.slots.find((s) => s.id === slot);
      if (!item) return;
      item[k] = el.value;
      el.classList.remove("bad");
      const shown = this._wrap.querySelector(`[data-show="${slot}${k}"]`); // time in the subjects grid
      if (shown) shown.textContent = el.value;
      this._changed({ rerender: false });
    } else if (pm) {
      const [day, i] = pm.split("-");
      const item = this._draft.afternoon[day]?.[+i];
      if (!item) return;
      item[k] = el.value;
      el.classList.remove("bad");
      this._changed({ rerender: false });
    } else if (cell) {
      this._draft.days[el.dataset.day][cell] = el.value;
      this._changed({ rerender: false });
    }
  }

  _onChange(e) {
    const el = e.target;
    if (el.tagName !== "SELECT") return; // text fields are handled in _onInput
    if (el.dataset.cfg) {
      this._setOption(el.dataset.cfg, el.value);
      if (el.dataset.cfg === "child") this._selectFromConfig();
    } else if (el.dataset.slot) {
      const slot = this._draft.slots.find((s) => s.id === el.dataset.slot);
      if (slot) slot.type = el.value;
      this._changed({ rerender: true });
    }
  }

  /** Time fields and afternoon names are checked when leaving the field (red background, no re-render). */
  _onFocusOut(e) {
    if (!e.target.matches?.("input.tm, [data-pm][data-k=name]")) return;
    this._bad = this._validate();
    this._showBad();
  }

  /** Update the red markers in the existing fields without re-rendering (keeps the focus). */
  _showBad() {
    this._wrap.querySelectorAll("input.tm").forEach((el) => {
      const key = el.dataset.slot ? el.dataset.slot : `pm${el.dataset.pm}`;
      el.classList.toggle("bad", this._bad.has(key + el.dataset.k));
    });
  }

  _onClick(e) {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      if (pick.dataset.pick === this._editId) return;
      if (this._dirty && !confirm(this.t("editor.discard_confirm"))) return;
      this._openPlan(pick.dataset.pick);
      return;
    }
    const button = e.target.closest("[data-act]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    this._onAction(button);
  }

  async _onAction(el) {
    const d = this._draft;
    switch (el.dataset.act) {
      case "day": {
        const day = +el.dataset.day;
        const on = d.school_days.includes(day);
        if (on && d.school_days.length === 1) return; // at least one school day
        d.school_days = on ? d.school_days.filter((x) => x !== day) : [...d.school_days, day].sort((a, b) => a - b);
        this._changed({ rerender: true });
        break;
      }
      case "del":
        d.slots = d.slots.filter((s) => s.id !== el.dataset.id);
        this._changed({ rerender: true });
        break;
      case "add": {
        const type = el.dataset.type;
        const start = this._latestEnd(d.slots) ?? 8 * 60;
        const length = this._lengthOf(d.slots.filter((s) => s.type === type), type);
        d.slots.push({ id: uid(), type, start: fromMin(start), end: fromMin(start + length) });
        this._changed({ rerender: true });
        break;
      }
      case "pmadd": {
        const items = d.afternoon[el.dataset.day];
        const start = this._latestEnd(items) ?? 13 * 60;
        items.push({ name: "", start: fromMin(start), end: fromMin(start + DEFAULT_LENGTH.afternoon) });
        this._changed({ rerender: true });
        this._wrap.querySelector(`[data-pm="${el.dataset.day}-${items.length - 1}"][data-k=name]`)?.focus();
        break;
      }
      case "pmdel":
        d.afternoon[el.dataset.day].splice(+el.dataset.i, 1);
        this._changed({ rerender: true });
        break;
      case "pmcopy": {
        const source = el.dataset.day;
        const others = this._days.filter((day) => String(day) !== source && d.afternoon[day].length);
        if (others.length && !confirm(this.t("editor.copy_confirm", { day: dayName(this._locale, +source, "long") }))) return;
        for (const day of this._days) if (String(day) !== source) d.afternoon[day] = clone(d.afternoon[source]);
        this._changed({ rerender: true });
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

  /** End of the latest valid entry in minutes, or null. New entries start there. */
  _latestEnd(items) {
    const ends = items.map((x) => parseTime(x.end)).filter(Boolean).map(toMin);
    return ends.length ? Math.max(...ends) : null;
  }

  /** Length of the latest valid slot of the same kind, so a new lesson is as long as the existing ones. */
  _lengthOf(items, kind) {
    const valid = items.filter((x) => parseTime(x.start) && parseTime(x.end) && toMin(x.end) > toMin(x.start));
    const latest = valid.sort((a, b) => toMin(b.start) - toMin(a.start))[0];
    return latest ? toMin(latest.end) - toMin(latest.start) : DEFAULT_LENGTH[kind];
  }

  /** Keys of all invalid time fields: format, start before end, no overlap with the previous entry. */
  _validate() {
    const bad = new Set();
    if (!this._draft) return bad;
    const check = (rows) => {
      let previous = null;
      for (const { item, key } of rows) {
        const start = parseTime(item.start);
        const end = parseTime(item.end);
        if (start === null) bad.add(key + "start");
        if (end === null) bad.add(key + "end");
        if (start === null || end === null) {
          previous = null;
          continue;
        }
        if (toMin(start) >= toMin(end)) bad.add(key + "end");
        if (previous && toMin(start) < previous.end) {
          bad.add(key + "start");
          bad.add(previous.key + "end");
        }
        previous = { end: toMin(end), key };
      }
    };
    check(this._draft.slots.map((s) => ({ item: s, key: s.id })));
    for (const day of this._days) {
      // empty afternoon entries are ignored (and dropped when saving)
      check(this._draft.afternoon[day].flatMap((item, i) => ((item.name || "").trim() ? [{ item, key: `pm${day}-${i}` }] : [])));
    }
    return bad;
  }

  async _save() {
    this._bad = this._validate();
    if (this._bad.size) {
      this._showBad();
      return;
    }
    const d = this._draft;
    for (const s of d.slots) {
      s.start = parseTime(s.start);
      s.end = parseTime(s.end);
    }
    for (const day of ALL_DAYS) {
      d.afternoon[day] = d.afternoon[day]
        .filter((e) => (e.name || "").trim())
        .map((e) => ({ name: e.name.trim(), start: parseTime(e.start), end: parseTime(e.end) }));
    }
    this._bad = null;
    this._saving = true;
    this._render();
    try {
      this._draft = this._prepare(await this._hass.callWS({ type: `${WS}/save`, entry_id: this._editId, plan: d }));
      this._dirty = false;
      this._msg = { err: false, text: this.t("editor.saved") };
    } catch (e) {
      this._msg = { err: true, text: errorText(e) };
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
.grid { display:grid; grid-template-columns: minmax(44px,auto) repeat(var(--days, 5), minmax(0,1fr)); gap:4px; align-items:stretch; }
.dayhead { text-align:center; font-weight:500; color:var(--secondary-text-color); padding:9px 0; font-size:1.05em; }
.time { display:flex; flex-direction:column; justify-content:center; padding:0 6px 0 2px; color:var(--secondary-text-color); font-size:.88em; line-height:1.25; font-variant-numeric:tabular-nums; }
`;

const VIEW_STYLE = `
ha-card.mode-light { color-scheme:light; --primary-text-color:#212121; --secondary-text-color:#727272; --divider-color:rgba(0,0,0,.12); --secondary-background-color:#e5e5e5; --card-background-color:#fff; --ha-card-background:#fff; --ha-card-border-color:#e0e0e0; }
ha-card.mode-dark { color-scheme:dark; --primary-text-color:#e1e1e1; --secondary-text-color:#9b9b9b; --divider-color:rgba(225,225,225,.12); --secondary-background-color:#282828; --card-background-color:#1c1c1c; --ha-card-background:#1c1c1c; --ha-card-border-color:rgba(225,225,225,.12); }
ha-card { display:block; padding: 12px 12px 14px; overflow:hidden; color:var(--primary-text-color); container-type:inline-size; }
.update { display:block; box-sizing:border-box; width:100%; margin:0 0 10px; padding:8px 12px; font:inherit; font-size:.92em; text-align:center; border:none; border-radius:8px; background:color-mix(in srgb, var(--primary-color) 18%, transparent); color:var(--primary-text-color); }
button.update { cursor:pointer; }
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
.breakrow { grid-column: span var(--days, 5); position:relative; display:flex; align-items:center; justify-content:center; font-size:.82em; color:var(--secondary-text-color); letter-spacing:.06em; text-transform:uppercase; min-height:16px; overflow:hidden; }
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
.days { display:flex; gap:6px; flex-wrap:wrap; }
.day { font:inherit; font-size:.95em; min-width:46px; border:1px solid var(--divider-color); background:none; color:var(--secondary-text-color); border-radius:18px; padding:6px 10px; cursor:pointer; }
.day.on { background:var(--primary-color); border-color:var(--primary-color); color:var(--text-primary-color, #fff); }
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
  .day { min-width:0; flex:1; padding:6px 4px; }
}
`;

/* =====================================================================
 * Registration
 * ===================================================================== */

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
