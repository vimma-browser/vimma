import { describe, test, expect } from "vitest";
import {
  AMO_API,
  CURATED,
  amoCuratedUrl,
  amoEntries,
  amoSearchUrl,
  curatedOffline,
  formatUsers,
  initialSetup,
  planSetup,
  setupKey,
  withAddons,
} from "../src/system/setup.mjs";
import type { SetupState } from "../src/system/setup.mjs";

/** An AMO search result as the v5 API returns it. */
const amo = (over = {}) => ({
  guid: "x@example.com",
  slug: "x",
  type: "extension",
  name: { "en-US": "X" },
  summary: { "en-US": "Does x" },
  authors: [{ name: "Ann" }],
  average_daily_users: 1200,
  current_version: {
    file: { url: "https://addons.mozilla.org/firefox/downloads/file/1/x.xpi", hash: "sha256:ab" },
  },
  ...over,
});

const engines = ["Google", "DuckDuckGo", "Bing"];
const fresh = () =>
  initialSetup({
    addons: amoEntries([amo(), amo({ guid: "y@e", slug: "y" })]),
    engines,
    engine: "Google",
  });

/** Feeds keys, returning the last result. */
const keys = (state: SetupState, ...ks: string[]) => {
  let r: ReturnType<typeof setupKey> = { state, effect: null };
  for (const k of ks) r = setupKey(r.state, k);
  return r;
};

