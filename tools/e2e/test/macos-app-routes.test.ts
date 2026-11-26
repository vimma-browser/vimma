// The macOS app-routes smoke (docs/specs/app-routes.md, Tests, "macOS smoke"): its config routes
// the helper app's names as the patched openURLs: passes them, and it refuses to run outside CI.
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../packages/vimma-core/src/config/config.mjs";
import { matchRoute, parseAppList } from "../../../packages/vimma-core/src/config/routes.mjs";
import {
  BARE_EXE,
  OPENER_EXE,
  OPENER_ID,
  openerInfoPlist,
  refuseOutsideCi,
  smokeConfig,
  stateShows,
} from "../macos-app-routes.ts";

const BASE = "http://127.0.0.1:28471/";

/** The workspace config.toml routes `url` to when opened by `names` (comma-separated). */
function routed(url: string, names: string) {
  const { config, errors } = parseConfig(smokeConfig(BASE));
  expect(errors).toEqual([]);
  const workspaces = (config?.workspaces ?? []).map((w) => w.name);
  return matchRoute(config?.routes ?? [], { url, apps: parseAppList(names) }, { workspaces })
    ?.workspace;
}

describe("the macOS app-routes smoke's config", () => {
  it("routes the opener's bundle identifier to work and its executable name to dev", () => {
    const names = `${OPENER_ID},${OPENER_EXE}`;
    expect(routed(`${BASE}article.html`, names)).toBe("work");
    expect(routed(`${BASE}long.html`, names)).toBe("dev");
  });

  it("routes the unbundled opener's executable name to dev, so a link it names would show", () => {
    expect(routed(`${BASE}form.html`, BARE_EXE)).toBe("dev");
    expect(routed(`${BASE}form.html`, "")).toBe("admin");
  });

  it("routes a link with no names, or other names, to admin by the domain rule", () => {
    expect(routed(`${BASE}article.html`, "")).toBe("admin");
    expect(routed(`${BASE}long.html`, "open")).toBe("admin");
  });

  it("starts in home, a workspace no rule names", () => {
    const { config } = parseConfig(smokeConfig(BASE));
    expect(config?.workspaces[0]?.name).toBe("home");
  });
});

describe("the link opener app", () => {
  it("is a window-less app with its own bundle identifier and executable", () => {
    const plist = openerInfoPlist();
    expect(plist).toContain(`<key>CFBundleIdentifier</key>\n  <string>${OPENER_ID}</string>`);
    expect(plist).toContain(`<key>CFBundleExecutable</key>\n  <string>${OPENER_EXE}</string>`);
    expect(plist).toContain("<key>LSUIElement</key>\n  <true/>");
  });
});

describe("refuseOutsideCi", () => {
  it("runs only on a GitHub Actions runner, never on a developer's Mac", () => {
    expect(() => refuseOutsideCi({})).toThrow(/only on a CI runner/);
    expect(() => refuseOutsideCi({ CI: "true" })).toThrow(/only on a CI runner/);
    expect(() => refuseOutsideCi({ GITHUB_ACTIONS: "true", CI: "true" })).not.toThrow();
  });
});

describe("stateShows", () => {
  const state = {
    workspace: "work",
    tabs: [
      { url: "about:blank", selected: false },
      { url: `${BASE}article.html`, selected: true },
    ],
  };

  it("is true when the workspace is shown with the link's tab in it", () => {
    expect(stateShows(state, { workspace: "work", url: `${BASE}article.html` })).toBe(true);
  });

  it("is false for another workspace or a missing tab", () => {
    expect(stateShows(state, { workspace: "admin", url: `${BASE}article.html` })).toBe(false);
    expect(stateShows(state, { workspace: "work", url: `${BASE}long.html` })).toBe(false);
    expect(stateShows(null, { workspace: "work", url: `${BASE}article.html` })).toBe(false);
  });
});
