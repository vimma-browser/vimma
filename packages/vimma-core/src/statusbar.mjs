/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The always-visible status bar as plain data (spec m2-core-logic): segments with text and theme
 * token names, fitted to a character budget. The host renders them; no HTML here.
 */
import { formatConfigError } from "./config.mjs";
import { findStatusText } from "./find.mjs";
import { displayLabel } from "./tablabels.mjs";
import { clusterWidth, graphemes, textWidth } from "./textwidth.mjs";
import { PRIVATE_COLOR_TOKEN, PRIVATE_GLYPH, PRIVATE_NAME } from "./privatews.mjs";
import { AGENT_GLYPH } from "./agent.mjs";
import { upperLast } from "./hints.mjs";

export { textWidth };

/** @import { Mode } from "./modes.mjs" */
/** @import { ConfigError } from "./config.mjs" */
/** @import { FindStatus } from "./find.mjs" */

/**
 * @typedef {object} Segment
 * @property {string} id
 * @property {string} text
 * @property {string} fg            theme token name (`--vimma-…`)
 * @property {string | null} bg     theme token name, or null for the bar's background
 * @property {"left" | "right"} side
 * @property {number} priority      0 = most important; higher gives way first
 * @property {number} min           shortest width it may be shrunk to
 * @property {"end" | "middle" | "url" | "none"} cut  "url": truncateUrl with `origin`
 * @property {UrlOrigin | null} [origin]  for `cut: "url"`
 * @property {boolean} [keep]  never dropped: cut to its `min` while others give way, and past it
 *   only as the last resort
 */

/**
 * The host of a URL as the bar shows it, and its registrable domain (eTLD+1; the whole host for
 * an IP address), both in display form, from the host (`Services.eTLD`).
 * @typedef {{ host: string, base: string }} UrlOrigin
 */

/**
 * @typedef {object} StatusInput
 * @property {Mode} mode
 * @property {readonly string[]} [pending]      dispatcher.pending()
 * @property {{ name: string, index: number, color?: string, private?: boolean } | null} [workspace]
 *   `private`: the private workspace (docs/specs/private-workspace.md), `◆ private`
 * @property {{ index: number, count: number, title?: string | null, url?: string | null,
 *   label?: string | null, origin?: UrlOrigin | null } | null} [tab]
 * @property {{ index: number, count: number, hidden?: boolean } | null} [pane]  `hidden`: the
 *   split is kept as a view that is not shown (docs/specs/side-panel-unsplit.md decision 27)
 * @property {boolean} [loading]
 * @property {number | null} [progress]          0..1
 * @property {readonly ConfigError[]} [configErrors]
 * @property {string} [configFile]
 * @property {readonly string[]} [alerts]  persistent errors (containers off: no workspaces)
 * @property {FindStatus | null} [find]          the current `/` or `?` find (spec m1-find)
 * @property {{ waiting: number, minutes: number | null, ran: boolean, builtin?: string | null }
 *   | null} [agent]  local AI
 *   agents (docs/specs/vimma-mcp.md decision 24): questions waiting, the shortest grant's
 *   minutes left (Infinity for a grant of the whole connection), a request that just ran, and
 *   the built-in agent's running tasks (docs/specs/builtin-agent.md Behaviour 35)
 * @property {boolean} [toolbarHidden]  Firefox's toolbar is hidden (docs/specs/toolbar-toggle.md):
 *   the bar then carries its security and private-browsing cues; shown, those are left out
 * @property {SecurityLevel} [security]  the selected page's connection (securityFromState)
 * @property {boolean} [privateWindow]  a private browsing window
 * @property {readonly string[]} [sharing]  devices the page uses (sharingCues)
 * @property {UpdateNotice | null} [update]  a newer Vimma, or an update problem
 *   (docs/specs/m6a-updater.md §5, updateNotice)
 * @property {ElementStatus | null} [element]  the focused text block in ELEMENT mode
 * @property {HintStatus | null} [hint]  the hint session (hints.mjs hintStatus)
 */
