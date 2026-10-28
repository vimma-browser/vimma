/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * config.toml: parse, validate schema v2, migrate, merge with defaults, keep the last good one.
 * See docs/specs/m5-core-config-and-theme.md (v1) and docs/specs/m3-m4-core-prep.md (v2).
 * Core does no I/O: the host passes file contents.
 */
import { closest, resolveActionName } from "./actions.mjs";
import { BOOKMARKS_TOOLBAR_SETTINGS } from "./bookmarks-toolbar.mjs";
import { DEFAULT_CONFIG, WORKSPACE_DEFAULTS, formatConfigTemplate } from "./defaults.mjs";
import { INSERT_SITE_MODES } from "./editable.mjs";
import { DEFAULT_HINT_CHARS, hintLabels } from "./hints.mjs";
import { KeymapError, compileKeymap } from "./keymap.mjs";
import { MODES, isMode } from "./modes.mjs";
import { PANES_MAX_DEFAULT, PANES_MAX_LIMIT } from "./panes.mjs";
import { MAIN_SIZE_DEFAULT } from "./layouts.mjs";
import { APPEARANCES, BUILTIN_THEMES, PALETTE_KEYS, isHexColor, normalizeHex } from "./theme.mjs";
import { resolveRoutes, validateRoutes } from "./routes.mjs";
import { formatPath, locateKeys, parsePath, parseToml } from "./toml.mjs";
import { canonicalChord, isShortcutChord } from "./firefox-keys.mjs";
import { KeyNotationError, formatKey, parseKey } from "./keys.mjs";
import { BOOKMARKS_ROOTS } from "./bookmarks.mjs";
import { quarantineProblem, resolveDownloadDir } from "./agent-downloads.mjs";
import { resolveSearch, validateSearch } from "./search.mjs";

/** @import { Keymap } from "./keymap.mjs" */
/** @import { UserConfig } from "./defaults.mjs" */
/** @import { Path } from "./toml.mjs" */
/** @import { ThemeConfig } from "./theme.mjs" */
/** @import { InsertSiteMode, InsertSiteRule } from "./editable.mjs" */
/** @import { Route } from "./routes.mjs" */
/** @import { BookmarksRoot } from "./bookmarks.mjs" */
/** @import { ResolvedSearch } from "./search.mjs" */

/**
 * @typedef {object} ConfigError
 * @property {number} [line]         1-based; absent when nothing in the file locates it
 * @property {number} [column]       syntax errors only
 * @property {string} path           config path (`keys.new_tab[1]`); "" for syntax errors
 * @property {string} message
 * @property {string} [suggestion]
 */

/**
 * @typedef {object} Workspace
 * @property {string} name
 * @property {string} color      canonical Firefox container colour
 * @property {string} icon
 * @property {string} [home]
 * @property {boolean} autofill
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {number} schema
 * @property {Record<string, string | string[]>} keys     as written; compileKeymap merges
 * @property {Record<string, unknown>} modal              as written; compileKeymap merges
 * @property {Record<string, string[]>} unbind
 * @property {Workspace[]} workspaces                     file order = workspace order
 * @property {ThemeConfig} theme
 * @property {{ max: number, layout: "dwindle" | "manual", mainSize: number }} panes
 *   `[panes]` (schema 2); `mainSize` is `main_size` as a share (0.6), docs/specs/tiling-layouts.md
 * @property {string} hintChars                          `[modal] hint_chars` (schema 2)
 * @property {InsertSiteRule[]} sites                    `[sites."<host>"]` in file order (schema 2)
 * @property {Route[]} routes                            `[[routes]]` in file order (schema 2)
 * @property {FirefoxKeySetting} firefox                 `[firefox]`, chords canonical (schema 2)
 * @property {boolean} insertEditing                     `[modal] insert_editing` (schema 2)
 * @property {{ root: BookmarksRoot }} bookmarks          `[bookmarks]` (schema 2)
 * @property {{ placement: PrivatePlacement }} private    `[private]` (schema 2), private-swap
 * @property {McpConfig} mcp                             `[mcp]` (schema 2), docs/specs/vimma-mcp.md
 * @property {{ toolbar: ToolbarSetting, bookmarksToolbar: BookmarksToolbarSetting | null }} ui
 *   `[ui]` (schema 2): toolbar-toggle; `bookmarksToolbar` is null when unset
 *   (docs/specs/bookmarks-toolbar-hidden.md decision 3: Firefox's pref decides)
 * @property {ResolvedSearch | null} search              `[search]` (schema 2), null without it;
 *   docs/specs/search-engines.md
 * @property {{ check: boolean }} updates                `[updates]` (schema 2),
 *   docs/specs/m6a-updater.md
 */

/**
 * `[mcp]` (vimma-mcp decision 26). `enabled` is there only when the file sets it: then it wins
 * over `:mcp on|off` (the pref), as `[theme] appearance` wins over `:theme`.
 * @typedef {{ enabled?: boolean, workspace: string, askTimeout: number, grantMinutes: number,
 *   grantMaxMinutes: number, maxReadChars: number, notify: boolean, downloadDir: string,
 *   downloadMaxMb: number, clamavMaxAgeDays: number }} McpConfig  `downloadDir` as written (`~` not expanded yet)
 */

/** @typedef {"swap" | "window"} PrivatePlacement */
/** @typedef {"shown" | "hidden"} ToolbarSetting */
/** @typedef {import("./bookmarks-toolbar.mjs").BookmarksToolbarSetting} BookmarksToolbarSetting */

/**
 * Which of Firefox's own shortcuts are off (docs/specs/key-handling-batch.md § 1).
 * @typedef {{ disable: "all" | string[], enable: string[] }} FirefoxKeySetting
 */

