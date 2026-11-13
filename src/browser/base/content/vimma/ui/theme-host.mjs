/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The theme tokens for every window and start page (spec: docs/specs/m5-omarchy-theme.md).
// One per app: imported with ChromeUtils.importESModule, so every window shares this module.
// It starts on the built-in palette (`[theme] name`, vimma by default) and swaps in the user's
// Omarchy theme (colors.toml, light.mode) once the async read completes, then polls the file
// (plan §3: Firefox has no portable file watcher). vimma-core parses and validates
// (themeStylesheet); this module only does the I/O and the injection. config.toml's `[theme]`
// (source, name, font, colors) arrives through `setConfig` (spec m5-config-load). The built-in
// vimma palette's sheet carries its light variant under @media (prefers-color-scheme: light):
// chrome documents match it by browser.theme.toolbar-theme and the system, the start pages by
// the content scheme (layout/style/PreferenceSheet.cpp), and both switch live with no script.
// Omarchy is looked for once (docs/specs/theme-appearance.md, A): without it nothing is polled.
// `[theme] appearance` or the pref `:theme` sets fixes the built-in palette dark or light (B).

import { DEFAULT_THEME_NAME, themeStylesheet } from "../core/theme.mjs";

const lazy = /** @type {Lazy<"clearInterval" | "setInterval">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

/** Points Firefox's focus colour at --vimma-focus (focus rings, the focused pane's outline). */
const FOCUS_SHEET = "chrome://browser/skin/vimma/focus.css";
/** Firefox's own sidebar in the tokens: the window's launcher and panel, and each panel document
 * (spec firefox-sidebar-theme). */
const SIDEBAR_SHEET = "chrome://browser/skin/vimma/firefox-sidebar.css";
const SIDEBAR_PAGE_SHEET = "chrome://browser/skin/vimma/firefox-sidebar-page.css";
/** Firefox's toolbar, URL field, suggestions and the panels hanging from the bar in the tokens
 * (spec toolbar-toggle decision 21). */
const TOOLBAR_SHEET = "chrome://browser/skin/vimma/firefox-toolbar.css";
/** The find bar, the menu bar and the menus; Firefox's own pages and dialogs (spec
 * firefox-surfaces-theme). */
const CHROME_SHEET = "chrome://browser/skin/vimma/firefox-chrome.css";
const PAGES_SHEET = "chrome://browser/skin/vimma/firefox-pages.css";
/** The History sidebar's import promo in the theme's colours, as an agent sheet (#912). */
const SIDEBAR_PROMO_SHEET = "chrome://browser/skin/vimma/firefox-sidebar-promo.css";
/** Tab Overview's and the sidebar's empty states without their picture's column (#912). */
const EMPTY_STATES_SHEET = "chrome://browser/skin/vimma/firefox-empty-states.css";
/**
 * Firefox's pages that load in the parent process with the system principal, by about: name
 * (nsAboutRedirector.cpp, AboutRedirector.cpp: IS_SECURE_CHROME_UI without
 * URI_MUST_LOAD_IN_CHILD). A content-process page is out of this module's reach.
 */
const THEMED_PAGES = new Set([
  "preferences",
  "settings",
  "addons",
  "downloads",
  "support",
  "config",
  "profiles",
  "processes",
  "firefoxview",
]);
/** A prompt's document: alert, confirm, prompt, over a tab or in a window of its own. */
const COMMON_DIALOG = "chrome://global/content/commonDialog.xhtml";
const SOURCE_PREF = "vimma.theme.source";
const PATH_PREF = "vimma.theme.omarchyPath";
const POLL_PREF = "vimma.theme.pollMs";
/** What `:theme` sets when config.toml has no `[theme] appearance` (theme-appearance B4). */
const APPEARANCE_PREF = "vimma.theme.appearance";
/** @type {readonly string[]} */
const APPEARANCE_WORDS = ["system", "dark", "light"];
const DEFAULT_PATH = "~/.local/state/omarchy/current/theme";
const DEFAULT_POLL_MS = 2000;
/** Notified after new tokens reach the windows, and when a theme file is rejected. */
const CHANGED_TOPIC = "vimma-theme-changed";
const ERROR_TOPIC = "vimma-theme-error";
/** @import { ResolvedConfig } from "../core/config.mjs" */