/**
 * A hint session (docs/specs/follow-link-switch.md decision 8): its action, and the first label
 * still on screen, null until the targets are collected.
 * @typedef {{ action: import("./hints.mjs").HintAction, label: string | null }} HintStatus
 */
/**
 * The focused text block (docs/specs/element-focus.md decision 5): its kind, its length in
 * characters, and `seq`, which changes on every focus and move, so that each is spoken.
 * @typedef {{ kind: string, length: number, seq: number }} ElementStatus
 */
/** @import { UpdateNotice } from "./updates.mjs" */

/** @typedef {"secure" | "insecure" | "neutral"} SecurityLevel */

/**
 * The selected page's connection, decided as Firefox's identity block decides it
 * (browser-siteIdentity.js `_refreshIdentityIcons`), from the browser's own state rather than
 * from any element: "secure" for a verified connection (Firefox's quiet lock); "insecure" for a
 * certificate error page, a certificate exception, a broken connection (mixed content, a weak
 * cipher) or a page not served over a secure connection; "neutral" for the rest (about: pages,
 * files, add-on pages, the start page, http on localhost, which Firefox counts as secure).
 * @param {{ scheme: string, secure: boolean, broken: boolean, certOverride: boolean,
 *   errorPage: boolean, secureContext: boolean }} state  `secure`, `broken`, `certOverride`:
 *   the STATE_IS_SECURE, STATE_IS_BROKEN and STATE_CERT_USER_OVERRIDDEN bits of
 *   `browser.securityUI.state`; `errorPage`: a certificate or HTTPS-Only error page;
 *   `secureContext`: the page's window is a secure context
 * @returns {SecurityLevel}
 */
export function securityFromState({
  scheme,
  secure,
  broken,
  certOverride,
  errorPage,
  secureContext,
}) {
  if (errorPage) return "insecure";
  if (scheme !== "http" && scheme !== "https") return "neutral";
  if (certOverride || broken) return "insecure";
  if (secure) return "secure";
  return secureContext ? "neutral" : "insecure";
}

/**
 * What the page is using, from Firefox's per-tab sharing state (`browser._sharingState`, as
 * browser-sitePermissionPanel.js `updateSharingIndicator` reads it), in the address bar's order.
 * @param {{ webRTC?: { camera?: unknown, microphone?: unknown, screen?: unknown } | null,
 *   geo?: unknown, xr?: unknown, serial?: unknown } | null | undefined} state
 * @returns {string[]}
 */
export function sharingCues(state) {
  if (!state) return [];
  /** @type {string[]} */
  const out = [];
  /**
   * Camera and microphone are nsIMediaManagerService states (1 capturing, 2 disabled: paused);
   * screen a string ending in "Paused" when paused (webrtcUI getCombinedStateForBrowser).
   * @param {string} name @param {unknown} value
   */
  const add = (name, value) => {
    if (!value) return;
    const paused = value === 2 || (typeof value === "string" && value.endsWith("Paused"));
    out.push(paused ? `${name} paused` : name);
  };
  add("camera", state.webRTC?.camera);
  add("mic", state.webRTC?.microphone);
  add("screen", state.webRTC?.screen);
  add("location", state.geo);
  add("XR", state.xr);
  add("serial", state.serial);
  return out;
}

/** `[workspaces.<name>] color` (Firefox container colours) → its readable text token. */
export const WORKSPACE_COLOR_TOKENS = Object.freeze({
  gray: "--vimma-fg-dim",
  yellow: "--vimma-text-yellow",
  orange: "--vimma-text-orange",
  red: "--vimma-text-red",
  pink: "--vimma-text-bright-magenta",
  purple: "--vimma-text-magenta",
  violet: "--vimma-text-bright-blue",
  blue: "--vimma-text-blue",
  cyan: "--vimma-text-cyan",
  green: "--vimma-text-green",
});

/** An update notice's tone → its text token (docs/specs/m6a-updater.md §5). */
const UPDATE_TONES = Object.freeze({
  info: "--vimma-fg-dim",
  urgent: "--vimma-text-error",
  warn: "--vimma-text-yellow",
});

const ELLIPSIS = "…";

/**
 * Total width with one separator column between neighbours.
 * @param {readonly Segment[]} segments
 */
