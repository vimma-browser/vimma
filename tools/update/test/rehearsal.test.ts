// docs/specs/m6a-updater.md, Tests, "Security rehearsal" (M6a exit test 2, decision 23): the
// scheduled job that installs the previous release's tarball and sees it offer, stage and apply
// the release updates.vimma.dev offers (tools/update/rehearsal.ts, update-rehearsal.yml). These
// tests cover the decisions it takes from what it reads; the install itself runs only in the
// workflow and by hand (docs/runbook/ci-update-keys-and-update-host.md, "The update rehearsal").
import { beforeAll, describe, expect, it } from "vitest";
import { constants, privateEncrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { testKey } from "../../test/test-keys.ts";
import {
  base64Encode,
  signatureComment,
  spkiKeyId,
} from "../../../packages/vimma-core/src/updates/updates.mjs";
import { buildManifest, digestInfo } from "../manifest.ts";
import {
  MANIFEST_URL,
  FIRST_UPDATER_RELEASE,
  appliedProblems,
  missingUpdater,
  planRehearsal,
  progress,
  publishedReleases,
  stagedProblems,
  summary,
} from "../rehearsal.ts";

const subtle = globalThis.crypto.subtle;
const HASH = (c: string) => c.repeat(128);
const NOW = new Date("2026-11-24T08:00:00Z");

async function kmsKey(name: "a" | "b") {
  const pair = testKey(name);
  const der = new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }));
  const pin = {
    id: await spkiKeyId(subtle, der),
    slot: "primary",
    spki: base64Encode(der),
  } as const;
  return { pair, pin };
}

let key: Awaited<ReturnType<typeof kmsKey>>;
let stranger: Awaited<ReturnType<typeof kmsKey>>;
beforeAll(async () => {
  [key, stranger] = await Promise.all([kmsKey("a"), kmsKey("b")]);
});

function sign(body: string, by = key) {
  const raw = privateEncrypt(
    { key: by.pair.privateKey, padding: constants.RSA_PKCS1_PADDING },
    digestInfo(body),
  );
  return body + signatureComment([{ key: by.pin.id, sig: raw.toString("base64") }]);
}

const offer = (version = "0.1.22", { mar = true, urgency = "security" } = {}) => ({
  appVersion: "160.0.1",
  buildId: "20261120123443",
  displayVersion: version,
  urgency: urgency as "normal" | "security",
  advisories: urgency === "security" ? ["MFSA 2026-130"] : [],
  assets: {
    tarball: { size: 10, sha512: HASH("a") },
    appimage: { size: 11, sha512: HASH("b") },
    deb: { size: 12, sha512: HASH("c") },
    rpm: { size: 13, sha512: HASH("d") },
  },
  ...(mar ? { mar: { size: 14, sha512: HASH("e") } } : {}),
});

const served = (version = "0.1.22", o = {}) =>
  sign(buildManifest({ serial: "20261120153701", update: offer(version, o) }));

const releases = [
  { tag: "v0.1.20", publishedAt: "2026-11-16T06:00:12Z" },
  { tag: "v0.1.22", publishedAt: "2026-11-20T15:35:17Z" },
  { tag: "v0.1.21", publishedAt: "2026-11-17T13:48:26Z" },
];

const plan = (manifest: string | null, rs = releases, now = NOW) =>
  planRehearsal({ manifest, releases: rs, keys: [key.pin], now });

describe("the manifest URL", () => {
  it("is the release channel's Linux manifest on updates.vimma.dev, as the browser's pref names it", () => {
    expect(MANIFEST_URL).toBe(
      "https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml",
    );
    const pref = readFileSync(
      new URL("../../../src/browser/branding/vimma/pref/firefox-branding.js", import.meta.url),
      "utf8",
    );
    const template = /pref\("vimma\.update\.url", "([^"]+)"\)/.exec(pref)?.[1];
    expect(
      template?.replace("%BUILD_TARGET%", "Linux_x86_64-gcc3").replace("%CHANNEL%", "vimma"),
    ).toBe(MANIFEST_URL);
  });
});

describe("publishedReleases", () => {
  it("keeps published releases, leaving out drafts, pre-releases (the nightly) and other tags", () => {
    const pages = [
      [
        { tag_name: "v0.1.23", draft: true, prerelease: false, published_at: null },
        {
          tag_name: "nightly",
          draft: false,
          prerelease: true,
          published_at: "2026-11-12T19:46:04Z",
        },
        {
          tag_name: "v0.1.22",
          draft: false,
          prerelease: false,
          published_at: "2026-11-20T15:35:17Z",
        },
      ],
      [
        {
          tag_name: "v0.1.21",
          draft: false,
          prerelease: false,
          published_at: "2026-11-17T13:48:26Z",
        },
      ],
    ];
    expect(publishedReleases(pages)).toEqual([
      { tag: "v0.1.22", publishedAt: "2026-11-20T15:35:17Z" },
      { tag: "v0.1.21", publishedAt: "2026-11-17T13:48:26Z" },
    ]);
  });

  it("refuses a response of another shape rather than reading it as no releases", () => {
    expect(() => publishedReleases({})).toThrow(/not a list of pages/);
    expect(() => publishedReleases([{}])).toThrow(/not a list of releases/);
    expect(() => publishedReleases([[{ tag_name: "v1.0.0" }]])).toThrow(/draft/);
  });
});