describe("setup", () => {
  test("skip from any step plans nothing", () => {
    for (const before of [[], ["enter"], ["enter", "space", "enter"]]) {
      for (const k of ["esc", "q"]) {
        const r = keys(fresh(), ...before, k);
        expect(r.effect, `${before} ${k}`).toEqual({ type: "close" });
        expect(planSetup(r.state)).toBeNull();
      }
    }
  });

  test("the summary lists marked add-ons and the chosen engine", () => {
    const r = keys(fresh(), "enter", "j", "space", "enter", "j", "enter");
    expect(r.state.step).toBe("summary");
    const plan = planSetup(r.state);
    expect(plan?.engine).toBe("DuckDuckGo");
    expect(plan?.addons.map((a) => a.guid)).toEqual(["y@e"]);
    expect(keys(r.state, "enter").effect).toEqual({ type: "apply", plan });
  });

  test("an AMO result off addons.mozilla.org or without a sha256 hash is dropped", () => {
    const file = (url: string, hash: string | undefined) => ({
      current_version: { file: { url, hash } },
    });
    const got = amoEntries([
      amo(file("http://addons.mozilla.org/f.xpi", "sha256:ab")),
      amo(file("https://evil.example/f.xpi", "sha256:ab")),
      amo(file("https://addons.mozilla.org.evil.example/f.xpi", "sha256:ab")),
      amo(file("https://addons.mozilla.org/f.xpi", "sha1:ab")),
      amo(file("https://addons.mozilla.org/f.xpi", undefined)),
      amo({ type: "statictheme" }),
      amo({ guid: "ok@e" }),
    ]);
    expect(got.map((a) => a.guid)).toEqual(["ok@e"]);
    expect(got[0]).toMatchObject({ name: "X", author: "Ann", summary: "Does x", users: 1200 });
  });

  test("malformed AMO answers are dropped or read as empty, never thrown on", () => {
    expect(amoEntries(null as unknown as unknown[])).toEqual([]);
    expect(amoEntries({ length: 1, 0: amo() } as unknown as unknown[])).toEqual([]);
    const dropped = amoEntries([
      null,
      "x",
      42,
      [amo()],
      amo({ guid: 1 }),
      amo({ slug: null }),
      amo({ current_version: null }),
      amo({ current_version: "v1" }),
      amo({ current_version: { file: null } }),
      amo({ current_version: { file: [] } }),
      amo({ current_version: { file: { url: 7, hash: "sha256:ab" } } }),
    ]);
    expect(dropped).toEqual([]);
    const [odd] = amoEntries([
      amo({
        name: null,
        summary: 5,
        // Not an array: AMO's authors list is read only as one.
        authors: { 0: { name: "Mallory" } },
        average_daily_users: "1200",
      }),
    ]);
    expect(odd).toMatchObject({ name: "x", author: "", summary: "", users: 0 });
    for (const authors of [null, "Ann", [], [null], ["Ann"], [{ name: 3 }]]) {
      expect(amoEntries([amo({ authors })])[0]?.author, JSON.stringify(authors)).toBe("");
    }
  });

  test("a curated slug answered with another guid is dropped", () => {
    const [first] = CURATED;
    if (!first) throw new Error("no curated add-on");
    const good = amo({ slug: first.slug, guid: first.guid });
    const bad = amo({ slug: first.slug, guid: "impostor@e" });
    expect(amoEntries([good], { curated: true })).toHaveLength(1);
    expect(amoEntries([bad], { curated: true })).toEqual([]);
    expect(amoEntries([amo()], { curated: true })).toEqual([]);
  });

  test("installed add-ons cannot be marked", () => {
    const addons = amoEntries([amo({ guid: "in@e" })], { installed: new Set(["in@e"]) });
    expect(addons[0]?.installed).toBe(true);
    const s = initialSetup({ addons, engines, engine: "Google" });
    const r = keys(s, "enter", "space", "enter", "enter");
    expect(planSetup(r.state)?.addons).toEqual([]);
  });

  test("the step keys move, mark and go back", () => {
    let r = keys(fresh(), "enter");
    expect(r.state.step).toBe("addons");
    r = keys(r.state, "j", "j", "k");
    expect(r.state.cursor).toBe(0);
    r = keys(r.state, "space", "space", "space");
    expect([...r.state.marked.keys()]).toEqual(["x@example.com"]);
    expect(keys(r.state, "/").effect).toEqual({ type: "search" });
    r = keys(r.state, "enter");
    expect(r.state).toMatchObject({ step: "engine", cursor: 0 });
    r = keys(r.state, "k", "enter");
    expect(r.state.step).toBe("summary");
    expect(planSetup(r.state)?.engine).toBe("Google");
    r = keys(r.state, "esc");
    expect(r.state.step).toBe("engine");
    expect(r.effect).toBeNull();
  });

  test("the curated list offline has no file, so it shows but cannot be marked", () => {
    expect(curatedOffline().map((a) => a.installed)).toEqual([false, false, false]);
    const [ublock, adguard] = CURATED;
    const offline = curatedOffline(new Set([adguard?.guid ?? ""]));
    expect(offline[0]).toEqual({ ...ublock, users: 0, url: "", hash: "", installed: false });
    expect(offline.map((a) => a.installed)).toEqual([false, true, false]);
    const s = initialSetup({ addons: offline, engines, engine: null });
    expect(keys(s, "enter", "space").state.marked.size).toBe(0);
  });

  test("searches AMO's public API for extensions by users, and the curated GUIDs in one request", () => {
    expect(AMO_API).toBe("https://addons.mozilla.org/api/v5/addons/");
    expect(amoSearchUrl("dark mode")).toBe(
      "https://addons.mozilla.org/api/v5/addons/search/?q=dark+mode&app=firefox&type=extension&sort=users",
    );
    expect(amoSearchUrl("a&b", "http://127.0.0.1:1/")).toBe(
      "http://127.0.0.1:1/search/?q=a%26b&app=firefox&type=extension&sort=users",
    );
    expect(amoCuratedUrl()).toBe(
      "https://addons.mozilla.org/api/v5/addons/search/?guid=" +
        encodeURIComponent(CURATED.map((c) => c.guid).join(",")) +
        "&app=firefox",
    );
    expect(amoCuratedUrl("http://127.0.0.1:1/")).toMatch(
      /^http:\/\/127\.0\.0\.1:1\/search\/\?guid=/,
    );
  });

  test("an AMO file on another port, or a URL that does not parse, is dropped", () => {
    const at = (url: string) => amo({ current_version: { file: { url, hash: "sha256:ab" } } });
    expect(amoEntries([at("https://addons.mozilla.org:8443/f.xpi")])).toEqual([]);
    expect(amoEntries([at("not a url")])).toEqual([]);
    expect(amoEntries([at("https://addons.mozilla.org:443/f.xpi")])).toHaveLength(1);
  });

  test("the hash is the whole value: sha256 and hex digits, any case", () => {
    const hashed = (hash: string) =>
      amoEntries([
        amo({ current_version: { file: { url: "https://addons.mozilla.org/f.xpi", hash } } }),
      ]).length;
    expect(hashed("SHA256:AB09")).toBe(1);
    for (const hash of ["sha256:", "xsha256:ab", "sha256:abz", "sha256:ab ", " sha256:ab"]) {
      expect(hashed(hash), hash).toBe(0);
    }
  });

  test("names are read in en-US, else the first language, and users must be a finite number", () => {
    const [e] = amoEntries([
      amo({ name: { fr: "Le X", "en-US": "X en" }, summary: { de: "Macht x", fr: "Fait x" } }),
    ]);
    expect(e).toMatchObject({ name: "X en", summary: "Macht x" });
    expect(amoEntries([amo({ name: { de: 1 } })])[0]?.name).toBe("x");
    expect(amoEntries([amo({ name: "", authors: [{ name: "Bo" }] })])[0]).toMatchObject({
      name: "x",
      author: "Bo",
    });
    for (const users of [Infinity, Number.NaN]) {
      expect(amoEntries([amo({ average_daily_users: users })])[0]?.users).toBe(0);
    }
    expect(amoEntries([amo({ average_daily_users: 0.5 })])[0]?.users).toBe(0.5);
    expect(amoEntries([amo({ current_version: { file: [] } })])).toEqual([]);
    expect(amoEntries([amo({ current_version: [{ file: {} }] })])).toEqual([]);
  });

  test("an entry keeps AMO's file and marks what is installed", () => {
    const [e] = amoEntries([amo()], { installed: new Set(["x@example.com"]) });
    expect(e).toEqual({
      guid: "x@example.com",
      slug: "x",
      name: "X",
      author: "Ann",
      summary: "Does x",
      users: 1200,
      url: "https://addons.mozilla.org/firefox/downloads/file/1/x.xpi",
      hash: "sha256:ab",
      installed: true,
    });
    expect(amoEntries([amo()])[0]?.installed).toBe(false);
  });

  test("curated answers come back in the curated order, whatever order AMO sends", () => {
    const answer = [...CURATED].reverse().map((c) => amo({ slug: c.slug, guid: c.guid }));
    const got = amoEntries(answer, { curated: true });
    expect(got.map((a) => a.guid)).toEqual(CURATED.map((c) => c.guid));
    const search = amoEntries(answer);
    expect(search.map((a) => a.guid)).toEqual(answer.map((a) => a.guid));
  });

  test("a new list puts the cursor back on its first entry", () => {
    const r = keys(fresh(), "enter", "j");
    expect(r.state.cursor).toBe(1);
    const s = withAddons(r.state, []);
    expect(s).toEqual({ ...r.state, addons: [], cursor: 0 });
    expect(initialSetup({ addons: [], engines, engine: "Bing" })).toEqual({
      step: "welcome",
      cursor: 0,
      addons: [],
      marked: new Map(),
      engines,
      engine: "Bing",
    });
  });

  test("the arrows move like j and k, and the cursor stays inside the list", () => {
    let r = keys(fresh(), "enter", "down");
    expect(r.state.cursor).toBe(1);
    r = keys(r.state, "down", "j");
    expect(r.state.cursor).toBe(1);
    r = keys(r.state, "up");
    expect(r.state.cursor).toBe(0);
    r = keys(r.state, "down", "k");
    expect(r.state.cursor).toBe(0);
    r = keys(r.state, "up", "k");
    expect(r.state.cursor).toBe(0);
    r = keys(r.state, "enter", "down", "down", "down", "j");
    expect(r.state).toMatchObject({ step: "engine", cursor: 2 });
    r = keys(r.state, "up");
    expect(r.state.cursor).toBe(1);
    r = keys(r.state, "k");
    expect(r.state.cursor).toBe(0);
    r = keys(r.state, "down", "enter");
    expect(planSetup(r.state)?.engine).toBe("DuckDuckGo");
  });

  test("an empty list does not move the cursor, nor mark anything", () => {
    const s = initialSetup({ addons: [], engines: [], engine: "Google" });
    let r = keys(s, "enter");
    for (const k of ["j", "down", "k", "up", "space"]) {
      const next = setupKey(r.state, k);
      expect(next.state, k).toBe(r.state);
      expect(next.effect, k).toBeNull();
    }
    r = keys(r.state, "enter");
    for (const k of ["j", "down", "k", "up"]) expect(setupKey(r.state, k).state, k).toBe(r.state);
    r = keys(r.state, "enter");
    expect(r.state.step).toBe("summary");
    expect(planSetup(r.state)).toEqual({ addons: [], engine: "Google" });
  });

  test("other keys do nothing on any step, and a closed page takes no keys", () => {
    const steps = [[], ["enter"], ["enter", "enter"], ["enter", "enter", "enter"], ["q"]];
    for (const before of steps) {
      const s = keys(fresh(), ...before).state;
      for (const k of ["x", "space", "/", "h", "l"]) {
        if (s.step === "addons" && (k === "space" || k === "/")) continue;
        const r = setupKey(s, k);
        expect(r.state, `${before} ${k}`).toBe(s);
        expect(r.effect, `${before} ${k}`).toBeNull();
      }
    }
    const closed = keys(fresh(), "q").state;
    expect(closed.step).toBe("closed");
    for (const k of ["enter", "esc", "q"]) expect(setupKey(closed, k).state).toBe(closed);
    const summary = keys(fresh(), "enter", "enter", "enter").state;
    expect(setupKey(summary, "q").state).toBe(summary);
  });

  test("the engine step starts on the current default, or the first when it is not listed", () => {
    const at = (engine: string | null) =>
      keys(initialSetup({ addons: [], engines, engine }), "enter", "enter").state.cursor;
    expect(at("Bing")).toBe(2);
    expect(at("Ecosia")).toBe(0);
    expect(at(null)).toBe(0);
    const back = keys(initialSetup({ addons: [], engines, engine: "Bing" }), "enter", "enter");
    const r = keys(back.state, "enter", "esc");
    expect(r.state).toMatchObject({ step: "engine", cursor: 2 });
    const none = { ...keys(fresh(), "enter", "enter", "enter").state, engine: null };
    expect(setupKey(none, "esc").state).toMatchObject({ step: "engine", cursor: 0 });
    const gone = { ...none, engine: "Ecosia" };
    expect(setupKey(gone, "esc").state).toMatchObject({ step: "engine", cursor: 0 });
  });

  test("the plan leaves out a marked add-on that got installed meanwhile", () => {
    const r = keys(fresh(), "enter", "space", "j", "space", "enter", "enter");
    const [x, y] = r.state.addons;
    if (!x || !y) throw new Error("no add-ons");
    const marked = new Map([
      [x.guid, { ...x, installed: true }],
      [y.guid, y],
    ]);
    expect(planSetup({ ...r.state, marked })?.addons).toEqual([y]);
  });

  test("user counts read as 999, 1.2k, 12k, 1.2M and 12M", () => {
    expect(formatUsers(0)).toBe("0 users");
    expect(formatUsers(999)).toBe("999 users");
    expect(formatUsers(1000)).toBe("1.0k users");
    expect(formatUsers(1234)).toBe("1.2k users");
    expect(formatUsers(10_000)).toBe("10k users");
    expect(formatUsers(1_000_000)).toBe("1.0M users");
    expect(formatUsers(1_234_567)).toBe("1.2M users");
    expect(formatUsers(10_000_000)).toBe("10M users");
    expect(formatUsers(12_345_678)).toBe("12M users");
  });

  test("a user count rounds first, so it never shows 10.0k, 1000k or 10.0M (#1190)", () => {
    expect(formatUsers(9_949)).toBe("9.9k users");
    expect(formatUsers(9_950)).toBe("9.9k users");
    expect(formatUsers(9_951)).toBe("10k users");
    expect(formatUsers(9_999)).toBe("10k users");
    expect(formatUsers(10_499)).toBe("10k users");
    expect(formatUsers(10_500)).toBe("11k users");
    expect(formatUsers(999_499)).toBe("999k users");
    expect(formatUsers(999_500)).toBe("1.0M users");
    expect(formatUsers(999_999)).toBe("1.0M users");
    expect(formatUsers(9_949_999)).toBe("9.9M users");
    expect(formatUsers(9_950_000)).toBe("9.9M users");
    expect(formatUsers(9_950_001)).toBe("10M users");
    expect(formatUsers(9_999_999)).toBe("10M users");
  });

  test("space marks and unmarks, and never marks an installed add-on", () => {
    let r = keys(fresh(), "enter", "space", "space");
    expect(r.state.marked.size).toBe(0);
    r = keys(r.state, "space");
    expect([...r.state.marked.keys()]).toEqual(["x@example.com"]);
    const addons = amoEntries([amo({ guid: "in@e" })], { installed: new Set(["in@e"]) });
    const s = keys(initialSetup({ addons, engines, engine: null }), "enter", "space").state;
    expect(s.marked.size).toBe(0);
  });

  test("a curated GUID answered under another slug is dropped too", () => {
    const [first] = CURATED;
    if (!first) throw new Error("no curated add-on");
    expect(amoEntries([amo({ slug: "lookalike", guid: first.guid })], { curated: true })).toEqual(
      [],
    );
  });

  test("the file and its hash must be a JSON object and a string, not an array", () => {
    const url = "https://addons.mozilla.org/f.xpi";
    const listed = Object.assign([], { url, hash: "sha256:ab" });
    expect(amoEntries([amo({ current_version: { file: listed } })])).toEqual([]);
    expect(amoEntries([amo({ current_version: { file: { url, hash: ["sha256:ab"] } } })])).toEqual(
      [],
    );
  });
});