/**
 * config.toml's `[theme]` (core's resolved form); the defaults until ConfigHost has read it.
 * @type {ResolvedConfig["theme"]}
 */
let configTheme = { source: "omarchy", name: DEFAULT_THEME_NAME, font: "monospace", colors: {} };

/** @param {string | null} omarchy  colors.toml text; null: the built-in theme */
function cssFor(omarchy, lightMode = false) {
  const source = omarchy === null ? "file" : "omarchy";
  return themeStylesheet({
    theme: { ...configTheme, source, appearance: appearance().value },
    omarchy,
    omarchyLightMode: lightMode,
    selector: ":root",
  });
}

/**
 * The built-in palette `[theme] name` with config.toml's font and `[theme.colors]` (they overlay
 * either source).
 */
function builtinCss() {
  const r = cssFor(null);
  for (const e of r.errors) console.warn(`vimma: [theme.colors] ${e.path} ${e.message}`);
  // The palette shown is the built-in one: an Omarchy theme's warnings no longer apply.
  warnings = r.warnings;
  return r.css;
}

/** @param {string} css */
const sheetUri = (css) => `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;

/** The user's home directory: where Omarchy is looked for and `~` resolves to. */
const systemHome = () => Services.dirsvc.get("Home", Ci.nsIFile).path;
/** The HOME the last detection looked in (tests pass a temporary one); null before one. */
/** @type {string | null} */
let home = null;
/** Omarchy found under `home` (theme-appearance A1); null while not looked for yet. */
/** @type {boolean | null} */
let omarchyInstalled = null;
/** @type {Promise<boolean> | null} the detection in force */
let detection = null;

/** The theme directory from the pref, `~` resolved against the home directory. */
function themeDir() {
  const path = Services.prefs.getStringPref(PATH_PREF, DEFAULT_PATH);
  if (path !== "~" && !path.startsWith("~/")) return path;
  return PathUtils.join(home ?? systemHome(), ...path.slice(2).split("/").filter(Boolean));
}

/**
 * Omarchy is installed when its install (`~/.local/share/omarchy`, a symlink to
 * /usr/share/omarchy on a packaged Omarchy 4) or its state (`~/.local/state/omarchy`, where
 * omarchy-theme-set keeps the current theme) exists. IOUtils.exists follows symlinks.
 * @param {string} dir  the HOME to look in
 */
async function lookForOmarchy(dir) {
  for (const sub of [".local/share/omarchy", ".local/state/omarchy"]) {
    if (await IOUtils.exists(PathUtils.join(dir, ...sub.split("/")))) return true;
  }
  return false;
}

/** The pref or config.toml's source = "file" force the built-in palette. */
const forcedBuiltin = () =>
  Services.prefs.getStringPref(SOURCE_PREF, "omarchy") === "builtin" ||
  configTheme.source === "file";

/**
 * Whether there is an Omarchy theme to follow: not forced off, and Omarchy found, or a theme
 * directory set by hand (vimma.theme.omarchyPath: an explicit opt-in, for tests and e2e too).
 */
const followsOmarchy = () =>
  !forcedBuiltin() && (omarchyInstalled === true || Services.prefs.prefHasUserValue(PATH_PREF));

/**
 * The built-in palette's appearance and where it comes from: config.toml wins, then the pref
 * `:theme` sets, then "system".
 * @returns {{ value: string, from: "config" | "pref" | "default" }}
 */
function appearance() {
  if (configTheme.appearance !== undefined)
    return { value: configTheme.appearance, from: "config" };
  const pref = Services.prefs.getStringPref(APPEARANCE_PREF, "");
  if (APPEARANCE_WORDS.includes(pref) && Services.prefs.prefHasUserValue(APPEARANCE_PREF)) {
    return { value: pref, from: "pref" };
  }
  return { value: "system", from: "default" };
}

/** IOUtils rejects with a DOMException named NotFoundError for a missing file. */
const notFound = (/** @type {unknown} */ e) => /** @type {any} */ (e)?.name === "NotFoundError";

/** @type {string[]} the applied theme's warnings (contrast), for about:vimma */
let warnings = [];
let css = builtinCss();
/** @type {Map<BrowserWindow, string>} each window's token sheet (a data: URI of `css`) */
const windows = new Map();
/**
 * @type {Map<Document, string>} the token sheet of each document in Firefox's sidebar (spec
 * firefox-sidebar-theme), by document: the sidebar's window object outlives its documents
 */
const pages = new Map();
/** The documents that have firefox-empty-states.css. @type {WeakSet<Document>} */
const emptyStateDocs = new WeakSet();
/** Sidebar documents are found by this topic (onDocumentInserted) while a window is themed. */
const DOCUMENT_TOPIC = "document-element-inserted";
let observingDocuments = false;
/** @type {Set<WeakRef<HTMLStyleElement>>} start pages' token <style> elements */
const styles = new Set();
/** What the theme file looked like at the last check; "" forces a read. */
let signature = "";
/** An Omarchy theme was applied since the source or path last changed. */
let loaded = false;
/** Bumped by recheck: a check started before it applies nothing. */
let generation = 0;
/** The last rejected colors.toml as one line (about:vimma), null once one applies. */
/** @type {string | null} */
let lastError = null;
/** @type {Promise<void> | null} */
let running = null;
/** @type {number | null} */
let timer = null;
/** A window is themed: the prefs are observed, and the poll may run. */
let started = false;

/** @param {string} next */
function apply(next) {
  if (next === css) return;
  css = next;
  for (const [win, old] of windows) {
    const uri = sheetUri(css);
    // Load before remove: no frame without tokens.
    win.windowUtils.loadSheetUsingURIString(uri, win.windowUtils.AUTHOR_SHEET);
    win.windowUtils.removeSheetUsingURIString(old, win.windowUtils.AUTHOR_SHEET);
    windows.set(win, uri);
  }
  for (const [doc, old] of pages) {
    const win = doc.defaultView;
    if (!win || win.document !== doc) {
      pages.delete(doc);
      continue;
    }
    const uri = sheetUri(css);
    win.windowUtils.loadSheetUsingURIString(uri, win.windowUtils.AUTHOR_SHEET);
    win.windowUtils.removeSheetUsingURIString(old, win.windowUtils.AUTHOR_SHEET);
    pages.set(doc, uri);
  }
  for (const ref of styles) {
    const style = ref.deref();
    if (style?.isConnected) style.textContent = css;
    else styles.delete(ref);
  }
  Services.obs.notifyObservers(null, CHANGED_TOPIC);
}

/**
 * The file's stat, cheap enough for every poll. It describes the file the path resolves to
 * now, so omarchy-theme-set's swap (a new current/theme directory or symlink) changes it too.
 * @param {string} dir
 * @returns {Promise<string | null>} null: no colors.toml
 */
async function stat(dir) {
  try {
    const info = await IOUtils.stat(PathUtils.join(dir, "colors.toml"));
    const light = await IOUtils.exists(PathUtils.join(dir, "light.mode"));
    return `${dir}|${info.lastModified}|${info.creationTime ?? ""}|${info.size}|${light}`;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

async function check() {
  const started = generation;
  // No Omarchy, the pref (tests, about:config) or config.toml's source = "file": nothing to read.
  if (!followsOmarchy()) {
    signature = "builtin";
    lastError = null;
    apply(builtinCss());
    return;
  }
  const dir = themeDir();
  const now = await stat(dir);
  if (started !== generation) return;
  if (now === null) {
    // No colors.toml: the built-in palette. Once a theme is showing, a missing file is most likely
    // omarchy-theme-set between its rm and its mv: keep the theme until the next one appears.
    signature = "missing";
    if (!loaded) apply(builtinCss());
    return;
  }
  if (now === signature) return;
  signature = now;
  let text;
  try {
    text = await IOUtils.readUTF8(PathUtils.join(dir, "colors.toml"));
    if (started !== generation) return;
  } catch (e) {
    if (notFound(e)) signature = "";
    else throw e;
    return;
  }
  const lightMode = now.endsWith("|true");
  const r = cssFor(text, lightMode);
  if (r.errors.length) {
    // Logged once: the signature holds until the file changes again.
    const where = PathUtils.join(dir, "colors.toml");
    const list = r.errors.map((e) => `${e.line ? `line ${e.line}: ` : ""}${e.path} ${e.message}`);
    console.warn(`vimma: ${where} rejected, keeping the current theme:\n  ${list.join("\n  ")}`);
    lastError = `${where}: ${list.join("; ")}`;
    Services.obs.notifyObservers(null, ERROR_TOPIC);
    return;
  }
  for (const w of r.warnings) console.info(`vimma: theme: ${w}`);
  lastError = null;
  warnings = r.warnings;
  loaded = true;
  apply(r.css);
}

/** One check at a time; a tick that finds one running is skipped. */
function poll() {
  if (running) return running;
  running = check()
    .catch((e) => console.error("vimma: theme check failed", e))
    .finally(() => {
      running = null;
    });
  return running;
}

function startTimer() {
  if (timer !== null) lazy.clearInterval(timer);
  const ms = Math.max(50, Services.prefs.getIntPref(POLL_PREF, DEFAULT_POLL_MS));
  timer = lazy.setInterval(poll, ms);
}

function stopTimer() {
  if (timer !== null) lazy.clearInterval(timer);
  timer = null;
}

/** The poll runs only while a window is open and there is an Omarchy theme to follow. */
function syncTimer() {
  if (started && windows.size && followsOmarchy()) {
    if (timer === null) startTimer();
  } else {
    stopTimer();
  }
}

/** Reads the theme again from scratch once the running check (with the old settings) is done. */
function recheck() {
  // A check in flight read the old settings: it must not apply them over this reset.
  generation++;
  signature = "";
  loaded = false;
  syncTimer();
  (running ?? Promise.resolve()).then(poll);
}

/**
 * Looks for Omarchy under `dir` and checks the theme again with the answer.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
function detect(dir) {
  const looking = lookForOmarchy(dir).then((found) => {
    // A later detection (tests) wins over one still looking.
    if (detection !== looking) return found;
    home = dir;
    omarchyInstalled = found;
    recheck();
    return found;
  });
  detection = looking;
  return looking;
}

/**
 * @param {unknown} _subject
 * @param {string} _topic
 * @param {string} pref
 */
function onPref(_subject, _topic, pref) {
  if (pref === POLL_PREF) {
    if (timer !== null) startTimer();
    return;
  }
  recheck();
}

const OBSERVED = [SOURCE_PREF, PATH_PREF, POLL_PREF, APPEARANCE_PREF];

function start() {
  if (started) return;
  started = true;
  for (const pref of OBSERVED) Services.prefs.addObserver(pref, onPref);
  // Never blocks startup: the windows already show the built-in palette. Omarchy is looked for
  // once per process (theme-appearance A2); with it, the theme swaps in when read.
  if (detection === null) detect(systemHome());
  else recheck();
}

function stopIfIdle() {
  if (windows.size || !started) return;
  started = false;
  stopTimer();
  for (const pref of OBSERVED) Services.prefs.removeObserver(pref, onPref);
  if (observingDocuments) Services.obs.removeObserver(onDocumentInserted, DOCUMENT_TOPIC);
  observingDocuments = false;
}

/**
 * A XUL <tree> (the bookmarks sidebar's) keeps two parts in its shadow root, where no document
 * sheet reaches, so one sheet adopted into each tree's shadow root gives them the tokens (custom
 * properties inherit into it), following them on a theme change:
 * - its vertical <scrollbar>, which the UA sheet resets to initial values (scrollbars.css,
 *   `all: initial`, for its style cache): it inherits neither scrollbar-color nor color-scheme,
 *   so it shows a white track on any theme. It gets the side panel's colours (side-panel.css).
 * - its rename-in-place field (`.tree-input`, tree.css), which the UA fills with Field and
 *   FieldText (a grey #2b2a33, or white) and whose selected text is Highlight. It takes the
 *   sidebar search box's colours (firefox-sidebar-page.css) and a selected row's (side-panel.css).
 *   Its ring is already --vimma-focus (focus.css in the document).
 */
const TREE_RULES = `
scrollbar { scrollbar-color: var(--vimma-muted) var(--vimma-bg-dark) !important; }
.tree-input {
  background-color: var(--vimma-bg) !important;
  color: var(--vimma-fg) !important;
}
.tree-input::selection {
  background-color: var(--vimma-selection) !important;
  color: var(--vimma-fg-bright) !important;
}`;

/**
 * A prompt in a window of its own draws its buttons natively in the <dialog>'s shadow root
 * (dialog.js, button.css), where no document sheet reaches and ::part() cannot tell the default
 * button from the others. One sheet adopted into that shadow root gives them the look of the
 * in-content buttons firefox-pages.css themes: the default one the accent, the others tinted.
 * Over a tab (a subdialog) the dialog already draws in-content buttons from the tokens.
 */
const DIALOG_BUTTON_RULES = `
@media not ((prefers-contrast) or (forced-colors)) {
  button[dlgtype] {
    appearance: none;
    padding: 4px 16px;
    border: 1px solid var(--vimma-muted);
    border-radius: var(--vimma-radius, 0);
    background-color: color-mix(in srgb, currentColor 12%, transparent);
    color: var(--vimma-fg);
  }
  button[dlgtype]:hover {
    background-color: color-mix(in srgb, currentColor 20%, transparent);
  }
  button[dlgtype][default] {
    border-color: transparent;
    background-color: var(--vimma-mode-normal);
    color: var(--vimma-mode-normal-fg);
  }
  button[dlgtype][default]:hover {
    background-color: color-mix(in srgb, var(--vimma-mode-normal) 85%, var(--vimma-mode-normal-fg));
  }
}`;

/**
 * Firefox's import wizard (<migration-wizard>, in Settings' #migrationWizardDialog) shows its
 * browser list as a XUL <panel> in its shadow root, where no document sheet reaches. The panel
 * takes the system's Menu and MenuText (popup.css, loaded by the wizard's own sheet), and the
 * chosen browser is a pressed button's colour (migration-wizard.css, panel-item.selected). One
 * sheet adopted into that shadow root gives the list a menu's colours (firefox-chrome.css): the
 * picker's surface, and the chosen browser a selected row. Custom properties inherit into the
 * shadow tree, so it follows theme changes.
 */
const WIZARD_RULES = `
@media not ((prefers-contrast) or (forced-colors)) {
  panel {
    --panel-background-color: var(--vimma-bg-dark) !important;
    --panel-text-color: var(--vimma-fg) !important;
    --panel-border-color: var(--vimma-muted) !important;
    --panel-border-radius: var(--vimma-radius, 0) !important;
    color-scheme: var(--vimma-color-scheme) !important;
  }
  panel-item.selected {
    background-color: var(--vimma-selection) !important;
    color: var(--vimma-fg-bright) !important;
  }
}`;

/**
 * The import wizard is built when Settings first opens its dialog, and asks for its state
 * (MigrationWizard:RequestState, bubbling from the wizard) before the dialog is shown, so its
 * shadow root gets WIZARD_RULES then, once.
 * @param {Document} doc  one of Firefox's pages, once parsed
 */
function colourWizards(doc) {
  const win = doc.defaultView;
  if (!win) return;
  /** @type {WeakSet<ShadowRoot>} */
  const done = new WeakSet();
  win.addEventListener(
    "MigrationWizard:RequestState",
    (/** @type {Event} */ event) => {
      const wizard = /** @type {Element} */ (event.target);
      const root = wizard?.localName === "migration-wizard" ? wizard.shadowRoot : null;
      if (!root || done.has(root)) return;
      done.add(root);
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(WIZARD_RULES);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    },
    true,
  );
}

/** @param {Document} doc  a prompt in a window of its own, once parsed */
function colourDialogButtons(doc) {
  const win = doc.defaultView;
  const root = doc.querySelector("dialog")?.shadowRoot;
  // Over a tab the frame marks the document [subdialog] only after it loads (SubDialog.sys.mjs),
  // so a window of its own is told apart by having no embedder.
  if (!win || !root || win.browsingContext?.embedderElement) return;
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync(DIALOG_BUTTON_RULES);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

/** @param {Document} doc  a sidebar document, once parsed */
function colourTrees(doc) {
  const win = doc.defaultView;
  if (!win) return;
  for (const tree of doc.querySelectorAll("tree")) {
    const root = tree.shadowRoot;
    if (!root) continue;
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(TREE_RULES);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
}

/**
 * A chrome document the window's sheets do not reach, and whose CSP refuses a data: <style>: it
 * gets the tokens, focus.css and `sheet` as author sheets, which its CSP does not apply to, is
 * kept in `pages` to follow theme changes, and is handed to `parsed` once it is parsed.
 * @param {Document | null | undefined} doc
 * @param {string} sheet
 * @param {(doc: Document) => void} parsed
 */
function attachPage(doc, sheet, parsed) {
  const win = doc?.defaultView;
  if (!doc || !win || pages.has(doc) || doc.documentURI === "about:blank") return;
  const uri = sheetUri(css);
  win.windowUtils.loadSheetUsingURIString(uri, win.windowUtils.AUTHOR_SHEET);
  win.windowUtils.loadSheetUsingURIString(FOCUS_SHEET, win.windowUtils.AUTHOR_SHEET);
  win.windowUtils.loadSheetUsingURIString(sheet, win.windowUtils.AUTHOR_SHEET);
  pages.set(doc, uri);
  win.addEventListener("unload", () => pages.delete(doc), { once: true });
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", () => parsed(doc), { once: true });
  } else {
    parsed(doc);
  }
}

/**
 * A document in Firefox's sidebar (history, bookmarks, ...), with firefox-sidebar-page.css; its
 * trees' scrollbars and rename fields get their colours once it is parsed. The History panel's
 * import promo draws its colours from tokens on :host in its shadow root, inside
 * sidebar-history's shadow root, which neither an author sheet nor an adopted sheet reaches
 * before Lit renders it: firefox-sidebar-promo.css is an agent sheet, which applies inside the
 * document's shadow trees, and sets only the promo's tokens.
 * @param {Document | null | undefined} doc
 */
function attachSidebarPage(doc) {
  attachPage(doc, SIDEBAR_PAGE_SHEET, (parsed) => {
    colourTrees(parsed);
    if (!parsed.nodePrincipal?.isSystemPrincipal) return;
    const win = /** @type {any} */ (parsed.defaultView);
    win?.windowUtils.loadSheetUsingURIString(SIDEBAR_PROMO_SHEET, win.windowUtils.AGENT_SHEET);
  });
}

/**
 * Whether `doc` is one of Firefox's own pages or dialogs shown by a themed window (spec
 * firefox-surfaces-theme): a privileged page in a tab (THEMED_PAGES), a dialog in a SubDialog
 * frame of a themed window or page (a prompt over a tab, the print settings, Settings' dialogs),
 * or a prompt in a window of its own while a window is themed. Only system-principal documents,
 * so no web page is ever touched.
 * @param {Document} doc
 */
function isFirefoxPage(doc) {
  if (!doc.nodePrincipal?.isSystemPrincipal) return false;
  const frame = /** @type {any} */ (doc.defaultView?.browsingContext?.embedderElement);
  if (!frame) return doc.documentURI === COMMON_DIALOG && windows.size > 0;
  const owner = frame.ownerDocument;
  if (!windows.has(owner.defaultView) && !pages.has(owner)) return false;
  if (frame.classList?.contains("dialogFrame")) return true;
  const name = /^about:([a-z-]+)/i.exec(doc.documentURI ?? "")?.[1]?.toLowerCase();
  return frame.localName === "browser" && name !== undefined && THEMED_PAGES.has(name);
}

/**
 * One of Firefox's pages or dialogs, with firefox-pages.css; a prompt in a window of its own
 * gets its buttons coloured once it is parsed. The root carries vimma-startpage while Vimma's
 * start page replaces Firefox Home, so Settings hides Firefox Home's content group (spec
 * firefox-surfaces-trim, decision 6): CSS cannot read a pref.
 * @param {Document} doc
 */
function attachFirefoxPage(doc) {
  attachPage(doc, PAGES_SHEET, (parsed) => {
    parsed.documentElement?.toggleAttribute(
      "vimma-startpage",
      Services.prefs.getBoolPref("vimma.startpage.newtab", false),
    );
    colourDialogButtons(parsed);
    colourWizards(parsed);
  });
}

/**
 * Tab Overview and the sidebar's documents, which show Firefox's empty states (#912), get
 * firefox-empty-states.css as an agent sheet: the picture's column sits in shadow roots, inside
 * further shadow roots, that neither an author sheet nor ::part reaches, while a document's agent
 * sheets apply inside its shadow trees. Only these parent-process system-principal documents, so
 * no web page can tell Vimma by it. Whether or not a window is themed: the pictures are always
 * empty.
 * @param {Document} doc
 * @param {boolean} inSidebar
 */
function hideEmptyStatePictures(doc, inSidebar) {
  const win = doc?.defaultView;
  if (!doc || !win || emptyStateDocs.has(doc)) return;
  if (!doc.nodePrincipal?.isSystemPrincipal) return;
  if (!inSidebar && !/^about:firefoxview(?:[#?]|$)/i.test(doc.documentURI ?? "")) return;
  win.windowUtils.loadSheetUsingURIString(EMPTY_STATES_SHEET, win.windowUtils.AGENT_SHEET);
  emptyStateDocs.add(doc);
}

/**
 * "document-element-inserted": a document got its root element, before it is styled or painted.
 * The sidebar documents' events do not reach the window, so this observer, not a listener on
 * <browser id="sidebar">, is how they are found: the panel's own document (not a frame inside it)
 * in a window this module themes.
 * @param {unknown} subject
 */
function onDocumentInserted(subject) {
  const doc = /** @type {Document} */ (subject);
  const frame = doc.defaultView?.browsingContext?.embedderElement;
  if (frame) hideEmptyStatePictures(doc, frame.id === "sidebar");
  if (frame?.id === "sidebar") {
    const owner = frame.ownerDocument.defaultView;
    if (owner && windows.has(owner)) attachSidebarPage(doc);
    return;
  }
  if (isFirefoxPage(doc)) attachFirefoxPage(doc);
}

export const ThemeHost = {
  /**
   * Once per browser window (vimma.js), before its UI is built: the current tokens as an author
   * sheet, swapped in place on every theme change; focus.css, which gives Firefox's focus colour
   * the tokens' --vimma-focus; firefox-sidebar.css, which gives Firefox's sidebar the tokens;
   * firefox-toolbar.css, which gives them to its toolbar and the panels hanging from it; and
   * firefox-chrome.css, to its find bar, menu bar and menus. Every document the sidebar's browser
   * loads gets the tokens too (spec firefox-sidebar-theme), and so do Firefox's own pages and
   * dialogs (spec firefox-surfaces-theme).
   * @param {BrowserWindow} win
   */
  init(win) {
    if (windows.has(win)) return;
    const uri = sheetUri(css);
    win.windowUtils.loadSheetUsingURIString(uri, win.windowUtils.AUTHOR_SHEET);
    win.windowUtils.loadSheetUsingURIString(FOCUS_SHEET, win.windowUtils.AUTHOR_SHEET);
    win.windowUtils.loadSheetUsingURIString(SIDEBAR_SHEET, win.windowUtils.AUTHOR_SHEET);
    win.windowUtils.loadSheetUsingURIString(TOOLBAR_SHEET, win.windowUtils.AUTHOR_SHEET);
    win.windowUtils.loadSheetUsingURIString(CHROME_SHEET, win.windowUtils.AUTHOR_SHEET);
    windows.set(win, uri);
    win.addEventListener(
      "unload",
      () => {
        windows.delete(win);
        stopIfIdle();
      },
      { once: true },
    );
    if (!observingDocuments) {
      Services.obs.addObserver(onDocumentInserted, DOCUMENT_TOPIC);
      observingDocuments = true;
    }
    // A panel already open (restored with the window) has missed its document's insertion.
    const panel = /** @type {any} */ (win.document.getElementById("sidebar"))?.contentDocument;
    attachSidebarPage(panel);
    hideEmptyStatePictures(panel, true);
    start();
  },

  /**
   * A start page's tokens: a <style> in its head, rewritten on every theme change.
   * @param {Document} doc
   */
  attachDocument(doc) {
    const style = /** @type {HTMLStyleElement} */ (doc.createElement("style"));
    style.textContent = css;
    doc.head.append(style);
    styles.add(new WeakRef(style));
  },

  /**
   * config.toml's `[theme]` (m5-config-load): `source` "file" stops following Omarchy; `name` is
   * the built-in palette shown without one; `font` and `colors` overlay either source. Unchanged
   * settings cost nothing.
   * @param {ResolvedConfig["theme"]} theme
   */
  setConfig(theme) {
    const next = {
      source: theme.source,
      name: theme.name ?? DEFAULT_THEME_NAME,
      ...(theme.appearance === undefined ? {} : { appearance: theme.appearance }),
      font: theme.font,
      colors: { ...theme.colors },
    };
    if (JSON.stringify(next) === JSON.stringify(configTheme)) return;
    configTheme = next;
    recheck();
  },

  /**
   * What about:vimma shows: the source in force ("builtin": no Omarchy, the pref, or
   * config.toml's source = "file"), whether Omarchy is installed (null: not looked for yet),
   * whether the poll runs, the built-in palette's name (`[theme] name`) and appearance, the
   * Omarchy theme directory, what the last check found ("pending" before one, "builtin",
   * "missing", "loaded", or "rejected" when that file's errors kept the theme shown), the
   * colors.toml mtime (ms) it saw, the last rejected file's errors, and the applied theme's
   * warnings.
   */
  get status() {
    const parts = signature.split("|");
    const seen = parts.length > 1;
    return {
      source: followsOmarchy() ? "omarchy" : "builtin",
      omarchy: omarchyInstalled,
      polling: timer !== null,
      builtin: configTheme.name ?? DEFAULT_THEME_NAME,
      appearance: appearance(),
      path: themeDir(),
      state: signature === "" ? "pending" : seen ? (lastError ? "rejected" : "loaded") : signature,
      mtime: seen ? Number(parts[1]) : null,
      lastError,
      warnings: [...warnings],
    };
  },

  /**
   * The control socket's `reload-theme` (Omarchy's theme-set hook): check the theme now rather
   * than at the next poll, and read colors.toml even if its stat looks unchanged. Same rules as
   * a poll (the configured path only, strict validation); settles once the windows show it.
   * @returns {Promise<{ changed: boolean }>}
   */
  async reload() {
    const before = css;
    // A check that stat'ed before the hook ran may skip the new file: let it finish first.
    while (running) await running;
    signature = "";
    await poll();
    return { changed: css !== before };
  },

  /**
   * Looks for Omarchy again, under `dir` (tests: a temporary HOME; startup does this once).
   * @param {string} dir
   * @returns {Promise<boolean>} found
   */
  detectOmarchy(dir) {
    return detect(dir);
  },

  /** Whether Omarchy is installed, once looked for (OmarchyHook waits for it). */
  get omarchyDetected() {
    return detection ?? detect(systemHome());
  },

  /**
   * Whether the theme follows Omarchy (the start page leaves out the `:theme` tip then), once
   * Omarchy has been looked for.
   * @returns {Promise<boolean>}
   */
  async followsOmarchy() {
    await this.omarchyDetected;
    return followsOmarchy();
  },

  /**
   * `:theme [dark|light|system]` (theme-appearance B3-B5): the built-in palette's appearance,
   * kept in a pref unless config.toml sets it; without a word the other of what `win` shows.
   * @param {BrowserWindow} win
   * @param {string} [text]
   * @returns {{ text: string, error?: boolean }}  the notice
   */
  setAppearance(win, text) {
    const word = (text ?? "").trim().toLowerCase();
    if (word && !APPEARANCE_WORDS.includes(word)) {
      return { text: `theme: ${JSON.stringify(word)} is not dark, light or system`, error: true };
    }
    if (configTheme.appearance !== undefined) {
      const set = JSON.stringify(configTheme.appearance);
      return { text: `theme: config.toml sets [theme] appearance = ${set}; change it there` };
    }
    const shown = win
      .getComputedStyle(win.document.documentElement)
      .getPropertyValue("--vimma-color-scheme")
      .trim();
    const next = word || (shown === "light" ? "dark" : "light");
    // Before the pref: its observer starts a fresh check, which forgets what is shown.
    const omarchyShown = followsOmarchy() && loaded;
    if (next === "system") Services.prefs.clearUserPref(APPEARANCE_PREF);
    else Services.prefs.setStringPref(APPEARANCE_PREF, next);
    let said = `theme: ${next}`;
    if (next === "system") {
      const light = win.matchMedia("(prefers-color-scheme: light)").matches;
      said += ` (${light ? "light" : "dark"} now)`;
    }
    const mode = configTheme.colors.mode;
    if (mode === "dark" || mode === "light") {
      said += `; config.toml's [theme.colors] mode = "${mode}" keeps it ${mode}`;
    } else if (omarchyShown) {
      said += "; your Omarchy theme is shown, this is for the built-in one";
    }
    return { text: said };
  },

  /** The token stylesheet in force (tests). */
  get css() {
    return css;
  },
};
