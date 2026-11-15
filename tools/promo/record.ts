#!/usr/bin/env node
/**
 * Records the promo video's footage from a real Vimma build: each shot in tools/promo/shots.ts
 * gets a fresh throwaway profile (the e2e harness's, plus promoPrefs), runs under its own Xvfb
 * and is driven through vimma-ctl, while ffmpeg's x11grab records the screen. The pages are the
 * fictional sites in tools/promo/fixtures, served by the harness's page server acting as an
 * HTTP proxy: no real website and no network. Colours: Vimma's built-in palette, set by a temp
 * config.toml (`[theme] source = "file"`, and `name = "vimma"` when the build knows the key), so
 * the recording machine's Omarchy theme never shows; the theme shot sets its Omarchy themes from
 * tools/promo/themes. The agent shot also runs the agent bench's stand-in shop, with
 * its own unbranded catalog and name (as
 * shop.example, through the same proxy) and its scripted shopper behind a local
 * OpenAI-compatible endpoint (--model-port, default 8800), which config.toml lists as the chat
 * window's provider. The video itself is composited elsewhere
 * (vimma-site: npm run video); this writes the raw clips and what happened in them.
 *
 *   node tools/promo/record.ts --out DIR                       # every shot, 1920x1080
 *   node tools/promo/record.ts --out DIR --geometry 1080x1920 --shots keys,tiling,agent
 *   node tools/promo/record.ts --out DIR --pace 800            # slower: ms per beat
 *
 * Options: --scale (device pixels per CSS pixel, default 1.5), --fps (default 30), --toolbar
 * (`[ui] toolbar` for every shot: hidden, the default, or shown), --build
 * and --vimma-ctl (as npm run e2e; VIMMA_E2E_BUILD and VIMMA_CTL work too), --keep (keep the
 * profiles). Needs Xvfb and ffmpeg (with x11grab and libx264).
 *
 * Writes DIR/<shot>.mkv (lossless H.264) and DIR/manifest.json: per shot its file, duration,
 * the keys sent with their times from the clip's first frame (the key-overlay track) and named
 * marks, and screen points of interest (`points`, device pixels). Exit 0 on success, 1 on a
 * failure, 2 on usage errors.
 */
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Ctl, findVimmaCtl } from "../e2e/driver.ts";
import { findBuild, launch, quitBrowser, startXvfb } from "../e2e/launcher.ts";
import { startPageServer } from "../e2e/pages.ts";
import { startShop } from "../agent-bench/shop.ts";
import type { ScriptTurn } from "../agent-bench/scripted.ts";
import {
  MODEL,
  PROMO_CATALOG,
  SHOP_NAME,
  promoShopper,
  startModelServer,
  textKeys,
} from "./agent.ts";
import { READ_PATH_PREF, devPrefs } from "../start.ts";
import { flatCore } from "../sync-core.mjs";
import {
  HOSTS,
  KeyTrack,
  cssWindow,
  parseGeometry,
  parseProbeTitle,
  promoConfig,
  promoPrefs,
  proxyRoute,
  servedModule,
  supportsThemeName,
} from "./promo.ts";
import { SHOTS } from "./shots.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const THEMES = join(HERE, "themes");
const LIGHT_THEMES = new Set(["rose-pine"]);