export function statusWidth(segments) {
  if (!segments.length) return 0;
  return segments.reduce((n, s) => n + textWidth(s.text), 0) + segments.length - 1;
}

/**
 * @param {[string, number][]} parts clusters with their widths
 * @param {number} max columns
 */
function take(parts, max) {
  /** @type {string[]} */
  const out = [];
  let used = 0;
  for (const [cluster, w] of parts) {
    if (used + w > max) break;
    out.push(cluster);
    used += w;
  }
  return { out, used };
}

/**
 * Cuts `text` to at most `width` columns with one ellipsis, never inside a grapheme cluster;
 * `middle` keeps head and tail. At one column it keeps the first character if that fits.
 * @param {string} text
 * @param {number} width
 * @param {"end" | "middle"} how
 */
export function truncate(text, width, how) {
  if (textWidth(text) <= width) return text;
  if (width <= 0) return "";
  /** @type {[string, number][]} */
  const parts = graphemes(text).map(({ segment }) => [segment, clusterWidth(segment)]);
  if (width === 1) {
    const first = /** @type {[string, number]} */ (parts[0]);
    return first[1] === 1 ? first[0] : ELLIPSIS;
  }
  const budget = width - 1;
  if (how === "end") return take(parts, budget).out.join("") + ELLIPSIS;
  const head = take(parts, Math.ceil(budget / 2));
  const tail = take(parts.slice().reverse(), budget - head.used);
  return head.out.join("") + ELLIPSIS + tail.out.reverse().join("");
}

/**
 * Where the host is in `text` (a URL as the bar shows it), with an IPv6 host's brackets.
 * @param {string} text
 * @param {string} host
 * @returns {{ start: number, end: number } | null}
 */
function findHost(text, host) {
  const scheme = text.indexOf("://");
  const from = scheme >= 0 ? scheme + 3 : 0;
  let start = text.indexOf(host, from);
  if (start < 0) start = text.lastIndexOf(host);
  if (start < 0) return null;
  let end = start + host.length;
  if (text[start - 1] === "[" && text[end] === "]") {
    start -= 1;
    end += 1;
  }
  return { start, end };
}

/**
 * The URL cut to `width` columns without ever cutting its registrable domain, since with the
 * toolbar hidden it is the only origin indicator (docs/security.md C3): the path and query go first, then the scheme with the leftmost labels of
 * the host, whole labels at a time, as Firefox's address bar keeps the base domain in view. Only
 * when even `…<base domain>…` does not fit is the domain's end cut. Without an origin (about:,
 * file:, a URL with no host) the end is cut, never the middle.
 * @param {string} text
 * @param {number} width
 * @param {UrlOrigin | null | undefined} origin
 * @returns {string | null}
 */
export function truncateUrl(text, width, origin) {
  if (textWidth(text) <= width) return text;
  const at = origin ? findHost(text, origin.host) : null;
  if (!origin || !at) return width > 0 ? truncate(text, width, "end") : null;
  const pre = text.slice(0, at.start);
  const host = text.slice(at.start, at.end);
  const rest = text.slice(at.end);
  const head = pre + host;
  const room = width - textWidth(head);
  if (room >= 2) return head + truncate(rest, room, "end");
  if (room === 1) return head + ELLIPSIS;
  const tail = rest ? ELLIPSIS : "";
  let last = "";
  for (const candidate of hostTails(host, origin.base, pre !== "")) {
    if (textWidth(candidate + tail) <= width) return candidate + tail;
    last = candidate;
  }
  // Narrower than the registrable domain itself: its end is cut as the last resort, rather
  // than the address going missing (docs/security.md C3).
  return width > 0 ? truncate(last + tail, width, "end") : null;
}

/**
 * The host with ever more of its leftmost labels cut, down to its registrable domain.
 * @param {string} host  as in the text (an IPv6 host with its brackets)
 * @param {string} base
 * @param {boolean} cutBefore  something before the host (the scheme) was cut
 */
