// tools/update/channel.mjs (docs/specs/m6a-updater.md §1): the compile-time channel stays
// `vimma`, which picks the updater's certificates, and the nightly tarball gets its own update
// channel when it is packaged. Both channel files must change together: channel-prefs.js picks
// the manifest URL, update-settings.ini the MAR channel the updater accepts.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { setChannel } from "../channel.mjs";

const SCRIPT = new URL("../channel.mjs", import.meta.url).pathname;
const PREFS = '/* comment */\npref("app.update.channel", "vimma");\n';
const SETTINGS =
  "; If you modify this file updates may fail.\n[Settings]\nACCEPTED_MAR_CHANNEL_IDS=vimma\n";

/** An unpacked install with both channel files, as `./mach package` writes them. */
function install(/** @type {{ prefs?: string, settings?: string }} */ o = {}) {
  const root = tempDir("vimma-channel-");
  const dir = join(root, "vimma");
  mkdirSync(join(dir, "defaults/pref"), { recursive: true });
  writeFileSync(join(dir, "defaults/pref/channel-prefs.js"), o.prefs ?? PREFS);
  writeFileSync(join(dir, "update-settings.ini"), o.settings ?? SETTINGS);
  writeFileSync(join(dir, "application.ini"), "[App]\nVersion=159.0.1\n");
  return { root, dir };
}

describe("setChannel", () => {
  it("rewrites both channel files, and nothing else in them", () => {
    const { dir } = install();
    setChannel(dir, "vimma-nightly");
    expect(readFileSync(join(dir, "defaults/pref/channel-prefs.js"), "utf8")).toBe(
      '/* comment */\npref("app.update.channel", "vimma-nightly");\n',
    );
    expect(readFileSync(join(dir, "update-settings.ini"), "utf8")).toBe(
      SETTINGS.replace("=vimma\n", "=vimma-nightly\n"),
    );
  });

  it.each([
    ["no channel pref", { prefs: "/* nothing */\n" }],
    ["two channel prefs", { prefs: PREFS + PREFS }],
    ["no ACCEPTED_MAR_CHANNEL_IDS", { settings: "[Settings]\n" }],
    ["a channel other than vimma", { settings: SETTINGS.replace("=vimma", "=release") }],
  ])("refuses an install with %s", (_name, o) => {
    const { dir } = install(o);
    expect(() => setChannel(dir, "vimma-nightly")).toThrow();
  });

  it("refuses a channel the updater does not know", () => {
    const { dir } = install();
    expect(() => setChannel(dir, "beta")).toThrow(/channel/);
  });
});

describe("channel.mjs --tarball", () => {
  it("writes a tarball whose install says vimma-nightly in both files", () => {
    const { root } = install();
    const tarball = join(root, "in.tar.xz");
    execFileSync("tar", ["-cJf", tarball, "-C", root, "vimma"]);
    const out = join(root, "out.tar.xz");
    const r = spawnSync(
      "node",
      [SCRIPT, "--tarball", tarball, "--channel", "vimma-nightly", "--out", out],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const check = tempDir("vimma-channel-out-");
    execFileSync("tar", ["-xJf", out, "-C", check]);
    expect(readFileSync(join(check, "vimma/update-settings.ini"), "utf8")).toContain(
      "ACCEPTED_MAR_CHANNEL_IDS=vimma-nightly\n",
    );
    expect(readFileSync(join(check, "vimma/defaults/pref/channel-prefs.js"), "utf8")).toContain(
      '"vimma-nightly"',
    );
  });
});
