/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarks-file.md, Delivery slice 3: with `[bookmarks] write_back = "all"`
// (the default), a change made outside Vimma's keys in a mirrored folder (the Library, Sync, an
// import) is written to bookmarks.toml a burst later, as one edit that keeps comments; a large
// removal asks first and `n` puts the bookmarks back; a guid Sync's dedupe changes keeps the item
// mirrored; when both sides changed one bookmark the file wins, and three put-backs in ten
// minutes pause the table; a private window's change is not written. Also #1347: a move out of
// the file never loses its bookmark when the file or the base cannot follow.

"use strict";

/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global PlacesObservers, PlacesBookmarkGuid -- chrome-only Places WebIDL in a browser window */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);

const { toolbarGuid, menuGuid, unfiledGuid } = PlacesUtils.bookmarks;
const SYNC = PlacesUtils.bookmarks.SOURCES.SYNC;
const dir = PathUtils.join(PathUtils.tempDir, `vimma-bookmarks-outside-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");
const bookmarksFile = PathUtils.join(dir, "bookmarks.toml");
const mirror = ConfigHost.bookmarksFile;

/**
 * @typedef {{ guid: string, typeCode?: number, title?: string, uri?: string,
 *   children?: Node[] }} Node
 */

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/** The top-level toolbar folder titled `name`, or null. */
async function topFolder(/** @type {string} */ name) {
  const bar = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(toolbarGuid));
  return (bar.children ?? []).find((c) => c.typeCode === 2 && c.title === name) ?? null;
}

/** @param {Node | null | undefined} node @returns {unknown[]} */
function contents(node) {
  return (node?.children ?? []).map((c) =>
    c.typeCode === 3
      ? "---"
      : c.typeCode === 2
        ? { [`${c.title}/`]: contents(c) }
        : `${c.title} ${c.uri}`,
  );
}

/** @param {string} name */
async function folderContents(name) {
  const f = await topFolder(name);
  return f ? contents(await PlacesUtils.promiseBookmarksTree(f.guid)) : null;
}

/** @param {string} name @param {unknown[]} expected @param {string} msg */
async function untilFolder(name, expected, msg) {
  const want = JSON.stringify(expected);
  let last = "";
  await until(async () => {
    last = JSON.stringify(await folderContents(name));
    return last === want;
  }, msg).catch((e) => {
    Assert.equal(last, want, msg);
    throw e;
  });
  Assert.ok(true, msg);
}

/** Waits until bookmarks.toml reads `text`. */
async function untilText(/** @type {string} */ text, /** @type {string} */ msg) {
  let last = "";
  await until(async () => {
    last = await IOUtils.readUTF8(bookmarksFile);
    return last === text;
  }, msg).catch((e) => {
    Assert.equal(last, text, msg);
    throw e;
  });
  Assert.ok(true, msg);
}

/** The guid of the bookmark of `url`. */
async function guidOf(/** @type {string} */ url) {
  return /** @type {string} */ ((await PlacesUtils.bookmarks.fetch({ url }))?.guid);
}

const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const promptEl = () => document.getElementById("vimma-rename");
const promptOpen = () => !!promptEl() && !(/** @type {HTMLElement} */ (promptEl()).hidden);
const promptText = () =>
  promptEl()?.querySelector(".vimma-cmdline-prompt")?.textContent?.trim() ?? "";
const errorSegment = () =>
  document.getElementById("vimma-statusbar")?.querySelector('[data-segment="error"]')
    ?.textContent ?? "";

/** Answers the mirror's question with `key`, after the moment it ignores keys for. */
async function answer(/** @type {string} */ key) {
  await new Promise((r) => setTimeout(r, 1200));
  EventUtils.synthesizeKey(key);
}

/**
 * Until everything a change started has run: no burst or settle waiting, the file read once
 * more (a forced run, which changes nothing that is already in agreement), and the queue idle.
 */
async function quiet() {
  const idle = () => mirror.burstTimer === null && mirror.settleTimer === null;
  await until(idle, "no burst or settle waiting");
  await mirror.tick(true);
  await mirror.settledRuns();
  await until(idle, "and none after the run");
  await mirror.settledRuns();
}

/** Writes config.toml with `write_back` (none: the default) and reads it. */
async function setWriteBack(/** @type {string | null} */ value) {
  await IOUtils.writeUTF8(
    configFile,
    value ? `schema = 2\n[bookmarks]\nwrite_back = "${value}"\n` : "schema = 2\n",
  );
  await ConfigHost.reload();
}

/** Removes every bookmark these tests made and drops the mirror's base. */
async function reset() {
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  await mirror.forget();
  await IOUtils.remove(bookmarksFile, { ignoreAbsent: true });
  await setWriteBack(null);
  await mirror.forget();
  for (const parent of [toolbarGuid, menuGuid, unfiledGuid]) {
    const tree = /** @type {Node} */ (await PlacesUtils.promiseBookmarksTree(parent));
    for (const c of tree.children ?? []) await PlacesUtils.bookmarks.remove(c.guid);
  }
  await mirror.settledRuns();
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
}

/** Counts the mirror's file writes while `fn` runs and what it starts settles. */
async function countWrites(/** @type {() => Promise<void>} */ fn) {
  const original = /** @type {NonNullable<typeof mirror.writeFile>} */ (mirror.writeFile);
  let n = 0;
  /** @type {typeof original} */
  const counted = async (path, compute) => {
    const r = await original(path, compute);
    if (!("error" in r) && r.text !== null) n++;
    return r;
  };
  mirror.writeFile = counted;
  try {
    await fn();
    await quiet();
  } finally {
    mirror.writeFile = original;
  }
  return n;
}

requestLongerTimeout(4);

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", configFile],
      ["vimma.config.pollMs", 100],
      ["vimma.bookmarks.settleMs", 50],
      ["vimma.bookmarks.burstMs", 200],
      ["vimma.feature.bookmarksFile", true],
    ],
  });
  registerCleanupFunction(async () => {
    await reset();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await reset();
});

const FILE = [
  "# my links",
  "[bookmarks.work]",
  '"docs/Guide" = "https://vimma.dev/docs"  # the guide',
  '"docs/Source" = "https://searchfox.org"',
  "",
  "# daily",
  '"Calendar" = "https://calendar.example.com/"',
  '"Mail" = "https://mail.example.com/"',
  "",
].join("\n");

const LOADED = [
  { "docs/": ["Guide https://vimma.dev/docs", "Source https://searchfox.org/"] },
  "Calendar https://calendar.example.com/",
  "Mail https://mail.example.com/",
];

add_task(async function write_back_all_is_the_default_and_writes_a_library_change_after_a_burst() {
  Assert.equal(ConfigHost.config?.bookmarks.writeBack, "all", "the default");
  await IOUtils.writeUTF8(bookmarksFile, FILE);
  await untilFolder("work", LOADED, "loaded");
  const docs = /** @type {string} */ (
    (await PlacesUtils.bookmarks.fetch({ parentGuid: (await topFolder("work"))?.guid, index: 0 }))
      ?.guid
  );
  // The Library: an add, a new title, a new URL and a removal, as one burst.
  const writes = await countWrites(async () => {
    await PlacesUtils.bookmarks.insert({
      parentGuid: docs,
      url: "https://lib.example/",
      title: "Library add",
    });
    await PlacesUtils.bookmarks.update({
      guid: await guidOf("https://calendar.example.com/"),
      title: "Agenda",
    });
    await PlacesUtils.bookmarks.update({
      guid: await guidOf("https://mail.example.com/"),
      url: "https://mail.example.com/inbox",
    });
    await PlacesUtils.bookmarks.remove(await guidOf("https://searchfox.org/"));
    await untilText(
      [
        "# my links",
        "[bookmarks.work]",
        '"docs/Guide" = "https://vimma.dev/docs"  # the guide',
        '"docs/Library add" = "https://lib.example/"',
        "",
        "# daily",
        '"Agenda" = "https://calendar.example.com/"',
        '"Mail" = "https://mail.example.com/inbox"',
        "",
      ].join("\n"),
      "written to the file, every comment kept",
    );
  });
  Assert.equal(writes, 1, "one edit for the burst");
  await untilFolder(
    "work",
    [
      { "docs/": ["Guide https://vimma.dev/docs", "Library add https://lib.example/"] },
      "Agenda https://calendar.example.com/",
      "Mail https://mail.example.com/inbox",
    ],
    "and nothing put back",
  );
  const stat = await IOUtils.stat(bookmarksFile);
  await quiet();
  Assert.equal((await IOUtils.stat(bookmarksFile)).lastModified, stat.lastModified, "no 2nd write");
  await reset();
});

add_task(async function write_back_vimma_and_none_put_a_library_change_back() {
  for (const value of ["vimma", "none"]) {
    await setWriteBack(value);
    await IOUtils.writeUTF8(bookmarksFile, FILE);
    await untilFolder("work", LOADED, `${value}: loaded`);
    await PlacesUtils.bookmarks.update({
      guid: await guidOf("https://calendar.example.com/"),
      title: "Agenda",
    });
    await untilFolder("work", LOADED, `${value}: put back`);
    await until(
      () => noticeText().includes(`put back (write_back = "${value}")`),
      `${value}: said`,
    );
    Assert.equal(await IOUtils.readUTF8(bookmarksFile), FILE, `${value}: the file as it was`);
    await reset();
  }
});

add_task(async function a_sync_source_burst_is_one_file_edit() {
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"a" = "https://example.com/a"\n');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  const work = /** @type {Node} */ (await topFolder("work")).guid;
  const writes = await countWrites(async () => {
    await PlacesUtils.bookmarks.insertTree(
      {
        guid: work,
        children: Array.from({ length: 40 }, (_, i) => ({
          url: `https://example.com/s${i}`,
          title: `s${i}`,
        })),
      },
      { source: SYNC },
    );
    await until(
      async () => (await IOUtils.readUTF8(bookmarksFile)).includes('"s39" = '),
      "Sync's 40 bookmarks written",
    );
  });
  Assert.equal(writes, 1, "one edit");
  Assert.equal((await folderContents("work"))?.length, 41, "all kept in Places");
  await reset();
});