function* hostTails(host, base, cutBefore) {
  if (host === base || host === `[${base}]` || !host.endsWith(`.${base}`)) {
    yield `${ELLIPSIS}${host}`;
    return;
  }
  const labels = host.split(".");
  const keep = base.split(".").length;
  for (let k = 0; k <= labels.length - keep; k++) {
    const lead = k > 0 || cutBefore ? ELLIPSIS : "";
    yield lead + labels.slice(k).join(".");
  }
}

/** The narrowest truncateUrl result for `text`, in columns. @param {string} text @param {UrlOrigin} origin */
function urlMinWidth(text, origin) {
  const at = findHost(text, origin.host);
  if (!at) return Math.min(12, textWidth(text));
  const host = text.slice(at.start, at.end);
  const rest = text.slice(at.end) ? 1 : 0;
  const tails = [...hostTails(host, origin.base, at.start > 0)];
  return Math.min(textWidth(text), textWidth(/** @type {string} */ (tails.at(-1))) + rest);
}

/**
 * The URL as the bar shows it: no `http(s)://`, no lone trailing `/`. `keepHttp` keeps
 * `http://`, which is part of the warning while the toolbar is hidden (toolbar-toggle 12).
 * @param {string} url
 * @param {{ keepHttp?: boolean }} [options]
 */
export function displayUrl(url, { keepHttp = false } = {}) {
  const m = (keepHttp ? /^https:\/\/(.*)$/i : /^https?:\/\/(.*)$/i).exec(url);
  if (!m) return url;
  const rest = /** @type {string} */ (m[1]);
  const slash = rest.indexOf("/");
  return slash === rest.length - 1 ? rest.slice(0, -1) : rest;
}

/** @param {number} n */
const chars = (n) => `${n} ${n === 1 ? "char" : "chars"}`;

/**
 * @param {Partial<Segment> & { id: string, text: string, fg: string, priority: number }} s
 * @returns {Segment}
 */
function seg(s) {
  return Object.freeze({ bg: null, side: "left", min: 0, cut: "none", ...s });
}

/**
 * Every segment the input calls for, untruncated, in on-screen order (left side, then right).
 * @param {StatusInput} input
 * @returns {Segment[]}
 */
