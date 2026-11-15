import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { preflight } from "../artifact-preflight.mjs";

const rev = "b".repeat(40);
const release = "releases/mozilla-release";
/** The Taskcluster index's answer for Firefox 159.0b1's revision, read on 2026-10-14. */
const beta159 = JSON.parse(
  readFileSync(new URL("fixtures/index-159.0b1.json", import.meta.url), "utf8"),
);
const now = new Date("2026-10-13T12:00:00Z");
/** @param {number} status @param {unknown} body */
const answer = (status, body) => async () => ({ status, json: async () => body });

describe("artifact preflight", () => {
  it("yes when Mozilla's release build of the revision is indexed and not expired", async () => {
    const r = await preflight(
      { tree: release, revision: rev },
      answer(200, { taskId: "T", expires: "2027-10-13T00:00:00Z" }),
      now,
    );
    expect(r).toEqual({
      artifacts: "yes",
      note: `Mozilla's linux64 build of ${rev.slice(0, 12)} is indexed until 2027-10-13`,
    });
  });

  it("no on a 404: the suites cannot run on an artifact build, the full build can", async () => {
    const r = await preflight(
      { tree: release, revision: rev },
      answer(404, { code: "ResourceNotFound" }),
      now,
    );
    expect(r.artifacts).toBe("no");
    expect(r.note).toMatch(/not in the Taskcluster index/);
  });

  it("no when the indexed build has expired", async () => {
    const r = await preflight(
      { tree: release, revision: rev },
      answer(200, { taskId: "T", expires: "2026-01-01T00:00:00Z" }),
      now,
    );
    expect(r.artifacts).toBe("no");
    expect(r.note).toMatch(/expired/);
  });

  it("a revision that is not 40 hex is never put in a request", async () => {
    for (const bad of ["../../secrets", "b".repeat(39), `${rev}/x`, `${rev}?q`, "B".repeat(40)]) {
      /** @type {string[]} */
      const asked = [];
      const fetchJson = async (/** @type {string} */ url) => {
        asked.push(url);
        return { status: 200, json: async () => ({}) };
      };
      const r = await preflight({ tree: release, revision: bad }, fetchJson, now);
      expect(asked).toEqual([]);
      expect(r).toEqual({ artifacts: "unknown", note: "the source revision is not 40 hex" });
    }
  });

  it("finds Mozilla's 159.0b1 build in the mozilla-beta index", async () => {
    const revision = "c0c03f3f899017ae4b7e56c0713f1ada51173c41";
    /** @type {string[]} */
    const asked = [];
    const fetchJson = async (/** @type {string} */ url) => {
      asked.push(url);
      return { status: 200, json: async () => beta159 };
    };
    const r = await preflight({ tree: "releases/mozilla-beta", revision }, fetchJson, now);
    expect(asked).toEqual([
      "https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/" +
        `gecko.v2.mozilla-beta.shippable.revision.${revision}.firefox.linux64-opt`,
    ]);
    expect(r).toEqual({
      artifacts: "yes",
      note: `Mozilla's linux64 build of ${revision.slice(0, 12)} is indexed until 2027-10-12`,
    });
  });

  it("a tree other than mozilla-release or mozilla-beta is never put in a request", async () => {
    for (const tree of ["mozilla-central", "releases/mozilla-esr140", "../x", null]) {
      /** @type {string[]} */
      const asked = [];
      const fetchJson = async (/** @type {string} */ url) => {
        asked.push(url);
        return { status: 200, json: async () => ({}) };
      };
      const r = await preflight({ tree, revision: rev }, fetchJson, now);
      expect(asked, String(tree)).toEqual([]);
      expect(r.artifacts).toBe("unknown");
      expect(r.note).toMatch(/tree/);
    }
  });

  it("unknown when there is no revision or Taskcluster does not answer", async () => {
    expect(
      (await preflight({ tree: release, revision: null }, answer(200, {}), now)).artifacts,
    ).toBe("unknown");
    const down = async () => {
      throw new Error("ETIMEDOUT");
    };
    expect(await preflight({ tree: release, revision: rev }, down, now)).toEqual({
      artifacts: "unknown",
      note: "Taskcluster index unreachable: ETIMEDOUT",
    });
    expect(
      (await preflight({ tree: release, revision: rev }, answer(500, {}), now)).artifacts,
    ).toBe("unknown");
  });
});
