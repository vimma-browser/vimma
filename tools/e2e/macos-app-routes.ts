// The macOS app-routes smoke (docs/specs/app-routes.md, Tests, "macOS smoke"; macos.yml): a
// window-less helper app (tools/package/test/link-opener.swift) opens a link with Vimma through
// NSWorkspace, as Slack or Ghostty do, and the link must open in the workspace of the rule that
// names the helper, both while Vimma runs and when the link starts it. A link opened with
// `open -a` carries no names even when VIMMA_FROM is set in the caller's environment
// (MacApplicationDelegate-mm.patch, R7 in docs/security/02-workspace-routing.md).
//
//   node tools/e2e/macos-app-routes.ts --app <Vimma.app>
//
// It starts Vimma with windows, through LaunchServices, and registers apps in ~/Applications
// (LaunchServices launches nothing from a temporary directory), so it runs only on a CI runner:
// a headless start never receives Apple Events, because it does not run AppKit's event loop
// while it starts (MacApplicationDelegate.mm, InitializeMacApp).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { ControlClient } from "./control-client.ts";
import { createProfile, waitForDiscovery } from "./launcher.ts";
import { startPageServer } from "./pages.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const run = promisify(execFile);

export const OPENER_ID = "dev.vimma.test.link-opener";
export const OPENER_EXE = "link-opener";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * config.toml for every start: the helper's bundle identifier routes `article.html` to `work`,
 * its executable name routes `long.html` to `dev`, and any other link from the page server goes
 * to `admin` by its domain. `home`, which no rule names, is shown at the start.
 * @param base the page server's base URL, with a trailing slash
 */
export function smokeConfig(base: string): string {
  const host = new URL(base).hostname;
  return `schema = 2

[workspaces.home]
[workspaces.work]
[workspaces.dev]
[workspaces.admin]

[[routes]]
app = "${OPENER_ID}"
url = "${base}article.html"
workspace = "work"

[[routes]]
app = "${OPENER_EXE}"
url = "${base}long.html"
workspace = "dev"

[[routes]]
domain = "${host}"
workspace = "admin"
`;
}

/** The helper bundle's Info.plist: no Dock icon, no window. */
export function openerInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${OPENER_ID}</string>
  <key>CFBundleExecutable</key>
  <string>${OPENER_EXE}</string>
  <key>CFBundleName</key>
  <string>Vimma link opener</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/** Throws unless this is a GitHub Actions runner: the smoke opens windows and registers apps. */
export function refuseOutsideCi(env: Record<string, string | undefined>) {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "macos-app-routes runs only on a CI runner: it starts Vimma with windows through " +
        "LaunchServices and registers apps in ~/Applications",
    );
  }
}

type State = { workspace?: string | null; tabs?: Array<{ url?: string }> } | null;

/** Whether `state` shows `workspace` with a tab on `url` in it. */
export function stateShows(state: State, { workspace, url }: { workspace: string; url: string }) {
  return state?.workspace === workspace && (state.tabs ?? []).some((t) => t.url === url);
}