export function statusSegments(input) {
  const {
    mode,
    pending = [],
    workspace = null,
    tab = null,
    pane = null,
    loading = false,
    progress = null,
    configErrors = [],
    configFile = "config.toml",
    alerts = [],
    find = null,
    agent = null,
    toolbarHidden = false,
    security = "neutral",
    privateWindow = false,
    sharing = [],
    update = null,
    element = null,
    hint = null,
  } = input;
  /** @type {Segment[]} */
  const left = [];
  /** @type {Segment[]} */
  const right = [];
  left.push(
    seg({
      id: "mode",
      text: mode.toUpperCase(),
      fg: `--vimma-mode-${mode}-fg`,
      bg: `--vimma-mode-${mode}`,
      priority: 0,
      min: 1,
      cut: "end",
    }),
  );
  if (element && mode === "element") {
    left.push(
      seg({
        id: "element",
        text: `${element.kind} · ${chars(element.length)}`,
        fg: "--vimma-fg-bright",
        priority: 1,
        min: 4,
        cut: "end",
      }),
    );
  }
  const hintText = mode === "hint" ? hintSegmentText(hint) : null;
  if (hintText) {
    // Cut at its end: the background half, gF's behaviour before the switch, goes last.
    left.push(
      seg({
        id: "hint",
        text: hintText,
        fg: "--vimma-fg-bright",
        priority: 1,
        min: 4,
        cut: "end",
      }),
    );
  }
  if (pending.length) {
    const prefix = pending[0] === "prefix";
    left.push(
      seg({
        id: "pending",
        text: pending.join(" "),
        fg: prefix ? "--vimma-mode-prefix-fg" : "--vimma-fg-bright",
        bg: prefix ? "--vimma-mode-prefix" : null,
        priority: 1,
      }),
    );
  }
  if (workspace?.private) {
    // The glyph and the word carry it without colour (private-workspace decision 6).
    left.push(
      seg({
        id: "workspace",
        text: `${PRIVATE_GLYPH} ${PRIVATE_NAME}`,
        fg: PRIVATE_COLOR_TOKEN,
        priority: 3,
        min: 6,
        cut: "end",
      }),
    );
  } else if (workspace) {
    const tokens = /** @type {Record<string, string>} */ (WORKSPACE_COLOR_TOKENS);
    left.push(
      seg({
        id: "workspace",
        text: `● ${workspace.index}:${workspace.name}`,
        fg: (workspace.color && tokens[workspace.color]) || "--vimma-text-accent",
        priority: 3,
        min: 6,
        cut: "end",
      }),
    );
  }
  let urlShownAsTitle = false;
  if (tab) {
    left.push(
      seg({
        id: "tab",
        text: `tab ${tab.index}/${tab.count}`,
        fg: "--vimma-statusbar-fg",
        priority: 4,
      }),
    );
  }
  if (pane && pane.count > 1) {
    left.push(
      seg({
        id: "pane",
        text: pane.hidden ? `split ${pane.count} hidden` : `pane ${pane.index}/${pane.count}`,
        fg: pane.hidden ? "--vimma-fg-dim" : "--vimma-statusbar-fg",
        priority: 7,
      }),
    );
  }
  if (tab) {
    const title = displayLabel(tab);
    // Toolbar hidden: the URL is the origin indicator, so a title cannot stand in for it.
    urlShownAsTitle = !toolbarHidden && !!tab.url && title === tab.url;
    left.push(
      seg({ id: "title", text: title, fg: "--vimma-fg-bright", priority: 5, min: 8, cut: "end" }),
    );
  }
  if (loading) {
    const text = typeof progress === "number" ? `${Math.round(progress * 100)}%` : "loading";
    right.push(seg({ id: "loading", text, fg: "--vimma-fg-dim", side: "right", priority: 6 }));
  }
  if (configErrors.length) {
    const first = formatConfigError(/** @type {ConfigError} */ (configErrors[0]), configFile);
    const n = configErrors.length;
    right.push(
      seg({
        id: "error",
        text: n > 1 ? `${n} errors: ${first}` : first,
        fg: "--vimma-text-error",
        side: "right",
        priority: 2,
        min: 16,
        cut: "end",
      }),
    );
  }
  if (alerts.length) {
    right.push(
      seg({
        id: "alert",
        text: alerts.join(" · "),
        fg: "--vimma-text-error",
        side: "right",
        priority: 2,
        min: 16,
        cut: "end",
      }),
    );
  }
  if (find) {
    right.push(
      seg({
        id: "find",
        text: findStatusText(find),
        fg: find.notFound ? "--vimma-text-error" : "--vimma-fg-bright",
        side: "right",
        priority: 3,
        min: 8,
        cut: "end",
      }),
    );
  }
  if (agent) {
    // The glyph and the word carry it without colour (decision 24), as `◆ private` does.
    const word = `${AGENT_GLYPH} agent`;
    // The built-in agent's running tasks say their own progress (builtin-agent Behaviour 35).
    const ran = agent.ran && !agent.waiting && !agent.builtin;
    const text = agent.waiting
      ? `${word} ${agent.waiting}?`
      : agent.builtin
        ? agent.builtin
        : ran
          ? `${word} ·`
          : agent.minutes !== null
            ? `${word} ${agent.minutes === Infinity ? "granted" : `${agent.minutes}m`}`
            : word;
    right.push(
      seg({
        id: "agent",
        text,
        fg: ran ? "--vimma-mode-normal-fg" : "--vimma-text-cyan",
        bg: ran ? "--vimma-mode-normal" : null,
        side: "right",
        // Just below the workspace's: it gives way before it, after the tab and title.
        priority: 3.5,
      }),
    );
  }
  if (update) {
    right.push(
      seg({
        id: "update",
        text: update.text,
        fg: UPDATE_TONES[update.tone],
        side: "right",
        // A security update outlasts the title (5); the rest give way before it.
        priority: update.tone === "urgent" ? 3 : 6.5,
        min: 8,
        cut: "end",
      }),
    );
  }
  if (toolbarHidden && security === "insecure") {
    // Text, not only colour (m7-a11y); as important as a config error (toolbar-toggle 12).
    right.push(
      seg({
        id: "security",
        text: "not secure",
        fg: "--vimma-text-error",
        side: "right",
        priority: 2,
      }),
    );
  }
  if (toolbarHidden && sharing.length) {
    // The address bar's and the tab's "in use" icons, both hidden here (docs/security.md C3).
    right.push(
      seg({
        id: "sharing",
        text: `using ${sharing.join(", ")}`,
        fg: "--vimma-text-error",
        side: "right",
        priority: 2,
      }),
    );
  }
  if (toolbarHidden && privateWindow && !workspace?.private) {
    // The toolbar's private-browsing indicator; the private workspace's segment says it already.
    right.push(
      seg({
        id: "private",
        text: PRIVATE_NAME,
        fg: PRIVATE_COLOR_TOKEN,
        side: "right",
        // A security cue: outranks the URL, as `not secure` and the devices in use do.
        priority: 2,
      }),
    );
  }
  if (tab?.url && !urlShownAsTitle && toolbarHidden) {
    // The origin indicator while the toolbar is hidden: never cut inside the registrable domain.
    const text = displayUrl(tab.url, { keepHttp: true });
    right.push(
      seg({
        id: "url",
        text,
        fg: "--vimma-fg-dim",
        side: "right",
        priority: 4.9,
        min: tab.origin ? urlMinWidth(text, tab.origin) : Math.min(12, textWidth(text)),
        cut: "url",
        origin: tab.origin ?? null,
        // Never dropped: what else gives way first, then the address is cut further.
        keep: true,
      }),
    );
  } else if (tab?.url && !urlShownAsTitle) {
    right.push(
      seg({
        id: "url",
        text: displayUrl(tab.url, { keepHttp: toolbarHidden }),
        fg: "--vimma-fg-dim",
        side: "right",
        // Toolbar hidden: the bar is the only place the address shows, so it outlasts the
        // title (5; on a tie the later segment gives way first, so just below it).
        priority: toolbarHidden ? 4.9 : 8,
        min: 12,
        cut: "middle",
      }),
    );
  }
  return [...left, ...right];
}

