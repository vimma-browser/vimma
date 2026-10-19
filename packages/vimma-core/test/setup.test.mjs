import { describe, test, expect } from "vitest";
import { CURATED, amoEntries, initialSetup, planSetup, setupKey } from "../src/setup.mjs";

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
const keys = (state, ...ks) => {
  let r = { state, effect: null };
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
    const file = (url, hash) => ({ current_version: { file: { url, hash } } });
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

  test("a curated slug answered with another guid is dropped", () => {
    const [first] = CURATED;
    const good = amo({ slug: first.slug, guid: first.guid });
    const bad = amo({ slug: first.slug, guid: "impostor@e" });
    expect(amoEntries([good], { curated: true })).toHaveLength(1);
    expect(amoEntries([bad], { curated: true })).toEqual([]);
    expect(amoEntries([amo()], { curated: true })).toEqual([]);
  });

  test("installed add-ons cannot be marked", () => {
    const addons = amoEntries([amo({ guid: "in@e" })], { installed: new Set(["in@e"]) });
    expect(addons[0].installed).toBe(true);
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
});
