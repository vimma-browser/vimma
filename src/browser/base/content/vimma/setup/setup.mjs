/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:vimma-setup's page (docs/specs/first-run-setup.md): draws the step core/setup.mjs is in
// and turns trusted keys and clicks into its keys. SetupHost does every request and change, and
// only after the summary (decision 2).

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { SetupHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
);
const { formatUsers, initialSetup, setupKey, withAddons } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/setup.mjs",
);
ThemeHost.attachDocument(document);

const root = document.documentElement;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const search = /** @type {HTMLInputElement} */ ($("setup-search"));
/** The page's own browser: the permission prompt anchors to it, and closing removes its tab. */
const browser = () => SetupHost.browserFor(window);

/** @type {any} */
let state = initialSetup({ addons: [], engines: [], engine: null });
/** @type {any[]} */
let curated = [];
let curatedLoaded = false;
/** "summary" until applied, then "applying", then "done" (enter closes). */
let phase = "summary";

/** @param {string} tag @param {Record<string, string>} attrs @param {...(Node | string)} kids */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

function drawAddons() {
  const list = $("setup-addons");
  list.replaceChildren(
    ...state.addons.map((/** @type {any} */ a, /** @type {number} */ i) => {
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
      if (i === state.cursor && step() === "addons") li.setAttribute("aria-current", "true");
      if (a.installed || !a.url) li.classList.add("disabled");
      return li;
    }),
  );
  list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
}

function drawEngines() {
  $("setup-engines").replaceChildren(
    ...state.engines.map((/** @type {string} */ name, /** @type {number} */ i) => {
      const li = el(
        "li",
        { role: "option", "data-name": name },
        el("span", { class: "mark", "aria-hidden": "true" }, name === state.engine ? "●" : "○"),
        el("span", { class: "body" }, el("span", { class: "name" }, name)),
        el("span", { class: "meta" }, name === state.engine ? "current" : ""),
      );
      if (i === state.cursor) li.setAttribute("aria-current", "true");
      return li;
    }),
  );
}

function drawSummary() {
  const addons = [...state.marked.values()].map((/** @type {any} */ a) => a.name);
  $("setup-plan").replaceChildren(
    el("dt", {}, "Install"),
    el("dd", {}, addons.length ? addons.join(", ") : "no add-ons"),
    el("dt", {}, "Search with"),
    el("dd", {}, `${state.engine} (config.toml [search] default)`),
  );
  SetupHost.configProblem().then((/** @type {string | null} */ problem) => {
    const notice = $("setup-config-error");
    notice.hidden = !problem;
    notice.textContent = problem
      ? `${problem}. config.toml is left as it is; add-ons still install.`
      : "";
  });
}

const step = () => state.step;

function draw() {
  root.dataset.step = phase === "summary" ? state.step : phase;
  for (const id of ["welcome", "addons", "engine", "summary"]) {
    $(id).hidden = id !== state.step;
  }
  if (state.step === "addons") drawAddons();
  if (state.step === "engine" || state.step === "summary") drawEngines();
  if (state.step === "summary" && phase === "summary") drawSummary();
  if (state.step === "welcome") $("setup-start").focus();
}

async function loadAddons() {
  if (curatedLoaded) return;
  curatedLoaded = true;
  const r = await SetupHost.curated();
  curated = r.addons;
  $("setup-offline").hidden = !r.offline;
  if (!search.value) state = withAddons(state, curated);
  draw();
}

async function runSearch() {
  const terms = search.value.trim();
  search.blur();
  if (!terms) {
    state = withAddons(state, curated);
    draw();
    return;
  }
  root.dataset.searching = "true";
  const r = await SetupHost.search(terms);
  delete root.dataset.searching;
  $("setup-offline").hidden = !r.offline;
  state = withAddons(state, r.offline ? curated : r.addons);
  draw();
}

/** The summary's `enter` (behaviour 5): config.toml first, then each add-on, one at a time. */
async function apply(/** @type {any} */ plan) {
  phase = "applying";
  draw();
  const results = $("setup-results");
  const report = (/** @type {string} */ what, /** @type {string} */ outcome) =>
    results.append(el("li", { class: outcome }, el("span", {}, what), el("span", {}, outcome)));
  if (plan.engine) {
    const problem = await SetupHost.writeEngine(plan.engine);
    report(`Search with ${plan.engine}`, problem ? "not saved" : "saved");
  }
  for (const a of plan.addons) report(a.name, await SetupHost.install(browser(), a.guid));
  phase = "done";
  $("setup-summary-keys").replaceChildren(el("kbd", {}, "enter"), " close");
  draw();
}

/** @param {KeyboardEvent} e */
function keyName(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  return (
    {
      Enter: "enter",
      Escape: "esc",
      " ": "space",
      ArrowDown: "down",
      ArrowUp: "up",
      j: "j",
      k: "k",
      q: "q",
      "/": "/",
    }[e.key] ?? null
  );
}

/** @param {string} key */
function onKey(key) {
  if (phase === "applying") return;
  if (phase === "done") {
    if (key === "enter" || key === "esc" || key === "q") SetupHost.close(browser());
    return;
  }
  const before = state.step;
  const r = setupKey(state, key);
  state = r.state;
  if (r.effect?.type === "close") {
    SetupHost.close(browser());
    return;
  }
  if (r.effect?.type === "search") {
    search.focus();
    search.select();
    return;
  }
  if (r.effect?.type === "apply") {
    apply(r.effect.plan);
    return;
  }
  if (before !== "addons" && state.step === "addons") loadAddons();
  draw();
}

document.addEventListener("keydown", (e) => {
  // Only the user's own keys drive the page (Security: "No agent or socket reach").
  if (!e.isTrusted) return;
  if (e.target === search) {
    if (e.key === "Enter") runSearch();
    else if (e.key === "Escape") search.blur();
    else return;
    e.preventDefault();
    return;
  }
  // Tab and the buttons stay the browser's own on the welcome screen.
  if (state.step === "welcome" && e.key === "Enter" && e.target instanceof HTMLButtonElement) {
    return;
  }
  const key = keyName(e);
  if (!key) return;
  e.preventDefault();
  onKey(key);
});

$("setup-start").addEventListener("click", (e) => e.isTrusted && onKey("enter"));
$("setup-skip").addEventListener("click", (e) => e.isTrusted && onKey("esc"));

SetupHost.engines().then((/** @type {{ names: string[], current: string }} */ e) => {
  state = { ...state, engines: e.names, engine: e.current };
  draw();
  root.dataset.ready = "true";
});
draw();
