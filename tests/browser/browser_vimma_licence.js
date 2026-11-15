/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #16: about:license carries the notice of the third-party code Vimma itself vendors
// (smol-toml, BSD-3-Clause), which clause 2 requires in binary redistributions.

"use strict";

/** The repository, found through `surfer import`'s symlink to this test file. */
function repoDir() {
  const self = getChromeDir(getResolvedURI(gTestPath));
  self.append(gTestPath.split("/").at(-1) ?? "");
  self.normalize();
  return self.parent.parent.parent; // tests/browser/<file>
}

/** @param {string} s */
function squash(s) {
  return s.replace(/\s+/g, " ").trim();
}

add_task(async function about_license_lists_smol_toml_with_its_full_licence() {
  const licence = await IOUtils.readUTF8(
    PathUtils.join(
      repoDir().path,
      "packages",
      "vimma-core",
      "src",
      "vendor",
      "smol-toml",
      "LICENSE",
    ),
  );
  Assert.stringContains(licence, "Copyright (c) Squirrel Chat et al.", "sanity: the LICENSE file");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:license");
  // about:license loads in the parent process (nsAboutRedirector.cpp gives it no
  // URI_MUST_LOAD_IN_CHILD), so the browser has its document; a read through a missing one
  // throws, as it did before.
  const doc = /** @type {Document} */ (tab.linkedBrowser.contentDocument);

  const link = doc.querySelector('a[href="about:license#smol-toml"]');
  Assert.ok(link, "the index links to the smol-toml entry");
  Assert.stringContains(link?.textContent ?? "", "smol-toml", "the index entry is named");

  const anchor = doc.getElementById("smol-toml");
  Assert.ok(anchor, "the smol-toml entry has its anchor");
  // The entry: its heading and what follows it, up to the next rule or heading.
  const heading = anchor?.closest("h1");
  Assert.ok(heading, "the anchor is in the entry's heading");
  const parts = [];
  for (let el = heading?.nextElementSibling; el && !/^(HR|H1)$/.test(el.tagName);) {
    parts.push(el);
    el = el.nextElementSibling;
  }
  const pre = parts.find((el) => el.tagName === "PRE")?.textContent ?? "";
  Assert.equal(squash(pre), squash(licence), "the full BSD-3-Clause text, copyright line included");

  const text = parts.map((el) => el.textContent).join(" ");
  Assert.stringContains(text, "smol-toml 1.9.0", "names the vendored version");
  Assert.stringContains(text, "modified", "says Vimma's copy is modified");
  Assert.stringContains(
    text,
    "chrome://browser/content/vimma/core/vendor/smol-toml/smol-toml.mjs",
    "names the file it applies to",
  );
  BrowserTestUtils.removeTab(tab);
});