/** @typedef {{ config: ResolvedConfig, keymap: Keymap }} ActiveConfig */
/** @typedef {(config: Record<string, unknown>) => Record<string, unknown>} Migration */

export const CONFIG_SCHEMA_VERSION = 2;

/**
 * Step `n` turns a schema-n object into a schema-(n+1) object. Pure; never mutates its input.
 * @type {Readonly<Record<number, Migration>>}
 */
export const MIGRATIONS = Object.freeze({
  // v0: configs without `schema`, written before M5. Same shape as v1.
  0: (config) => ({ ...config, schema: 1 }),
  // v1 → v2 only adds keys ([panes], [sites], [modal] hint_chars). A file must say schema = 2 to
  // use them, so an older vimma reports "from a newer vimma" instead of an unknown key.
  1: (config) => ({ ...config, schema: 2 }),
});

/**
 * @param {Record<string, unknown>} raw
 * @param {number} from
 * @param {number} [to]
 * @param {Readonly<Record<number, Migration>>} [registry]
 * @returns {{ config: Record<string, unknown>, applied: string[] }}
 */
export function migrate(raw, from, to = CONFIG_SCHEMA_VERSION, registry = MIGRATIONS) {
  if (from > to) throw new Error(`config schema ${from} is newer than ${to}`);
  let config = raw;
  /** @type {string[]} */
  const applied = [];
  for (let v = from; v < to; v++) {
    const step = registry[v];
    if (typeof step !== "function") throw new Error(`no migration from schema ${v} to ${v + 1}`);
    config = step(config);
    applied.push(`${v}→${v + 1}`);
  }
  return { config, applied };
}

// Firefox container colours and icons (ContextualIdentityService.sys.mjs); workspacedefs.mjs too.
export const CONTAINER_COLORS = [
  "gray",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "violet",
  "blue",
  "cyan",
  "green",
];
/** @type {Record<string, string>} */
const COLOR_ALIASES = { turquoise: "cyan", toolbar: "gray" };
export const CONTAINER_ICONS = [
  "fingerprint",
  "briefcase",
  "dollar",
  "cart",
  "vacation",
  "gift",
  "food",
  "fruit",
  "pet",
  "tree",
  "chill",
  "circle",
  "fence",
];
const TOP_KEYS = [
  "schema",
  "keys",
  "modal",
  "unbind",
  "workspaces",
  "theme",
  "panes",
  "sites",
  "routes",
  "firefox",
  "bookmarks",
  "private",
  "mcp",
  "ui",
  "search",
  "updates",
];
const KEYMAP_SECTIONS = new Set(["keys", "modal", "unbind", "firefox"]);
const WORKSPACE_KEYS = ["color", "icon", "home", "autofill"];
const THEME_KEYS = ["source", "name", "appearance", "font", "colors"];
const THEME_NAMES = Object.keys(BUILTIN_THEMES);
const THEME_SOURCES = ["omarchy", "file"];
const PANES_KEYS = ["max", "layout", "main_size"];
/** `[panes] layout` (docs/specs/tiling-layouts.md): where a pane opened without a direction goes. */
export const PANES_LAYOUT_MODES = Object.freeze(["dwindle", "manual"]);
/** `[panes] main_size` bounds, in percent. */
export const MAIN_SIZE_MIN = 20;
export const MAIN_SIZE_MAX = 80;
const SITE_KEYS = ["insert"];
const MODAL_KEYS = ["leader", "timeout_ms", "hint_chars", "insert_editing"];
const FIREFOX_KEYS = ["disable", "enable"];
const FIREFOX_DISABLE = 'must be "all" or a list of keys like "ctrl+w"';
/** Keys a file may use only when it declares `schema = 2`, by config path. */
const SCHEMA_2_KEYS = [
  "panes",
  "sites",
  "modal.hint_chars",
  "routes",
  "firefox",
  "modal.insert_editing",
  "bookmarks",
  "theme.name",
  "theme.appearance",
  "private",
  "mcp",
  "ui",
  "search",
  "updates",
];
/** `[bookmarks]` (docs/specs/bookmarks.md, decision 2). */
const BOOKMARKS_KEYS = ["root"];
/** `[private] placement` (docs/specs/private-swap.md, decision 1). */
export const PRIVATE_PLACEMENTS = Object.freeze(
  /** @type {PrivatePlacement[]} */ (["swap", "window"]),
);
const PRIVATE_KEYS = ["placement"];
/** `[ui] toolbar` (docs/specs/toolbar-toggle.md, decision 3). */
export const TOOLBAR_SETTINGS = Object.freeze(
  /** @type {ToolbarSetting[]} */ (["shown", "hidden"]),
);
const UI_KEYS = ["toolbar", "bookmarks_toolbar"];
/** Firefox's words for the bookmarks toolbar's states, and the Vimma word each means. */
const FIREFOX_VISIBILITY_WORDS = Object.freeze({ always: "shown", never: "hidden" });
/** `[updates]` (docs/specs/m6a-updater.md, Security and privacy, "Off"). */
const UPDATES_KEYS = ["check"];
/** `[mcp]` (docs/specs/vimma-mcp.md, decision 26) and its bounds. */
const MCP_KEYS = [
  "enabled",
  "workspace",
  "ask_timeout",
  "grant_minutes",
  "grant_max_minutes",
  "max_read_chars",
  "notify",
  "download_dir",
  "download_max_mb",
  "clamav_max_age_days",
];
export const MCP_BOUNDS = Object.freeze({
  askTimeout: Object.freeze({ min: 10, max: 300 }),
  grantMaxMinutes: Object.freeze({ min: 1, max: 1440 }),
  maxReadChars: Object.freeze({ min: 1000, max: 500000 }),
  downloadMaxMb: Object.freeze({ min: 1, max: 4096 }),
  clamavMaxAgeDays: Object.freeze({ min: 1, max: 90 }),
});

