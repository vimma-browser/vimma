import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../packages/vimma-core/src/config/config.mjs";
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
} from "../promo.ts";
import { ROSE_PINE } from "../shots.ts";
import { flatCore } from "../../sync-core.mjs";

describe("parseGeometry", () => {
  it("reads WIDTHxHEIGHT", () => {
    expect(parseGeometry("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseGeometry("1080x1920")).toEqual({ width: 1080, height: 1920 });
  });
  it("refuses anything else, and odd sizes H.264 cannot encode", () => {
    expect(() => parseGeometry("1920")).toThrow(/WIDTHxHEIGHT/);
    expect(() => parseGeometry("1921x1080")).toThrow(/even/);
  });
});

describe("cssWindow", () => {
  it("divides the screen by the scale", () => {
    expect(cssWindow({ width: 1920, height: 1080 }, 1.5)).toEqual({ width: 1280, height: 720 });
  });
  it("refuses a scale outside 1..3", () => {
    expect(() => cssWindow({ width: 1920, height: 1080 }, 0.5)).toThrow(/scale/);
  });
});

describe("promoPrefs", () => {
  it("proxies the fixture hosts, reads the theme from the given directory, never ~", () => {
    const prefs = promoPrefs({ port: 4321, themeDir: "/tmp/t", scale: 1.5 });
    expect(prefs["network.proxy.http_port"]).toBe(4321);
    expect(prefs["vimma.theme.omarchyPath"]).toBe("/tmp/t");
    expect(prefs["vimma.theme.source"]).toBe("omarchy");
    expect(prefs["vimma.theme.omarchyHook"]).toBe(false);
    expect(prefs["layout.css.devPixelsPerPx"]).toBe("1.5");
  });
  it("reads config.toml from the given path, never ~/.config, and picks up edits quickly", () => {
    const prefs = promoPrefs({
      port: 4321,
      themeDir: "/tmp/t",
      configPath: "/tmp/c/config.toml",
      scale: 1.5,
    });
    expect(prefs["vimma.config.path"]).toBe("/tmp/c/config.toml");
    expect(prefs["vimma.config.pollMs"]).toBeLessThanOrEqual(250);
  });
  it("treats every fixture host as a secure context, the notes and tracker sites too", () => {
    const prefs = promoPrefs({ port: 4321, themeDir: "/tmp/t", scale: 1.5 });
    const allowed = String(prefs["dom.securecontext.allowlist"]).split(",");
    const hosts = Object.values(HOSTS).map((u) => new URL(u).hostname);
    expect(hosts).toEqual(expect.arrayContaining(["wiki.example", "notes.example"]));
    expect(hosts).toContain("tracker.example");
    expect(allowed.sort()).toEqual([...hosts].sort());
  });
  it("sends HTTPS to the fixture server too, so no page reaches the network", () => {
    const prefs = promoPrefs({ port: 4321, themeDir: "/tmp/t", configPath: "/c", scale: 1.5 });
    expect(prefs["network.proxy.ssl"]).toBe("127.0.0.1");
    expect(prefs["network.proxy.ssl_port"]).toBe(4321);
    // about:addons opens on the installed extensions, not on recommendations from the web
    expect(prefs["extensions.getAddons.showPane"]).toBe(false);
    expect(prefs["extensions.htmlaboutaddons.recommendations.enabled"]).toBe(false);
    expect(prefs["extensions.ui.lastCategory"]).toBe("addons://list/extension");
  });
});

describe("promoConfig", () => {
  it("names the built-in palette when the build knows [theme] name", () => {
    expect(promoConfig({ source: "file", name: "vimma" })).toBe(
      'schema = 2\n\n[theme]\nsource = "file"\nname = "vimma"\n',
    );
  });
  it("pins the dark appearance when asked, so the system's light or dark never decides", () => {
    const text = promoConfig({ source: "file", name: "vimma", appearance: "dark" });
    expect(text).toBe(
      'schema = 2\n\n[theme]\nsource = "file"\nname = "vimma"\nappearance = "dark"\n',
    );
    expect(parseConfig(text).errors).toEqual([]);
  });
  it("hides the toolbar when asked, for the keyboard-only look", () => {
    const text = promoConfig({
      source: "file",
      name: "vimma",
      appearance: "dark",
      toolbar: "hidden",
    });
    expect(text).toBe(
      'schema = 2\n\n[theme]\nsource = "file"\nname = "vimma"\nappearance = "dark"\n\n[ui]\ntoolbar = "hidden"\n',
    );
    expect(parseConfig(text).errors).toEqual([]);
  });
  it("lists the agent's provider when given: a local OpenAI-compatible endpoint, no key", () => {
    const text = promoConfig({
      source: "file",
      name: "vimma",
      agent: { endpoint: "http://127.0.0.1:8800/v1", model: "scripted" },
    });
    expect(text).toBe(
      'schema = 2\n\n[theme]\nsource = "file"\nname = "vimma"\n\n[agent]\ndefault = "local"\n\n' +
        '[[agent.providers]]\nname = "local"\nkind = "openai"\n' +
        'endpoint = "http://127.0.0.1:8800/v1"\nmodel = "scripted"\n',
    );
    expect(parseConfig(text).errors).toEqual([]);
  });
  it("sets single colours over the palette with [theme.colors], as the config card types them", () => {
    expect(
      parseConfig(promoConfig({ source: "file", name: "vimma", colors: ROSE_PINE })).errors,
    ).toEqual([]);
    const text = promoConfig({
      source: "file",
      name: "tokyo-night",
      colors: { accent: "#ff9e64" },
      toolbar: "hidden",
    });
    expect(text).toBe(
      'schema = 2\n\n[theme]\nsource = "file"\nname = "tokyo-night"\n\n[theme.colors]\n' +
        'accent = "#ff9e64"\n\n[ui]\ntoolbar = "hidden"\n',
    );
    expect(parseConfig(text).errors).toEqual([]);
  });
  it("makes the fixture search the default engine when asked, so no engine's name shows", () => {
    const text = promoConfig({ source: "file", name: "vimma", search: true });
    expect(text).toBe(
      'schema = 2\n\n[theme]\nsource = "file"\nname = "vimma"\n\n[search]\ndefault = "@s"\n\n' +
        '[search.aliases]\ns = "http://search.example/?q=%s"\n',
    );
    expect(parseConfig(text).errors).toEqual([]);
  });
  it("leaves the name out for a build without it: its default built-in shows", () => {
    expect(promoConfig({ source: "omarchy", name: null })).toBe(
      'schema = 2\n\n[theme]\nsource = "omarchy"\n',
    );
  });
});

describe("proxyRoute", () => {
  const routes = {
    "shop.example": "http://127.0.0.1:5001",
    "127.0.0.1:8800": "http://127.0.0.1:8800",
  };
  it("sends a routed host to its server, keeping the path and query", () => {
    expect(
      proxyRoute("http://shop.example/search?q=oat", "shop.example", routes, "http://p"),
    ).toEqual({ origin: "http://127.0.0.1:5001", path: "/search?q=oat" });
    expect(proxyRoute("http://127.0.0.1:8800/v1/models", "", routes, "http://p")).toEqual({
      origin: "http://127.0.0.1:8800",
      path: "/v1/models",
    });
  });
  it("reads the Host header for a request sent straight to the proxy", () => {
    expect(proxyRoute("/basket", "shop.example", routes, "http://p")).toEqual({
      origin: "http://127.0.0.1:5001",
      path: "/basket",
    });
  });
  it("sends every other host to the fixture pages", () => {
    expect(
      proxyRoute("http://wiki.example/runbook.html", "wiki.example", routes, "http://p"),
    ).toEqual({ origin: "http://p", path: "/runbook.html" });
  });
});

describe("servedModule", () => {
  it("renames a module's relative imports to .js, which the page server serves as scripts", () => {
    const text = 'import { a } from "./blocks.mjs";\nimport { b, c } from "./agent-element.mjs";\n';
    expect(servedModule(text)).toEqual({
      text: 'import { a } from "./blocks.js";\nimport { b, c } from "./agent-element.js";\n',
      imports: ["blocks", "agent-element"],
    });
  });
  it("serves hints.mjs and every module it reaches, each import naming a served .js", () => {
    // record.ts (serveCore) serves vimma-core's hints.mjs to probe.js with what it imports.
    // vimma-core stays .mjs (ADR-025) while tools/ moves to .ts, so the rewrite reads `./x.mjs`;
    // the modules come from sync-core's flat copy, where each imports the others that way.
    const core = flatCore(
      fileURLToPath(new URL("../../../packages/vimma-core/src", import.meta.url)),
    );
    const served = new Map();
    const queue = ["hints"];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (served.has(name)) continue;
      const source = core.get(`${name}.mjs`);
      if (source === undefined) throw new Error(`no core module ${name}.mjs`);
      const { text, imports } = servedModule(source);
      served.set(name, text);
      queue.push(...imports);
    }
    expect(served.size).toBeGreaterThan(1);
    for (const [name, text] of served) {
      for (const [, spec] of text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const target = /^\.\/([\w-]+)\.js$/.exec(spec ?? "")?.[1];
        expect(target && served.has(target), `${name}.js imports ${spec}`).toBe(true);
      }
    }
  });
  it("leaves a module without imports as it is", () => {
    expect(servedModule("export const x = 1;\n")).toEqual({
      text: "export const x = 1;\n",
      imports: [],
    });
  });
});

describe("supportsThemeName", () => {
  it("is true when the build's parseConfig takes [theme] name without errors", () => {
    expect(supportsThemeName(() => ({ errors: [] }), "vimma")).toBe(true);
  });
  it("is false when it reports an error, such as an unknown key", () => {
    const parse = () => ({ errors: [{ path: "theme.name", message: 'unknown key "name"' }] });
    expect(supportsThemeName(parse, "vimma")).toBe(false);
  });
  it("is false when it throws", () => {
    const parse = () => {
      throw new Error("boom");
    };
    expect(supportsThemeName(parse, "vimma")).toBe(false);
  });
  it("with vimma-core's own parser: the config without a name is valid, a bad name is not", () => {
    expect(parseConfig(promoConfig({ source: "file", name: null })).errors).toEqual([]);
    expect(parseConfig(promoConfig({ source: "omarchy", name: null })).errors).toEqual([]);
    expect(supportsThemeName(parseConfig, "no-such-palette")).toBe(false);
  });
  it("asks about exactly the config the recorder writes", () => {
    const seen: string[] = [];
    supportsThemeName((text: string) => (seen.push(text), { errors: [] }), "vimma");
    expect(seen).toEqual([promoConfig({ source: "file", name: "vimma" })]);
  });
});

describe("parseProbeTitle", () => {
  it("is null until the page reports", () => {
    expect(parseProbeTitle("Leave the mouse in the drawer")).toBeNull();
  });
  it("reads the label and the link's centre on the screen", () => {
    expect(parseProbeTitle("probe:ls@812,904")).toEqual({ label: "ls", x: 812, y: 904 });
  });
  it("throws the page's reason when it cannot label its target", () => {
    expect(() => parseProbeTitle("probe-error:2 link(s) cross the viewport's edge")).toThrow(
      /edge/,
    );
  });
  it("refuses anything that is not a label and a point", () => {
    expect(() => parseProbeTitle("probe:{}")).toThrow(/not a probe report/);
    expect(() => parseProbeTitle("probe:ls")).toThrow(/not a probe report/);
  });
});

describe("KeyTrack", () => {
  it("times keys and marks from the clip's first frame", () => {
    const track = new KeyTrack();
    track.mark("hints", 10_400);
    track.key("f", 10_500);
    track.key("l h", 11_250);
    expect(track.resolve(10_000)).toEqual({
      keys: [
        { t: 0.5, keys: "f" },
        { t: 1.25, keys: "l h" },
      ],
      marks: [{ t: 0.4, name: "hints" }],
    });
  });
  it("clamps an event from before the first frame to 0", () => {
    const track = new KeyTrack();
    track.key("j", 900);
    expect(track.resolve(1000).keys).toEqual([{ t: 0, keys: "j" }]);
  });
});
