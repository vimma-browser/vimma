import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { CHECKS } from "../results.mjs";
import {
  FOLLOW_TARGET,
  GATED_CHECKS,
  SNAPSHOT_CSP,
  SNAPSHOT_LICENCES,
  finishSnapshot,
  offlineSites,
  recordable,
  renderGate,
  snapshotGate,
  validateManifest,
  verifySnapshot,
} from "../snapshot.mjs";

// The snapshot layer (docs/specs/site-compat.md, "Snapshot layer"): recorded pages replayed
// offline on every pull request. A snapshot is third-party page content served to a real browser
// in CI, so verifySnapshot is the gate that keeps scripts, handlers and network references out of
// every committed one (docs/security.md, SC5).
const DIR = new URL("../../../tests/e2e/fixtures/sites/", import.meta.url);
const SITES = JSON.parse(readFileSync(new URL("../sites.json", import.meta.url), "utf8"));
const MANIFEST = JSON.parse(readFileSync(new URL("snapshots.json", DIR), "utf8"));

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">`;
/** A minimal snapshot as the recorder writes it, with `body` inside. @param {string} body */
const page = (body, head = "") =>
  finishSnapshot(
    `<html lang="en"><head>${CSP_META}<meta charset="utf-8"><title>t</title>${head}</head>` +
      `<body>${body}</body></html>`,
  );

describe("verifySnapshot", () => {
  it("accepts a page of plain markup, fragment links and the follow target", () => {
    const html = page(
      `<p class="x" style="color: red">Hi <a href="#top">top</a> <a href="${FOLLOW_TARGET}">` +
        `next</a></p><input type="search" name="q"><div style="overflow-y: auto">x</div>` +
        `<svg viewBox="0 0 1 1"><use href="#icon"></use></svg>`,
      `<style>p { color: blue } @media (min-width: 9px) { p { margin: 0 } }</style>`,
    );
    expect(verifySnapshot(html)).toEqual([]);
  });

  it("wants the doctype, and the CSP as the first thing in <head>", () => {
    expect(verifySnapshot(page("x").replace("<!doctype html>\n", ""))).toContain(
      "does not start with <!doctype html>",
    );
    const late = page("x").replace(CSP_META, "").replace("<title>", `${CSP_META}<title>`);
    expect(verifySnapshot(late)).toContain(
      "the first element in <head> is not the snapshot's Content-Security-Policy meta",
    );
    const weak = page("x").replace(SNAPSHOT_CSP, "default-src *");
    expect(verifySnapshot(weak).join("\n")).toMatch(/Content-Security-Policy/);
    expect(verifySnapshot(page("x", CSP_META.replace(SNAPSHOT_CSP, "script-src *")))).toContain(
      "<meta http-equiv> other than the first Content-Security-Policy",
    );
  });

  it("rejects scripts and every element that loads or embeds something", () => {
    for (const el of [
      "<script>alert(1)</script>",
      "<SCRIPT SRC=x.js></SCRIPT>",
      "<iframe></iframe>",
      "<frame>",
      "<object></object>",
      "<embed>",
      "<img alt=x>",
      "<video></video>",
      "<audio></audio>",
      "<source>",
      "<picture></picture>",
      "<link rel=stylesheet>",
      "<base>",
      "<portal></portal>",
      "<svg><image></image></svg>",
      "<svg><script>x</script></svg>",
    ]) {
      const name = /^(?:<svg>)?<(\w+)/.exec(el)?.[1]?.toLowerCase();
      expect(verifySnapshot(page(el)), el).toContain(`<${name}> is not allowed`);
    }
  });

  it("rejects event handlers however they are written", () => {
    for (const attr of [
      `onclick="x()"`,
      `ONLOAD='x()'`,
      `onmouseover=x()`,
      `/onerror="x"`,
      `x=1 onfocus=x`,
    ]) {
      expect(verifySnapshot(page(`<div ${attr}>t</div>`)).join("\n"), attr).toMatch(
        /event handler attribute on\w+ on <div>/,
      );
    }
  });

  it("allows only fragment links and the follow target as href", () => {
    for (const href of [
      "https://example.com/",
      "//example.com/",
      "/wiki/Vim",
      "javascript:alert(1)",
      "java&#x73;cript:x",
      " #x",
      "followed.html?x",
      "data:text/html,x",
    ]) {
      expect(verifySnapshot(page(`<a href="${href}">t</a>`)), href).toContain(
        `href ${JSON.stringify(href)} on <a> is not a fragment or ${FOLLOW_TARGET}`,
      );
    }
    expect(verifySnapshot(page(`<svg><a xlink:href="https://x/">t</a></svg>`))).toContain(
      "xlink:href on <a> is not allowed",
    );
  });

  it("rejects every other attribute that names a URL", () => {
    for (const attr of ["src", "srcset", "action", "formaction", "poster", "background", "ping"]) {
      expect(verifySnapshot(page(`<div ${attr}="x">t</div>`)), attr).toContain(
        `${attr} on <div> is not allowed`,
      );
    }
  });

  it("rejects url(), @import and image-set() in styles", () => {
    for (const css of ["url(x.png)", "URL( 'https://x/' )", "image-set('a.png' 1x)"]) {
      expect(verifySnapshot(page(`<b style="background: ${css}">t</b>`)).join("\n"), css).toMatch(
        /style attribute on <b> loads something/,
      );
      expect(verifySnapshot(page("t", `<style>b { background: ${css} }</style>`)), css).toContain(
        "a <style> element loads something",
      );
    }
    expect(verifySnapshot(page("t", `<style>@import "x.css";</style>`))).toContain(
      "a <style> element loads something",
    );
  });

  it("reads attribute values with > and quotes inside them", () => {
    expect(verifySnapshot(page(`<div title="a > b" data-x='"'>t</div>`))).toEqual([]);
    expect(verifySnapshot(page(`<div title="a > b" onclick="x">t</div>`)).join("\n")).toMatch(
      /onclick/,
    );
  });

  it("is not fooled by markup inside comments, text or <style>", () => {
    expect(verifySnapshot(page(`<!-- <script>x</script> -->&lt;script&gt;`))).toEqual([]);
    expect(verifySnapshot(page("t", `<style>b::after { content: "<script>" }</style>`))).toEqual(
      [],
    );
    // A <textarea>'s content is text: no element inside it is ever made.
    expect(verifySnapshot(page(`<textarea><img src=x onerror=y></textarea>`))).toEqual([]);
  });
});