/** The private workspace's name (privatews.mjs): never the agent workspace's. */
const PRIVATE_WORKSPACE_NAME = "private";
const NEEDS_SCHEMA_2 = "is new in schema 2: put schema = 2 at the top of the file";
const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const DOMAIN = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.?$`, "i");
// Hex digits, dots and colons, bracketed or not; with a colon (tested apart: a pattern placing
// the colon inside the run backtracks quadratically on a long key).
const IPV6 = /^(?:\[[0-9a-f:.]*\]|[0-9a-f:.]*)$/i;
const BAD_HOST = 'must be a hostname like "docs.google.com", without scheme, port, path or *';
const MAX_TIMEOUT_MS = 10000;
export const MAX_WORKSPACE_NAME = 32;
const MAX_FONT = 200;
const FONT_FORBIDDEN = /["';{}\\<>]/;
const HOME = /^(?:https?:\/\/|about:)\S+$/;

/** @param {string} s */
const hasControl = (s) =>
  [...s].some((ch) => /** @type {number} */ (ch.codePointAt(0)) < 0x20 || ch === "\x7f");

/** @param {unknown} v */
function typeName(v) {
  if (Array.isArray(v)) return "an array";
  if (v instanceof Date) return "a date";
  if (typeof v === "object") return "a table";
  // parsed with integersAsBigInt: TOML integers are BigInt, TOML floats are numbers
  if (typeof v === "bigint") return "an integer";
  if (typeof v === "number") return "a float";
  return typeof v === "string" ? "a string" : "a boolean";
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isTable = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** @typedef {{ path: Path, message: string, suggestion?: string }} Problem */

/**
 * A `[sites."<host>"]` key: a hostname as `URL.hostname` gives it (a domain, an IPv4 address or
 * an IPv6 address, bracketed or not), optionally with a trailing dot.
 * @param {string} host
 */
const isSiteHost = (host) => DOMAIN.test(host) || (host.includes(":") && IPV6.test(host));

/**
 * The same host as matchSiteRule compares it: case, a trailing dot and IPv6 brackets ignored.
 * @param {string} host
 */
const siteKey = (host) =>
  host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");

/**
 * What the user probably meant by a key that is not a hostname: the host of a URL, a host
 * without its port, a wildcard domain without `*.` (a rule already covers subdomains).
 * @param {string} key
 * @returns {string | undefined}
 */
function hostSuggestion(key) {
  const host = key
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\*\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d*$/, "");
  return host !== key && isSiteHost(host) ? host : undefined;
}

/**
 * @param {unknown} chars
 * @returns {boolean}
 */
function isHintCharset(chars) {
  try {
    hintLabels(0, /** @type {string} */ (chars));
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the current schema and returns every problem; keymap contents are left to compileKeymap.
 * @param {Record<string, unknown>} raw  migrated to the current schema
 * @param {number} declared  the schema the file declared (0 without `schema`)
 * @returns {Problem[]}
 */
function validate(raw, declared) {
  /** @type {Problem[]} */
  const problems = [];
  /** @param {Path} path @param {string} message @param {string} [suggestion] */
  const fail = (path, message, suggestion) =>
    problems.push(suggestion ? { path, message, suggestion } : { path, message });
  /** @param {Path} path @param {unknown} v @param {string} expected */
  const typeError = (path, v, expected) => fail(path, `expected ${expected}, got ${typeName(v)}`);
  /**
   * @param {Path} path
   * @param {unknown} v
   * @returns {v is Record<string, unknown>}
   */
  const table = (path, v) => {
    if (isTable(v)) return true;
    typeError(path, v, "a table");
    return false;
  };
  /** @param {Path} path @param {string} key @param {readonly string[]} known */
  const unknownKey = (path, key, known) => fail(path, `unknown key "${key}"`, closest(key, known));

  /**
   * A schema-2 key in a file that declares an older schema: reported once, then skipped.
   * @param {Path} path
   */
  const gated = (path) => {
    if (declared >= 2 || !SCHEMA_2_KEYS.includes(path.join("."))) return false;
    fail(path, NEEDS_SCHEMA_2);
    return true;
  };

  for (const [key, v] of Object.entries(raw)) {
    if (!TOP_KEYS.includes(key)) unknownKey([key], key, TOP_KEYS);
    else if (key === "routes") {
      // An array of tables (workspace-routing); routes.mjs checks it.
      if (!gated([key])) {
        for (const p of validateRoutes(v)) problems.push({ ...p, path: [key, ...p.path] });
      }
    } else if (key !== "schema" && !gated([key])) table([key], v);
  }

  if (isTable(raw.modal)) {
    for (const [key, v] of Object.entries(raw.modal)) {
      const path = ["modal", key];
      if (key === "leader") {
        if (typeof v !== "string") typeError(path, v, "a key string");
      } else if (key === "timeout_ms") {
        if (typeof v !== "bigint") typeError(path, v, "an integer");
        else if (v < 0n || v > BigInt(MAX_TIMEOUT_MS)) {
          fail(path, `must be an integer between 0 and ${MAX_TIMEOUT_MS}`);
        }
      } else if (key === "hint_chars") {
        if (gated(path)) continue;
        if (typeof v !== "string") typeError(path, v, "a string");
        else if (!isHintCharset(v)) {
          fail(path, "must be at least 2 distinct characters, none uppercase or whitespace");
        }
      } else if (key === "insert_editing") {
        if (gated(path)) continue;
        if (typeof v !== "boolean") typeError(path, v, "a boolean");
      } else if (isMode(key)) {
        table(path, v);
      } else {
        unknownKey(path, key, [...MODES, ...MODAL_KEYS]);
      }
    }
  }

  if (declared >= 2 && isTable(raw.firefox)) {
    for (const [key, v] of Object.entries(raw.firefox)) {
      const path = ["firefox", key];
      if (!FIREFOX_KEYS.includes(key)) {
        unknownKey(path, key, FIREFOX_KEYS);
        continue;
      }
      if (key === "disable" && v === "all") continue;
      if (!Array.isArray(v)) {
        if (key === "disable") fail(path, FIREFOX_DISABLE);
        else typeError(path, v, "a list of key strings");
        continue;
      }
      v.forEach((chord, i) => {
        const at = [...path, i];
        if (typeof chord !== "string") {
          typeError(at, chord, "a key string");
          return;
        }
        try {
          const c = parseKey(chord);
          // Firefox's stop (esc, shift+esc) is the inventory's only key without ctrl, alt or meta
          // that `all` turns off and a user can want back (docs/specs/firefox-keys.md decision 9).
          if (!isShortcutChord(c) && !["esc", "shift+esc"].includes(formatKey(c))) {
            fail(
              at,
              "Firefox's shortcuts have ctrl, alt or meta, are function keys, or are esc or shift+esc",
            );
          }
        } catch (e) {
          /* c8 ignore next */
          if (!(e instanceof KeyNotationError)) throw e;
          fail(at, e.message);
        }
      });
    }
  }

  if (isTable(raw.unbind)) {
    for (const [mode, v] of Object.entries(raw.unbind)) {
      if (!isMode(mode)) fail(["unbind", mode], `unknown mode "${mode}"`, closest(mode, MODES));
      else if (!Array.isArray(v)) typeError(["unbind", mode], v, "a list of key strings");
    }
  }

  if (isTable(raw.workspaces)) {
    for (const [name, ws] of Object.entries(raw.workspaces)) {
      const path = ["workspaces", name];
      const length = [...name].length;
      if (length < 1 || length > MAX_WORKSPACE_NAME) {
        fail(path, `workspace name must be 1 to ${MAX_WORKSPACE_NAME} characters`);
        continue;
      }
      if (hasControl(name)) {
        fail(path, "workspace name must not contain control characters");
        continue;
      }
      if (!table(path, ws)) continue;
      for (const [key, v] of Object.entries(ws)) {
        const at = [...path, key];
        if (key === "color") {
          if (typeof v !== "string") typeError(at, v, "a string");
          else if (!CONTAINER_COLORS.includes(v) && !Object.hasOwn(COLOR_ALIASES, v)) {
            fail(
              at,
              `unknown colour "${v}"`,
              closest(v, [...CONTAINER_COLORS, ...Object.keys(COLOR_ALIASES)]),
            );
          }
        } else if (key === "icon") {
          if (typeof v !== "string") typeError(at, v, "a string");
          else if (!CONTAINER_ICONS.includes(v))
            fail(at, `unknown icon "${v}"`, closest(v, CONTAINER_ICONS));
        } else if (key === "home") {
          if (typeof v !== "string") typeError(at, v, "a string");
          else if (!HOME.test(v))
            fail(at, "must be an http://, https:// or about: URL without spaces");
        } else if (key === "autofill") {
          if (typeof v !== "boolean") typeError(at, v, "a boolean");
        } else {
          unknownKey(at, key, WORKSPACE_KEYS);
        }
      }
    }
  }

  if (declared >= 2 && isTable(raw.panes)) {
    for (const [key, v] of Object.entries(raw.panes)) {
      const path = ["panes", key];
      if (key === "layout") {
        if (typeof v !== "string") typeError(path, v, "a string");
        else if (!PANES_LAYOUT_MODES.includes(v)) {
          fail(path, `must be "dwindle" or "manual"`, closest(v, PANES_LAYOUT_MODES));
        }
      } else if (key === "main_size") {
        if (typeof v !== "bigint") typeError(path, v, "an integer");
        else if (v < BigInt(MAIN_SIZE_MIN) || v > BigInt(MAIN_SIZE_MAX)) {
          fail(path, `must be an integer between ${MAIN_SIZE_MIN} and ${MAIN_SIZE_MAX} (percent)`);
        }
      } else if (key !== "max") unknownKey(path, key, PANES_KEYS);
      else if (typeof v !== "bigint") typeError(path, v, "an integer");
      else if (v < 1n || v > BigInt(PANES_MAX_LIMIT)) {
        fail(path, `must be an integer between 1 and ${PANES_MAX_LIMIT}`);
      }
    }
  }

  if (declared >= 2 && isTable(raw.bookmarks)) {
    for (const [key, v] of Object.entries(raw.bookmarks)) {
      const path = ["bookmarks", key];
      if (key !== "root") unknownKey(path, key, BOOKMARKS_KEYS);
      else if (typeof v !== "string") typeError(path, v, "a string");
      else if (!BOOKMARKS_ROOTS.includes(/** @type {BookmarksRoot} */ (v))) {
        fail(path, 'must be "workspace", "toolbar" or "all"', closest(v, BOOKMARKS_ROOTS));
      }
    }
  }

  if (declared >= 2 && isTable(raw.private)) {
    for (const [key, v] of Object.entries(raw.private)) {
      const path = ["private", key];
      if (key !== "placement") unknownKey(path, key, PRIVATE_KEYS);
      else if (typeof v !== "string") typeError(path, v, "a string");
      else if (!PRIVATE_PLACEMENTS.includes(/** @type {PrivatePlacement} */ (v))) {
        fail(path, 'must be "swap" or "window"', closest(v, PRIVATE_PLACEMENTS));
      }
    }
  }

  if (declared >= 2 && isTable(raw.ui)) {
    for (const [key, v] of Object.entries(raw.ui)) {
      const path = ["ui", key];
      if (!UI_KEYS.includes(key)) unknownKey(path, key, UI_KEYS);
      else if (typeof v !== "string") typeError(path, v, "a string");
      else if (key === "bookmarks_toolbar") {
        if (!BOOKMARKS_TOOLBAR_SETTINGS.includes(/** @type {BookmarksToolbarSetting} */ (v))) {
          const word = /** @type {Record<string, string>} */ (FIREFOX_VISIBILITY_WORDS)[v];
          fail(
            path,
            'must be "shown", "hidden" or "newtab"',
            word ?? closest(v, BOOKMARKS_TOOLBAR_SETTINGS),
          );
        }
      } else if (!TOOLBAR_SETTINGS.includes(/** @type {ToolbarSetting} */ (v))) {
        fail(path, 'must be "shown" or "hidden"', closest(v, TOOLBAR_SETTINGS));
      }
    }
  }

  if (declared >= 2 && isTable(raw.updates)) {
    for (const [key, v] of Object.entries(raw.updates)) {
      const path = ["updates", key];
      if (key !== "check") unknownKey(path, key, UPDATES_KEYS);
      else if (typeof v !== "boolean") typeError(path, v, "a boolean");
    }
  }

  if (declared >= 2 && isTable(raw.mcp)) validateMcp(raw.mcp, { fail, typeError, unknownKey });

  // docs/specs/search-engines.md, decision 2.
  if (declared >= 2 && isTable(raw.search)) problems.push(...validateSearch(raw.search));

  if (declared >= 2 && isTable(raw.sites)) {
    /** @type {Map<string, string>} */
    const seen = new Map();
    for (const [host, site] of Object.entries(raw.sites)) {
      const path = ["sites", host];
      if (!isSiteHost(host)) {
        fail(path, BAD_HOST, hostSuggestion(host));
        continue;
      }
      const first = seen.get(siteKey(host));
      if (first !== undefined) {
        fail(path, `same host as ${JSON.stringify(first)}`);
        continue;
      }
      seen.set(siteKey(host), host);
      if (!table(path, site)) continue;
      for (const [key, v] of Object.entries(site)) {
        const at = [...path, key];
        if (key !== "insert") unknownKey(at, key, SITE_KEYS);
        else if (typeof v !== "string") typeError(at, v, "a string");
        else if (!INSERT_SITE_MODES.includes(/** @type {InsertSiteMode} */ (v))) {
          fail(at, 'must be "auto", "never" or "always"', closest(v, INSERT_SITE_MODES));
        }
      }
    }
  }

  if (isTable(raw.theme)) {
    for (const [key, v] of Object.entries(raw.theme)) {
      const path = ["theme", key];
      if (key === "source") {
        if (typeof v !== "string") typeError(path, v, "a string");
        else if (!THEME_SOURCES.includes(v)) {
          fail(path, `must be "omarchy" or "file"`, closest(v, THEME_SOURCES));
        }
      } else if (key === "name") {
        if (gated(path)) continue;
        if (typeof v !== "string") typeError(path, v, "a string");
        else if (!THEME_NAMES.includes(v)) {
          const names = THEME_NAMES.map((n) => `"${n}"`).join(" or ");
          fail(path, `must be ${names}`, closest(v, THEME_NAMES));
        }
      } else if (key === "appearance") {
        // docs/specs/theme-appearance.md B1: left out, `:theme` (a pref) decides.
        if (gated(path)) continue;
        if (typeof v !== "string") typeError(path, v, "a string");
        else if (!APPEARANCES.includes(/** @type {any} */ (v))) {
          fail(path, `must be "system", "dark" or "light"`, closest(v, [...APPEARANCES]));
        }
      } else if (key === "font") {
        if (typeof v !== "string") typeError(path, v, "a string");
        else if (v.length < 1 || v.length > MAX_FONT)
          fail(path, `must be 1 to ${MAX_FONT} characters`);
        else if (FONT_FORBIDDEN.test(v) || hasControl(v)) {
          fail(path, `must not contain quotes, ; { } \\ < > or control characters`);
        }
      } else if (key === "colors") {
        if (!table(path, v)) continue;
        for (const [name, c] of Object.entries(v)) {
          const at = [...path, name];
          if (!PALETTE_KEYS.includes(name)) {
            fail(at, `unknown colour key "${name}"`, closest(name, PALETTE_KEYS));
          } else if (name === "mode") {
            if (c !== "dark" && c !== "light") fail(at, `must be "dark" or "light"`);
          } else if (!isHexColor(c)) {
            fail(at, `must be a hex colour like "#7aa2f7"`);
          }
        }
      } else {
        unknownKey(path, key, THEME_KEYS);
      }
    }
  }
  return problems;
}

/**
 * `[mcp]` (vimma-mcp decision 26): every value bounded, `grant_minutes` at most the
 * `grant_max_minutes` in force, `workspace` a workspace name that is not the private one's.
 * @param {Record<string, unknown>} mcp
 * @param {{ fail: (path: Path, message: string, suggestion?: string) => void,
 *   typeError: (path: Path, v: unknown, expected: string) => void,
 *   unknownKey: (path: Path, key: string, known: readonly string[]) => void }} report
 */
function validateMcp(mcp, { fail, typeError, unknownKey }) {
  /** @param {Path} path @param {unknown} v @param {number} min @param {number} max */
  const integer = (path, v, min, max, unit = "") => {
    if (typeof v !== "bigint") typeError(path, v, "an integer");
    else if (v < BigInt(min) || v > BigInt(max)) {
      fail(path, `must be an integer between ${min} and ${max}${unit}`);
    } else return true;
    return false;
  };
  const max = mcp.grant_max_minutes;
  const { grantMaxMinutes: g } = MCP_BOUNDS;
  const maxValid = typeof max === "bigint" && max >= BigInt(g.min) && max <= BigInt(g.max);
  const grantMax = maxValid ? Number(max) : DEFAULT_CONFIG.mcp?.grant_max_minutes;
  for (const [key, v] of Object.entries(mcp)) {
    const path = ["mcp", key];
    if (key === "enabled" || key === "notify") {
      if (typeof v !== "boolean") typeError(path, v, "a boolean");
    } else if (key === "workspace") {
      if (typeof v !== "string") typeError(path, v, "a string");
      else if ([...v].length < 1 || [...v].length > MAX_WORKSPACE_NAME) {
        fail(path, `must be 1 to ${MAX_WORKSPACE_NAME} characters`);
      } else if (hasControl(v)) fail(path, "must not contain control characters");
      else if (v === PRIVATE_WORKSPACE_NAME) {
        fail(path, `must not be "${PRIVATE_WORKSPACE_NAME}", the private workspace's name`);
      }
    } else if (key === "ask_timeout") {
      integer(path, v, MCP_BOUNDS.askTimeout.min, MCP_BOUNDS.askTimeout.max, " (seconds)");
    } else if (key === "grant_max_minutes") {
      integer(path, v, g.min, g.max, " (minutes)");
    } else if (key === "grant_minutes") {
      if (typeof v !== "bigint") typeError(path, v, "an integer");
      // 0: a bare `a` grants the whole connection (docs/specs/mcp-session-grants.md S1).
      else if (v < 0n || (grantMax !== undefined && v > BigInt(grantMax))) {
        fail(path, `must be an integer between 0 and grant_max_minutes (${grantMax})`);
      }
    } else if (key === "max_read_chars") {
      integer(path, v, MCP_BOUNDS.maxReadChars.min, MCP_BOUNDS.maxReadChars.max);
    } else if (key === "download_max_mb") {
      const { min, max: top } = MCP_BOUNDS.downloadMaxMb;
      integer(path, v, min, top, " (MB)");
    } else if (key === "clamav_max_age_days") {
      const { min, max: top } = MCP_BOUNDS.clamavMaxAgeDays;
      integer(path, v, min, top, " (days)");
    } else if (key === "download_dir") {
      const problem = downloadDirProblem(v);
      if (problem === "type") typeError(path, v, "a string");
      else if (problem) fail(path, problem);
    } else unknownKey(path, key, MCP_KEYS);
  }
}

