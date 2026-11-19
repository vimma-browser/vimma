/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's page (docs/specs/setup-v2.md), behind vimma.feature.setupV2: the welcome screen,
// one step at a time and a stop screen after each chapter. core/setup.mjs keeps the state;
// SetupHost reads the values in force and saves each step on its `enter`. A step is drawn by
// the renderer named after it in RENDERERS, else as a list of choices, so that a later step is
// a row of the step table, its id in BUILT_STEPS and, when it needs more, a renderer here.

/** @import { AddonEntry, FlowContext, FlowEffect, FlowState } from "../core/setup.mjs" */

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { SetupHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
);
const { flowAdvance, flowChapters, flowKey, flowStep, formatUsers, initialFlow } =
  ChromeUtils.importESModule("chrome://browser/content/vimma/core/setup.mjs");

const root = document.documentElement;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const search = /** @type {HTMLInputElement} */ ($("v2-search"));
/** The page's own browser: the host's key for what this page was sent, and the prompt anchor. */
const browser = () => SetupHost.browserFor(window);

/**
 * @typedef {object} StepView  what SetupHost.stepView returns
 * @property {string} id
 * @property {"setting" | "action"} kind
 * @property {string} title
 * @property {string} question
 * @property {{ tag: "kbd" | "code" | null, text: string }[]} text
 * @property {{ label: string, keep: boolean, lines: string[] }[]} choices
 * @property {number} selected
 * @property {string | null} blocked
 */

/** Stop screen headings by chapter; another chapter reads "<name>: done". */
const STOP_TITLES = /** @type {Record<string, string>} */ ({
  essentials: "The essentials are saved",
});

let state = initialFlow({ chapters: flowChapters() });
/** @type {StepView | null} the open step as the host last drew it */
let view = null;
/** Bumped by each request for a view: an older answer is dropped. */
let viewSerial = 0;
/** "busy" while a save, an install or a search runs: keys wait. */
let busy = false;
/** What the last `enter` wrote, for the footer (behaviour 12): null before one. */
/** @type {{ title: string, lines: string[], action?: boolean } | null} */
let last = null;
/** The content blocker's lists. @type {AddonEntry[]} */
let curated = [];
/** @type {AddonEntry[]} */
let addons = [];
let curatedLoaded = false;
/** @type {string[]} chapters finished before (welcome ticks) */
let finished = [];

/** @param {string} tag @param {Record<string, string>} attrs @param {...(Node | string)} kids */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** Step text as nodes, never as HTML (textParts). @param {StepView["text"]} parts */
const textNodes = (parts) => parts.map((p) => (p.tag ? el(p.tag, {}, p.text) : p.text));

/** @type {FlowContext} */
const ctx = {
  get count() {
    const step = flowStep(state);
    if (step?.id === "content_blocker") return addons.length;
    return view?.choices.length ?? 0;
  },
  // The value in force is the host's to say; a step opens on row 0 until its view arrives.
  selected: () => 0,
  get addons() {
    return addons;
  },
};

/** The footer's place in the chapter (behaviour 11). */
function place() {
  const chapter = state.chapters[state.chapter];
  if (!chapter) return "";
  if (state.screen === "stop") return `${chapter.digit}. ${chapter.name} · done`;
  return `${chapter.digit}. ${chapter.name} · step ${state.step + 1} of ${chapter.steps.length}`;
}

/** @param {string} id @returns {string} */
const titleOf = (id) =>
  state.chapters.flatMap((c) => c.steps).find((s) => s.id === id)?.title ?? id;

/** @param {import("../core/setup.mjs").FlowSaved[]} list */
function savedList(list) {
  return list.flatMap((x) =>
    x.lines.map((line) =>
      el("li", {}, el("span", { class: "what" }, titleOf(x.step)), el("code", {}, line)),
    ),
  );
}

function drawFooter() {
  const footer = $("v2-footer");
  footer.hidden = state.screen !== "step" && state.screen !== "stop";
  $("v2-place").textContent = place();
  $("v2-last").replaceChildren(
    ...(last
      ? [
          `${last.title}: `,
          ...(last.action
            ? [last.lines.join(", ")]
            : last.lines.length
              ? last.lines.flatMap((l, i) => [...(i ? [", "] : []), el("code", {}, l)])
              : ["nothing written, it was already so"]),
        ]
      : []),
  );
  $("v2-saved").replaceChildren(
    state.saved.length ? "Saved this run: " : "Nothing saved this run yet.",
    ...state.saved.flatMap((x, i) => [
      ...(i ? ["; "] : []),
      ...x.lines.flatMap((l, j) => [...(j ? [", "] : []), el("code", {}, l)]),
    ]),
  );
  const step = flowStep(state);
  /** @type {(Node | string)[]} */
  const keys = [];
  /** @param {string[]} ks @param {string} what */
  const add = (ks, what) => {
    if (keys.length) keys.push(" · ");
    ks.forEach((k, i) => keys.push(...(i ? ["/"] : []), el("kbd", {}, k)));
    keys.push(` ${what}`);
  };
  if (state.screen === "stop") {
    add(["enter"], state.done ? "close" : "go on");
    add(["h"], "back");
    add(["q"], "leave");
  } else {
    add(["j", "k"], "choose");
    if (step?.id === "content_blocker") {
      add(["space"], "mark");
      add(["/"], "search");
      add(["enter"], "install and go on");
    } else if (view?.blocked) {
      add(["enter"], "cannot save here");
    } else {
      add(["enter"], "save and go on");
    }
    add(["s"], "skip");
    add(["h"], "back");
    add(["q"], "leave");
  }
  $("v2-keys").replaceChildren(...keys);
}