const lines = (/** @type {number} */ n) =>
  Array.from({ length: n }, (_, i) => `"b${i}" = "https://example.com/${i}"`).join("\n");

add_task(async function a_sync_removal_of_many_asks_and_n_puts_them_back() {
  const text = `[bookmarks.work]\n${lines(25)}\n`;
  await IOUtils.writeUTF8(bookmarksFile, text);
  await until(async () => (await folderContents("work"))?.length === 25, "25 loaded");
  const removeMany = async () => {
    const guids = [];
    for (let i = 0; i < 22; i++) guids.push({ guid: await guidOf(`https://example.com/${i}`) });
    await PlacesUtils.bookmarks.remove(guids, { source: SYNC });
  };
  await removeMany();
  await until(
    () =>
      promptOpen() &&
      promptText() ===
        'Sync removes 22 bookmarks from "work": remove them from bookmarks.toml? y/N',
    "asked in the window",
  );
  await answer("n");
  await until(async () => (await folderContents("work"))?.length === 25, "n puts them back");
  await until(
    () => noticeText().includes("Sync's removal of 22 bookmarks put back from the file"),
    "and says so",
  );
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), text, "the file untouched");
  // Again, and y removes them from the file.
  await removeMany();
  await until(() => promptOpen(), "asked again");
  await answer("y");
  await untilText(`[bookmarks.work]\n${lines(25).split("\n").slice(22).join("\n")}\n`, "removed");
  Assert.equal((await folderContents("work"))?.length, 3, "and Places keeps the rest");
  await reset();
});