describe("the committed snapshots", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".html"));

  it("are four to six licensed pages, plus the follow target", () => {
    expect(files).toContain(FOLLOW_TARGET);
    const pages = files.filter((f) => f !== FOLLOW_TARGET);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(pages.length).toBeLessThanOrEqual(6);
  });

  for (const file of files) {
    it(`${file} passes verifySnapshot`, () => {
      expect(verifySnapshot(readFileSync(new URL(file, DIR), "utf8"))).toEqual([]);
    });
  }

  it("each have a manifest entry with a licence that allows redistribution", () => {
    expect(validateManifest(MANIFEST, SITES, files)).toEqual([]);
  });

  it("are attributed in the README next to them", () => {
    const readme = readFileSync(new URL("README.md", DIR), "utf8");
    for (const entry of MANIFEST) {
      const site = SITES.find((/** @type {any} */ s) => s.id === entry.id);
      expect(readme).toContain(site.url);
      expect(readme).toContain(entry.licence);
    }
  });
});

describe("validateManifest", () => {
  const expect_ = Object.fromEntries(GATED_CHECKS.map((id) => [id, "pass"]));
  const good = [
    { id: "wikipedia", licence: "CC BY-SA 4.0", recorded: "2026-10-21", expect: expect_ },
  ];

  it("accepts a licensed site with an expectation for every gated check", () => {
    expect(validateManifest(good, SITES, ["wikipedia.html", FOLLOW_TARGET])).toEqual([]);
  });

  it("gates every check but shortcuts, which needs the site's own scripts", () => {
    expect(GATED_CHECKS).toEqual(CHECKS.filter((id) => id !== "shortcuts"));
  });

  it("rejects unlicensed sites, wrong licences, missing files and loose files", () => {
    const github = { ...good[0], id: "github-repo", licence: "CC BY-SA 4.0" };
    expect(validateManifest([github], SITES, ["github-repo.html", FOLLOW_TARGET])).toContain(
      "github-repo: not a site whose licence allows a committed snapshot",
    );
    expect(validateManifest([{ ...good[0], licence: "MIT" }], SITES, ["wikipedia.html"])).toContain(
      `wikipedia: licence must be "CC BY-SA 4.0"`,
    );
    expect(validateManifest(good, SITES, [FOLLOW_TARGET])).toContain(
      "wikipedia: no wikipedia.html",
    );
    expect(validateManifest(good, SITES, ["wikipedia.html", "mdn.html", FOLLOW_TARGET])).toContain(
      "mdn.html: not in snapshots.json",
    );
  });

  it("rejects missing or unknown expectations, odd dates and duplicates", () => {
    const partial = { ...expect_ };
    delete partial.hints;
    const files = ["wikipedia.html", FOLLOW_TARGET];
    expect(validateManifest([{ ...good[0], expect: partial }], SITES, files)).toContain(
      "wikipedia: expect.hints must be pass or skip",
    );
    expect(
      validateManifest([{ ...good[0], expect: { ...expect_, shortcuts: "pass" } }], SITES, files),
    ).toContain("wikipedia: expect.shortcuts is not a gated check");
    expect(validateManifest([{ ...good[0], recorded: "yesterday" }], SITES, files)).toContain(
      "wikipedia: recorded must be a date (YYYY-MM-DD)",
    );
    expect(validateManifest([good[0], good[0]], SITES, files)).toContain("wikipedia: duplicate");
    expect(validateManifest({}, SITES, files)).toEqual(["snapshots.json must be an array"]);
  });
});