/**
 * The hint segment's text: `gF`'s two outcomes with a label the user can type now, `sd
 * background · sD go there` (only the first half when the label's last character has no upper
 * case); the switching action's one; none for `f` and `F`, whose outcome case does not change.
 * @param {HintStatus | null} hint
 * @returns {string | null}
 */
function hintSegmentText(hint) {
  if (!hint?.label) return null;
  if (hint.action === "hint.follow_new_tab_fg") return `${hint.label} go there`;
  if (hint.action !== "hint.follow_new_tab") return null;
  const up = upperLast(hint.label);
  return up ? `${hint.label} background · ${up} go there` : `${hint.label} background`;
}

/** What a screen reader hears once when a new-tab hint session starts (decision 9). */
const HINT_OUTCOMES = /** @type {Record<string, string>} */ ({
  "hint.follow_new_tab": "new tab: lower case opens in the background, upper case goes there",
  "hint.follow_new_tab_fg": "new tab: goes there",
});

/**
 * Fits segments into `width` columns: least important first, each is shrunk as far as needed
 * (down to its `min`), else dropped; `mode` (priority 0) is cut, never dropped, and keeps at least
 * one column. Returns the input itself when it fits, and no segments at width 0 or less.
 * @param {readonly Segment[]} segments
 * @param {number} width
 * @returns {Segment[]}
 */
