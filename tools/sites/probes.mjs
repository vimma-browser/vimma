// Probes the site suite evaluates in the browser over RDP (docs/specs/site-compat.md, decision
// 2). Each is a self-contained function: `probe(fn, arg)` sends its source, so it may use
// nothing from this module's scope. `content*` ones run in the tab's page (as the DevTools
// console does: the page cannot see the evaluation), `chrome*` ones in the parent process's
// browser window. They read, except: the keydown recorder on the page's window, focusing the
// search field, the consent click, leaving fullscreen, and the clipboard sentinel. Each returns
// JSON text, so only a string crosses the protocol.

/**
 * The source to evaluate: `fn(arg)`, its result as JSON.
 * @param {Function} fn
 * @param {unknown} [arg]
 */
export function probe(fn, arg = null) {
  return `(() => JSON.stringify((${fn.toString()})(${jsonLiteral(arg)})))()`;
}

/** @type {Record<string, string>} */
const LITERAL_ESCAPES = {
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * `arg` as a JSON literal that is also safe to embed in code: the characters that could close
 * a surrounding script or comment, or end a line, become \u escapes, which decode to the same
 * value. In JSON text they occur only inside strings, so the escapes stay valid.
 * @param {unknown} arg
 */
export function jsonLiteral(arg) {
  return JSON.stringify(arg).replace(/[<>/\u2028\u2029]/g, (ch) => LITERAL_ESCAPES[ch] ?? ch);
}

// ---------------------------------------------------------------------------------------------
// In the page

/**
 * What classify.mjs needs, plus load state and timing.
 * @param {{ consentSelectors: string[] }} arg
 */
export function contentPageInfo({ consentSelectors }) {
  const visible = (/** @type {Element} */ el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const nav = /** @type {PerformanceNavigationTiming | undefined} */ (
    performance.getEntriesByType("navigation")[0]
  );
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text: (document.body?.innerText ?? "").slice(0, 30000),
    frames: [...document.querySelectorAll("iframe")]
      .map((f) => f.src)
      .filter(Boolean)
      .slice(0, 40),
    consent: consentSelectors.filter((sel) => {
      const el = document.querySelector(sel);
      return !!el && visible(el);
    }),
    loadMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd - nav.startTime) : null,
  };
}

/** The document's scroller and every inner element that can scroll vertically. */
export function contentScrollSnapshot() {
  const root = document.scrollingElement ?? document.documentElement;
  const desc = (/** @type {Element} */ el) =>
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : "") +
    (typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "");
  /** @type {Array<{ key: string, top: number, max: number, area: number }>} */
  const inner = [];
  const seen = new Map();
  const walker = document.createTreeWalker(document.body ?? root, NodeFilter.SHOW_ELEMENT);
  let n = 0;
  for (let el = /** @type {Element | null} */ (walker.currentNode); el && n < 6000; n++) {
    const max = /** @type {any} */ (el).scrollTopMax ?? el.scrollHeight - el.clientHeight;
    if (max > 0 && el !== root && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") {
        const base = desc(el);
        const i = (seen.get(base) ?? 0) + 1;
        seen.set(base, i);
        const r = el.getBoundingClientRect();
        inner.push({
          key: i > 1 ? `${base}[${i}]` : base,
          top: Math.round(el.scrollTop),
          max: Math.round(max),
          area: Math.round(Math.max(0, r.width) * Math.max(0, r.height)),
        });
      }
    }
    el = /** @type {Element | null} */ (walker.nextNode());
  }
  inner.sort((a, b) => b.area - a.area);
  return {
    main: {
      top: Math.round(root.scrollTop),
      max: Math.round(
        /** @type {any} */ (root).scrollTopMax ?? root.scrollHeight - root.clientHeight,
      ),
    },
    inner: inner.slice(0, 40),
  };
}

/**
 * Focus the site's search field: `selector`, else the first visible search-like input that takes
 * the focus, else the first visible textarea or contenteditable text box that does (a code
 * editor). A visible field can refuse the focus: a component library's hidden form input (a
 * select's value on regex101) is one, so the next candidate is tried.
 * @param {{ selector: string | null }} arg
 */