const OPTIONS = {
  out: { type: "string" },
  geometry: { type: "string", default: "1920x1080" },
  scale: { type: "string", default: "1.5" },
  pace: { type: "string", default: "700" },
  toolbar: { type: "string", default: "hidden" },
  fps: { type: "string", default: "30" },
  "model-port": { type: "string", default: "8800" },
  shots: { type: "string" },
  build: { type: "string" },
  "vimma-ctl": { type: "string" },
  keep: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

function usage(message: string): never {
  process.stderr.write(`promo: ${message}\nSee the comment at the top of tools/promo/record.ts.\n`);
  process.exit(2);
}

/**
 * Write a theme into the temp theme directory the profile reads (vimma.theme.omarchyPath):
 * colors.toml, and light.mode for a light theme, as omarchy-theme-set leaves them.
 * @param name a file in tools/promo/themes
 */
function writeTheme(dir: string, name: string) {
  copyFileSync(join(THEMES, `${name}.colors.toml`), join(dir, "colors.toml.tmp"));
  rmSync(join(dir, "colors.toml"), { force: true });
  copyFileSync(join(dir, "colors.toml.tmp"), join(dir, "colors.toml"));
  rmSync(join(dir, "colors.toml.tmp"));
  if (LIGHT_THEMES.has(name)) writeFileSync(join(dir, "light.mode"), "");
  else rmSync(join(dir, "light.mode"), { force: true });
}

/**
 * Serve vimma-core's `name`.mjs as `name`.js in `dir`, with the modules it imports, for
 * probe.js (fixtures/probe.js imports hints.js). The modules come from sync-core's flat copy, in
 * which each imports the others as `./name.mjs`, whichever folder of the package holds it.
 */
function serveCore(
  dir: string,
  name: string,
  done: Set<string> = new Set(),
  core: Map<string, string> = flatCore(join(REPO, "packages/vimma-core/src")),
) {
  if (done.has(name)) return;
  done.add(name);
  const source = core.get(`${name}.mjs`);
  if (source === undefined) throw new Error(`vimma-core has no module ${name}.mjs`);
  const { text, imports } = servedModule(source);
  writeFileSync(join(dir, `${name}.js`), text);
  for (const dep of imports) serveCore(dir, dep, done, core);
}

/** Replace config.toml whole (write, then rename), so Vimma's poll never reads half a file. */
function writeConfig(path: string, text: string) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/**
 * The checkout a local build was made from (`<checkout>/engine/obj-*\/dist/bin/vimma`), or
 * null for a build elsewhere.
 */
function buildCheckout(binary: string) {
  const m = /^(.*)\/engine\/obj-[^/]+\/dist\/bin\/[^/]+$/.exec(binary);
  return m?.[1] && existsSync(join(m[1], "src")) ? m[1] : null;
}

/**
 * The look config.toml gives every shot: which built-in palette to name in `[theme] name`,
 * whether to pin its dark appearance, and `[ui] toolbar`. "vimma" when the build's own
 * vimma-core (the copy its chrome files use, synced into its checkout's src/) takes the key,
 * else null, and the build's default built-in shows (Tokyo Night before the vimma palette
 * landed); "dark" when it also takes `[theme] appearance`, so the palette is dark whatever the
 * system reports; `toolbar` (from --toolbar) when it takes `[ui] toolbar`. Each key is kept
 * only if the build reads the config with it and without an error, since a config.toml with an
 * error is not applied at all. A build whose checkout cannot be found gets none of them.
 */
async function promoLook(
  binary: string,
  toolbar: "hidden" | "shown",
): Promise<{ name: string | null; appearance?: "dark"; toolbar?: "hidden" | "shown" }> {
  const checkout = buildCheckout(binary);
  const config = checkout && join(checkout, "src/browser/base/content/vimma/core/config.mjs");
  if (!config || !existsSync(config)) return { name: null };
  try {
    const { parseConfig } = await import(pathToFileURL(config).href);
    if (!supportsThemeName(parseConfig, "vimma")) return { name: null };
    const look: { name: string; appearance?: "dark"; toolbar?: "hidden" | "shown" } = {
      name: "vimma",
    };
    const reads = (more: object) =>
      parseConfig(promoConfig({ source: "file", ...look, ...more })).errors.length === 0;
    if (reads({ appearance: "dark" })) look.appearance = "dark";
    if (reads({ toolbar })) look.toolbar = toolbar;
    return look;
  } catch {
    return { name: null };
  }
}

/**
 * A local build's chrome files lead into its checkout's src/ (tools/start.ts), which the
 * content sandbox must be allowed to read. The harness allows this checkout's; a build from
 * another checkout (--build ../vimma/engine/...) needs that one's too, or the content actors
 * (hints, scrolling) fail to load.
 */
function sandboxPrefs(binary: string): Record<string, string> {
  const checkout = buildCheckout(binary);
  if (!checkout) return {};
  const paths = new Set([...devPrefs(REPO), ...devPrefs(checkout)].map(([, v]) => String(v)));
  return { [READ_PATH_PREF]: [...paths].join(",") };
}

/**
 * The HTTP proxy the profile uses for every request: the fixture pages for the fixture hosts,
 * and the servers `routes` names for theirs (the shop and the scripted model of the agent shot).
 * `routes` is read at each request, so a shot can add its servers after the proxy starts.
 * @param pages the fixture page server's origin
 */
async function startProxy(
  pages: string,
  routes: Record<string, string>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const { origin, path } = proxyRoute(req.url ?? "/", req.headers.host ?? "", routes, pages);
    const target = new URL(origin);
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway\n");
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * Screen recording with ffmpeg's x11grab. x11grab stamps each frame with the wall clock, and
 * -copyts keeps those stamps, so the file's start time is the first frame's epoch time: the
 * origin of the key track.
 */
async function startRecording({
  display,
  width,
  height,
  fps,
  file,
}: {
  display: string;
  width: number;
  height: number;
  fps: number;
  file: string;
}) {
  const child = spawn(
    "ffmpeg",
    [
      ...["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"],
      ...["-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps)],
      ...["-video_size", `${width}x${height}`, "-i", display],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p"],
      ...["-copyts", "-y", file],
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  // wait until frames are being written: progress reports frame=N
  await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d;
      const frames = [...buf.matchAll(/^frame=(\d+)$/gm)].map((m) => Number(m[1]));
      if (frames.some((n) => n >= 2)) {
        child.stdout.off("data", onData);
        child.stdout.resume();
        resolve(undefined);
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    exited.then((code) => reject(new Error(`ffmpeg exited (${code}) before recording: ${stderr}`)));
  });
  return {
    pid: child.pid,
    async stop() {
      child.stdin.end("q");
      const code = await exited;
      if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr}`);
    },
  };
}

/** @returns stdout */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.trim()}`)),
    );
  });
}