function drawWelcome() {
  $("v2-chapters").replaceChildren(
    ...state.chapters.map((c) =>
      el(
        "li",
        { "data-chapter": c.id, ...(finished.includes(c.id) ? { "data-finished": "true" } : {}) },
        el("kbd", {}, String(c.digit)),
        el("span", { class: "name" }, c.name),
        el("span", { class: "steps" }, c.steps.map((s) => s.title).join(", ")),
        el(
          "span",
          { class: "tick", "aria-label": finished.includes(c.id) ? "done" : "" },
          finished.includes(c.id) ? "✓" : "",
        ),
      ),
    ),
  );
  $("v2-start").focus();
}

/** @param {StepView} v */
function drawChoices(v) {
  $("v2-choices").replaceChildren(
    ...v.choices.map((c, i) => {
      const li = el(
        "li",
        { role: "option", "data-index": String(i), ...(c.keep ? { "data-keep": "true" } : {}) },
        el("span", { class: "mark", "aria-hidden": "true" }, i === v.selected ? "●" : "○"),
        el("span", { class: "body" }, el("span", { class: "name" }, c.label)),
        el("span", { class: "meta" }, i === v.selected ? "in force" : ""),
      );
      if (i === state.cursor) li.setAttribute("aria-current", "true");
      return li;
    }),
  );
  const choice = v.choices[state.cursor];
  // editLines says "Writes nothing" for Keep or the value in force (behaviour 12).
  const nothing = !choice || choice.lines[0] === "Writes nothing";
  $("v2-writes").replaceChildren(
    ...(nothing
      ? ["Writes nothing"]
      : ["Writes ", ...choice.lines.flatMap((l, i) => [...(i ? [", "] : []), el("code", {}, l)])]),
  );
}

function drawAddons() {
  $("v2-addons").replaceChildren(
    ...addons.map((a, i) => {
      const marked = state.marked.has(a.guid);
      const li = el(
        "li",
        { role: "option", "aria-selected": String(marked), "data-guid": a.guid },
        el(
          "span",
          { class: "mark", "aria-hidden": "true" },
          a.installed ? "✓" : marked ? "●" : "○",
        ),
        el(
          "span",
          { class: "body" },
          el("span", { class: "name" }, a.name, el("span", { class: "by" }, ` by ${a.author}`)),
          el("span", { class: "summary" }, a.summary),
        ),
        el(
          "span",
          { class: "meta" },
          a.installed ? "installed" : a.users ? formatUsers(a.users) : "",
        ),
      );
      if (i === state.cursor) li.setAttribute("aria-current", "true");
      if (a.installed || !a.url) li.classList.add("disabled");
      return li;
    }),
  );
  $("v2-addons").querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
}

/**
 * Renderers by step id: the content blocker's add-on list; every other step is a list of
 * choices with the line it writes. A later step that needs more (a drawing of the window)
 * adds one here.
 * @type {Record<string, (v: StepView) => void>}
 */
const RENDERERS = {
  content_blocker() {
    $("v2-blocker").hidden = false;
    $("v2-choices").hidden = true;
    $("v2-writes-row").hidden = true;
    drawAddons();
  },
};

function drawStep() {
  const step = flowStep(state);
  if (!step) return;
  const chapter = state.chapters[state.chapter];
  $("v2-progress").textContent =
    `${chapter?.name} · ${step.title} · step ${state.step + 1} of ${chapter?.steps.length}`;
  $("v2-question").textContent = step.question;
  root.dataset.stepId = step.id;
  $("v2-blocker").hidden = true;
  $("v2-choices").hidden = false;
  $("v2-writes-row").hidden = step.kind !== "setting";
  const v = view?.id === step.id ? view : null;
  $("v2-text").replaceChildren(...(v ? textNodes(v.text) : []));
  const notice = $("v2-notice");
  notice.hidden = !v?.blocked;
  notice.textContent = v?.blocked ? `${v.blocked} Press s to skip this step.` : "";
  if (!v) return;
  (RENDERERS[step.id] ?? drawChoices)(v);
}

