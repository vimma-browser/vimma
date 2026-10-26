import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";

// Spec macos-build, sub-PR 7: a release's Vimma.app signed with Vimma's Developer ID, under the
// hardened runtime with Vimma's production entitlements, notarised and stapled, then packed into a
// new .dmg; and the check a hosted Mac runs on the result.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
/** @param {string} path */
const read = (path) => readFileSync(join(repo, path), "utf8");
const UNPACK = join(repo, "tools/package/macos-dmg-unpack.sh");
const SIGN = join(repo, "tools/package/macos-sign-app.sh");
const PACK = join(repo, "tools/package/macos-dmg-pack.sh");
const MANIFEST = join(repo, "tools/package/macos-app-manifest.sh");
const ENTITLEMENTS = join(repo, "configs/macos/entitlements");
const TEAM = "ABCDE12345";
const PASSWORD = "p12-password-never-on-a-command-line";
const API_KEY = '{"issuer_id":"never-on-a-command-line"}';

/**
 * The plist keys of an entitlements file, each with its value as written.
 * @param {string} xml
 */
function entitlements(xml) {
  /** @type {Record<string, string>} */
  const keys = {};
  // comments removed until none is left, so a removal cannot join two halves into a new one
  let body = xml;
  for (let before = ""; before !== body;) {
    before = body;
    body = body.replace(/<!--[\s\S]*?-->/g, "");
  }
  for (const m of body.matchAll(
    /<key>([^<]+)<\/key>\s*(<true\/>|<false\/>|<string>[^<]*<\/string>)/g,
  )) {
    keys[m[1] ?? ""] = m[2] ?? "";
  }
  return keys;
}

describe("Vimma's production entitlements (configs/macos/entitlements)", () => {
  // Firefox 158.0, security/mac/hardenedruntime/production/firefox.browser.xml, without the two
  // restricted entitlements that need a provisioning profile (mach macos-sign's
  // production-without-restricted, tools/signing/macos/mach_commands.py).
  it("the browser gets Firefox's production entitlements without the restricted pair", () => {
    expect(entitlements(read("configs/macos/entitlements/browser.xml"))).toEqual({
      "com.apple.security.cs.disable-library-validation": "<true/>",
      "com.apple.security.cs.allow-jit": "<true/>",
      "com.apple.security.device.audio-input": "<true/>",
      "com.apple.security.device.camera": "<true/>",
      "com.apple.security.device.usb": "<true/>",
      "com.apple.security.personal-information.location": "<true/>",
      "com.apple.security.smartcard": "<true/>",
    });
  });

  it("names no team, no bundle identifier and no Mozilla identity", () => {
    for (const file of readdirSync(ENTITLEMENTS)) {
      const xml = read(`configs/macos/entitlements/${file}`);
      expect(xml, file).not.toMatch(
        /application-identifier|public-key-credential|43AQ936H96|org\.mozilla/,
      );
    }
  });

  it("plugin-container gets JIT and media-plugin-helper loads third-party CDMs, as in Firefox", () => {
    expect(entitlements(read("configs/macos/entitlements/plugin-container.xml"))).toEqual({
      "com.apple.security.cs.allow-jit": "<true/>",
    });
    expect(entitlements(read("configs/macos/entitlements/media-plugin-helper.xml"))).toEqual({
      "com.apple.security.cs.disable-library-validation": "<true/>",
    });
    expect(readdirSync(ENTITLEMENTS).sort()).toEqual([
      "browser.xml",
      "media-plugin-helper.xml",
      "plugin-container.xml",
    ]);
  });
});

/**
 * A Vimma.app as mach package lays it out, with its helpers, under `dir/name`.
 * @param {string} dir
 * @param {{ stapled?: boolean, links?: Record<string, string> }} [options]
 */
function appTree(dir, { stapled = false, links = {} } = {}) {
  const app = join(dir, "Vimma.app");
  for (const f of [...APP_FILES, ...(stapled ? ["Contents/CodeResources"] : [])]) {
    mkdirSync(join(app, f, ".."), { recursive: true });
    writeFileSync(join(app, f), "x");
  }
  for (const [where, exe] of Object.entries(PLISTS)) {
    writeFileSync(join(app, where, "Info.plist"), plist(exe));
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(app, path));
  return app;
}