export function fitStatus(segments, width) {
  if (width <= 0) return [];
  if (statusWidth(segments) <= width) return /** @type {Segment[]} */ (segments);
  /** @type {(Segment | null)[]} */
  const out = segments.slice();
  const visit = segments
    .map((s, i) => i)
    .sort(
      (a, b) =>
        /** @type {Segment} */ (segments[b]).priority -
          /** @type {Segment} */ (segments[a]).priority || b - a,
    );
  const current = () => /** @type {Segment[]} */ (out.filter(Boolean));
  /** @type {number[]} segments with `keep` */
  const kept = [];
  let yielded = false;
  for (const i of visit) {
    const excess = statusWidth(current()) - width;
    if (excess <= 0) break;
    const s = /** @type {Segment} */ (segments[i]);
    // A kept segment takes room only from less important ones: before anything that outranks
    // it gives way (the mode, the error, security and in-use cues), it is cut further.
    if (kept.length && s.priority < KEEP_YIELDS_BELOW && !yielded) {
      yielded = true;
      // The mode's full word gives way first, to its one-column short form; then the kept
      // segment, down to nothing; only then the cues themselves.
      let left = excess - shortenModes(out, left0(excess));
      if (left > 0 && yieldKept(out, segments, kept, left)) break;
      left = statusWidth(current()) - width;
      if (left <= 0) break;
    }
    const w = textWidth(s.text);
    if (s.priority === 0) {
      // never dropped: cut as far as needed, but to one column at least
      const room = Math.max(1, w - excess);
      out[i] =
        room === w
          ? s
          : { ...s, text: truncate(s.text, room, s.cut === "middle" ? "middle" : "end") };
      continue;
    }
    if (s.keep) {
      // Down to its `min` now; whatever comes next gives way before it is cut further.
      const room = Math.max(Math.min(s.min, w), w - excess);
      kept.push(i);
      out[i] = room >= w ? s : { ...s, text: cutUrl(s, room) };
      continue;
    }
    if (s.cut === "url" && w - Math.min(s.min, w) >= excess) {
      const text = truncateUrl(s.text, w - excess, s.origin);
      out[i] = text === null ? null : { ...s, text };
    } else if (s.cut !== "none" && w - Math.min(s.min, w) >= excess) {
      out[i] = { ...s, text: truncate(s.text, w - excess, s.cut === "url" ? "end" : s.cut) };
    } else {
      out[i] = null;
    }
  }
  // A kept segment takes back what the others freed (with its separator, if it had to go),
  // then the mode its full word.
  for (const i of kept) {
    const s = /** @type {Segment} */ (segments[i]);
    const now = out[i] ? textWidth(/** @type {Segment} */ (out[i]).text) : -1;
    const room = now + width - statusWidth(current());
    out[i] = room < 1 ? null : room >= textWidth(s.text) ? s : { ...s, text: cutUrl(s, room) };
  }
  if (yielded) {
    segments.forEach((s, i) => {
      const now = out[i];
      if (s.priority !== 0 || !now) return;
      const room = textWidth(now.text) + width - statusWidth(current());
      out[i] =
        room >= textWidth(s.text) ? s : { ...s, text: truncate(s.text, Math.max(1, room), "end") };
    });
  }
  return current();
}

/** @param {number} n */
const left0 = (n) => Math.max(0, n);

/**
 * Cuts the modes (priority 0) toward one column to free `excess` columns; returns how many.
 * @param {(Segment | null)[]} out
 * @param {number} excess
 */
function shortenModes(out, excess) {
  let freed = 0;
  out.forEach((s, i) => {
    if (!s || s.priority !== 0 || freed >= excess) return;
    const w = textWidth(s.text);
    const room = Math.max(1, w - (excess - freed));
    if (room < w) {
      out[i] = { ...s, text: truncate(s.text, room, "end") };
      freed += w - textWidth(/** @type {Segment} */ (out[i]).text);
    }
  });
  return freed;
}

/**
 * Segments whose priority is below this (more important) outrank a kept segment: the mode's
 * one-column short form (0), and the error, security, in-use and private cues (2). The mode's
 * full word does not: it gives way first. docs/security.md C3 orders them so.
 */
const KEEP_YIELDS_BELOW = 2.5;

/**
 * Cuts the kept segments further, down to nothing as the last resort, to free `excess` columns.
 * @param {(Segment | null)[]} out
 * @param {readonly Segment[]} segments
 * @param {number[]} kept
 * @param {number} excess
 * @returns {boolean} whether that was enough
 */