/**
 * Why `[mcp] download_dir` is not a quarantine folder (decision 31 b), or null: `~/…` or an
 * absolute path, never home, `/` or the Downloads folder itself. The browser checks the folder
 * Firefox downloads to as well, when it uses it.
 * @param {unknown} v
 * @returns {string | null} `"type"` for a value that is not a string
 */
function downloadDirProblem(v) {
  if (typeof v !== "string") return "type";
  if (hasControl(v)) return "must not contain control characters";
  if (v.startsWith("$")) return "must not start with $: write ~/ for your home folder";
  if (!(v === "~" || v.startsWith("~/") || v.startsWith("/"))) return "must start with ~/ or /";
  if (v.split("/").includes("..")) return "must not contain ..";
  // `~` stands for a home folder no real path can be: the checks see `~/…` as under home.
  const HOME = "/~";
  return quarantineProblem(resolveDownloadDir(v, HOME), HOME);
}

/**
 * `[mcp]` with the defaults filled in (camelCase, as ResolvedConfig keeps it).
 * @param {UserConfig["mcp"]} mcp  valid
 * @returns {McpConfig}
 */
function resolveMcp(mcp) {
  const d = /** @type {Required<Omit<NonNullable<UserConfig["mcp"]>, "enabled">>} */ (
    DEFAULT_CONFIG.mcp
  );
  return {
    ...(mcp?.enabled === undefined ? {} : { enabled: mcp.enabled }),
    workspace: mcp?.workspace ?? d.workspace,
    askTimeout: mcp?.ask_timeout ?? d.ask_timeout,
    grantMinutes: mcp?.grant_minutes ?? d.grant_minutes,
    grantMaxMinutes: mcp?.grant_max_minutes ?? d.grant_max_minutes,
    maxReadChars: mcp?.max_read_chars ?? d.max_read_chars,
    notify: mcp?.notify ?? d.notify,
    downloadDir: mcp?.download_dir ?? d.download_dir,
    downloadMaxMb: mcp?.download_max_mb ?? d.download_max_mb,
    clamavMaxAgeDays: mcp?.clamav_max_age_days ?? d.clamav_max_age_days,
  };
}

