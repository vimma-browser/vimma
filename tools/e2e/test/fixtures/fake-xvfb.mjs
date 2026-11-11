#!/usr/bin/env node
// Stands in for Xvfb in the launcher's cancellation tests. Takes Xvfb's `-displayfd N` and
// `-fbdir DIR`, writes DIR/Xvfb_screen0 at once, then after FAKE_XVFB_DELAY_MS (default 0)
// reports display 99 on fd N and stays up. FAKE_XVFB_RECORD names a file where it writes
// { pid, fbdir } first, so a test can check both are gone afterwards.
import { createWriteStream, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const fd = Number(argv[argv.indexOf("-displayfd") + 1]);
const fbdir = argv[argv.indexOf("-fbdir") + 1] ?? "";
if (process.env.FAKE_XVFB_RECORD) {
  // A test waits for the record to exist, then reads it: written in place, it exists empty or
  // half written for a moment. A rename within one directory puts it there whole.
  const record = process.env.FAKE_XVFB_RECORD;
  const partial = `${record}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify({ pid: process.pid, fbdir, argv }));
  renameSync(partial, record);
}
writeFileSync(join(fbdir, "Xvfb_screen0"), "");
setInterval(() => {}, 1000);
setTimeout(
  () => createWriteStream("", { fd }).write("99\n"),
  Number(process.env.FAKE_XVFB_DELAY_MS ?? 0),
);