/** The raw capture's first-frame time (epoch ms), and a copy re-based to start at 0. */
async function finishClip(raw: string, clip: string) {
  const probe = JSON.parse(
    await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=start_time,duration",
      "-of",
      "json",
      raw,
    ]),
  );
  const start = Number(probe.format.start_time);
  if (!(start > 1e9))
    throw new Error(`${raw}: no wall-clock start time (${probe.format.start_time})`);
  await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-c", "copy", clip]);
  const duration = Number(
    JSON.parse(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        clip,
      ]),
    ).format.duration,
  );
  return { origin: start * 1000, duration };
}

/**
 * What a shot can do. Every keystroke goes through vimma-ctl send-keys and onto the key track.
 */
export class Director {
  declare ctl: Ctl;
  declare pace: number;
  declare themeDir: string;
  declare track: KeyTrack;
  declare configPath: string;
  declare themeName: string | null;
  declare appearance: "dark" | undefined;
  declare toolbar: "hidden" | "shown" | undefined;
  /** hint labels worked out in setup */
  declare labels: Record<string, string>;
  /** screen points for the video's zoom */
  declare points: Record<string, { x: number; y: number }>;
  /** the agent shot's model turns */
  declare agentReplies: ScriptTurn[] | null;
  constructor({
    ctl,
    pace,
    themeDir,
    track,
    configPath = "",
    themeName = null,
    appearance,
    toolbar,
  }: {
    ctl: Ctl;
    pace: number;
    themeDir: string;
    track: KeyTrack;
    configPath?: string;
    themeName?: string | null;
    appearance?: "dark";
    toolbar?: "hidden" | "shown";
  }) {
    this.ctl = ctl;
    this.pace = pace;
    this.themeDir = themeDir;
    this.track = track;
    this.configPath = configPath;
    this.themeName = themeName;
    this.appearance = appearance;
    this.toolbar = toolbar;
    this.labels = {};
    this.points = {};
    this.agentReplies = null;
  }

  state(): Promise<any> {
    return this.ctl.state();
  }