/**
 * TOML integers parsed as BigInt back to numbers, once validation has bounded them.
 * @param {unknown} v
 * @returns {any}
 */
function toNumbers(v) {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(toNumbers);
  if (!isTable(v)) return v;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    Object.defineProperty(out, k, { value: toNumbers(x), enumerable: true, writable: true });
  }
  return out;
}

/**
 * `[firefox]` with the defaults filled in and every chord canonical, each once.
 * @param {UserConfig["firefox"]} firefox  valid
 * @returns {FirefoxKeySetting}
 */
function resolveFirefox(firefox) {
  const disable = firefox?.disable ?? "all";
  return {
    disable: disable === "all" ? "all" : [...new Set(disable.map(canonicalChord))],
    enable: [...new Set((firefox?.enable ?? []).map(canonicalChord))],
  };
}

/**
 * Fill every section of a valid config (as parsed) with defaults and normalise values.
 * @param {UserConfig} user
 * @param {string[]} [workspaceOrder]  workspace names in file order; JS objects list
 *   number-like keys first, so parseConfig passes the order it read from the text
 * @param {string[]} [siteOrder]  `[sites]` hosts in file order, for the same reason
 * @returns {ResolvedConfig}
 */
export function mergeWithDefaults(user, workspaceOrder, siteOrder) {
  const theme = user.theme ?? {};
  const defTheme = /** @type {Required<NonNullable<UserConfig["theme"]>>} */ (DEFAULT_CONFIG.theme);
  /** @type {Record<string, string>} */
  const colors = {};
  for (const [k, v] of Object.entries(theme.colors ?? {}))
    colors[k] = isHexColor(v) ? normalizeHex(v) : v;
  return {
    schema: CONFIG_SCHEMA_VERSION,
    keys: user.keys ?? {},
    modal: user.modal ?? {},
    unbind: user.unbind ?? {},
    workspaces: (workspaceOrder ?? Object.keys(user.workspaces ?? {})).map((name) => {
      const w = /** @type {NonNullable<UserConfig["workspaces"]>} */ (user.workspaces)[name] ?? {};
      const color = w.color ?? WORKSPACE_DEFAULTS.color;
      return {
        name,
        color: (Object.hasOwn(COLOR_ALIASES, color) && COLOR_ALIASES[color]) || color,
        icon: w.icon ?? WORKSPACE_DEFAULTS.icon,
        ...(w.home === undefined ? {} : { home: w.home }),
        autofill: w.autofill ?? WORKSPACE_DEFAULTS.autofill,
      };
    }),
    theme: {
      source: theme.source ?? defTheme.source,
      name: theme.name ?? defTheme.name,
      // Only when the file sets it: config.toml then wins over `:theme` (theme-appearance B4).
      ...(theme.appearance === undefined ? {} : { appearance: theme.appearance }),
      font: theme.font ?? defTheme.font,
      colors,
    },
    panes: {
      max: user.panes?.max ?? PANES_MAX_DEFAULT,
      layout: user.panes?.layout ?? "dwindle",
      mainSize: (user.panes?.main_size ?? MAIN_SIZE_DEFAULT * 100) / 100,
    },
    hintChars: /** @type {string | undefined} */ (user.modal?.hint_chars) ?? DEFAULT_HINT_CHARS,
    sites: (siteOrder ?? Object.keys(user.sites ?? {})).map((match) => ({
      match,
      insert: /** @type {NonNullable<UserConfig["sites"]>} */ (user.sites)[match]?.insert ?? "auto",
    })),
    routes: resolveRoutes(/** @type {Record<string, string>[]} */ (user.routes ?? [])),
    firefox: resolveFirefox(user.firefox),
    insertEditing: /** @type {boolean | undefined} */ (user.modal?.insert_editing) ?? true,
    bookmarks: { root: user.bookmarks?.root ?? "workspace" },
    private: { placement: user.private?.placement ?? "swap" },
    mcp: resolveMcp(user.mcp),
    ui: {
      toolbar: user.ui?.toolbar ?? "shown",
      bookmarksToolbar: user.ui?.bookmarks_toolbar ?? null,
    },
    search: resolveSearch(user.search),
    updates: { check: user.updates?.check ?? true },
  };
}