function drawStop() {
  const chapter = state.chapters[state.chapter];
  if (!chapter) return;
  $("v2-stop-title").textContent = state.done
    ? "The setup is done"
    : (STOP_TITLES[chapter.id] ?? `${chapter.name}: done`);
  const list = state.done ? state.saved : state.saved.filter((x) => x.chapter === chapter.id);
  const items = savedList(list);
  $("v2-stop-saved").replaceChildren(
    ...(items.length
      ? items
      : [el("li", { class: "none" }, "Nothing was written to config.toml.")]),
  );
  const next = state.chapters[state.chapter + 1];
  $("v2-stop-next").replaceChildren(
    ...(state.done
      ? ["Type ", el("code", {}, ":setup"), " to come back to it."]
      : next
        ? [`Next: ${next.digit}. ${next.name}: ${next.steps.map((s) => s.title).join(", ")}.`]
        : []),
  );
  $("v2-go-on").replaceChildren(el("kbd", {}, "enter"), state.done ? " Close" : " Go on");
  $("v2-done").hidden = state.done;
}

function draw() {
  root.dataset.screen = state.screen;
  $("welcome").hidden = true;
  root.dataset.step = state.screen === "step" ? (flowStep(state)?.id ?? "") : state.screen;
  $("v2-welcome").hidden = state.screen !== "welcome";
  $("v2-step").hidden = state.screen !== "step";
  $("v2-stop").hidden = state.screen !== "stop";
  if (state.screen === "welcome") drawWelcome();
  if (state.screen === "step") drawStep();
  if (state.screen === "stop") drawStop();
  drawFooter();
}

/** Asks the host for the open step, and selects the value in force when the step just opened. */
async function loadView(select = true) {
  const step = flowStep(state);
  if (!step) return;
  const serial = ++viewSerial;
  delete root.dataset.viewReady;
  if (step.id === "content_blocker") loadAddons();
  const v = /** @type {StepView | null} */ (await SetupHost.stepView(browser(), step.id));
  if (serial !== viewSerial || flowStep(state)?.id !== step.id) return;
  view = v;
  state = { ...state, blocked: !!v?.blocked };
  if (select && v && step.id !== "content_blocker") state = { ...state, cursor: v.selected };
  if (v && state.cursor >= ctx.count && step.id !== "content_blocker") {
    state = { ...state, cursor: Math.max(0, ctx.count - 1) };
  }
  draw();
  root.dataset.viewReady = "true";
}

async function loadAddons() {
  if (curatedLoaded) return;
  curatedLoaded = true;
  const r = await SetupHost.curated();
  curated = r.addons;
  $("v2-offline").hidden = !r.offline;
  if (!search.value) addons = curated;
  draw();
}

async function runSearch() {
  const terms = search.value.trim();
  search.blur();
  if (!terms) {
    addons = curated;
    state = { ...state, cursor: 0 };
    draw();
    return;
  }
  root.dataset.searching = "true";
  const r = await SetupHost.search(terms);
  delete root.dataset.searching;
  $("v2-offline").hidden = !r.offline;
  addons = r.offline ? curated : r.addons;
  state = { ...state, cursor: 0 };
  draw();
}

/**
 * The content blocker's `enter` (behaviour 19): each marked add-on in turn, through Firefox's
 * permission prompt, each result shown before the next step opens.
 * @param {AddonEntry[]} list
 */
async function install(list) {
  const results = $("v2-results");
  results.replaceChildren();
  /** @type {string[]} */
  const report = [];
  /** @type {Set<string>} */
  const installed = new Set();
  for (const a of list) {
    const outcome = await SetupHost.install(browser(), a.guid);
    results.append(el("li", { class: outcome }, el("span", {}, a.name), el("span", {}, outcome)));
    report.push(`${a.name} ${outcome}`);
    if (outcome === "installed") installed.add(a.guid);
  }
  addons = addons.map((a) => (installed.has(a.guid) ? { ...a, installed: true } : a));
  return {
    report,
    saved: list.filter((a) => installed.has(a.guid)).map((a) => `${a.name} installed`),
  };
}

