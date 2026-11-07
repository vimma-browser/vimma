// The promo recorder's pure parts (tools/promo/record.mjs): the profile's prefs, the window
// geometry, the probe page's report of a hint label, and the key-overlay track. No I/O
// here, so test/promo.test.mjs covers it without a browser.
/** The fixture sites' host names; the fixture server answers them all as an HTTP proxy. */
export const HOSTS = Object.freeze({
  handbook: "http://handbook.example/",
  news: "http://news.example/",
  mail: "http://mail.example/",
  wiki: "http://wiki.example/",
  notes: "http://notes.example/",
  tracker: "http://tracker.example/",
  /** the agent bench's stand-in shop (tools/agent-bench/shop.mjs), for the agent shot */
  shop: "http://shop.example/",
  /** the default search engine's host; nothing in a shot searches it */
  search: "http://search.example/",
});

/**
 * A vimma-core module as the fixture server serves it next to probe.js: the server serves
 * `.js` as a script and nothing as `.mjs`, so each relative `./name.mjs` import becomes
 * `./name.js`. `imports` names those modules, which the recorder serves the same way.
 * @param {string} text
 * @returns {{ text: string, imports: string[] }}
 */
export function servedModule(text) {
  /** @type {string[]} */
  const imports = [];
  const out = text.replace(/(from\s+["']\.\/)([\w-]+)\.mjs(["'])/g, (_, head, name, tail) => {
    imports.push(name);
    return `${head}${name}.js${tail}`;
  });
  return { text: out, imports };
}

/**
 * Where the recorder's proxy sends a request: the server `routes` names for its host (the shop,
 * the scripted model), else the fixture pages. A proxy gets an absolute URL; a request sent
 * straight to it has only a path, and its Host header names the host.
 * @param {string} url the request line's target
 * @param {string} host the Host header
 * @param {Record<string, string>} routes host (with any port) → origin of its server
 * @param {string} fallback origin of the fixture pages
 * @returns {{ origin: string, path: string }}
 */
export function proxyRoute(url, host, routes, fallback) {
  const parsed = new URL(url, `http://${host || "localhost"}`);
  const origin = Object.hasOwn(routes, parsed.host) ? routes[parsed.host] : fallback;
  return { origin: /** @type {string} */ (origin), path: `${parsed.pathname}${parsed.search}` };
}

/**
 * @param {string} text e.g. "1920x1080"
 * @returns {{ width: number, height: number }}
 */
export function parseGeometry(text) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(text);
  if (!m)
    throw new Error(`geometry must be WIDTHxHEIGHT, e.g. 1920x1080, got ${JSON.stringify(text)}`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width % 2 || height % 2) throw new Error(`geometry must be even for H.264, got ${text}`);
  return { width, height };
}

/**
 * The browser window in CSS pixels: the screen divided by the device-pixel scale, so the window
 * fills the Xvfb screen exactly.
 * @param {{ width: number, height: number }} screen
 * @param {number} scale
 */
export function cssWindow(screen, scale) {
  if (!(scale >= 1 && scale <= 3)) throw new Error(`scale must be from 1 to 3, got ${scale}`);
  return { width: Math.round(screen.width / scale), height: Math.round(screen.height / scale) };
}

/**
 * Prefs over the e2e harness's throwaway profile (tools/e2e/launcher.mjs PROFILE_PREFS, which
 * already turns the control socket on): the fixture server as the HTTP proxy, so the address
 * bar shows handbook.example rather than a port; dark chrome and content; larger pixels for a
 * video; smooth scrolling; the theme read from `themeDir` (a temp copy of a colors.toml),
 * never the user's ~/.local/state/omarchy; and config.toml read from `configPath`, never
 * ~/.config/vimma. Theme changes are applied by `vimma-ctl reload-theme`, so the 2 s theme poll
 * is slowed right down to keep it from racing the recorder; config.toml is polled quickly, so a
 * shot that edits it (the theme shot's way back to the built-in palette) shows the change soon.
 * HTTPS goes to the fixture server too, which refuses it: nothing in a shot reaches the network
 * (about:addons would otherwise fetch its recommendations from addons.mozilla.org).
 * @param {{ port: number, themeDir: string, configPath?: string, scale: number }} options
 * @returns {Record<string, boolean | number | string | null>}
 */
export function promoPrefs({ port, themeDir, configPath, scale }) {
  return {
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": port,
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.ssl_port": port,
    "network.proxy.no_proxies_on": "",
    "network.proxy.allow_hijacking_localhost": true,
    "dom.security.https_first": false,
    "dom.security.https_first_schemeless": false,
    "dom.securecontext.allowlist": Object.values(HOSTS)
      .map((u) => new URL(u).hostname)
      .join(","),
    "security.insecure_connection_icon.enabled": false,
    "security.insecure_connection_text.enabled": false,
    "security.insecure_connection_text.pbmode.enabled": false,
    "ui.systemUsesDarkTheme": 1,
    "layout.css.prefers-color-scheme.content-override": 0,
    "layout.css.devPixelsPerPx": String(scale),
    "ui.prefersReducedMotion": 0,
    "general.smoothScroll": true,
    "vimma.theme.source": "omarchy",
    "vimma.theme.omarchyPath": themeDir,
    "vimma.theme.pollMs": 3_600_000,
    "vimma.theme.omarchyHook": false,
    ...(configPath ? { "vimma.config.path": configPath } : {}),
    "vimma.config.pollMs": 200,
    "extensions.getAddons.showPane": false,
    "extensions.ui.lastCategory": "addons://list/extension",
    "extensions.htmlaboutaddons.recommendations.enabled": false,
  };
}