/**
 * @typedef {object} ParseResult
 * @property {ResolvedConfig | null} config   null whenever errors is non-empty
 * @property {Keymap | null} keymap
 * @property {ConfigError[]} errors           in file order
 * @property {number | null} migratedFrom     the file's schema when older than the current one
 */

/**
 * @param {string} text  contents of config.toml
 * @param {{ mac?: boolean }} [options]  compile over macOS's default keys (compileKeymap)
 * @returns {ParseResult}
 */
export function parseConfig(text, { mac = false } = {}) {
  /** @param {ConfigError[]} errors @returns {ParseResult} */
  const failed = (errors) => ({ config: null, keymap: null, errors, migratedFrom: null });

  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok) return failed([{ path: "", ...parsed.error }]);
  const raw = parsed.value;
  const lineOf = locateKeys(text);
  /** @param {Problem[]} problems @returns {ConfigError[]} */
  const located = (problems) =>
    problems
      .map(({ path, message, suggestion }) => {
        const line = lineOf(path);
        return {
          ...(line === undefined ? {} : { line }),
          path: formatPath(path),
          message,
          ...(suggestion ? { suggestion } : {}),
        };
      })
      .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));

  const rawSchema = raw.schema ?? 0n;
  if (typeof rawSchema === "number") {
    return failed(located([{ path: ["schema"], message: "must be an integer, got a float" }]));
  }
  if (typeof rawSchema !== "bigint" || rawSchema < 0n) {
    return failed(located([{ path: ["schema"], message: "must be a non-negative integer" }]));
  }
  const schema = rawSchema > BigInt(CONFIG_SCHEMA_VERSION) ? Infinity : Number(rawSchema);
  if (schema > CONFIG_SCHEMA_VERSION) {
    const message = `schema ${rawSchema} is from a newer vimma; this one reads up to ${CONFIG_SCHEMA_VERSION}`;
    return failed(located([{ path: ["schema"], message }]));
  }
  const migrated = migrate(raw, schema).config;
  const problems = validate(migrated, schema);
  const user = /** @type {UserConfig} */ (toNumbers(migrated));

  /** @type {Keymap | null} */
  let keymap = null;
  if (!problems.some((p) => KEYMAP_SECTIONS.has(/** @type {string} */ (p.path[0])))) {
    try {
      keymap = compileKeymap(
        { keys: user.keys, modal: user.modal, unbind: user.unbind, firefox: user.firefox },
        { mac },
      );
    } catch (e) {
      /* c8 ignore next */
      if (!(e instanceof KeymapError)) throw e;
      // compileKeymap names actions canonically; say what the user wrote (prev_workspace)
      let path = parsePath(e.path);
      let message = e.detail;
      for (const written of Object.keys(user.keys ?? {})) {
        const name = resolveActionName(written)?.name;
        if (!name || name === written) continue;
        if (path[0] === "keys" && path[1] === name) path = ["keys", written, ...path.slice(2)];
        message = message.replace(new RegExp(`\\b${name}\\b`, "g"), written);
      }
      problems.push({ path, message, ...(e.suggestion ? { suggestion: e.suggestion } : {}) });
    }
  }
  if (problems.length) return failed(located(problems));
  /** @param {"workspaces" | "sites"} table */
  const fileOrder = (table) =>
    Object.keys(user[table] ?? {}).sort(
      (a, b) =>
        /** @type {number} */ (lineOf([table, a])) - /** @type {number} */ (lineOf([table, b])),
    );
  return {
    config: mergeWithDefaults(user, fileOrder("workspaces"), fileOrder("sites")),
    keymap,
    errors: [],
    migratedFrom: schema === CONFIG_SCHEMA_VERSION ? null : schema,
  };
}