add_task(async function a_mixed_sync_batch_answered_n_or_not_at_all_keeps_its_additions() {
  // A Sync batch that removes many and adds some. `n`, or no answer, puts the
  // removals back; the additions (and renames) are still written, never deleted everywhere.
  await SpecialPowers.pushPrefEnv({ set: [["vimma.bookmarks.askMs", 2500]] });
  for (const how of ["n", "no answer"]) {
    const text = `[bookmarks.work]\n${lines(30)}\n`;
    await IOUtils.writeUTF8(bookmarksFile, text);
    await until(async () => (await folderContents("work"))?.length === 30, `${how}: 30 loaded`);
    await quiet();
    const work = /** @type {Node} */ (await topFolder("work")).guid;
    const gone = [];
    for (let i = 0; i < 25; i++) gone.push({ guid: await guidOf(`https://example.com/${i}`) });
    await PlacesUtils.bookmarks.remove(gone, { source: SYNC });
    await PlacesUtils.bookmarks.insertTree(
      {
        guid: work,
        children: Array.from({ length: 10 }, (_, i) => ({
          url: `https://new.example/${i}`,
          title: `new ${i}`,
        })),
      },
      { source: SYNC },
    );
    await PlacesUtils.bookmarks.update({
      guid: await guidOf("https://example.com/29"),
      title: "renamed by Sync",
      source: SYNC,
    });
    await until(
      () => promptOpen() && promptText().includes("removes 25 bookmarks from"),
      `${how}: asked`,
    );
    if (how === "n") await answer("n");
    await until(async () => {
      const t = await IOUtils.readUTF8(bookmarksFile);
      return t.includes('"new 9" = "https://new.example/9"') && t.includes('"renamed by Sync"');
    }, `${how}: the additions and the rename are written`);
    await until(
      async () => (await folderContents("work"))?.length === 40,
      `${how}: the 25 are back in Places, beside the 10 new ones`,
    );
    const file = await IOUtils.readUTF8(bookmarksFile);
    for (let i = 0; i < 25; i++) {
      Assert.ok(file.includes(`"b${i}" = "https://example.com/${i}"`), `${how}: b${i} kept`);
    }
    for (let i = 0; i < 10; i++) {
      Assert.ok(await PlacesUtils.bookmarks.fetch({ url: `https://new.example/${i}` }), `new ${i}`);
    }
    await reset();
  }
  await SpecialPowers.popPrefEnv();
});