describe("recordable", () => {
  it("names the licence of the pages that may be committed, and nothing else", () => {
    expect(recordable("wikipedia")).toBe("CC BY-SA 4.0");
    expect(recordable("rust-std")).toBe(SNAPSHOT_LICENCES["rust-std"]);
    for (const id of ["github-repo", "stackoverflow", "youtube", "google", "nope"])
      expect(recordable(id)).toBeNull();
  });

  it("covers only sites on the list", () => {
    for (const id of Object.keys(SNAPSHOT_LICENCES))
      expect(SITES.map((/** @type {any} */ s) => s.id)).toContain(id);
  });
});

describe("offlineSites", () => {
  it("takes each snapshot's checks from sites.json and its URL from the page server", () => {
    const [site] = offlineSites(
      [{ id: "mdn", licence: SNAPSHOT_LICENCES.mdn, recorded: "2026-10-21", expect: {} }],
      SITES,
      "http://127.0.0.1:4000/",
    );
    expect(site).toEqual({
      id: "mdn",
      name: "MDN (snapshot)",
      url: "http://127.0.0.1:4000/mdn.html",
      find: "length",
    });
  });
});

describe("snapshotGate", () => {
  /** @param {Record<string, string>} statuses @returns {any} */
  const result = (statuses, extra = {}) => ({
    id: "wikipedia",
    name: "Wikipedia (snapshot)",
    status: "ok",
    checks: CHECKS.map((id) => ({
      id,
      status: statuses[id] ?? (id === "shortcuts" ? "skip" : "pass"),
      ...(statuses[id] === "fail" ? { reason: `${id} broke` } : {}),
    })),
    ...extra,
  });
  const entry = {
    id: "wikipedia",
    licence: "CC BY-SA 4.0",
    recorded: "2026-10-21",
    expect: { ...Object.fromEntries(GATED_CHECKS.map((id) => [id, "pass"])), insert: "skip" },
  };
  /** @param {any[]} sites */
  const run = (sites, harnessError = null) => ({ sites, harnessError });

  it("passes when every check that passed on the recording passes", () => {
    const gate = snapshotGate(run([result({ insert: "skip" })]), [entry]);
    expect(gate).toEqual({ snapshots: 1, regressions: [], improved: [], missing: [], exit: 0 });
  });

  it("fails on a check that passed on the recording and does not now", () => {
    const gate = snapshotGate(run([result({ insert: "skip", hints: "fail", find: "skip" })]), [
      entry,
    ]);
    expect(gate.exit).toBe(1);
    expect(gate.regressions).toEqual([
      { site: "wikipedia", check: "find", expected: "pass", actual: "skip", reason: null },
      {
        site: "wikipedia",
        check: "hints",
        expected: "pass",
        actual: "fail",
        reason: "hints broke",
      },
    ]);
  });

  it("fails when a check that was skipped now fails, and notes one that now passes", () => {
    expect(snapshotGate(run([result({ insert: "fail" })]), [entry]).regressions).toHaveLength(1);
    const gate = snapshotGate(run([result({})]), [entry]);
    expect(gate.exit).toBe(0);
    expect(gate.improved).toEqual([{ site: "wikipedia", check: "insert" }]);
  });

  it("ignores shortcuts, which the snapshot cannot replay", () => {
    expect(snapshotGate(run([result({ insert: "skip", shortcuts: "fail" })]), [entry]).exit).toBe(
      0,
    );
  });

  it("fails on a site that did not run and on a harness error", () => {
    expect(snapshotGate(run([]), [entry])).toMatchObject({ missing: ["wikipedia"], exit: 1 });
    expect(snapshotGate(run([result({ insert: "skip" })], "boom"), [entry]).exit).toBe(1);
  });

  it("renders the verdict for the job summary", () => {
    const ok = renderGate(snapshotGate(run([result({ insert: "skip" })]), [entry]));
    expect(ok).toMatch(/^## Snapshot gate\n\nPassed: 1 snapshot/m);
    const bad = renderGate(snapshotGate(run([result({ insert: "skip", hints: "fail" })]), [entry]));
    expect(bad).toContain("Failed");
    expect(bad).toContain("| wikipedia | hints | pass | fail | hints broke |");
  });
});