describe("planRehearsal", () => {
  it("rehearses the release before the offered one updating to it", async () => {
    expect(await plan(served())).toEqual({
      kind: "rehearse",
      from: "v0.1.21",
      to: {
        version: "0.1.22",
        buildId: "20261120123443",
        appVersion: "160.0.1",
        urgent: true,
        marUrl:
          "https://github.com/vimma-browser/vimma/releases/download/v0.1.22/vimma-0.1.22-linux-x86_64.complete.mar",
      },
      serial: "20261120153701",
      key: key.pin.id,
    });
  });

  // The job runs only while UPDATES_ENABLED is true, so a missing manifest is an outage or a
  // broken publish that leaves every install behind, not "updates are off".
  it("fails when the host serves no manifest although releases are published", async () => {
    await expect(plan(null)).rejects.toThrow(
      `${MANIFEST_URL} serves no manifest, but v0.1.22 was published 88 h ago`,
    );
  });

  it("has nothing to rehearse without a manifest when no release is past the grace hours", async () => {
    expect(await plan(null, [{ tag: "v0.1.1", publishedAt: "2026-11-24T06:00:00Z" }])).toEqual({
      kind: "nothing",
      reason: `${MANIFEST_URL} serves no manifest and v0.1.1 was published 2 h ago`,
    });
    expect(await plan(null, [])).toEqual({
      kind: "nothing",
      reason: `${MANIFEST_URL} serves no manifest and no release is published`,
    });
  });

  it("has nothing to rehearse when the manifest offers nothing (an update pulled, decision 22)", async () => {
    const empty = sign(buildManifest({ serial: "20261121000000", update: null }));
    expect(await plan(empty)).toEqual({
      kind: "nothing",
      reason: "the manifest offers no update (serial 20261121000000)",
    });
  });

  it("has nothing to rehearse when no earlier release exists", async () => {
    expect(await plan(served(), [{ tag: "v0.1.22", publishedAt: "2026-11-20T15:35:17Z" }])).toEqual(
      { kind: "nothing", reason: "no published release is older than v0.1.22" },
    );
  });

  it("fails on a manifest no pinned key signed, as the browser would refuse it", async () => {
    await expect(plan(served().replace("0.1.22", "0.1.99"))).rejects.toThrow(
      /the served manifest fails verification/,
    );
    const bySomeoneElse = sign(
      buildManifest({ serial: "20261120153701", update: offer() }),
      stranger,
    );
    await expect(plan(bySomeoneElse)).rejects.toThrow(/the served manifest fails verification/);
  });

  it("fails on an offer without a MAR: a tarball has nothing to stage", async () => {
    await expect(plan(served("0.1.22", { mar: false }))).rejects.toThrow(
      "the manifest offers 0.1.22 without a MAR (<patch>), so a tarball cannot stage it",
    );
  });

  it("fails when the manifest offers a version that is not a published release", async () => {
    await expect(plan(served("0.1.23"))).rejects.toThrow(
      "the manifest offers 0.1.23, which is not a published release (the newest is v0.1.22)",
    );
  });

  it("waits a few hours for a newly published release's manifest, then fails on a stale one", async () => {
    const fresh = [...releases, { tag: "v0.1.23", publishedAt: "2026-11-24T05:00:00Z" }];
    expect(await plan(served(), fresh)).toEqual({
      kind: "nothing",
      reason:
        "v0.1.23 was published 3 h ago and the manifest still offers 0.1.22; update-publish.yml " +
        "may not have run yet",
    });
    const stale = [...releases, { tag: "v0.1.23", publishedAt: "2026-11-23T20:00:00Z" }];
    await expect(plan(served(), stale)).rejects.toThrow(
      "v0.1.23 was published 12 h ago, but the manifest still offers 0.1.22",
    );
  });
});

describe("missingUpdater", () => {
  it("has nothing to rehearse for a release from before Firefox's updater shipped", () => {
    expect(FIRST_UPDATER_RELEASE).toBe("v0.1.17");
    expect(missingUpdater("v0.1.16")).toEqual({
      kind: "nothing",
      reason: "v0.1.16's tarball predates Firefox's updater (first in v0.1.17)",
    });
  });

  it("fails for a later release whose tarball lacks the updater: a regression in release.yml", () => {
    expect(missingUpdater("v0.1.21")).toEqual({
      kind: "failed",
      from: "v0.1.21",
      problem: "v0.1.21's tarball has no updater or update-settings.ini",
    });
  });
});