export function contentFocusField({ selector }) {
  const visible = (/** @type {Element} */ el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const lists = selector
    ? [selector]
    : [
        "input[type=search], [role=searchbox], input[name=q], textarea[name=q], " +
          "input[placeholder*='earch' i], input[aria-label*='earch' i], " +
          "input[type=text], input:not([type])",
        "textarea, [contenteditable=true][role=textbox], [contenteditable=''][role=textbox]",
      ];
  const describe = (/** @type {Element} */ el) =>
    `${el.tagName.toLowerCase()}${el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : ""}${el.id ? `#${el.id}` : ""}`;
  /** @type {HTMLElement | null} */
  let first = null;
  for (const list of lists) {
    for (const node of document.querySelectorAll(list)) {
      const el = /** @type {HTMLElement} */ (node);
      if (!visible(el)) continue;
      first ??= el;
      el.focus();
      if (document.activeElement === el) return { found: true, desc: describe(el), focused: true };
    }
  }
  if (!first) return { found: false, desc: null, focused: false };
  return { found: true, desc: describe(first), focused: false };
}

/** The focused element: is it a text field? */
export function contentActive() {
  const el = /** @type {HTMLElement | null} */ (document.activeElement);
  const tag = el?.tagName.toLowerCase() ?? null;
  const type = el instanceof HTMLInputElement ? el.type : null;
  const textInput =
    tag === "textarea" ||
    (tag === "input" &&
      ![
        "button",
        "checkbox",
        "radio",
        "submit",
        "reset",
        "image",
        "file",
        "range",
        "color",
        "hidden",
      ].includes(type ?? "text"));
  return {
    tag,
    editable: !!el && (textInput || el.isContentEditable),
    desc: el ? `${tag}${el.id ? `#${el.id}` : ""}` : null,
  };
}

/**
 * A keydown recorder on the page's window, capture phase (did the page get the key at all?) and
 * bubble phase, added last (did the page's own handlers prevent its default?). Returns and
 * clears what it saw.
 */
export function contentRecorder() {
  const key = Symbol.for("vimma-site-compat");
  const w = /** @type {any} */ (window);
  if (!w[key]) {
    const rec = { seen: /** @type {string[]} */ ([]), prevented: /** @type {string[]} */ ([]) };
    const name = (/** @type {KeyboardEvent} */ e) =>
      `${e.ctrlKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.metaKey ? "meta+" : ""}${e.key}`;
    window.addEventListener("keydown", (e) => rec.seen.push(name(e)), true);
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) rec.prevented.push(name(e));
    });
    w[key] = rec;
  }
  const rec = w[key];
  const out = { seen: [...rec.seen], prevented: [...rec.prevented] };
  rec.seen.length = 0;
  rec.prevented.length = 0;
  return out;
}

/** What a site shortcut may change. */
export function contentReaction() {
  const el = document.activeElement;
  return {
    url: location.href,
    active: el
      ? `${el.tagName}#${el.id}.${typeof el.className === "string" ? el.className : ""}`
      : "",
    scrollY: Math.round(window.scrollY),
    dialogs: document.querySelectorAll(
      "dialog[open], [role=dialog]:not([hidden]), [aria-modal=true]",
    ).length,
    fullscreen: !!document.fullscreenElement,
  };
}

/**
 * Press `key` for the page alone: keydown, keypress and keyup dispatched at the focused element
 * (synthetic, so Vimma never sees them and Firefox runs no default action such as quick find).
 * Returns whether the page's handlers called preventDefault() on the keydown.
 * @param {{ key: string }} arg
 */
export function contentPressKey({ key }) {
  const shifted = /^[A-Z?:]$/.test(key);
  const code = /^[a-z]$/i.test(key)
    ? `Key${key.toUpperCase()}`
    : ({ "/": "Slash", "?": "Slash", ":": "Semicolon" }[key] ?? "");
  const target = document.activeElement ?? document.body;
  if (!target) return false;
  /** @param {string} type */
  const fire = (type) =>
    target.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code,
        shiftKey: shifted,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }),
    );
  const notPrevented = fire("keydown");
  fire("keypress");
  fire("keyup");
  return !notPrevented;
}

/**
 * Undo what a probed site shortcut did: leave fullscreen (YouTube's `f`), let the site close a
 * dialog with a synthetic Escape, and take focus out of a field it focused.
 */
export function contentExitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const el = /** @type {HTMLElement | null} */ (document.activeElement);
  if (el && el !== document.body) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    el.blur?.();
  }
  return true;
}

/**
 * The link under each hint label's top-left corner (+2 px).
 * @param {{ points: Array<{ label: string, x: number, y: number }> }} arg
 */
export function contentLinksAt({ points }) {
  const here = location.href.split("#")[0];
  return points.map(({ label, x, y }) => {
    const el = document.elementFromPoint(x + 2, y + 2);
    const a = /** @type {HTMLAnchorElement | null} */ (el?.closest("a[href]") ?? null);
    if (!a) return { label, href: null };
    const href = a.href;
    return {
      label,
      href,
      target: a.target || "",
      sameDoc: href.split("#")[0] === here,
      sameOrigin: (() => {
        try {
          return new URL(href).origin === location.origin;
        } catch {
          return false;
        }
      })(),
    };
  });
}

/** Visible links and buttons in the viewport, to set the hint count against. */
export function contentClickables() {
  const vw = innerWidth;
  const vh = innerHeight;
  let n = 0;
  for (const el of document.querySelectorAll(
    "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]",
  )) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw)
      continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") continue;
    n++;
  }
  return n;
}

/**
 * A word on the page for `/`: the most frequent word of 6 to 12 letters in the visible text.
 */
export function contentPickWord() {
  const counts = new Map();
  for (const w of (document.body?.innerText ?? "").toLowerCase().match(/\b[a-z]{6,12}\b/g) ?? [])
    counts.set(w, (counts.get(w) ?? 0) + 1);
  let best = null;
  let most = 0;
  for (const [w, c] of counts) if (c > most) [best, most] = [w, c];
  return best;
}