/**
 * Changes an item's guid as Sync's dedupe does (SyncedBookmarksMirror, noteGuidChanged).
 * @param {string} oldGuid
 * @param {string} newGuid
 */
async function changeGuid(oldGuid, newGuid) {
  const info = /** @type {{ parentGuid: string, type: number, url?: URL }} */ (
    await PlacesUtils.bookmarks.fetch(oldGuid)
  );
  /** @type {number} */
  let id = 0;
  await PlacesUtils.withConnectionWrapper(
    "vimma test: change a guid",
    async (
      /** @type {{ execute(sql: string, params: object): Promise<{ getResultByName(name: string): number }[]> }} */ db,
    ) => {
      const rows = await db.execute("SELECT id FROM moz_bookmarks WHERE guid = :oldGuid", {
        oldGuid,
      });
      id = rows[0].getResultByName("id");
      await db.execute("UPDATE moz_bookmarks SET guid = :newGuid WHERE guid = :oldGuid", {
        newGuid,
        oldGuid,
      });
    },
  );
  PlacesObservers.notifyListeners([
    new PlacesBookmarkGuid({
      id,
      itemType: info.type,
      url: info.url?.href ?? null,
      guid: newGuid,
      parentGuid: info.parentGuid,
      lastModified: Date.now(),
      source: SYNC,
      isTagging: false,
    }),
  ]);
}

add_task(async function a_guid_change_keeps_the_bookmark_and_its_folder_mirrored() {
  await IOUtils.writeUTF8(bookmarksFile, FILE);
  await untilFolder("work", LOADED, "loaded");
  const folder = /** @type {Node} */ (await topFolder("work")).guid;
  const mail = await guidOf("https://mail.example.com/");
  await changeGuid(folder, "workNEWguid1");
  await changeGuid(mail, "mailNEWguid1");
  await quiet();
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), FILE, "nothing written for a new guid");
  await untilFolder("work", LOADED, "nothing removed or made again");
  Assert.equal((await topFolder("work"))?.guid, "workNEWguid1", "the same folder");
  Assert.equal(await guidOf("https://mail.example.com/"), "mailNEWguid1", "the same bookmark");
  // Still mirrored under the new guids: a Library rename is written.
  await PlacesUtils.bookmarks.update({ guid: "mailNEWguid1", title: "Post" });
  await untilText(FILE.replace('"Mail"', '"Post"'), "a change of the item is written");
  await reset();
});