/** @param {{ state: FlowState, effect: FlowEffect | null }} r */
async function settle(r) {
  const before = flowStep(state)?.id ?? state.screen;
  state = r.state;
  const effect = r.effect;
  if (effect?.type === "chapter-done") SetupHost.finishChapter(browser(), effect.chapter);
  if (effect?.type === "close") {
    SetupHost.close(browser());
    return;
  }
  if (effect?.type === "search") {
    search.focus();
    search.select();
    return;
  }
  if (effect?.type === "blur") {
    search.blur();
    return;
  }
  if (effect?.type === "run-search") {
    await runSearch();
    return;
  }
  if (effect?.type === "save" || effect?.type === "install") {
    busy = true;
    root.dataset.busy = "true";
    try {
      await runEnter(effect);
    } finally {
      busy = false;
      delete root.dataset.busy;
    }
    return;
  }
  const after = flowStep(state)?.id ?? state.screen;
  if (after !== before && state.screen === "step") {
    view = null;
    $("v2-results").replaceChildren();
    draw();
    await loadView();
    return;
  }
  draw();
}

/** @param {Extract<FlowEffect, { type: "save" } | { type: "install" }>} effect */
async function runEnter(effect) {
  const step = flowStep(state);
  if (!step) return;
  if (effect.type === "install") {
    const { report, saved } = await install(effect.addons);
    last = { title: step.title, lines: report, action: true };
    await settle(flowAdvance(state, ctx, saved));
    return;
  }
  const r = await SetupHost.saveStep(browser(), effect.step, effect.index);
  if ("stale" in r) {
    // The engine went away since the list was drawn (behaviour 20): draw the list as it is now.
    await loadView();
    const notice = $("v2-notice");
    notice.hidden = false;
    notice.textContent = "That engine is no longer installed; nothing was written. Choose again.";
    return;
  }
  if ("error" in r) {
    // A failed write keeps the step open and says why (behaviour 16).
    const notice = $("v2-notice");
    notice.hidden = false;
    notice.textContent = `Not saved: ${r.error}`;
    root.dataset.failed = "true";
    return;
  }
  delete root.dataset.failed;
  last = { title: step.title, lines: r.written };
  await settle(flowAdvance(state, ctx, r.written));
}

/** @param {KeyboardEvent} e */
function keyName(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (/^[1-9]$/.test(e.key)) return e.key;
  return (
    {
      Enter: "enter",
      Escape: "esc",
      " ": "space",
      ArrowDown: "down",
      ArrowUp: "up",
      j: "j",
      k: "k",
      s: "s",
      h: "h",
      q: "q",
      "/": "/",
    }[e.key] ?? null
  );
}

/** @param {string} key */
function onKey(key) {
  if (busy) return;
  settle(flowKey(state, key, ctx));
}

/** Wires the page; only with vimma.feature.setupV2, else setup.mjs's summary flow has it. */
function start() {
  ThemeHost.attachDocument(document);
  document.addEventListener("keydown", (e) => {
    // Only the user's own keys drive the page (behaviour 29, Security "Trusted input only").
    if (!e.isTrusted) return;
    if (e.target === search) {
      // In the field only enter and esc are the page's; `q` and the rest are typed (behaviour 7).
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      onKey(e.key === "Enter" ? "enter" : "esc");
      return;
    }
    // Tab and the buttons stay the browser's own.
    if (e.key === "Enter" && e.target instanceof HTMLButtonElement) return;
    const key = keyName(e);
    if (!key) return;
    e.preventDefault();
    onKey(key);
  });

  // A click into the field is the same as `/`: its keys are typed until enter or esc.
  search.addEventListener("focus", () => {
    if (!state.searching) state = { ...state, searching: true };
  });
  search.addEventListener("blur", () => {
    if (state.searching) state = { ...state, searching: false };
  });

  $("v2-start").addEventListener("click", (e) => e.isTrusted && onKey("enter"));
  $("v2-skip").addEventListener("click", (e) => e.isTrusted && onKey("q"));
  $("v2-go-on").addEventListener("click", (e) => e.isTrusted && onKey("enter"));
  $("v2-done").addEventListener("click", (e) => e.isTrusted && onKey("q"));

  // config.toml read again while a step is open: draw its line from the new value in force
  // (behaviour 12), keeping the row under the cursor.
  const onConfigRead = () => {
    if (state.screen === "step") loadView(false);
  };
  Services.obs.addObserver(onConfigRead, SetupHost.CONFIG_READ_TOPIC);
  window.addEventListener("unload", () =>
    Services.obs.removeObserver(onConfigRead, SetupHost.CONFIG_READ_TOPIC),
  );

  SetupHost.flowStart(browser()).then((s) => {
    finished = s.finished;
    state = { ...state, blocked: s.private || !!s.problem };
    const notice = $("v2-config-error");
    notice.hidden = !s.problem && !s.private;
    notice.textContent = s.private
      ? "This is a private window: setting steps cannot save here and can only be skipped."
      : s.problem
        ? `${s.problem}. Setting steps save nothing until it loads; add-ons still install.`
        : "";
    draw();
    root.dataset.ready = "true";
  });
  draw();
}

if (SetupHost.chaptersOn) start();