/**
 * The config.toml a shot runs with: `[theme] source` ("file": the built-in palette, whatever
 * Omarchy theme the recording machine has; "omarchy": the theme directory the prefs name),
 * when the build knows the key, `name` (which built-in palette), and `appearance` when given:
 * "dark" pins the built-in palette's dark variant, whatever light or dark the system reports;
 * and `[ui] toolbar` when given: "hidden" records the page up to the window's top edge, with
 * only the status bar around it. Without `name` the build's default built-in shows. `schema = 2`: `[theme] name` is a
 * schema-2 key. With `agent`, the chat window's provider: one OpenAI-compatible endpoint on this
 * machine, as a user lists a local server, and the default for new conversations. `colors` is
 * `[theme.colors]`: single colours over the palette, as the theme shot's config card types. With
 * `search`, a fixture search URL as the default engine: an engine made from a URL is not one of
 * Firefox's own, so the address bar's placeholder names no search company.
 * @param {{ source: "file" | "omarchy", name: string | null, appearance?: "dark" | "light",
 *   colors?: Record<string, string>, toolbar?: "hidden" | "shown",
 *   agent?: { endpoint: string, model: string }, search?: boolean }} options
 */
export function promoConfig({ source, name, appearance, colors, toolbar, agent, search }) {
  const lines = ["schema = 2", "", "[theme]", `source = "${source}"`];
  if (name) lines.push(`name = "${name}"`);
  if (appearance) lines.push(`appearance = "${appearance}"`);
  if (colors) {
    lines.push("", "[theme.colors]");
    for (const [k, v] of Object.entries(colors)) lines.push(`${k} = "${v}"`);
  }
  if (toolbar) lines.push("", "[ui]", `toolbar = "${toolbar}"`);
  if (search) {
    lines.push("", "[search]", 'default = "@s"', "", "[search.aliases]");
    lines.push(`s = "${HOSTS.search}?q=%s"`);
  }
  if (agent) {
    lines.push("", "[agent]", 'default = "local"', "", "[[agent.providers]]", 'name = "local"');
    lines.push('kind = "openai"', `endpoint = "${agent.endpoint}"`, `model = "${agent.model}"`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Whether a build takes `[theme] name = "<name>"`: its own vimma-core `parseConfig` reads the
 * config the recorder would write without an error. A build from before the key reports it as
 * unknown, and a config.toml with an error is not applied at all, so the recorder leaves the
 * key out for such a build.
 * @param {(text: string) => { errors: unknown[] }} parseConfig
 * @param {string} name
 */
export function supportsThemeName(parseConfig, name) {
  try {
    return parseConfig(promoConfig({ source: "file", name })).errors.length === 0;
  } catch {
    return false;
  }
}

/**
 * Read a probe page's title (fixtures/probe.js): `probe:<label>@<x>,<y>` is the hint label of
 * the page's target link and its centre on the screen, `probe-error:<why>` a page the label
 * cannot be worked out for.
 * @param {string} title
 * @returns {{ label: string, x: number, y: number } | null} null until the page has reported
 */
export function parseProbeTitle(title) {
  if (title.startsWith("probe-error:")) {
    throw new Error(
      `the probe page cannot label its target: ${title.slice("probe-error:".length)}`,
    );
  }
  if (!title.startsWith("probe:")) return null;
  const m = /^probe:([a-z]{1,3})@(\d+),(\d+)$/.exec(title);
  if (!m) throw new Error(`not a probe report: ${JSON.stringify(title.slice(0, 80))}`);
  return { label: String(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

/**
 * The key-overlay track: every keystroke the recorder sends, with its time in seconds from the
 * clip's first frame, for the compositor to draw. Times are taken before the keys are sent.
 */
export class KeyTrack {
  constructor() {
    /** @type {{ t: number, keys: string }[]} */
    this.keys = [];
    /** @type {{ t: number, name: string }[]} */
    this.marks = [];
    /** @type {number | null} epoch ms of the clip's first frame */
    this.origin = null;
    /** @type {{ at: number, keys?: string, name?: string }[]} */
    this.pending = [];
  }

  /** @param {string} keys @param {number} at epoch ms */
  key(keys, at) {
    this.pending.push({ at, keys });
  }

  /** @param {string} name @param {number} at epoch ms */
  mark(name, at) {
    this.pending.push({ at, name });
  }

  /**
   * Fix the clip's origin once the first frame's time is known, and resolve every event.
   * @param {number} origin epoch ms of the first frame
   */
  resolve(origin) {
    this.origin = origin;
    for (const e of this.pending) {
      const t = Math.max(0, Math.round(e.at - origin) / 1000);
      if (e.keys !== undefined) this.keys.push({ t, keys: e.keys });
      else if (e.name !== undefined) this.marks.push({ t, name: e.name });
    }
    this.pending = [];
    return { keys: this.keys, marks: this.marks };
  }
}