const APP_FILES = [
  "Contents/MacOS/vimma",
  "Contents/MacOS/XUL",
  "Contents/MacOS/vimma-ctl",
  "Contents/MacOS/libmozglue.dylib",
  "Contents/MacOS/libnss3.dylib",
  "Contents/MacOS/pingsender",
  "Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container",
  "Contents/MacOS/media-plugin-helper.app/Contents/MacOS/media-plugin-helper",
  "Contents/Resources/gmp-clearkey/0.1/libclearkey.dylib",
];
const ART = [".DS_Store", ".background/background.png", ".VolumeIcon.icns"];
/** Each bundle's Info.plist directory and its CFBundleExecutable. */
const PLISTS = {
  Contents: "vimma",
  "Contents/MacOS/plugin-container.app/Contents": "plugin-container",
  "Contents/MacOS/media-plugin-helper.app/Contents": "media-plugin-helper",
};

/**
 * An XML Info.plist naming `exe` as the bundle's executable, as mach package writes it.
 * @param {string} exe
 */
function plist(exe) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${exe}</string>
  <key>CFBundleIdentifier</key>
  <string>dev.vimma.browser</string>
</dict>
</plist>
`;
}

/**
 * Stub disk-image tools (dmg, hfsplus, newfs_hfs) in `dir/dmg-tools`, logging each call to
 * `dir/log`. `dmg extract` + `hfsplus extractall` lay out a volume with one Vimma.app, the window
 * art and the Applications link, as mach package makes it.
 * @param {string} dir
 * @param {{ stapled?: boolean, buildFails?: boolean }} [options]
 */
function dmgTools(dir, { stapled = false, buildFails = false } = {}) {
  const log = join(dir, "log");
  const tools = join(dir, "dmg-tools");
  mkdirSync(tools);
  const files = [
    ...APP_FILES.map((f) => `Vimma.app/${f}`),
    ...ART,
    ...(stapled ? ["Vimma.app/Contents/CodeResources"] : []),
  ];
  const tool = (/** @type {string} */ name, /** @type {string} */ body) => {
    writeFileSync(join(tools, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}`);
    chmodSync(join(tools, name), 0o755);
  };
  tool(
    "dmg",
    `case "$1" in extract) echo hfs > "$3" ;; build) ${buildFails ? "exit 5" : 'echo dmg > "$3"'} ;; esac\n`,
  );
  tool(
    "hfsplus",
    `if [ "$2" = extractall ]; then
  for f in ${files.map((f) => `'${f}'`).join(" ")}; do mkdir -p "$4/$(dirname "$f")"; echo x > "$4/$f"; done
  ln -s /Applications "$4/ "
fi
if [ "$2" = addall ]; then (cd "$3" && find . -name CodeResources | sort) > "${log}.packed"; fi
`,
  );
  tool("newfs_hfs", ":\n");
  return { log, tools };
}

/**
 * Runs a script with a clean environment; undefined values are left out.
 * @param {string} script
 * @param {string[]} args
 * @param {string} dir
 * @param {Record<string, string | undefined>} env
 */
function run(script, args, dir, env) {
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  /** @type {Record<string, string>} */
  const clean = { PATH: process.env.PATH ?? "", TMPDIR: tmp };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const result = spawnSync(script, args, { encoding: "utf8", env: clean });
  return { ...result, tmp };
}

/** @param {string} log */
const lines = (log) => readFileSync(log, "utf8").trim().split("\n");