  /**
   * Wait for the state to satisfy `test`, polling every 50 ms.
   */
  async until(test: (state: any) => boolean, what: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      last = await this.ctl.state();
      if (test(last)) return last;
      if (Date.now() >= deadline) {
        throw new Error(`waited ${timeoutMs} ms for ${what}; state: ${JSON.stringify(last)}`);
      }
      await sleep(50);
    }
  }

  /** A pacing pause, in beats of --pace, so a viewer can follow. */
  hold(beats: number) {
    return sleep(Math.round(beats * this.pace));
  }

  /** Keys sent off camera (setup): not on the key track. */
  send(keys: string) {
    return this.ctl.sendKeys(keys);
  }

  /**
   * One keystroke (or chord sequence) on camera, then `beats` of pause.
   */
  async key(keys: string, beats = 1) {
    this.track.key(keys, Date.now());
    await this.ctl.sendKeys(keys);
    await this.hold(beats);
  }

  /** `ctrl+b`, a short beat (the status bar shows "prefix"), then `k`. */
  async prefix(k: string) {
    await this.key("ctrl+b", 0.7);
    await this.key(k, 0);
  }

  /** Type text a character at a time. */
  async type(text: string, beats: number) {
    for (const c of text) await this.key(c === " " ? "space" : c, beats);
  }

  /**
   * The agent shot: wait until the scripted model has asked to click at the checkout, the
   * payment checkpoint Vimma then puts to the user. Nothing in the state shows the question,
   * so the shot's next hold covers its drawing.
   */
  async agentPaying() {
    const replies = this.agentReplies;
    if (!replies) throw new Error("agentPaying in a shot without agent: true");
    await this.until(
      () => {
        const at = replies.findIndex((r) =>
          r.calls?.some((c) => c.name === "vimma_open" && /\/checkout$/.test(c.args.url)),
        );
        return (
          at >= 0 && replies.slice(at + 1).some((r) => r.calls?.[0]?.name === "vimma_activate")
        );
      },
      "the agent's click at the checkout",
      60_000,
    );
  }

  /** The agent shot: wait for the scripted model's closing reply. */
  async agentDone() {
    const replies = this.agentReplies;
    if (!replies) throw new Error("agentDone in a shot without agent: true");
    await this.until(() => !replies.at(-1)?.calls?.length, "the agent's last reply", 30_000);
  }

  /**
   * Type a sentence a word at a time, `beats` after each, off the key track: a chip for every
   * letter of a sentence would bury the picture. Marked as `typed` once done.
   */
  async typeText(text: string, beats: number) {
    for (const word of textKeys(text)) {
      await this.ctl.sendKeys(word);
      await this.hold(beats);
    }
    this.mark("typed");
  }

  open(url: string) {
    return this.ctl.open(url);
  }

  mark(name: string) {
    this.track.mark(name, Date.now());
  }

  /**
   * Swap the theme file, as omarchy-theme-set does, and have Vimma read it now (what
   * Omarchy's theme-set hook does). Marked on the track as `theme:<name>`.
   */
  async theme(name: string) {
    writeTheme(this.themeDir, name);
    this.mark(`theme:${name}`);
    const out = await this.ctl.run(["reload-theme"]);
    if (/false/.test(out))
      throw new Error(`reload-theme did not change the theme to ${name}: ${out}`);
  }

  /**
   * Save config.toml's theme as a user does in their editor: `source` (the built-in palette,
   * "file", unless given), `name` (the built-in palette's) and `colors` (`[theme.colors]`), with
   * the shot's other keys as they were. Vimma polls config.toml (every 200 ms in the promo
   * profile); nothing in the state shows the colours, so the shot's next hold covers the poll.
   * Marked on the track as `mark`.
   */
  async saveTheme(
    {
      source = "file",
      name,
      colors,
    }: { source?: "file" | "omarchy"; name?: string; colors?: Record<string, string> },
    mark: string,
  ) {
    writeConfig(
      this.configPath,
      promoConfig({
        source,
        name: name ?? this.themeName,
        appearance: this.appearance,
        colors,
        toolbar: this.toolbar,
        search: true,
      }),
    );
    this.mark(mark);
  }

  /**
   * The hint label Vimma will give the page's target link: load `url#probe` (fixtures/probe.js
   * titles it with the label, worked out with vimma-core's hints.mjs), then close that tab.
   */
  async probeHintLabel(url: string) {
    await this.open(`${url}#probe`);
    const s = await this.until(
      (st) => st.tabs.some((t: any) => t.selected && /^probe(-error)?:/.test(t.title)),
      "the probe page's report",
    );
    const tab = s.tabs.find((t: any) => t.selected);
    const report = parseProbeTitle(tab.title);
    if (!report) throw new Error("no probe report");
    const count = s.tabs.length;
    await this.send("ctrl+b shift+x");
    await this.until((st) => st.tabs.length === count - 1, "the probe tab closed");
    return report;
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, allowPositionals: false }));
  } catch (e) {
    return usage((e as Error).message);
  }
  if (values.help) {
    process.stdout.write("See the comment at the top of tools/promo/record.ts.\n");
    return 0;
  }
  if (!values.out) return usage("--out DIR is required");
  const screen = parseGeometry(values.geometry);
  const scale = Number(values.scale);
  const pace = Number(values.pace);
  const fps = Number(values.fps);
  if (!(pace >= 100 && pace <= 5000)) return usage("--pace is ms per beat, 100 to 5000");
  if (![24, 25, 30, 50, 60].includes(fps)) return usage("--fps is 24, 25, 30, 50 or 60");
  const toolbarFlag = values.toolbar;
  if (toolbarFlag !== "hidden" && toolbarFlag !== "shown")
    return usage("--toolbar is hidden or shown");
  const names = values.shots ? values.shots.split(",") : SHOTS.map((s) => s.name);
  const shots = names.map((n) => {
    const shot = SHOTS.find((s) => s.name === n);
    if (!shot) return usage(`no shot "${n}"; there are ${SHOTS.map((s) => s.name).join(", ")}`);
    return shot;
  });
  const window = cssWindow(screen, scale);

  const build = findBuild({ build: values.build, env: process.env });
  const ctlBin = findVimmaCtl({ flag: values["vimma-ctl"], env: process.env });
  const out = values.out;
  mkdirSync(out, { recursive: true });
  console.log(
    `promo: build ${build.binary}\npromo: ${values.geometry} at ${scale}x, pace ${pace} ms`,
  );

  const cleanups: Array<() => Promise<void>> = [];
  const cleanupAll = async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  };
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(sig, () => cleanupAll().finally(() => process.exit(code)));
  }

  try {
    // the fixtures, plus vimma-core's hints.mjs and its imports for probe.js (as .js: the
    // server's types)
    const served = mkdtempSync(join(tmpdir(), "vimma-promo-pages-"));
    cleanups.push(async () => rmSync(served, { recursive: true, force: true }));
    cpSync(FIXTURES, served, { recursive: true });
    serveCore(served, "hints");
    const pages = await startPageServer(served);
    cleanups.push(() => pages.close());
    const routes: Record<string, string> = {};
    const proxy = await startProxy(new URL(pages.base).origin, routes);
    cleanups.push(() => proxy.close());
    const port = proxy.port;
    const modelPort = Number(values["model-port"]);
    const display = await startXvfb({ ...screen });
    cleanups.push(() => display.stop());
    const themeDir = mkdtempSync(join(tmpdir(), "vimma-promo-theme-"));
    cleanups.push(async () => rmSync(themeDir, { recursive: true, force: true }));
    const configDir = mkdtempSync(join(tmpdir(), "vimma-promo-config-"));
    cleanups.push(async () => rmSync(configDir, { recursive: true, force: true }));
    const configPath = join(configDir, "config.toml");
    const { name: themeName, appearance, toolbar } = await promoLook(build.binary, toolbarFlag);
    console.log(
      themeName
        ? `promo: built-in palette "${themeName}" ([theme] name), ${appearance ?? "system"}` +
            `, toolbar ${toolbar ?? "as the build starts"}`
        : "promo: this build has no [theme] name: its default built-in palette",
    );
    // our own Xvfb at the full screen size, with the window in CSS pixels: launch()'s own
    // Xvfb would be the window's size, which is smaller once devPixelsPerPx is over 1
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display.display };
    delete baseEnv.WAYLAND_DISPLAY;
    const env = { ...build.env, GDK_BACKEND: "x11", MOZ_ENABLE_WAYLAND: "0" };

    const manifest = {
      geometry: screen,
      scale,
      fps,
      pace,
      shots: [] as any[],
    };
    for (const shot of shots) {
      console.log(`promo: ${shot.name}`);
      // no Omarchy theme until a shot sets one; config.toml picks the source
      for (const f of readdirSync(themeDir)) rmSync(join(themeDir, f), { force: true });
      // the agent shot: a fresh shop (an empty basket) and a fresh script, on this machine
      let agent: { endpoint: string; model: string } | undefined;
      let closeAgent: () => Promise<void> = async () => {};
      let agentReplies: ScriptTurn[] | null = null;
      if (shot.agent) {
        const shop = await startShop({ catalog: PROMO_CATALOG, name: SHOP_NAME });
        const shopHost = new URL(HOSTS.shop).host;
        routes[shopHost] = new URL(shop.base).origin;
        const model = await startModelServer({
          port: modelPort,
          script: promoShopper({ base: HOSTS.shop }),
          paceMs: Math.round(pace * 1.8),
        });
        routes[new URL(model.endpoint).host] = new URL(model.endpoint).origin;
        closeAgent = async () => {
          delete routes[shopHost];
          delete routes[new URL(model.endpoint).host];
          await Promise.all([shop.close(), model.close()]);
        };
        cleanups.push(() => closeAgent());
        agent = { endpoint: model.endpoint, model: MODEL };
        agentReplies = model.replies;
      }
      writeConfig(
        configPath,
        promoConfig({
          source: shot.theme ?? "file",
          name: themeName,
          appearance,
          toolbar,
          agent,
          search: true,
        }),
      );
      let teardown: () => Promise<void> = async () => {};
      const session = await launch({
        build: { binary: build.binary, env },
        xvfb: false,
        baseEnv,
        window,
        keep: values.keep,
        prefs: {
          ...promoPrefs({ port, themeDir, configPath, scale }),
          ...sandboxPrefs(build.binary),
        },
        onTeardown: (t) => {
          teardown = t;
          cleanups.push(t);
        },
        log: (line) => console.log(`  ${line}`),
      });
      const ctl = new Ctl({ bin: ctlBin, profile: session.profile });
      await ctl.ready();
      const track = new KeyTrack();
      const director = new Director({
        ctl,
        pace,
        themeDir,
        track,
        configPath,
        themeName,
        appearance,
        toolbar,
      });
      director.agentReplies = agentReplies;
      await director.until((s) => s.workspace === "main", "the first window", 20_000);
      await shot.setup(director);
      const raw = join(out, `${shot.name}.raw.mkv`);
      const recording = await startRecording({
        display: display.display,
        ...screen,
        fps,
        file: raw,
      });
      try {
        await shot.run(director);
      } finally {
        await recording.stop();
      }
      if (!(await quitBrowser({ ctl, child: session.child }))) {
        console.log("  ctrl+q did not quit the browser; signalling it");
      }
      const failed = session.loadFailure();
      await teardown();
      await closeAgent();
      closeAgent = async () => {};
      if (failed) throw new Error(`the browser logged "${failed}"`);
      const file = `${shot.name}.mkv`;
      const { origin, duration } = await finishClip(raw, join(out, file));
      rmSync(raw);
      const { keys, marks } = track.resolve(origin);
      manifest.shots.push({
        name: shot.name,
        file,
        duration,
        keys,
        marks,
        points: director.points,
      });
      console.log(`  ${file}: ${duration.toFixed(2)} s, ${keys.length} keys`);
    }
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`promo: wrote ${join(out, "manifest.json")}`);
    return 0;
  } finally {
    await cleanupAll();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`promo: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(1);
    },
  );
}
