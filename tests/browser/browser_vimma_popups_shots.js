/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Temporary: screenshots of the pop-up bar's cue and the :popups picker, in the stock and an
// Omarchy theme, saved to MOZ_UPLOAD_DIR for review (docs/specs/popup-blocked.md).

"use strict";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const BLOCKING = ROOT + "file_vimma_popups.html";
const CUE = "pop-up blocked · y allow · n block · Esc close";
const UNDO_CUE = "pop-ups blocked · :popups to allow";
const themeDir = PathUtils.join(PathUtils.tempDir, `vimma-popup-shots-${Date.now()}`);
const outDir = Services.env.get("MOZ_UPLOAD_DIR") || PathUtils.tempDir;

/** tests/contract/theme/tokyo-night.colors.toml */
const TOKYO_NIGHT = `mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"
foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"
red = "#f7768e"
yellow = "#e0af68"
orange = "#eb927b"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
brown = "#75493d"
bright_red = "#ff7a93"
bright_yellow = "#ff9e64"
bright_green = "#b9f27c"
bright_cyan = "#0db9d7"
bright_blue = "#7da6ff"
bright_magenta = "#bb9af7"
`;

const cueEl = () => document.querySelector('#vimma-statusbar [data-segment="popups"]');
const cue = () => cueEl()?.textContent ?? null;
const picker = () => document.getElementById("vimma-popup-picker");
const bar = () =>
  gBrowser
    .readNotificationBox(gBrowser.selectedBrowser)
    ?.getNotificationWithValue("popup-blocked") ?? null;
const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const until = (/** @type {() => boolean} */ cond, /** @type {string} */ msg) =>
  TestUtils.waitForCondition(cond, msg, 50, 200);
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} name */
async function shot(name) {
  await wait(300);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const w = window.innerWidth;
  const h = window.innerHeight;
  const bitmap = await window.browsingContext.currentWindowGlobal.drawSnapshot(
    new DOMRect(0, 0, w, h),
    1,
    "white",
  );
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const path = PathUtils.join(outDir, `popups-${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  const el = cueEl();
  const style = el && getComputedStyle(el);
  info(
    `shot ${path}: cue=${JSON.stringify(cue())} color=${style?.color} bg=${style?.backgroundColor}` +
      ` font=${style?.fontFamily} ${style?.fontSize} clipped=${el ? el.scrollWidth > el.clientWidth : "-"}`,
  );
  Assert.ok(await IOUtils.exists(path), `saved ${name}`);
}

/** @param {string} theme */
async function shots(theme) {
  const tab = BrowserTestUtils.addTab(gBrowser, BLOCKING);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await until(() => !!bar(), "the bar");
  await until(() => cue() === CUE, "armed");
  await shot(`${theme}-1-bar-armed`);

  EventUtils.synthesizeKey("n");
  await until(() => !bar() && cue() === UNDO_CUE, "after n");
  await shot(`${theme}-2-after-n`);

  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("popups");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => !!picker()?.open && picker().querySelectorAll("[role=option]").length > 0,
    "picker",
  );
  await shot(`${theme}-3-picker`);
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !picker()?.open, "picker closed");

  Services.perms.removeFromPrincipal(tab.linkedBrowser.contentPrincipal, "popup");
  BrowserTestUtils.removeTab(tab);
}

add_task(async function popup_shots() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.disable_open_during_load", true],
      ["privacy.popups.showBrowserMessage", true],
      ["browser.tabs.loadDivertedInBackground", true],
      ["security.notification_enable_delay", 400],
      ["vimma.theme.pollMs", 100],
    ],
  });
  await IOUtils.makeDirectory(outDir, { createAncestors: true });
  registerCleanupFunction(async () => {
    await IOUtils.remove(themeDir, { recursive: true, ignoreAbsent: true });
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  });

  await shots("stock");

  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), TOKYO_NIGHT);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", themeDir],
    ],
  });
  await until(() => token("--vimma-bg") === "#1a1b26", "the Omarchy theme applies");
  await shots("omarchy");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});
