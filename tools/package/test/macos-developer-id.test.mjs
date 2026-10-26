import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const SCRIPT = join(repo, "tools/package/macos-developer-id.sh");
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
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
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
 * Stub disk-image tools (dmg, hfsplus, newfs_hfs) and rcodesign in `dir`, logging each call to
 * `dir/log`. `dmg extract` + `hfsplus extractall` lay out a volume with one Vimma.app, its
 * helpers, the window art and the Applications link, as mach package makes it.
 * @param {string} dir
 * @param {{ team?: string, subject?: string, notaryFails?: boolean, signFails?: boolean,
 *   stapled?: boolean, staples?: boolean }} [options]
 */
function stubs(
  dir,
  {
    team = TEAM,
    subject = `Developer ID Application: Vimma (${TEAM})`,
    notaryFails = false,
    signFails = false,
    stapled = false,
    staples = true,
  } = {},
) {
  const log = join(dir, "log");
  const tools = join(dir, "dmg-tools");
  mkdirSync(tools);
  const files = [
    "Vimma.app/Contents/MacOS/vimma",
    "Vimma.app/Contents/MacOS/XUL",
    "Vimma.app/Contents/MacOS/vimma-ctl",
    "Vimma.app/Contents/MacOS/libmozglue.dylib",
    "Vimma.app/Contents/MacOS/libnss3.dylib",
    "Vimma.app/Contents/MacOS/pingsender",
    "Vimma.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container",
    "Vimma.app/Contents/MacOS/media-plugin-helper.app/Contents/MacOS/media-plugin-helper",
    "Vimma.app/Contents/Resources/gmp-clearkey/0.1/libclearkey.dylib",
    ".DS_Store",
    ".background/background.png",
    ".VolumeIcon.icns",
    ...(stapled ? ["Vimma.app/Contents/CodeResources"] : []),
  ];
  const tool = (/** @type {string} */ name, /** @type {string} */ body) => {
    writeFileSync(join(tools, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}`);
    chmodSync(join(tools, name), 0o755);
  };
  tool("dmg", 'case "$1" in extract) echo hfs > "$3" ;; build) echo dmg > "$3" ;; esac\n');
  tool(
    "hfsplus",
    `if [ "$2" = extractall ]; then
  for f in ${files.map((f) => `'${f}'`).join(" ")}; do mkdir -p "$4/$(dirname "$f")"; echo x > "$4/$f"; done
  ln -s /Applications "$4/ "
fi
if [ "$2" = addall ]; then (cd "$3" && find . -name CodeResources | sort) > "${log}.packed"; fi
`,
  );
  tool("newfs_hfs", 'echo "$3" > /dev/null\n');
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
      DMG_TOOLS: tools,
      APPLE_P12_FILE: join(secrets, "developer-id.p12"),
      APPLE_P12_PASSWORD_FILE: join(secrets, "p12-password"),
      APPLE_NOTARY_API_KEY_FILE: join(secrets, "notary-api-key.json"),
      APPLE_TEAM_ID: TEAM,
    },
  };
}

/**
 * Runs macos-developer-id.sh on dir/in.dmg into dir/out/Vimma.dmg.
 * @param {string} dir
 * @param {Record<string, string | undefined>} env
 */
function run(dir, env) {
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "in.dmg"), "ad hoc dmg\n");
  /** @type {Record<string, string>} */
  const clean = { PATH: process.env.PATH ?? "", TMPDIR: tmp };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const result = spawnSync(SCRIPT, [join(dir, "in.dmg"), join(dir, "out/Vimma.dmg")], {
    encoding: "utf8",
    env: clean,
  });
  return { ...result, tmp };
}

/** @param {string} log */
const lines = (log) => readFileSync(log, "utf8").trim().split("\n");

describe("macos-developer-id.sh", () => {
  it("unpacks the dmg with the disk-image tools, as mach's unpack_dmg does on Linux", () => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir);
    const { status, stderr } = run(dir, env);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const calls = lines(log);
    // python/mozbuild/mozpack/dmg.py, extract_dmg_contents (Firefox 158.0)
    expect(calls[0]).toMatch(new RegExp(`^dmg extract ${join(dir, "in.dmg")} \\S+\\.hfs$`));
    expect(calls[1]).toMatch(/^hfsplus \S+\.hfs extractall \/ \S+$/);
  });

  it("checks the certificate is a Developer ID Application of APPLE_TEAM_ID before signing", () => {
    for (const [options, message] of /** @type {const} */ ([
      [{ team: "ZZZZZ99999" }, /team/i],
      [{ subject: `Apple Development: Vimma (${TEAM})` }, /Developer ID Application/],
    ])) {
      const dir = tempDir("vimma-devid-");
      const { log, env } = stubs(dir, options);
      const { status, stdout, stderr } = run(dir, env);
      expect(status).not.toBe(0);
      expect(stdout + stderr).toMatch(message);
      expect(readFileSync(log, "utf8")).not.toMatch(/rcodesign sign|notary-submit|dmg build/);
      expect(existsSync(join(dir, "out/Vimma.dmg"))).toBe(false);
    }
  });

  it("signs in one rcodesign run, nested code inside-out with mach macos-sign's settings", () => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir);
    expect(run(dir, env).status).toBe(0);
    const sign = lines(log).find((l) => l.startsWith("rcodesign sign ")) ?? "";
    const args = sign.split(" ").slice(2);
    const app = args.at(-1) ?? "";
    expect(app).toMatch(/\/Vimma\.app$/);
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

  it("notarises and staples the app, then packs the dmg as mach's make_dmg does on Linux", () => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir);
    const { status, tmp } = run(dir, env);
    expect(status).toBe(0);
    const calls = lines(log);
    const at = (/** @type {RegExp} */ re) => calls.findIndex((l) => re.test(l));
    const notary = calls[at(/^rcodesign notary-submit /)] ?? "";
    expect(notary).toMatch(
      new RegExp(
        `^rcodesign notary-submit --api-key-file ${env.APPLE_NOTARY_API_KEY_FILE} ` +
          "--max-wait-seconds \\d+ --wait --staple \\S+/Vimma\\.app$",
      ),
    );
    expect(at(/^rcodesign analyze-certificate /)).toBeLessThan(at(/^rcodesign sign /));
    expect(at(/^rcodesign sign /)).toBeLessThan(at(/^rcodesign notary-submit /));
    // python/mozbuild/mozpack/dmg.py, create_dmg on Linux (Firefox 158.0)
    const pack = calls.slice(at(/^rcodesign notary-submit /) + 1);
    expect(pack[0]).toMatch(/^newfs_hfs -v Vimma \S+\.hfs$/);
    expect(pack[1]).toMatch(/^hfsplus \S+\.hfs symlink \/ {2}\/Applications$/);
    expect(pack[2]).toMatch(/^hfsplus \S+\.hfs attr \/ C$/);
    expect(pack[3]).toMatch(/^hfsplus \S+\.hfs addall \S+$/);
    expect(pack[4]).toMatch(/^dmg build \S+\.hfs \S+$/);
    expect(pack).toHaveLength(5);
    // the stapled ticket is inside the app that is packed
    expect(readFileSync(`${log}.packed`, "utf8").trim()).toBe("./Vimma.app/Contents/CodeResources");
    expect(readFileSync(join(dir, "out/Vimma.dmg"), "utf8")).toBe("dmg\n");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("passes the password and the API key as files, never on a command line", () => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir);
    const { status, stdout, stderr } = run(dir, env);
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
    "DMG_TOOLS",
  ])("refuses to run without %s", (name) => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir);
    const { status, stderr } = run(dir, { ...env, [name]: undefined });
    expect(status).not.toBe(0);
    expect(stderr).toContain(name);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses a team ID that is not ten capitals and digits", () => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir);
    const { status, stderr } = run(dir, { ...env, APPLE_TEAM_ID: "abc; rm -rf /" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("APPLE_TEAM_ID");
    expect(existsSync(log)).toBe(false);
  });

  it("refuses an app that is already stapled, so a re-run starts from macos-build's dmg", () => {
    const dir = tempDir("vimma-devid-");
    const { log, env } = stubs(dir, { stapled: true });
    const { status, stderr } = run(dir, env);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/already/);
    expect(readFileSync(log, "utf8")).not.toMatch(/rcodesign sign/);
  });

  it("writes no dmg when signing or notarisation fails, or nothing was stapled", () => {
    for (const options of [{ signFails: true }, { notaryFails: true }, { staples: false }]) {
      const dir = tempDir("vimma-devid-");
      const { log, env } = stubs(dir, options);
      const { status, tmp } = run(dir, env);
      expect(status, JSON.stringify(options)).not.toBe(0);
      expect(readFileSync(log, "utf8")).not.toMatch(/dmg build/);
      expect(existsSync(join(dir, "out/Vimma.dmg"))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    }
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
   *   staple?: number, verify?: number }} [out]
   */
  function check({
    app = SIGNED(),
    nested = SIGNED(),
    spctl = ACCEPTED,
    spctlStatus = 0,
    staple = 0,
    verify = 0,
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
      },
    });
    return { ...result, log: readFileSync(join(dir, "log"), "utf8"), bundle };
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