// Job macos-unpack: the handed-over disk-image tools run here, with no secret on the runner.
describe("macos-dmg-unpack.sh", () => {
  /** @param {string} dir @param {Record<string, string | undefined>} env */
  const unpack = (dir, env) => {
    writeFileSync(join(dir, "in.dmg"), "ad hoc dmg\n");
    return run(UNPACK, [join(dir, "in.dmg"), join(dir, "volume")], dir, env);
  };

  it("unpacks the dmg with the disk-image tools, as mach's unpack_dmg does on Linux", () => {
    const dir = tempDir("vimma-unpack-");
    const { log, tools } = dmgTools(dir);
    const { status, stderr, tmp } = unpack(dir, { DMG_TOOLS: tools });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const calls = lines(log);
    // python/mozbuild/mozpack/dmg.py, extract_dmg_contents (Firefox 158.0)
    expect(calls[0]).toMatch(new RegExp(`^dmg extract ${join(dir, "in.dmg")} \\S+\\.hfs$`));
    expect(calls[1]).toMatch(/^hfsplus \S+\.hfs extractall \/ \S+$/);
    expect(calls).toHaveLength(2);
    // the app and the art, without the Applications link, which make_dmg adds again
    expect(readdirSync(join(dir, "volume")).sort()).toEqual([
      ".DS_Store",
      ".VolumeIcon.icns",
      ".background",
      "Vimma.app",
    ]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("refuses to run without DMG_TOOLS", () => {
    const dir = tempDir("vimma-unpack-");
    const { status, stderr } = unpack(dir, {});
    expect(status).not.toBe(0);
    expect(stderr).toContain("DMG_TOOLS");
  });

  it("refuses an app that is already stapled, so a re-run starts from macos-build's dmg", () => {
    const dir = tempDir("vimma-unpack-");
    const { tools } = dmgTools(dir, { stapled: true });
    const { status, stderr } = unpack(dir, { DMG_TOOLS: tools });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/already/);
  });
});

// macos-build writes it for the app mach built; macos-notarise recomputes it from what
// macos-unpack handed over and refuses a difference, before any credential exists.
describe("macos-app-manifest.sh", () => {
  /** @param {string} app */
  const manifest = (app) =>
    spawnSync(MANIFEST, [app], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

  it("lists every entry with its type, executable bit and SHA-256, sorted bytewise", () => {
    const dir = tempDir("vimma-manifest-");
    const app = join(dir, "Vimma.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents/Resources/empty"), { recursive: true });
    writeFileSync(join(app, "Contents/MacOS/vimma"), "binary\n");
    chmodSync(join(app, "Contents/MacOS/vimma"), 0o755);
    writeFileSync(join(app, "Contents/Resources/a b@2x.png"), "png\n");
    chmodSync(join(app, "Contents/Resources/a b@2x.png"), 0o644);
    const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex");
    const { status, stdout, stderr } = manifest(app);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toBe(
      [
        "d x - Contents",
        "d x - Contents/MacOS",
        `f x ${sha("binary\n")} Contents/MacOS/vimma`,
        "d x - Contents/Resources",
        `f - ${sha("png\n")} Contents/Resources/a b@2x.png`,
        "d x - Contents/Resources/empty",
        "",
      ].join("\n"),
    );
  });

  it("changes when a byte, an executable bit or a file name changes", () => {
    const dir = tempDir("vimma-manifest-");
    const app = appTree(dir);
    const before = manifest(app).stdout;
    writeFileSync(join(app, "Contents/MacOS/XUL"), "y");
    const byte = manifest(app).stdout;
    expect(byte).not.toBe(before);
    chmodSync(join(app, "Contents/MacOS/XUL"), 0o755);
    expect(manifest(app).stdout).not.toBe(byte);
    writeFileSync(join(app, "Contents/MacOS/extra"), "y");
    expect(manifest(app).stdout).toContain("Contents/MacOS/extra");
  });

  it("refuses a symlink in the app, the app itself as a link, and a name with a newline", () => {
    const dir = tempDir("vimma-manifest-");
    const app = appTree(dir, { links: { "Contents/MacOS/x": "." } });
    expect(manifest(app).status).not.toBe(0);
    expect(manifest(app).stderr).toMatch(/symlink/);
    const clean = appTree(join(dir, "clean"));
    symlinkSync(clean, join(dir, "Linked.app"));
    expect(manifest(join(dir, "Linked.app")).status).not.toBe(0);
    writeFileSync(join(clean, "Contents/MacOS/a\nb"), "x");
    expect(manifest(clean).status).not.toBe(0);
    expect(manifest(clean).stderr).toMatch(/newline/);
  });

  // It runs in macos-notarise: coreutils only, nothing from the build.
  it("runs only coreutils and sha256sum", () => {
    const script = read("tools/package/macos-app-manifest.sh")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(script).not.toMatch(
      /DMG_TOOLS|hfsplus|dmg|mach|node|rcodesign|eval|source |^\s*"\$[a-z_]+"/m,
    );
    expect(script).toContain("sha256sum");
  });
});

// Job macos-notarise, the only one with the Apple secrets: rcodesign and nothing from the build.
describe("macos-sign-app.sh", () => {
  /**
   * A stub rcodesign in `dir`, logging to `dir/log`, and the credential files.
   * @param {string} dir
   * @param {{ team?: string, subject?: string, notaryFails?: boolean, signFails?: boolean,
   *   staples?: boolean }} [options]
   */
  function rcodesignStub(
    dir,
    {
      team = TEAM,
      subject = `Developer ID Application: Vimma (${TEAM})`,
      notaryFails = false,
      signFails = false,
      staples = true,
    } = {},
  ) {
    const log = join(dir, "log");
    const rcodesign = join(dir, "rcodesign");
    writeFileSync(
      rcodesign,
      `#!/bin/sh
echo "rcodesign $*" >> "${log}"
case "$1" in
  analyze-certificate)
    echo "# Certificate 0"
    echo "Subject CN:                  ${subject}"
    echo "Team ID:                     ${team}"
    ;;
  sign) ${signFails ? "exit 3" : ":"} ;;
  notary-submit)
    ${notaryFails ? "exit 4" : ""}
    for last; do :; done
    ${staples ? 'echo ticket > "$last/Contents/CodeResources"' : ":"}
    ;;
esac
`,
    );
    chmodSync(rcodesign, 0o755);
    const secrets = join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "developer-id.p12"), "p12");
    writeFileSync(join(secrets, "p12-password"), PASSWORD);
    writeFileSync(join(secrets, "notary-api-key.json"), API_KEY);
    return {
      log,
      env: {
        RCODESIGN: rcodesign,
        APPLE_P12_FILE: join(secrets, "developer-id.p12"),
        APPLE_P12_PASSWORD_FILE: join(secrets, "p12-password"),
        APPLE_NOTARY_API_KEY_FILE: join(secrets, "notary-api-key.json"),
        APPLE_TEAM_ID: TEAM,
      },
    };
  }

  /**
   * @param {Parameters<typeof rcodesignStub>[1]} [options]
   * @param {Parameters<typeof appTree>[1]} [tree]
   */
  const setup = (options, tree) => {
    const dir = tempDir("vimma-sign-");
    const app = appTree(dir, tree);
    return { dir, app, ...rcodesignStub(dir, options) };
  };

  it("checks the certificate is a Developer ID Application of APPLE_TEAM_ID before signing", () => {
    for (const [options, message] of /** @type {const} */ ([
      [{ team: "ZZZZZ99999" }, /team/i],
      [{ subject: `Apple Development: Vimma (${TEAM})` }, /Developer ID Application/],
    ])) {
      const { dir, app, log, env } = setup(options);
      const { status, stdout, stderr } = run(SIGN, [app], dir, env);
      expect(status).not.toBe(0);
      expect(stdout + stderr).toMatch(message);
      expect(readFileSync(log, "utf8")).not.toMatch(/rcodesign sign|notary-submit/);
    }
  });

  it("signs in one rcodesign run, nested code inside-out with mach macos-sign's settings", () => {
    const { dir, app, log, env } = setup();
    expect(run(SIGN, [app], dir, env).status).toBe(0);
    const sign = lines(log).find((l) => l.startsWith("rcodesign sign ")) ?? "";
    const args = sign.split(" ").slice(2);
    expect(args.at(-1)).toBe(app);
    /** @param {string} flag */
    const values = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
    expect(values("--p12-file")).toEqual([env.APPLE_P12_FILE]);
    expect(values("--p12-password-file")).toEqual([env.APPLE_P12_PASSWORD_FILE]);
    // Developer ID, a secure timestamp and the hardened runtime on every Mach-O, or rcodesign
    // refuses (rcodesign 0.29.0, ensure_for_notarization_settings)
    expect(args).toContain("--for-notarization");
    expect(args).not.toContain("--timestamp-url");
    // taskcluster/config.yml, mac-signing.hardened-sign-config.production, release channel:
    // each helper app and binary present gets the runtime flag, the two helper apps their own
    // entitlements, the app Vimma's browser.xml; security-module-helper is nightly-only.
    expect(values("--code-signature-flags")).toEqual([
      "Contents/MacOS/plugin-container.app:runtime",
      "Contents/MacOS/media-plugin-helper.app:runtime",
      "Contents/MacOS/XUL:runtime",
      "Contents/MacOS/pingsender:runtime",
      "Contents/MacOS/libmozglue.dylib:runtime",
      "Contents/MacOS/libnss3.dylib:runtime",
      "Contents/Resources/gmp-clearkey/0.1/libclearkey.dylib:runtime",
      "Contents/MacOS/vimma-ctl:runtime",
      "runtime",
    ]);
    expect(values("--entitlements-xml-file")).toEqual([
      `Contents/MacOS/plugin-container.app:${ENTITLEMENTS}/plugin-container.xml`,
      `Contents/MacOS/media-plugin-helper.app:${ENTITLEMENTS}/media-plugin-helper.xml`,
      `${ENTITLEMENTS}/browser.xml`,
    ]);
  });

  it("notarises and staples the app after signing it", () => {
    const { dir, app, log, env } = setup();
    const { status } = run(SIGN, [app], dir, env);
    expect(status).toBe(0);
    const calls = lines(log);
    expect(calls.map((l) => l.split(" ")[1])).toEqual([
      "analyze-certificate",
      "sign",
      "notary-submit",
    ]);
    expect(calls[2]).toBe(
      `rcodesign notary-submit --api-key-file ${env.APPLE_NOTARY_API_KEY_FILE} ` +
        `--max-wait-seconds 3600 --wait --staple ${app}`,
    );
    expect(readFileSync(join(app, "Contents/CodeResources"), "utf8")).toBe("ticket\n");
  });

  it("passes the password and the API key as files, never on a command line", () => {
    const { dir, app, log, env } = setup();
    const { status, stdout, stderr } = run(SIGN, [app], dir, env);
    expect(status).toBe(0);
    const all = readFileSync(log, "utf8") + stdout + stderr;
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain("never-on-a-command-line");
    expect(all).not.toMatch(/--p12-password |--api-key-path|--api-issuer/);
  });

  it.each([
    "APPLE_P12_FILE",
    "APPLE_P12_PASSWORD_FILE",
    "APPLE_NOTARY_API_KEY_FILE",
    "APPLE_TEAM_ID",
  ])("refuses to run without %s", (name) => {
    const { dir, app, log, env } = setup();
    const { status, stderr } = run(SIGN, [app], dir, { ...env, [name]: undefined });
    expect(status).not.toBe(0);
    expect(stderr).toContain(name);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses a team ID that is not ten capitals and digits", () => {
    const { dir, app, log, env } = setup();
    const { status, stderr } = run(SIGN, [app], dir, { ...env, APPLE_TEAM_ID: "abc; rm -rf /" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("APPLE_TEAM_ID");
    expect(existsSync(log)).toBe(false);
  });

  // The app comes from macos-unpack's artifact: a link out of the bundle could make rcodesign
  // read or write a file outside it, such as the credentials. A chain of links that each look
  // harmless as text (x -> ., then x/x/../..) still gets out.
  it("refuses a symlink that leaves the app, before rcodesign runs", () => {
    const cases = [
      { "Contents/MacOS/escape": "/etc/hosts" },
      { "Contents/MacOS/escape": "../../../secrets/p12-password" },
      { "Contents/MacOS/escape": "../../.." },
      { "Contents/MacOS/x": ".", "Contents/MacOS/esc": "x/x/x/../../../../secrets/p12-password" },
    ];
    for (const links of cases) {
      const { dir, app, log, env } = setup(undefined, { links });
      const { status, stderr } = run(SIGN, [app], dir, env);
      expect(status, JSON.stringify(links)).not.toBe(0);
      expect(stderr, JSON.stringify(links)).toMatch(/symlink/);
      expect(existsSync(log), JSON.stringify(links)).toBe(false);
    }
  });

  // An installed Vimma.app on Firefox 158.0.1 has no symlink in the bundle;
  // its frameworks are flat. So any link is refused, inside or out.
  it("refuses every symlink, even one that stays inside the app, and an app that is a link", () => {
    for (const links of [{ "Contents/MacOS/link-to-xul": "XUL" }, { "Contents/up": "MacOS" }]) {
      const { dir, app, log, env } = setup(undefined, { links });
      const { status, stderr } = run(SIGN, [app], dir, env);
      expect(status, JSON.stringify(links)).not.toBe(0);
      expect(stderr).toMatch(/symlink/);
      expect(existsSync(log)).toBe(false);
    }
    const { dir, app, log, env } = setup();
    symlinkSync(app, join(dir, "Linked.app"));
    const { status, stderr } = run(SIGN, [join(dir, "Linked.app")], dir, env);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/symlink/);
    expect(existsSync(log)).toBe(false);
  });

  // A name becomes part of rcodesign's `<path>:<value>` scope syntax, so a `:` or a newline in it
  // would change what is signed with which setting.
  it("refuses a file name outside [A-Za-z0-9._+-] in a path it scopes a setting to", () => {
    for (const name of ["lib:evil.dylib", "lib evil.dylib", "lib\nx.dylib"]) {
      const { dir, app, log, env } = setup();
      writeFileSync(join(app, "Contents/MacOS", name), "x");
      const { status, stderr } = run(SIGN, [app], dir, env);
      expect(status, JSON.stringify(name)).not.toBe(0);
      expect(stderr).toMatch(/name/);
      expect(existsSync(log)).toBe(false);
    }
  });

  it("refuses a CFBundleExecutable with a / or .., and a binary Info.plist", () => {
    const plists = [
      plist("../../../secrets/p12-password"),
      plist("MacOS/../vimma"),
      plist(".."),
      "bplist00 binary",
      // where sed and a real plist parser disagree: each is refused before it is parsed
      plist("vimma").replace(
        "</dict>",
        "<!-- <key>CFBundleExecutable</key><string>../../x</string> --></dict>",
      ),
      plist("vimma").replace("<string>vimma</string>", "<string><![CDATA[../../x]]></string>"),
      plist("vimma").replace(
        "<string>vimma</string>",
        '<string xml:space="preserve">../x</string>',
      ),
      plist("vimma").replace("<string>vimma</string>", "<string >../x</string>"),
      plist("vimma").replace(
        "</dict>",
        "<key>CFBundleExecutable</key><string>../x</string></dict>",
      ),
      // the key is there, but its value is not a <string> that parses
      plist("vimma").replace("<string>vimma</string>", "<integer>1</integer>"),
    ];
    for (const [i, text] of plists.entries()) {
      for (const where of ["Contents", "Contents/MacOS/plugin-container.app/Contents"]) {
        const { dir, app, log, env } = setup();
        writeFileSync(join(app, where, "Info.plist"), text);
        const { status, stderr } = run(SIGN, [app], dir, env);
        expect(status, `${i} ${where}`).not.toBe(0);
        expect(stderr, `${i} ${where}`).toMatch(/Info\.plist/);
        expect(existsSync(log)).toBe(false);
      }
    }
  });

  it("refuses an app that is already stapled", () => {
    const { dir, app, log, env } = setup(undefined, { stapled: true });
    const { status, stderr } = run(SIGN, [app], dir, env);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/already/);
    expect(existsSync(log)).toBe(false);
  });

  it("fails when signing or notarisation fails, or nothing was stapled", () => {
    for (const options of [{ signFails: true }, { notaryFails: true }, { staples: false }]) {
      const { dir, app, env } = setup(options);
      const { status } = run(SIGN, [app], dir, env);
      expect(status, JSON.stringify(options)).not.toBe(0);
    }
  });

  // What the job holding the secrets runs is this script and rcodesign; nothing that came from
  // the build, and no other tool of this repository.
  it("runs rcodesign and no disk-image tool, mach, node or other program of the build", () => {
    const script = read("tools/package/macos-sign-app.sh")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(script).not.toMatch(
      /DMG_TOOLS|hfsplus|newfs_hfs|\bdmg\b|mach|node|eval|source |^\s*\. /m,
    );
    const invoked = [...script.matchAll(/^\s*(?:[a-z_]+=\$\()?"\$([a-z_]+)"/gm)].map((m) => m[1]);
    expect(new Set(invoked)).toEqual(new Set(["rcodesign"]));
  });
});

// Job macos-pack: the handed-over tools again, after the secrets' job has ended.
describe("macos-dmg-pack.sh", () => {
  /**
   * @param {{ stapled?: boolean, art?: string[], buildFails?: boolean }} [options]
   */
  const pack = ({ stapled = true, art = ART, buildFails = false } = {}) => {
    const dir = tempDir("vimma-pack-");
    const { log, tools } = dmgTools(dir, { buildFails });
    const volume = join(dir, "volume");
    appTree(volume, { stapled });
    for (const f of art) {
      mkdirSync(join(volume, f, ".."), { recursive: true });
      writeFileSync(join(volume, f), "art");
    }
    mkdirSync(join(dir, "out"));
    const result = run(PACK, [volume, join(dir, "out/Vimma.dmg")], dir, { DMG_TOOLS: tools });
    return { ...result, dir, log };
  };

  it("packs the volume as mach's make_dmg does on Linux", () => {
    const { status, stderr, dir, log, tmp } = pack();
    expect(stderr).toBe("");
    expect(status).toBe(0);
    // python/mozbuild/mozpack/dmg.py, create_dmg on Linux (Firefox 158.0)
    const calls = lines(log);
    expect(calls[0]).toMatch(/^newfs_hfs -v Vimma \S+\.hfs$/);
    expect(calls[1]).toMatch(/^hfsplus \S+\.hfs symlink \/ {2}\/Applications$/);
    expect(calls[2]).toMatch(/^hfsplus \S+\.hfs attr \/ C$/);
    expect(calls[3]).toMatch(/^hfsplus \S+\.hfs addall \S+$/);
    expect(calls[4]).toMatch(/^dmg build \S+\.hfs \S+$/);
    expect(calls).toHaveLength(5);
    expect(readFileSync(`${log}.packed`, "utf8").trim()).toBe("./Vimma.app/Contents/CodeResources");
    expect(readFileSync(join(dir, "out/Vimma.dmg"), "utf8")).toBe("dmg\n");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("refuses an app without a stapled ticket, so an unsigned app is never packed", () => {
    const { status, stderr, dir } = pack({ stapled: false });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/stapled/);
    expect(existsSync(join(dir, "out/Vimma.dmg"))).toBe(false);
  });

  it("refuses a volume without its window art or volume icon", () => {
    for (const missing of ART) {
      const { status, stderr } = pack({ art: ART.filter((f) => f !== missing) });
      expect(status, missing).not.toBe(0);
      expect(stderr, missing).toContain(missing);
    }
  });

  it("writes no dmg when the disk-image tool fails", () => {
    const { status, dir } = pack({ buildFails: true });
    expect(status).not.toBe(0);
    expect(existsSync(join(dir, "out/Vimma.dmg"))).toBe(false);
  });
});

// What a hosted Mac checks on the app from a Developer ID release (macos-smoke).
describe("macos-developer-id-check.sh", () => {
  const CHECK = join(repo, "tools/package/macos-developer-id-check.sh");
  const NESTED = ["Contents/MacOS/vimma-ctl", "Contents/MacOS/plugin-container.app"];
  /** codesign -dvv as macOS prints it for a Developer ID signature with a secure timestamp. */
  const SIGNED = (team = TEAM, flags = "0x10000(runtime)") =>
    [
      "Executable=/x/Vimma.app/Contents/MacOS/vimma",
      "Identifier=dev.vimma.browser",
      "Format=app bundle with Mach-O thin (arm64)",
      `CodeDirectory v=20500 size=1234 flags=${flags} hashes=30+7 location=embedded`,
      "Signature size=9000",
      `Authority=Developer ID Application: Vimma (${team})`,
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      "Timestamp=26 Oct 2026 at 10.00.00",
      "Notarization Ticket=stapled",
      `TeamIdentifier=${team}`,
    ].join("\n");
  const ADHOC = [
    "Executable=/x/Vimma.app/Contents/MacOS/vimma",
    "CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7 location=embedded",
    "Signature=adhoc",
    "TeamIdentifier=not set",
  ].join("\n");
  const ACCEPTED = `accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Vimma (${TEAM})`;

  /**
   * @param {{ app?: string, nested?: string, spctl?: string, spctlStatus?: number,
   *   staple?: number, verify?: number, expected?: string }} [out]
   */
  function check({
    app = SIGNED(),
    nested = SIGNED(),
    spctl = ACCEPTED,
    spctlStatus = 0,
    staple = 0,
    verify = 0,
    expected = TEAM,
  } = {}) {
    const dir = tempDir("vimma-devid-check-");
    const bundle = join(dir, "Vimma.app");
    for (const path of NESTED) mkdirSync(join(bundle, path, ".."), { recursive: true });
    writeFileSync(join(bundle, "Contents/MacOS/vimma-ctl"), "x");
    mkdirSync(join(bundle, "Contents/MacOS/plugin-container.app"));
    writeFileSync(join(dir, "app.txt"), app);
    writeFileSync(join(dir, "nested.txt"), nested);
    const stub = (/** @type {string} */ name, /** @type {string} */ body) => {
      writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/log"\n${body}`);
      chmodSync(join(dir, name), 0o755);
    };
    stub(
      "codesign",
      `case "$1" in
  --verify) exit ${verify} ;;
  -dvv) for last; do :; done
    if [ "$last" = "${bundle}" ]; then cat "${dir}/app.txt" >&2; else cat "${dir}/nested.txt" >&2; fi ;;
esac
`,
    );
    stub("spctl", `cat <<'EOF' >&2\n${spctl}\nEOF\nexit ${spctlStatus}\n`);
    stub("xcrun", `exit ${staple}\n`);
    const result = spawnSync(CHECK, [bundle], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CODESIGN: join(dir, "codesign"),
        SPCTL: join(dir, "spctl"),
        XCRUN: join(dir, "xcrun"),
        ...(expected === undefined ? {} : { EXPECTED_TEAM_ID: expected }),
      },
    });
    const log = existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "";
    return { ...result, log, bundle };
  }

  it("passes a Developer ID app under the hardened runtime, notarised, stapled and accepted", () => {
    const result = check();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.log).toContain(`codesign --verify --deep --strict --verbose=2 ${result.bundle}`);
    expect(result.log).toContain(`codesign -dvv ${result.bundle}`);
    for (const path of NESTED)
      expect(result.log).toContain(`codesign -dvv ${result.bundle}/${path}`);
    expect(result.log).toContain(`spctl --assess --type execute -vv ${result.bundle}`);
    expect(result.log).toContain(`xcrun stapler validate ${result.bundle}`);
    expect(result.stdout).toContain(TEAM);
  });

  it.each([
    ["an ad hoc signature", { app: ADHOC }, /Developer ID/],
    ["no hardened runtime", { app: SIGNED(TEAM, "0x0(none)") }, /hardened runtime/],
    [
      "no secure timestamp",
      { app: SIGNED().replace(/^Timestamp=.*$/m, "Signed Time=now") },
      /timestamp/,
    ],
    ["a nested binary from another team", { nested: SIGNED("ZZZZZ99999") }, /vimma-ctl/],
    ["a nested binary without the runtime", { nested: SIGNED(TEAM, "0x0(none)") }, /vimma-ctl/],
    ["a strict verify failure", { verify: 1 }, /./],
    [
      "Gatekeeper's rejection",
      { spctl: "rejected\nsource=Unnotarized Developer ID", spctlStatus: 3 },
      /Gatekeeper/,
    ],
    ["acceptance without notarisation", { spctl: "accepted\nsource=Developer ID" }, /Notarized/],
    ["no stapled ticket", { staple: 65 }, /stapl/],
    // any notarised Developer ID app passes Gatekeeper; only Vimma's team's is Vimma
    [
      "another team's notarised app",
      { app: SIGNED("ZZZZZ99999"), nested: SIGNED("ZZZZZ99999") },
      /EXPECTED_TEAM_ID/,
    ],
    ["without EXPECTED_TEAM_ID", { expected: "" }, /EXPECTED_TEAM_ID/],
  ])("fails %s", (_name, out, message) => {
    const result = check(out);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(message);
  });

  it("is a script the release smoke job can run on macOS's bash 3.2", () => {
    const script = read("tools/package/macos-developer-id-check.sh");
    expect(script.split("\n")[0]).toBe("#!/usr/bin/env bash");
    expect(script).not.toMatch(/declare -A|mapfile|readarray|\$\{[a-z_]+,,\}/);
  });
});