add_task(async function the_loop_guard_holds_across_two_simulated_devices() {
  // Device B is Sync: its changes are written, however often it makes them.
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"a" = "https://example.com/a"\n');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  const a = await guidOf("https://example.com/a");
  for (let i = 1; i <= 4; i++) {
    await PlacesUtils.bookmarks.update({ guid: a, title: `b${i}`, source: SYNC });
    await untilText(`[bookmarks.work]\n"b${i}" = "https://example.com/a"\n`, `written, time ${i}`);
  }
  Assert.ok(!errorSegment().includes("paused both ways"), "no pause for changes it takes");
  // Both devices change one bookmark at once, round after round: this file wins each time and
  // Places is put back; the third time in ten minutes pauses the table.
  for (let i = 1; i <= 3; i++) {
    // Both changes land before either run: the runs wait in the edit queue meanwhile.
    /** @type {(value: unknown) => void} */
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    const held = mirror.edits.run(() => gate);
    await PlacesUtils.bookmarks.update({ guid: a, title: `sync ${i}`, source: SYNC });
    await IOUtils.writeUTF8(
      bookmarksFile,
      `[bookmarks.work]\n"mine ${i}" = "https://example.com/a"\n`,
    );
    await new Promise((r) => setTimeout(r, 500));
    release(undefined);
    await held;
    await untilFolder("work", [`mine ${i} https://example.com/a`], `the file won, time ${i}`);
    if (i < 3) {
      await until(
        () => noticeText().includes(`bookmarks.toml kept "work"/mine ${i}; Sync's change put back`),
        `said, time ${i}`,
      );
    }
  }
  await until(
    () => noticeText().includes('"work" put back 3 times in 10 minutes; paused both ways'),
    "the third put-back pauses the table",
  );
  await until(() => errorSegment().includes("paused both ways"), "and the status bar keeps it");
  await PlacesUtils.bookmarks.update({ guid: a, title: "sync 4", source: SYNC });
  await quiet();
  Assert.deepEqual(await folderContents("work"), ["sync 4 https://example.com/a"], "left as is");
  Assert.equal(
    await IOUtils.readUTF8(bookmarksFile),
    '[bookmarks.work]\n"mine 3" = "https://example.com/a"\n',
    "and not written",
  );
  await reset();
});

add_task(async function a_library_change_during_an_apply_is_written_not_put_back() {
  // D5's closing compare under "all": what lands while the mirror applies a file edit is an
  // outside change like any other, written by the next run, never removed.
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"a" = "https://example.com/a"\n');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  const apply = mirror.apply.bind(mirror);
  let once = true;
  mirror.apply = async (/** @type {Parameters<typeof apply>[0]} */ ops) => {
    await apply(ops);
    if (once && ops.length) {
      once = false;
      await PlacesUtils.bookmarks.insert({
        parentGuid: /** @type {Node} */ (await topFolder("work")).guid,
        url: "https://example.com/during",
        title: "during",
      });
    }
  };
  try {
    await IOUtils.writeUTF8(
      bookmarksFile,
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n',
    );
    await untilText(
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n"during" = "https://example.com/during"\n',
      "the change made during the apply is written",
    );
  } finally {
    mirror.apply = apply;
  }
  await untilFolder(
    "work",
    ["a https://example.com/a", "b https://example.com/b", "during https://example.com/during"],
    "and kept in Places",
  );
  await reset();
});

add_task(async function a_sync_change_between_the_write_and_the_plan_is_written_not_put_back() {
  // #1365: a Sync change that lands after the run wrote Places' change to the file, but before
  // it plans, is an outside change for the next run, not a divergence from the file to put back.
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"a" = "https://example.com/a"\n');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  const a = await guidOf("https://example.com/a");
  const original = /** @type {NonNullable<typeof mirror.writeFile>} */ (mirror.writeFile);
  let once = true;
  /** @type {typeof original} */
  const racing = async (path, compute) => {
    const r = await original(path, compute);
    if (once && !("error" in r) && r.text?.includes('"b2"')) {
      once = false;
      await PlacesUtils.bookmarks.update({ guid: a, title: "b3", source: SYNC });
    }
    return r;
  };
  mirror.writeFile = racing;
  try {
    await PlacesUtils.bookmarks.update({ guid: a, title: "b2", source: SYNC });
    await until(() => !once, "Sync's second change landed right after the first was written");
    await quiet();
  } finally {
    mirror.writeFile = original;
  }
  Assert.deepEqual(await folderContents("work"), ["b3 https://example.com/a"], "kept in Places");
  Assert.equal(
    await IOUtils.readUTF8(bookmarksFile),
    '[bookmarks.work]\n"b3" = "https://example.com/a"\n',
    "and written to the file",
  );
  await reset();
});

