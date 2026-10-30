// docs/security.md: rules about what Vimma's chrome code never does, checked over its source.
// Chrome code runs with full privileges, so these hold for every file, not one feature: a
// string that reaches the DOM as HTML, code built from text, a process started or an add-on
// installed would each turn a page title, a config value or a clipboard into an attack.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHROME = join(ROOT, "src/browser/base/content/vimma");
/** The agent CLI runner, C2's third exception. */
const CLI = "src/browser/base/content/vimma/agent/AgentCli.sys.mjs";

/** Our chrome sources; core/ is a copy of packages/vimma-core/src (npm run sync-core). */
function sources() {
  /** @type {{ path: string, text: string }[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (relative(CHROME, p) !== "core") walk(p);
      } else if (/\.(m?js|html)$/.test(e.name)) {
        out.push({ path: relative(ROOT, p), text: readFileSync(p, "utf8") });
      }
    }
  };
  walk(CHROME);
  walk(join(ROOT, "packages/vimma-core/src"));
  return out;
}

/** "path:line: text" for every line of our sources that matches `re`. */
function hits(/** @type {RegExp} */ re) {
  return sources().flatMap(({ path, text }) =>
    text
      .split("\n")
      .flatMap((line, i) => (re.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  );
}

describe("chrome code", () => {
  test("sanity: the scan sees our sources", () => {
    const paths = sources().map((s) => s.path);
    expect(paths).toContain("src/browser/base/content/vimma/ui/picker.mjs");
    expect(paths).toContain("src/browser/base/content/vimma/ctl/VimmaControl.sys.mjs");
  });

  test("never parses strings as HTML: page titles, add-on and bookmark names stay text", () => {
    expect(
      hits(
        /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|createContextualFragment|parseFromString|\.setHTML(Unsafe)?\(|document\.write/,
      ),
    ).toEqual([]);
  });

  test("never builds code from text: no eval, Function or sandbox evaluation", () => {
    expect(hits(/\beval\(|new Function\b|\bFunction\(|evalInSandbox|loadSubScript/)).toEqual([]);
  });

  // C2's one exception (docs/specs/vimma-mcp.md decisions 31 g, 43-45; security.md M13): an
  // agent download is scanned with the system's clamscan, or clamdscan when clamd can be used.
  // One file, one call, fixed program lists, arguments only from the three fixed builders with
  // the path after `--`, no shell, no PATH search, and no other way to reach Subprocess.
  test("never starts a process, but ClamAV, an AppImage's restart and an agent CLI", () => {
    const CLAM = "src/browser/base/content/vimma/ctl/AgentDownloads.sys.mjs";
    const RESTART = "src/browser/base/content/vimma/host/restart.mjs";
    const all = hits(/Subprocess|nsIProcess|@mozilla\.org\/process\/|\.launch\(\)|\.reveal\(\)/);
    expect(
      all.filter(
        (h) =>
          !h.startsWith(`${CLAM}:`) && !h.startsWith(`${RESTART}:`) && !h.startsWith(`${CLI}:`),
      ),
    ).toEqual([]);
    const text = readFileSync(join(ROOT, CLAM), "utf8");
    // Every mention: the lazy getter's name and module, and one call.
    expect(text.match(/Subprocess\b/g)).toHaveLength(3);
    expect(text).toContain('  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",');
    expect(text.match(/Subprocess\.call\(/g)).toHaveLength(1);
    expect(text).toMatch(
      /lazy\.Subprocess\.call\(\{\s*command: program,\s*arguments: args,\s*stderr: "pipe",?\s*\}\)/,
    );
    // runProgram is the call's only way in: each caller passes a found scanner and a builder's
    // fixed arguments.
    expect([...text.matchAll(/runProgram\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0])).toEqual([
      "runProgram(program, args)",
      "runProgram(program, args)",
      "runProgram(clamd.path, clamdArguments(clamd.conf, path))",
      "runProgram(clam, clamArguments(path))",
    ]);
    expect(text.match(/definitionsProblem\((?:[^()]|\([^()]*\))*\)/g)).toEqual([
      "definitionsProblem(program, args)",
      "definitionsProblem(clamd.path, clamVersionArguments(clamd.conf))",
      "definitionsProblem(clam, clamVersionArguments())",
    ]);
    expect(text).toContain(
      'const CLAM_PATHS = Object.freeze(["/usr/bin/clamscan", "/usr/local/bin/clamscan"]);',
    );
    expect(text).toContain(
      'const CLAMD_PATHS = Object.freeze(["/usr/bin/clamdscan", "/usr/local/bin/clamdscan"]);',
    );
    expect(text).toContain('const CLAMD_CONF = "/etc/clamav/clamd.conf";');
    // No PATH search, no aliasing, no bracket access, no shell.
    expect(text).not.toMatch(
      /pathSearch|Subprocess\s*\[|=\s*(lazy\.)?Subprocess\b|\}\s*=\s*lazy\b/,
    );
    expect(text).not.toMatch(/lazy\s*\[|nsIProcess|\/bin\/sh|"sh"|"-c"/);
    // clamArguments: fixed, with the path last, after `--`.
    const core = readFileSync(join(ROOT, "packages/vimma-core/src/agent-downloads.mjs"), "utf8");
    expect(core).toMatch(/"--alert-exceeds-max=yes",\s*"--",\s*path,\s*\]/);
    expect(core).toContain(
      'return [`--config-file=${configFile}`, "--fdpass", "--no-summary", "--stdout", "--", path];',
    );
    expect(core).toContain(
      'return configFile ? [`--config-file=${configFile}`, "--version"] : ["--version"];',
    );
  });

  // C2's third exception (docs/specs/builtin-agent-cli.md C2, C4): an agent CLI the user picked
  // in setup, from its confirmed path only, with arguments from the fixed builders, the task on
  // stdin, and no shell. Two calls: the run and `--version`; the PATH search only in `find`.
  test("starts an agent CLI only from its checked path, with fixed arguments and no shell", () => {
    const text = readFileSync(join(ROOT, CLI), "utf8");
    expect(text.match(/Subprocess\.call\(/g)).toHaveLength(2);
    expect(text).toMatch(
      /lazy\.Subprocess\.call\(\{\s*command: checked\.path,\s*arguments: cli\.args\(\{ mcpConfig: file, model: o\.provider\.model \}\),\s*environment: cliEnvironment\(lazy\.Subprocess\.getEnvironment\(\)\),\s*workdir: dir,\s*stderr: "pipe",\s*\}\)/,
    );
    expect(text).toMatch(
      /lazy\.Subprocess\.call\(\{\s*command: r\.path,\s*arguments: \[\.\.\.cli\.versionArgs\],\s*environment: cliEnvironment\(lazy\.Subprocess\.getEnvironment\(\)\),\s*workdir: await runBase\(\),\s*stderr: "pipe",\s*\}\)/,
    );
    // `version` runs only a path `inspect` passed, checked inside it whoever calls it, and only
    // while agent CLIs are on; the run only `checked`, inspect's result.
    expect(text).toMatch(
      /async version\(path, id = CLI_IDS\[0\] \?\? ""\) \{\s*const cli = CLIS\[id\];\s*if \(!this\.enabled \|\| !cli\) return null;\s*const r = await inspect\(path\);\s*if \("problem" in r\) return null;/,
    );
    expect(text).toContain("const checked = await inspect(path);");
    expect(text).toContain("const version = await this.version(r.path, cli.id);");
    // The CLI is a CLIS entry, never a value of config.toml's (C2): its arguments, input and
    // version arguments come from that entry's fixed builders.
    expect(text).toContain('const cli = CLIS[o.provider.cli ?? ""];');
    expect(text.match(/pathSearch\(/g)).toEqual(["pathSearch("]);
    expect(text).toContain("found = await lazy.Subprocess.pathSearch(cli.bin);");
    // No aliasing, no bracket access, no shell, and the task never an argument.
    expect(text).not.toMatch(/Subprocess\s*\[|=\s*(lazy\.)?Subprocess\b|\}\s*=\s*lazy\b/);
    expect(text).not.toMatch(/lazy\s*\[|nsIProcess|\/bin\/sh|"sh"|"-c"/);
    expect(text).toContain("await proc.stdin.write(cli.input(taskPrompt(o.messages, o.text)));");
    const core = readFileSync(join(ROOT, "packages/vimma-core/src/agent-cli.mjs"), "utf8");
    expect(core).toContain('versionArgs: Object.freeze(["--version"]),');
    expect(core).toContain(
      "args: (/** @type {{ mcpConfig: string, model: string }} */ o) => claudeArguments(o),",
    );
    expect(core).toContain("input: (/** @type {string} */ text) => userLine(text),");
    expect(core).toMatch(
      /"--permission-mode",\s*"dontAsk",\s*\.\.\.\(model \? \["--model", model\] : \[\]\),/,
    );
  });

  // C2's second exception (docs/specs/m6a-updater.md §5; security.md C2, UP10): an AppImage's
  // `:restart` starts /bin/sh with one fixed script that waits for Vimma to exit and then runs
  // `$APPIMAGE`. One call site, the program and arguments only from relaunchCommand, the pid and
  // the path as positional arguments that the script never reads as shell text.
  test("restarts an AppImage through one fixed script, with its path never shell text", () => {
    const RESTART = "src/browser/base/content/vimma/host/restart.mjs";
    const text = readFileSync(join(ROOT, RESTART), "utf8");
    expect(text).not.toMatch(/Subprocess|\.launch\(\)|\.reveal\(\)|\brun(Async)?\(|\brunwAsync\(/);
    expect(text.match(/@mozilla\.org\/process\/util;1/g)).toHaveLength(1);
    expect(text.match(/nsIProcess/g)).toHaveLength(1);
    expect(text.match(/\.runw\(/g)).toEqual([".runw("]);
    expect(text).toContain("proc.runw(false, args, args.length);");
    expect(text).toContain("proc.noShell = true;");
    // The process is the program relaunchCommand names, and nothing else.
    expect(text.match(/initWithPath\(/g)).toHaveLength(2);
    expect(text).toContain("  file.initWithPath(program);\n");
    expect(text).toContain("  proc.init(file);\n");
    // Started only from quit-application (the observer) and the automation-only test hook.
    expect(text.match(/\bstartRelaunch\(/g)).toHaveLength(3);
    expect(text).toContain("const observer = () => startRelaunch();");
    expect(text).toMatch(
      /if \(!inAutomation\(\)\) throw new Error\("test-only"\);\s*startRelaunch\(\);/,
    );
    // runDetached is reached only through `spawn`, whose one call is relaunchCommand's output.
    expect(text.match(/runDetached\b/g)).toHaveLength(3);
    expect(text.match(/\bspawn\(/g)).toEqual(["spawn("]);
    expect(text).toMatch(
      /const \{ program, args \} = relaunchCommand\(\{\s*pid: Services\.appinfo\.processID,\s*appImage: path,\s*\}\);\s*spawn\(program, args\);/,
    );
    const core = readFileSync(join(ROOT, "packages/vimma-core/src/restart.mjs"), "utf8");
    expect(core).toContain('program: "/bin/sh",');
    expect(core).toContain(
      'args: ["-c", RELAUNCH_SCRIPT, "vimma-restart", String(pid), appImage],',
    );
    // The script: quoted positional parameters only, no eval, and `$2` run with no arguments.
    const start = core.indexOf("export const RELAUNCH_SCRIPT");
    const script = core.slice(start, core.indexOf(";\n\n", start));
    expect(script).not.toMatch(/\beval\b|\$\{|\$[3-9@*]|\$\(\s*[a-z]|`/);
    expect(script).toContain(`'exec "$2"'`);
  });

  // js-ctypes reaches any native function. Its one use is a file's owner and mode (clamd's
  // socket, M13, and an agent CLI's path checks, M55), read with statx(2) on Linux and
  // lstat(2) on macOS (security.md C2): nothing else may load a
  // library or declare a function. lstat's symbol is named in one table, by architecture, and
  // libSystem by its absolute path, since dyld searches the working directory for a bare name.
  test("never calls native code, but statx or lstat for a file's owner and mode", () => {
    const CLAM = "src/browser/base/content/vimma/ctl/AgentDownloads.sys.mjs";
    const all = hits(/ctypes/);
    expect(all.filter((h) => !h.startsWith(`${CLAM}:`))).toEqual([]);
    const text = readFileSync(join(ROOT, CLAM), "utf8");
    expect(text.match(/ctypes\.open\([^)]*\)/g)).toEqual([
      'ctypes.open("libc.so.6")',
      'ctypes.open("/usr/lib/libSystem.B.dylib")',
    ]);
    expect(text.match(/\.declare\(\s*"?[\w$]*/g)).toEqual([
      '.declare(\n      "statx',
      ".declare(symbol",
    ]);
    expect(text).toContain('const LSTAT = { aarch64: "lstat", x86_64: "lstat$INODE64" };');
    expect(text.match(/const symbol = [^;]*;/g)).toEqual([
      "const symbol = LSTAT[/** @type {keyof typeof LSTAT} */ (arch)];",
    ]);
  });

  // Only the setup page's summary installs, through Firefox's AMO path (security.md A1).
  test("installs an add-on only from the setup page", () => {
    const SETUP = "src/browser/base/content/vimma/setup/SetupHost.sys.mjs";
    const all = hits(
      /getInstallForURL|getInstallForFile|installAddonFromWebpage|installAddonFromAOM|installTemporaryAddon|installBuiltinAddon|\.install\(\)/,
    );
    expect(all.filter((h) => !h.startsWith(`${SETUP}:`))).toEqual([]);
    const text = readFileSync(join(ROOT, SETUP), "utf8");
    expect(text.match(/getInstallForURL|installAddonFrom\w+/g)).toEqual([
      "getInstallForURL",
      "installAddonFromAOM",
    ]);
  });
});
