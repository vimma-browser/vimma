/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Temporary: screenshots of the find prompt (#685) in the stock and an Omarchy theme. Removed
// before merge. It fails on purpose at the end so CI uploads e2e-output/ with the PNGs.

/* global focusContent -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_find.html";
const XHTML = "http://www.w3.org/1999/xhtml";

// tests/contract/theme/event-horizon.colors.toml
const EVENT_HORIZON = `accent = "#26bbd9"
active_border_color = "#3fc4de"
active_tab_background = "#26bbd9"
cursor = "#fadad1"
foreground = "#fadad1"
background = "#1c1e26"
selection_foreground = "#1c1e26"
selection_background = "#26bbd9"
color0 = "#1c1e26"
color1 = "#e95678"
color2 = "#29d398"
color3 = "#fab795"
color4 = "#26bbd9"
color5 = "#ee64ac"
color6 = "#59e3e3"
color7 = "#fadad1"
color8 = "#6c6f93"
color9 = "#ec6a88"
color10 = "#3fdaa4"
color11 = "#fbc3a7"
color12 = "#3fc4de"
color13 = "#f075b5"
color14 = "#6be4e6"
color15 = "#fadad1"
`;

const outDirs = [];
for (const name of ["MOZ_UPLOAD_DIR", "GITHUB_WORKSPACE"]) {
  const v = Services.env.get(name);
  if (v) outDirs.push(name === "GITHUB_WORKSPACE" ? PathUtils.join(v, "e2e-output") : v);
}

async function shot(name) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const w = window.innerWidth;
  const h = window.innerHeight;
  const bitmap = await window.browsingContext.currentWindowGlobal.drawSnapshot(
    new DOMRect(0, 0, w, h),
    1,
    "rgb(255, 0, 255)",
  );
  const canvas = /** @type {HTMLCanvasElement} */ (document.createElementNS(XHTML, "canvas"));
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const data = canvas.toDataURL("image/png").split(",")[1];
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const file = `issue-685-${name}.png`;
  for (const dir of outDirs) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    await IOUtils.write(PathUtils.join(dir, file), bytes);
    info(`wrote ${PathUtils.join(dir, file)}`);
  }
  if (!outDirs.length) info(`no upload dir for ${file}`);
}

function type(text) {
  for (const ch of text) EventUtils.synthesizeKey(ch);
}

async function openFindBar() {
  let findbar = null;
  await TestUtils.waitForCondition(() => {
    findbar = gBrowser.getCachedFindBar();
    return findbar && !findbar.hidden && findbar.getBoundingClientRect().height > 0;
  }, "the find bar is open");
  return findbar;
}

async function shots(theme) {
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await focusContent(browser);
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");

    EventUtils.synthesizeKey("/");
    const findbar = await openFindBar();
    await shot(`${theme}-1-empty`);

    type("word");
    await TestUtils.waitForCondition(
      () => findbar.querySelector(".vimma-find-count")?.textContent === "[1/4]",
      "[1/4]",
    );
    await shot(`${theme}-2-matches`);

    EventUtils.synthesizeMouseAtCenter(browser, {});
    await TestUtils.waitForCondition(() => document.activeElement === browser, "page focused");
    Assert.ok(!findbar.hidden, "still open after a click");
    await shot(`${theme}-4-after-click`);

    EventUtils.synthesizeKey("/");
    await TestUtils.waitForCondition(() => document.activeElement === findbar._findField, "back");
    type("zzzqqq");
    await TestUtils.waitForCondition(
      () => findbar._findField.getAttribute("status") === "notfound",
      "not found",
    );
    await shot(`${theme}-3-notfound`);
    findbar.close(true);

    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("g");
    await TestUtils.waitForCondition(() => document.getElementById("vimma-picker")?.open, "picker");
    await shot(`${theme}-5-picker-for-comparison`);
    EventUtils.synthesizeKey("KEY_Escape");
  });
}

add_task(async function find_prompt_screenshots() {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await shots("stock");

  const dir = PathUtils.join(PathUtils.tempDir, `vimma-685-omarchy-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  await IOUtils.writeUTF8(PathUtils.join(dir, "colors.toml"), EVENT_HORIZON);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", dir],
    ],
  });
  await TestUtils.waitForCondition(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--vimma-bg").trim() ===
      "#1c1e26",
    "the Omarchy theme applies",
  );
  await shots("omarchy");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();

  Assert.ok(false, "temporary: fail on purpose so CI uploads e2e-output/");
});