function yieldKept(out, segments, kept, excess) {
  let left = excess;
  for (const i of kept) {
    const now = out[i];
    if (!now || left <= 0) continue;
    const w = textWidth(now.text);
    const room = w - left;
    if (room >= 1) {
      out[i] = { ...now, text: cutUrl(/** @type {Segment} */ (segments[i]), room) };
      left -= w - textWidth(/** @type {Segment} */ (out[i]).text);
    } else {
      out[i] = null;
      left -= w + 1;
    }
  }
  return left <= 0;
}

/** @param {Segment} s @param {number} width */
function cutUrl(s, width) {
  return (
    (s.cut === "url" ? truncateUrl(s.text, width, s.origin) : truncate(s.text, width, "end")) ??
    ELLIPSIS
  );
}

/**
 * @param {StatusInput} input
 * @param {number} width columns available
 */
export function renderStatusBar(input, width) {
  return fitStatus(statusSegments(input), width);
}

/**
 * Modes whose own focused UI tells a screen reader where it is (the help dialog, the command
 * line's combobox, a panel's list): the status bar does not say them again.
 * @type {ReadonlySet<Mode>}
 */
const SELF_ANNOUNCING = new Set(["help", "command", "panel"]);

/**
 * What the status bar last said: the mode, the failed search (page and query), how many
 * agent questions were waiting, the focused text block's `seq`, and whether this hint session's
 * outcomes were said.
 * @typedef {{ mode: Mode | null, notFound: string | null, agentWaiting?: number,
 *   element?: number | null, hintTold?: boolean }} Announced
 */

/**
 * What the status bar's polite live region says for `input` (spec m7-a11y), or null for
 * nothing new. A mode is said once when it changes, except the modes in SELF_ANNOUNCING, which
 * are skipped as if they never happened (so the way back from them is silent too). A search
 * that found nothing is said once, when the line has closed. Titles and URLs are never said: a
 * screen reader reads the bar on demand (role=status).
 * @param {Announced} last
 * An agent question waiting (docs/specs/vimma-mcp.md decision 24) is said when the count rises.
 * A focused text block (docs/specs/element-focus.md decision 16) is said on each focus and
 * move: its kind and length, as "paragraph, 412 characters". A new-tab hint session
 * (docs/specs/follow-link-switch.md decision 9) says how to choose its outcome, once.
 * @param {{ mode: Mode, find?: FindStatus | null, url?: string | null, agentWaiting?: number,
 *   element?: ElementStatus | null, hint?: HintStatus | null }} input
 * @returns {{ text: string | null, last: Announced }}
 */
export function statusAnnouncement(
  last,
  { mode, find = null, url = null, agentWaiting = 0, element = null, hint = null },
) {
  const parts = [];
  let { mode: lastMode, notFound } = last;
  // ELEMENT mode is said with the block it focused, once the frame has said what that is.
  const waiting = mode === "element" && !element;
  if (!SELF_ANNOUNCING.has(mode) && mode !== lastMode && !waiting) {
    parts.push(`${mode} mode`);
    lastMode = mode;
  }
  if (find?.notFound && mode !== "command") {
    const key = `${url ?? ""}\n${find.query}`;
    if (key !== notFound) parts.push(`Pattern not found: ${find.query}`);
    notFound = key;
  } else if (!find?.notFound) {
    notFound = null;
  }
  const focused = mode === "element" && element ? element.seq : null;
  if (element && focused !== null && focused !== (last.element ?? null)) {
    const n = element.length;
    parts.push(`${element.kind}, ${n} ${n === 1 ? "character" : "characters"}`);
  }
  let hintTold = mode === "hint" && (last.hintTold ?? false);
  const outcomes = mode === "hint" && hint ? HINT_OUTCOMES[hint.action] : undefined;
  if (outcomes && !hintTold) {
    parts.push(outcomes);
    hintTold = true;
  }
  if (agentWaiting > (last.agentWaiting ?? 0)) {
    parts.push(
      agentWaiting === 1
        ? "Agent request waiting: ctrl+b shift+a to answer"
        : `${agentWaiting} agent requests waiting`,
    );
  }
  return {
    text: parts.length ? parts.join(". ") : null,
    last: { mode: lastMode, notFound, agentWaiting, element: focused, hintTold },
  };
}