add_task(async function a_sync_change_in_the_run_after_a_failed_apply_is_written_not_put_back() {
  // #1368: the run after a failed apply ends with the same closing compare; a Sync change that
  // lands before it is merged into the file by one more run, never put back and uploaded.
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"a" = "https://example.com/a"\n');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  const a = await guidOf("https://example.com/a");
  const apply = mirror.apply.bind(mirror);
  let calls = 0;
  let landed = false;
  mirror.apply = async (/** @type {Parameters<typeof apply>[0]} */ ops) => {
    if (!ops.length) return apply(ops);
    calls++;
    if (calls === 1) throw new Error("test: the first apply fails");
    await apply(ops);
    if (calls === 2) {
      await PlacesUtils.bookmarks.update({ guid: a, title: "a2", source: SYNC });
      landed = true;
    }
  };
  try {
    await IOUtils.writeUTF8(
      bookmarksFile,
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n',
    );
    await until(() => landed, "Sync's change landed right after the retried apply");
    await quiet();
  } finally {
    mirror.apply = apply;
  }
  Assert.deepEqual(
    await folderContents("work"),
    ["a2 https://example.com/a", "b https://example.com/b"],
    "kept in Places",
  );
  Assert.equal(
    await IOUtils.readUTF8(bookmarksFile),
    '[bookmarks.work]\n"a2" = "https://example.com/a"\n"b" = "https://example.com/b"\n',
    "and written to the file",
  );
  await reset();
});

add_task(async function a_sync_removal_that_lands_before_an_apply_is_named_sync() {
  // #1368: the apply forgets only its own events, so the run that writes Sync's removal names
  // Sync, not Firefox.
  await IOUtils.writeUTF8(
    bookmarksFile,
    '[bookmarks.work]\n"a" = "https://example.com/a"\n"c" = "https://example.com/c"\n',
  );
  await untilFolder("work", ["a https://example.com/a", "c https://example.com/c"], "loaded");
  const c = await guidOf("https://example.com/c");
  const apply = mirror.apply.bind(mirror);
  let once = true;
  mirror.apply = async (/** @type {Parameters<typeof apply>[0]} */ ops) => {
    if (once && ops.length) {
      once = false;
      await PlacesUtils.bookmarks.remove(c, { source: SYNC });
    }
    await apply(ops);
  };
  try {
    await IOUtils.writeUTF8(
      bookmarksFile,
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"c" = "https://example.com/c"\n"b" = "https://example.com/b"\n',
    );
    await untilText(
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n',
      "Sync's removal is written",
    );
    await until(() => noticeText().includes('removed 1 bookmark from "work"'), "said");
    Assert.ok(
      noticeText().includes('bookmarks.toml: Sync removed 1 bookmark from "work"'),
      `the notice names Sync: ${noticeText()}`,
    );
    await quiet();
  } finally {
    mirror.apply = apply;
  }
  await reset();
});

add_task(async function a_renamed_or_deleted_workspace_folder_follows_write_back_all() {
  await IOUtils.writeUTF8(
    bookmarksFile,
    '[bookmarks.work]\n"a" = "https://example.com/a"\n\n[bookmarks.home]\n"h" = "https://example.com/h"\n',
  );
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  await PlacesUtils.bookmarks.update({
    guid: /** @type {Node} */ (await topFolder("work")).guid,
    title: "job",
  });
  await untilText(
    '[bookmarks.job]\n"a" = "https://example.com/a"\n\n[bookmarks.home]\n"h" = "https://example.com/h"\n',
    "renamed in the Library: the header follows",
  );
  await PlacesUtils.bookmarks.remove(/** @type {Node} */ (await topFolder("home")).guid);
  await untilText(
    '[bookmarks.job]\n"a" = "https://example.com/a"\n\n',
    "deleted in the Library: its table goes",
  );
  await reset();
});

add_task(async function a_url_the_file_cannot_hold_stays_in_places_only() {
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"a" = "https://example.com/a"\n');
  await untilFolder("work", ["a https://example.com/a"], "loaded");
  const work = /** @type {Node} */ (await topFolder("work")).guid;
  await PlacesUtils.bookmarks.insert({ parentGuid: work, url: "data:text/html,x", title: "d" });
  await PlacesUtils.bookmarks.insert({
    parentGuid: work,
    url: "https://example.com/b",
    title: "b",
  });
  await untilText(
    '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n',
    "the rest of the burst is written",
  );
  await until(() => noticeText().includes("stays in Firefox only"), "said");
  // Another edit of the file does not remove it.
  await IOUtils.writeUTF8(
    bookmarksFile,
    '[bookmarks.work]\n"a" = "https://example.com/a2"\n"b" = "https://example.com/b"\n',
  );
  await untilFolder(
    "work",
    ["a https://example.com/a2", "d data:text/html,x", "b https://example.com/b"],
    "kept in Places",
  );
  await reset();
});