/**
 * Click a consent wall's reject-only button. `patterns` are classify.mjs's REJECT sources.
 * @param {{ patterns: string[] }} arg
 */
export function contentClickReject({ patterns }) {
  const res = patterns.map((p) => new RegExp(p));
  for (const el of document.querySelectorAll(
    "button, [role=button], input[type=submit], input[type=button]",
  )) {
    const text = (
      el instanceof HTMLInputElement
        ? el.value
        : (el.textContent ?? "") || el.getAttribute("aria-label") || ""
    )
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && res.some((re) => re.test(text))) {
      /** @type {HTMLElement} */ (el).click();
      return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// In the parent process (the browser window)

/**
 * Collect errors from Vimma's code: script errors (chrome and, forwarded, the content actor)
 * whose source or stack is ours, and Vimma's own console.error calls. Kept on the window.
 */
export function chromeWatchErrors() {
  const w = /** @type {any} */ (window);
  if (w.__vimmaSiteCompat) return "already";
  const ours = /chrome:\/\/browser\/(content|skin)\/vimma\//;
  /** @type {string[]} */
  const errors = [];
  const listener = {
    /** @param {any} m */
    observe(m) {
      try {
        if (!(m instanceof Ci.nsIScriptError)) return;
        if (m.flags & Ci.nsIScriptError.warningFlag || m.flags & Ci.nsIScriptError.infoFlag) return;
        const stack = String(m.stack ?? "");
        if (!ours.test(m.sourceName ?? "") && !ours.test(stack)) return;
        // Thrown elsewhere but called from our code: name our frame too.
        const via = ours.test(m.sourceName ?? "")
          ? ""
          : `, via ${/chrome:\/\/browser\/(content|skin)\/vimma\/[^\s)]+/.exec(stack)?.[0] ?? "ours"}`;
        errors.push(`${m.errorMessage} (${m.sourceName}:${m.lineNumber}${via})`);
      } catch {
        // a message we cannot read is not ours
      }
    },
  };
  const consoleObserver = {
    /** @param {any} subject */
    observe(subject) {
      const msg = subject?.wrappedJSObject ?? subject;
      if (msg?.level !== "error" || !ours.test(String(msg.filename ?? ""))) return;
      const args = (msg.arguments ?? []).map((/** @type {unknown} */ a) => String(a)).join(" ");
      errors.push(`console.error: ${args} (${msg.filename}:${msg.lineNumber})`);
    },
  };
  Services.console.registerListener(listener);
  Services.obs.addObserver(consoleObserver, "console-api-log-event");
  w.__vimmaSiteCompat = { errors, listener, consoleObserver };
  return "watching";
}

/** The errors collected since the last call. */
export function chromeTakeErrors() {
  const w = /** @type {any} */ (window);
  const errors = w.__vimmaSiteCompat?.errors ?? [];
  return errors.splice(0);
}

/** Whether the selected tab is still loading (its throbber), e.g. after a challenge's redirect. */
export function chromeTabBusy() {
  return gBrowser.selectedTab.hasAttribute("busy");
}

/** The status bar's mode segment, e.g. "NORMAL". */
export function chromeStatusbarMode() {
  return document.querySelector("#vimma-statusbar [data-segment=mode]")?.textContent ?? null;
}

/** The hint labels drawn now, with their top-left in content CSS pixels. */
export function chromeHints() {
  const zoom = Number(gBrowser.selectedBrowser.fullZoom) || 1;
  return [...document.querySelectorAll("#vimma-hints .vimma-hint")]
    .filter((el) => !(/** @type {HTMLElement} */ (el).hidden))
    .map((el) => {
      const s = /** @type {HTMLElement} */ (el).style;
      return {
        label: /** @type {HTMLElement} */ (el).dataset.label ?? "",
        x: parseFloat(s.left) / zoom,
        y: parseFloat(s.top) / zoom,
      };
    });
}

/** Vimma's find status for the selected tab (host/VimmaHost.sys.mjs, status().find). */
export function chromeFindStatus() {
  const { VimmaHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
  );
  return VimmaHost.status(window).find ?? null;
}

/** Close Firefox's own find bar if a pass-through `/` opened it. */
export function chromeCloseFindbar() {
  const bar = gBrowser.isFindBarInitialized?.() ? gBrowser.getCachedFindBar() : null;
  if (bar && !bar.hidden) {
    bar.close(true);
    return true;
  }
  return false;
}

/** @param {{ text: string }} arg */
export function chromeSetClipboard({ text }) {
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
  return true;
}

export function chromeReadClipboard() {
  const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  t.init(null);
  t.addDataFlavor("text/plain");
  Services.clipboard.getData(
    t,
    Ci.nsIClipboard.kGlobalClipboard,
    window.browsingContext.currentWindowContext,
  );
  const out = {};
  try {
    t.getTransferData("text/plain", out);
  } catch {
    return null;
  }
  return /** @type {any} */ (out).value?.QueryInterface(Ci.nsISupportsString).data ?? null;
}