/**
 * Apply new config text atomically: on any error the previous config stays active (plan M5).
 * @param {ActiveConfig | null} active  the config in use, null before the first load
 * @param {string} text
 * @param {{ mac?: boolean }} [options]  macOS's default keys (compileKeymap)
 * @returns {{ active: ActiveConfig, errors: ConfigError[], kept: boolean }}
 *   kept: the text was not applied; `active` is the previous config, or the defaults
 */
export function reloadConfig(active, text, { mac = false } = {}) {
  const r = parseConfig(text, { mac });
  if (r.config && r.keymap)
    return { active: { config: r.config, keymap: r.keymap }, errors: [], kept: false };
  const fallback = active ?? {
    config: mergeWithDefaults({}),
    keymap: compileKeymap({}, { mac }),
  };
  return { active: fallback, errors: r.errors, kept: true };
}

/**
 * `[updates] check` as the file says it, even when the file as a whole has errors elsewhere
 * (docs/specs/m6a-updater.md decision 31): a boolean, or null when the TOML does not parse or
 * the key is missing or not a boolean.
 * @param {string} text
 * @returns {boolean | null}
 */
export function rawUpdatesCheck(text) {
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok) return null;
  const updates = parsed.value.updates;
  const check = isTable(updates) ? updates.check : undefined;
  return typeof check === "boolean" ? check : null;
}