describe("progress", () => {
  const want = { version: "0.1.22", buildId: "20261120123443" };
  const update = (o: object) => ({
    enabled: true,
    installType: "tarball",
    outcome: "never",
    checkedAt: null,
    offer: null,
    stage: "none",
    ...o,
  });
  const offered = { version: "0.1.22", buildId: "20261120123443", urgent: true };

  it("is done once the offered build is staged", () => {
    expect(progress(update({ outcome: "offer", offer: offered, stage: "staged" }), want)).toEqual({
      done: true,
    });
  });

  it("keeps waiting before the first check and while the MAR downloads", () => {
    expect(progress(update({}), want)).toEqual({ done: false });
    expect(progress(update({ outcome: "offer", offer: offered, stage: "pending" }), want)).toEqual({
      done: false,
    });
    // A host that does not answer once is retried by the browser (decision 27).
    expect(progress(update({ outcome: "unreachable" }), want)).toEqual({ done: false });
  });

  it("fails at once on what no wait changes: a refused manifest, updates off, another install type", () => {
    expect(progress(update({ outcome: "refused" }), want)).toEqual({
      done: false,
      fail: "the browser refused the manifest (outcome refused)",
    });
    expect(progress(update({ enabled: false, outcome: "off" }), want).fail).toBe(
      "updates are off in this install (outcome off)",
    );
    expect(progress(update({ installType: "appimage" }), want).fail).toBe(
      "the install is appimage, not a tarball",
    );
  });

  it("fails when the browser offers another build than the manifest", () => {
    const other = { ...offered, buildId: "20261120000000" };
    expect(progress(update({ outcome: "offer", offer: other, stage: "staged" }), want).fail).toBe(
      "the browser offers 0.1.22 (build 20261120000000), not 0.1.22 (build 20261120123443)",
    );
  });

  it("fails on a state without an update field (a build before the field, #811)", () => {
    expect(progress(undefined, want).fail).toBe("the control state has no update field");
  });
});

const log = (...statuses: string[]) =>
  statuses.map((s) => `2026-11-24 06:23:41+0200: Writing status to file: ${s}\n`).join("");

describe("stagedProblems", () => {
  it("passes when the updater staged the offered build", () => {
    expect(
      stagedProblems({
        status: "applied\n",
        log: log("applying", "applied"),
        stagedIni: "[App]\nVersion=160.0.1\nBuildID=20261120123443\n",
        buildId: "20261120123443",
      }),
    ).toEqual([]);
  });

  it("names each part that did not stage", () => {
    expect(
      stagedProblems({
        status: "failed: 19\n",
        log: log("applying", "failed: 19"),
        stagedIni: null,
        buildId: "20261120123443",
      }),
    ).toEqual([
      "updates/0/update.status is `failed: 19`, not `applied`",
      "the updater's log ends `failed: 19`, not `applied`",
      "updated/application.ini is missing",
    ]);
    expect(
      stagedProblems({
        status: "applied",
        log: log("applied"),
        stagedIni: "[App]\nBuildID=20261117000000\n",
        buildId: "20261120123443",
      }),
    ).toEqual(["the staged build is 20261117000000, not 20261120123443"]);
  });
});

describe("appliedProblems", () => {
  it("passes when the install and the profile run the offered build", () => {
    expect(
      appliedProblems({
        installIni: "[App]\nBuildID=20261120123443\n",
        compatibility: "[Compatibility]\nLastVersion=160.0.1_20261120123443/20261120123443\n",
        log: log("applying", "applied", "succeeded"),
        buildId: "20261120123443",
      }),
    ).toEqual([]);
  });

  it("names each part that was not applied", () => {
    expect(
      appliedProblems({
        installIni: "[App]\nBuildID=20261117000000\n",
        compatibility: "[Compatibility]\nLastVersion=160.0_20261117000000/20261117000000\n",
        log: log("applied", "failed: 23"),
        buildId: "20261120123443",
      }),
    ).toEqual([
      "the install's application.ini says build 20261117000000, not 20261120123443",
      "the profile last ran build 20261117000000, not 20261120123443",
      "the updater's log ends `failed: 23`, not `succeeded`",
    ]);
  });
});

describe("summary", () => {
  it("says what was rehearsed, and that nothing was when there was nothing to rehearse", () => {
    expect(summary({ kind: "nothing", reason: "the manifest offers no update" })).toBe(
      "## Update rehearsal\n\nNothing to rehearse: the manifest offers no update.\n",
    );
    expect(
      summary({
        kind: "passed",
        from: "v0.1.21",
        to: "0.1.22",
        steps: ["offered after 35 s", "staged after 52 s"],
      }),
    ).toBe(
      "## Update rehearsal\n\nv0.1.21 took 0.1.22 from updates.vimma.dev:\n\n" +
        "- offered after 35 s\n- staged after 52 s\n",
    );
    expect(summary({ kind: "failed", from: "v0.1.21", to: "0.1.22", problem: "x" })).toBe(
      "## Update rehearsal\n\nFailed: v0.1.21 did not take 0.1.22: x\n",
    );
  });
});
