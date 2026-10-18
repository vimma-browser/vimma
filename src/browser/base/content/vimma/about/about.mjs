/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:vimma's page script (spec: docs/specs/m5-about-vimma.md). It runs with the system
// principal (AboutVimma.sys.mjs), so it reads the app's modules directly. Text only goes in
// through textContent: config errors and workspace names are the user's text.

const { AboutVimma } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
);
const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);

ThemeHost.attachDocument(document);

/**
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {...(Node | string)} children
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** @param {Array<[string, Node | string]>} pairs */
function dl(pairs) {
  return el("dl", {}, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

/** @param {string} label @param {string | number} value @param {string} id */
const field = (label, value, id) =>
  /** @type {[string, Node]} */ ([label, el("span", { id }, String(value))]);

/**
 * Replaces section `id`'s body (everything after its heading).
 * @param {string} id
 * @param {...(Node | string)} body
 */
function fill(id, ...body) {
  const section = /** @type {HTMLElement} */ (document.getElementById(id));
  section.replaceChildren(/** @type {Element} */ (section.firstElementChild), ...body);
}

const win = /** @type {Window} */ (window.browsingContext.topChromeWindow);

/** What each install type is called on the page (docs/specs/m6a-updater.md §3). */
const INSTALL_TYPES = /** @type {Record<string, string>} */ ({
  source: "source build (never checks)",
  tarball: "tarball",
  appimage: "AppImage",
  deb: ".deb",
  aur: "AUR vimma-bin",
  "pkgbuild-release": "the release's PKGBUILD",
  packaged: "a package this version does not know",
});

const OUTCOMES = /** @type {Record<string, string>} */ ({
  never: "not checked yet",
  current: "up to date",
  offer: "a newer Vimma is available",
  unreachable: "no manifest from the update host",
  refused: "the manifest was refused",
  off: "checks are off",
  source: "not checked (source build)",
});

/**
 * The Updates section: the switch, the last check and its result, and for an offer the exact
 * steps for this install (`:update` opens the page here).
 * @param {import("./AboutVimma.sys.mjs").AboutData["updates"]} u
 */
function renderUpdates(u) {
  /** @type {[string, string | Node][]} */
  const rows = [
    [
      "Checks",
      u.enabled
        ? `on, every ${u.intervalHours} hours`
        : u.from === "config-errors"
          ? "off until config.toml's errors are fixed"
          : u.from === "config"
            ? "off ([updates] check = false in config.toml)"
            : "off (vimma.update.enabled)",
    ],
    ["Install type", INSTALL_TYPES[u.installType] ?? u.installType],
    ["Channel", u.channel],
    ["Last check", u.checkedAt ? new Date(u.checkedAt).toLocaleString() : "never"],
    field("Result", OUTCOMES[u.outcome] ?? u.outcome, "update-result"),
  ];
  // Only a refused manifest is an error: a host that is offline or has nothing published yet
  // is expected (decision 27).
  if (u.reason) {
    rows.push([
      "Reason",
      u.outcome === "refused" ? el("span", { class: "error" }, u.reason) : u.reason,
    ]);
  }
  if (u.offer) {
    rows.push(field("Available", u.offer.line, "update-offer"));
    rows.push([
      "Urgency",
      u.offer.urgent
        ? el(
            "span",
            { class: "error" },
            `security${u.offer.advisories.length ? `: ${u.offer.advisories.join(", ")}` : ""}`,
          )
        : "normal",
    ]);
  }
  rows.push(
    ["Manifest serial", u.serial ?? "-"],
    ["Signed by", u.key ? `${u.key.id} (${u.key.slot} key)` : "-"],
  );
  if (!u.pinnedKeys) rows.push(["Pinned keys", "none in this build: every manifest is refused"]);
  const body = [dl(rows)];
  if (u.offer) {
    const steps = u.offer.steps;
    body.push(
      el("h3", {}, "How to update"),
      el("p", {}, steps.text),
      ...steps.commands.map((c) => el("pre", { class: "command" }, el("code", {}, c))),
      el("p", {}, "Release notes: ", el("a", { href: steps.link }, steps.link)),
    );
  }
  fill("updates", ...body);
}

/** @param {import("./AboutVimma.sys.mjs").AboutData} d */
function render(d) {
  const v = d.version;
  fill(
    "version",
    dl([
      ["Vimma", v.vimma],
      ["Firefox", v.firefox],
      ["Build ID", v.buildId],
      ["Update channel", v.channel],
    ]),
  );

  renderUpdates(d.updates);

  if (d.patches) {
    fill(
      "patches",
      dl([
        field("Patches", d.patches.patches.length, "patch-count"),
        field("Hunks", d.patches.hunks, "hunk-count"),
      ]),
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, el("th", {}, "Patch"), el("th", {}, "Hunks"))),
        el(
          "tbody",
          {},
          ...d.patches.patches.map((p) =>
            el("tr", {}, el("td", {}, p.path), el("td", {}, String(p.hunks))),
          ),
        ),
      ),
    );
  } else {
    fill("patches", el("p", { class: "error" }, "patches.json is not packaged in this build"));
  }

  fill(
    "modes",
    dl(d.modes.map((m) => [`Window ${m.window}${m.current ? " (this one)" : ""}`, m.mode])),
  );

  fill(
    "keys",
    d.keys.length
      ? el("ol", {}, ...d.keys.map((k) => el("li", { title: k.mode }, `${k.key} → ${k.outcome}`)))
      : el("p", { class: "muted" }, "No keys yet."),
    el("p", { class: "muted" }, "Plain keys typed in insert or command mode show as ·."),
  );

  const c = d.config;
  const fileText = {
    pending: "not read yet",
    missing: "missing (the defaults apply)",
    read: c.errors.length ? "not applied (errors below)" : "loaded",
  }[c.file];
  fill(
    "config",
    dl([
      ["Path", c.path],
      ["File", fileText],
      field("Schema", c.schema ?? "-", "config-schema"),
      ["Overrides", String(d.bindings.filter((b) => b.overridden).length)],
    ]),
    ...(c.errors.length
      ? [el("ul", {}, ...c.errors.map((e) => el("li", { class: "error" }, e)))]
      : []),
  );

  // docs/specs/search-engines.md decision 14: the default, the aliases, the problems.
  const sr = d.search;
  fill(
    "search",
    dl([
      [
        "Default engine",
        sr.default === null
          ? "not read yet"
          : `${sr.default}${sr.fromConfig ? " ([search] default in config.toml)" : " (Settings)"}`,
      ],
      [
        "Aliases",
        sr.aliases.length
          ? sr.aliases
              .map(
                (a) =>
                  `${a.alias} → ${a.engine}${a.unencrypted ? " (queries sent unencrypted)" : ""}`,
              )
              .join(", ")
          : sr.errors.length
            ? "none applied: see the errors below"
            : "none in config.toml",
      ],
    ]),
    ...(sr.errors.length
      ? [el("ul", {}, ...sr.errors.map((e) => el("li", { class: "error" }, e)))]
      : []),
  );

  // docs/specs/theme-appearance.md: the Omarchy rows only where Vimma follows Omarchy.
  const t = d.theme;
  const omarchy = t.source === "omarchy";
  const from = { config: "config.toml", pref: ":theme", default: "the default" }[t.appearance.from];
  const change =
    t.appearance.from === "config"
      ? "change [theme] appearance in config.toml"
      : ":theme dark, :theme light or :theme system";
  /** @type {[string, string | Node][]} */
  const rows = [["Source", omarchy ? "Omarchy" : "built in"]];
  if (omarchy) rows.push(["Omarchy path", t.path], ["State", t.state]);
  rows.push(
    ["Theme", t.name ?? "-"],
    field("Appearance", `${t.appearance.value} (${from}; ${change})`, "theme-appearance"),
  );
  if (omarchy) rows.push(["colors.toml mtime", t.mtime ? new Date(t.mtime).toISOString() : "-"]);
  rows.push(
    ["Last error", t.lastError ? el("span", { class: "error" }, t.lastError) : "none"],
    ["Warnings", t.warnings.join("; ") || "none"],
  );
  fill("theme", dl(rows));

  fill(
    "workspaces",
    dl([field("Workspaces", d.workspaces.count, "workspace-count")]),
    d.workspaces.window.length
      ? el(
          "table",
          {},
          el(
            "thead",
            {},
            el("tr", {}, el("th", {}, "This window"), el("th", {}, "Tabs"), el("th", {}, "Panes")),
          ),
          el(
            "tbody",
            {},
            ...d.workspaces.window.map((w) =>
              el(
                "tr",
                {},
                el("td", {}, w.active ? `${w.name} (active)` : w.name),
                el("td", {}, String(w.tabs)),
                el("td", {}, String(w.panes)),
              ),
            ),
          ),
        )
      : el("p", { class: "muted" }, "No workspaces in this window."),
  );

  const routes = d.routes;
  /** @type {(Node | string)[]} */
  const tabLine = [];
  if (routes.tab) {
    const t = routes.tab;
    const text =
      t.rule === null
        ? `${t.host} (in ${t.workspace}): no rule matches.`
        : `${t.host} (in ${t.workspace}): route ${t.rule} sends it to ${t.target}` +
          (t.target === t.workspace ? "." : "; :route move moves it there.");
    tabLine.push(el("p", { id: "route-tab" }, `The tab :route was typed in: ${text}`));
  }
  fill(
    "routes",
    ...tabLine,
    routes.rules.length
      ? el(
          "table",
          {},
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "#"),
              el("th", {}, "Matches"),
              el("th", {}, "Workspace"),
              el("th", {}, "State"),
            ),
          ),
          el(
            "tbody",
            {},
            ...routes.rules.map((r) =>
              el(
                "tr",
                r.skipped ? { class: "error" } : {},
                el("td", {}, String(r.index)),
                el("td", {}, r.match),
                el("td", {}, r.workspace),
                el("td", {}, r.skipped ?? "in force"),
              ),
            ),
          ),
        )
      : el("p", { class: "muted" }, "No [[routes]] in config.toml."),
    el(
      "p",
      { class: "muted" },
      "The first matching rule, top to bottom, wins. :route add [workspace] adds one for a site.",
    ),
  );

  fill(
    "control",
    dl([
      ["State", d.control.status],
      ["Port", d.control.port === null ? "-" : String(d.control.port)],
    ]),
  );

  // docs/specs/vimma-mcp.md decision 27: the switch and the agent workspace, no URLs or titles.
  const mcp = d.mcp;
  fill(
    "mcp",
    dl([
      [
        "State",
        mcp.enabled
          ? `on${mcp.from === "config" ? " ([mcp] enabled in config.toml)" : " (:mcp on)"}`
          : `off${mcp.from === "config" ? " ([mcp] enabled in config.toml)" : " (:mcp on turns it on)"}`,
      ],
      // Decision 29: while MCP is on, each new full-control connection asks first.
      ["Full control", d.control.status],
      [
        "Agent workspace",
        mcp.workspace === null
          ? "none"
          : `${mcp.workspace}${mcp.adopted ? " (your own, adopted)" : ""} · ${mcp.tabs} ` +
            `${mcp.tabs === 1 ? "tab" : "tabs"}`,
      ],
    ]),
  );

  // docs/specs/private-swap.md decision 10: no addresses, no titles.
  fill("window-manager", dl([["Window manager", d.windowManager]]));

  const fk = d.firefoxKeys;
  fill(
    "firefox-keys",
    // docs/specs/firefox-keys.md decision 9: with `disable = "all"` the short list is the keys on.
    fk.on.length
      ? el(
          "table",
          {},
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Keys"),
              el("th", {}, "Firefox's key"),
              el("th", {}, "What it does"),
            ),
          ),
          el(
            "tbody",
            {},
            ...fk.on.map((k) =>
              el("tr", {}, el("td", {}, k.chord), el("td", {}, k.id), el("td", {}, k.label)),
            ),
          ),
        )
      : el("p", { class: "muted" }, `None: ${fk.off.length} Firefox shortcuts are off.`),
    el(
      "p",
      { class: "muted", id: "firefox-keys-unmatched" },
      fk.unmatched.length
        ? `No Firefox shortcut on: ${fk.unmatched.join(", ")}.`
        : "[firefox] enable in config.toml gives one back.",
    ),
  );

  fill(
    "bindings",
    el("p", { class: "muted" }, "* marks a binding config.toml overrides."),
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el("tr", {}, el("th", {}, "Action"), el("th", {}, "Keys"), el("th", {}, "Group")),
      ),
      el(
        "tbody",
        {},
        ...d.bindings.map((b) =>
          el(
            "tr",
            b.overridden ? { class: "overridden" } : {},
            el("td", {}, b.name),
            el("td", {}, b.bindings.join(", ") || "(unbound)"),
            el("td", {}, b.group),
          ),
        ),
      ),
    ),
  );
}

async function refresh() {
  const data = await AboutVimma.collect(win, {
    tab: new URLSearchParams(location.search).get("tab"),
  });
  render(data);
  document.documentElement.dataset.ready = "true";
  return data;
}

/** @param {string} text */
function say(text) {
  /** @type {HTMLElement} */ (document.getElementById("status")).textContent = text;
}

async function copyReport() {
  const data = await refresh();
  const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
  helper.copyString(AboutVimma.report(data));
  say("Redacted report copied to the clipboard.");
}

document.getElementById("refresh")?.addEventListener("click", () => {
  refresh().then(() => say("Refreshed."));
});
document.getElementById("copy")?.addEventListener("click", () => copyReport());

// `:bug` opens about:vimma#bug: the report goes to the clipboard at once.
if (location.hash === "#bug") copyReport();
else {
  refresh().then(() => {
    // `:route` opens about:vimma#routes: the browser scrolled to it before it had content.
    if (location.hash === "#routes") document.getElementById("routes")?.scrollIntoView();
  });
}