/**
 * `:route add` (spec workspace-routing): the text to append to config.toml for a `domain` rule,
 * or the whole file to create when it is missing (`text` null: the template plus the rule).
 * The result must parse: a file with errors now, an older schema or an inline `routes = [...]`
 * is refused with the reason, and nothing is written.
 * @param {string | null} text  config.toml as it is, null when missing
 * @param {{ domain: string, workspace: string }} rule
 * @param {{ mac?: boolean }} [options]  check it with macOS's default keys (compileKeymap)
 * @returns {{ append: string } | { create: string } | { error: string }}
 */
export function appendRouteText(text, { domain, workspace }, { mac = false } = {}) {
  const block = `[[routes]]\ndomain = ${JSON.stringify(domain)}\nworkspace = ${JSON.stringify(workspace)}\n`;
  const base = text ?? formatConfigTemplate();
  if (text !== null && parseConfig(text, { mac }).errors.length) {
    return { error: "config.toml does not parse now; fix it first (:config shows it)" };
  }
  const glue = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  const added = `${glue}${block}`;
  const after = parseConfig(base + added, { mac });
  const first = after.errors[0];
  if (first) {
    return {
      error: `config.toml does not parse with the rule added: ${first.path ? `${first.path}: ` : ""}${first.message}`,
    };
  }
  return text === null ? { create: base + added } : { append: added };
}

/**
 * `config.toml:12:5: keys.new_tabb: unknown action "new_tabb" (did you mean "new_tab"?)`
 * @param {ConfigError} e
 * @param {string} file  as the user should see it, e.g. ~/.config/vimma/config.toml
 */
export function formatConfigError(e, file) {
  const where = e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : "";
  const path = e.path ? `${e.path}: ` : "";
  const hint = e.suggestion ? ` (did you mean "${e.suggestion}"?)` : "";
  return `${file}${where}: ${path}${e.message}${hint}`;
}

/** `$HOME`, `$XDG_CONFIG_HOME`, `${HOME}`, `${XDG_CONFIG_HOME}` at the start of a path. */
const LEADING_VAR = /^\$(?:\{(HOME|XDG_CONFIG_HOME)\}|(HOME|XDG_CONFIG_HOME)(?![A-Za-z0-9_]))/;

/**
 * `:source <path>` (spec m5-config-load): the file a typed path names. `~`, `~/…`, `$HOME` and
 * `$XDG_CONFIG_HOME` (also as `${…}`) expand at the start; other variables and `~user` stay as
 * typed. A relative path is taken from the folder config.toml is in. `.` and `..` are resolved.
 * @param {string} arg
 * @param {{ home: string, xdgConfigHome?: string, configDir: string }} env
 *   `xdgConfigHome` unset, empty or relative means `~/.config`, as the XDG spec says
 * @returns {string | null} null for an empty argument (plain `:source`)
 */
export function resolveSourcePath(arg, { home, xdgConfigHome = "", configDir }) {
  let p = arg.trim();
  if (!p) return null;
  const xdg = xdgConfigHome.startsWith("/") ? xdgConfigHome : `${home}/.config`;
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  p = p.replace(LEADING_VAR, (_m, braced, bare) => ((braced ?? bare) === "HOME" ? home : xdg));
  if (!p.startsWith("/")) p = `${configDir}/${p}`;
  /** @type {string[]} */
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