add_task(async function a_private_window_change_is_not_written() {
  await IOUtils.writeUTF8(bookmarksFile, FILE);
  await untilFolder("work", LOADED, "loaded");
  const work = /** @type {Node} */ (await topFolder("work")).guid;
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await SimpleTest.promiseFocus(priv);
  await PlacesUtils.bookmarks.insert({
    parentGuid: work,
    url: "https://private.example/",
    title: "secret",
  });
  await PlacesUtils.bookmarks.update({
    guid: await guidOf("https://mail.example.com/"),
    title: "secret title",
  });
  await quiet();
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  Assert.equal(await IOUtils.readUTF8(bookmarksFile), FILE, "nothing written");
  await untilFolder(
    "work",
    [...LOADED, "secret https://private.example/"],
    "the rename put back; the new bookmark kept in Places only",
  );
  // A later edit of the file, and a change from a normal window, still leave it out.
  await IOUtils.writeUTF8(bookmarksFile, `${FILE}"News" = "https://news.example/"\n`);
  await untilFolder(
    "work",
    [...LOADED, "secret https://private.example/", "News https://news.example/"],
    "still kept",
  );
  Assert.ok(!(await IOUtils.readUTF8(bookmarksFile)).includes("private.example"), "never written");
  await reset();
});

add_task(
  async function a_move_out_whose_places_step_fails_and_whose_line_cannot_go_back_loses_nothing() {
    // #1347 N11: the Places move fails, and putting the line back is refused because an editor
    // saved the file meanwhile. Under "vimma" a bookmark in neither the file nor the base would
    // then be removed as an outside change.
    await setWriteBack("vimma");
    const text = '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n';
    await IOUtils.writeUTF8(bookmarksFile, text);
    await untilFolder("work", ["a https://example.com/a", "b https://example.com/b"], "loaded");
    const a = await guidOf("https://example.com/a");
    const r = await mirror.edit({
      type: "move",
      guid: a,
      parent: menuGuid,
      missing: [],
      title: null,
      outside: async () => {
        // An editor saves Vimma's own text again, with its own last line.
        const now = await IOUtils.readUTF8(bookmarksFile);
        await IOUtils.writeUTF8(bookmarksFile, `${now}# saved\n`);
        throw new Error("the destination is gone");
      },
    });
    Assert.ok("error" in r, "the key says it failed");
    await quiet();
    Assert.ok(
      (await IOUtils.readUTF8(bookmarksFile)).includes('"a" = "https://example.com/a"'),
      "the line is written back",
    );
    Assert.equal(await guidOf("https://example.com/a"), a, "and the bookmark is still there");
    await reset();
  },
);

add_task(async function a_base_that_cannot_be_saved_after_a_move_out_loses_nothing() {
  // #1347 N12: saving the base fails after the file was written (a full disk); the Places move
  // still runs, so the next run finds the bookmark outside the mirrored folders.
  await setWriteBack("vimma");
  await IOUtils.writeUTF8(
    bookmarksFile,
    '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"\n',
  );
  await untilFolder("work", ["a https://example.com/a", "b https://example.com/b"], "loaded");
  const a = await guidOf("https://example.com/a");
  const basePath = mirror.basePath;
  // Under a regular file: no write there can succeed.
  mirror.basePath = PathUtils.join(bookmarksFile, "base.json");
  /** @type {unknown} */
  let r;
  try {
    r = await mirror.edit({
      type: "move",
      guid: a,
      parent: menuGuid,
      missing: [],
      title: null,
      outside: async () => menuGuid,
    });
    await quiet();
  } finally {
    mirror.basePath = basePath;
  }
  Assert.ok(
    r && typeof r === "object" && !("error" in r),
    `the move went through (${JSON.stringify(r)})`,
  );
  // Another file change starts a run against the base held in memory.
  await IOUtils.writeUTF8(bookmarksFile, '[bookmarks.work]\n"b" = "https://example.com/b"\n\n');
  await quiet();
  const moved = await PlacesUtils.bookmarks.fetch(a);
  Assert.equal(moved?.parentGuid, menuGuid, "the bookmark is in the Menu, not lost");
  await reset();
});