/** Copies Vimma into ~/Applications and builds the helper there; both registered. */
async function install(app: string) {
  const dir = join(homedir(), "Applications");
  mkdirSync(dir, { recursive: true });
  const vimma = join(dir, "Vimma.app");
  const opener = join(dir, "VimmaLinkOpener.app");
  rmSync(vimma, { recursive: true, force: true });
  rmSync(opener, { recursive: true, force: true });
  await run("ditto", [app, vimma]);
  mkdirSync(join(opener, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(opener, "Contents/Info.plist"), openerInfoPlist());
  await run("swiftc", [
    "-O",
    "-o",
    join(opener, "Contents/MacOS", OPENER_EXE),
    join(REPO, "tools/package/test/link-opener.swift"),
  ]);
  // Ad hoc, so the arm64 binary may run; swiftc signs it, but not as part of a bundle.
  await run("codesign", ["--force", "--sign", "-", opener]);
  await run(LSREGISTER, ["-f", vimma]);
  await run(LSREGISTER, ["-f", opener]);
  return {
    vimma,
    opener,
    remove: async () => {
      for (const a of [opener, vimma]) {
        await run(LSREGISTER, ["-u", a]).catch(() => {});
        rmSync(a, { recursive: true, force: true });
      }
    },
  };
}

/** A profile with the control socket on and the smoke's config.toml. */
function profile(root: string, base: string) {
  const dir = createProfile(root);
  mkdirSync(join(dir, "vimma"), { recursive: true });
  writeFileSync(join(dir, "vimma", "config.toml"), smokeConfig(base));
  return dir;
}

/** Has the helper app open `url` with `vimma`, started through LaunchServices; its pid. */
async function openWithHelper(
  apps: { vimma: string; opener: string },
  root: string,
  url: string,
  vimmaArgs: string[] = [],
) {
  const out = join(mkdtempSync(join(root, "opener-")), "result");
  // -n: the previous helper may still run (it stays for the receiver's look-up); without it,
  // LaunchServices only activates that one and drops these arguments.
  await run("open", ["-n", "-a", apps.opener, "--args", apps.vimma, url, out, ...vimmaArgs]);
  const deadline = Date.now() + 60_000;
  while (!existsSync(out)) {
    if (Date.now() > deadline) throw new Error(`the link opener wrote no result for ${url}`);
    await sleep(250);
  }
  const line = readFileSync(out, "utf8").trim();
  console.log(`link opener: ${line}`);
  if (!line.startsWith("opened ")) throw new Error(`the link opener failed: ${line}`);
}

/** Waits for `state` to show `workspace` with `url`'s tab; the last state on failure. */
async function expectShown(
  client: ControlClient,
  what: { workspace: string; url: string },
  label: string,
) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await client.call("state", {});
    const state: State = r?.ok ? r.result : null;
    if (stateShows(state, what)) {
      console.log(`ok: ${label}: ${what.url} opened in ${what.workspace}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: want ${what.url} in ${what.workspace}, last state: ${JSON.stringify(state)}`,
      );
    }
    await sleep(500);
  }
}

/** Connects to the Vimma that owns `dir`'s control socket. */
async function connect(dir: string) {
  const discovery = await waitForDiscovery(dir, { timeoutMs: 120_000, intervalMs: 250 });
  const client = await ControlClient.connect({ ...discovery, role: "full" });
  return { client, pid: discovery.pid };
}

/** Quits the Vimma at `pid` and waits until it has exited. */
async function quit({ client, pid }: { client: ControlClient; pid: number }) {
  client.close();
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  while (alive()) {
    if (Date.now() > deadline) {
      process.kill(pid, "SIGKILL");
      break;
    }
    await sleep(250);
  }
}

async function main() {
  refuseOutsideCi(process.env);
  const { values } = parseArgs({ options: { app: { type: "string" } } });
  if (!values.app) throw new Error("usage: macos-app-routes.ts --app <Vimma.app>");
  const root = mkdtempSync(join(tmpdir(), "vimma-app-routes-"));
  const pages = await startPageServer(join(REPO, "tests/e2e/fixtures"));
  const apps = await install(values.app);
  const article = `${pages.base}article.html`;
  const long = `${pages.base}long.html`;
  const failures: string[] = [];
  const check = async (label: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (e) {
      console.log(`FAIL: ${(e as Error).message}`);
      failures.push(label);
    }
  };
  try {
    await check("running", async () => {
      const dir = profile(root, pages.base);
      await run("open", ["-a", apps.vimma, "--args", "--profile", dir]);
      const vimma = await connect(dir);
      try {
        await openWithHelper(apps, root, article);
        await expectShown(vimma.client, { workspace: "work", url: article }, "running, bundle id");
        await openWithHelper(apps, root, long);
        await expectShown(vimma.client, { workspace: "dev", url: long }, "running, executable");
      } finally {
        await quit(vimma);
      }
    });
    await check("cold start", async () => {
      const dir = profile(root, pages.base);
      await openWithHelper(apps, root, article, ["--profile", dir]);
      const vimma = await connect(dir);
      try {
        await expectShown(vimma.client, { workspace: "work", url: article }, "cold start");
      } finally {
        await quit(vimma);
      }
    });
    await check("inherited VIMMA_FROM", async () => {
      const dir = profile(root, pages.base);
      await run("open", [
        "--env",
        `VIMMA_FROM=${OPENER_ID}`,
        "-a",
        apps.vimma,
        article,
        "--args",
        "--profile",
        dir,
      ]);
      const vimma = await connect(dir);
      try {
        await expectShown(vimma.client, { workspace: "admin", url: article }, "inherited");
      } finally {
        await quit(vimma);
      }
    });
  } finally {
    await apps.remove();
    await pages.close();
    rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
