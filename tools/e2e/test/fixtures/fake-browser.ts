#!/usr/bin/env node
// Stands in for the Vimma binary in the launcher's tests. It takes the same `-profile DIR`
// argument, records its argv and environment, and behaves as FAKE_BROWSER says:
//   serve (default)  start the fake control server after FAKE_BROWSER_DELAY_MS
//   never            run without ever writing the discovery file (control socket off)
//   exit             write to stderr and exit with code 7 at once
// FAKE_BROWSER_STDERR is written to stderr at start, FAKE_BROWSER_LATE_STDERR after
// FAKE_BROWSER_LATE_STDERR_MS (a startup phase that stalls, issue #901). FAKE_BROWSER_CHILD=1 also starts a
// long-lived child (like a content process) and writes its pid to <profile>/grandchild.pid.
// FAKE_BROWSER_IGNORE_TERM=1 ignores SIGTERM.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeServer } from "../fake-server.ts";

const argv = process.argv.slice(2);
const profile = argv[argv.indexOf("-profile") + 1];
if (!profile) {
  process.stderr.write("fake browser: no -profile\n");
  process.exit(2);
}
const mode = process.env.FAKE_BROWSER ?? "serve";
writeFileSync(
  join(profile, "fake-browser.json"),
  JSON.stringify({
    argv,
    home: process.env.HOME,
    tmp: process.env.TMPDIR,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        /^(DISPLAY|XUL_APP_FILE|GDK_|QT_|MOZ_|WAYLAND_DISPLAY|PATH$|XDG_RUNTIME_DIR|FONTCONFIG_)/.test(
          k,
        ),
      ),
    ),
  }),
);
process.stderr.write(`fake browser starting (${mode})\n`);
if (process.env.FAKE_BROWSER_STDERR) process.stderr.write(`${process.env.FAKE_BROWSER_STDERR}\n`);
if (process.env.FAKE_BROWSER_LATE_STDERR) {
  const late = process.env.FAKE_BROWSER_LATE_STDERR;
  setTimeout(
    () => process.stderr.write(`${late}\n`),
    Number(process.env.FAKE_BROWSER_LATE_STDERR_MS ?? 0),
  );
}
if (process.env.FAKE_BROWSER_IGNORE_TERM) process.on("SIGTERM", () => {});

if (process.env.FAKE_BROWSER_CHILD) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(join(profile, "grandchild.pid"), String(child.pid));
}

if (mode === "exit") {
  process.stderr.write("fake browser: crashed on purpose\n");
  process.exit(7);
}
setInterval(() => {}, 1000);
if (mode === "serve") {
  const delay = Number(process.env.FAKE_BROWSER_DELAY_MS ?? 0);
  setTimeout(() => startFakeServer(profile), delay);
}
