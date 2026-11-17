// Edges of the update manifest's rules that the weekly mutation run (#1119) found unpinned: each
// refusal's reason, the format parseManifest accepts and nothing else (UP5), the signature
// comment's shape (UP1), the clock and replay boundaries (UP2), and the install type's marker.
// docs/security/16-update-check.md; the main suite is updates.test.ts.
import { describe, test, expect } from "vitest";
import {
  MAX_MANIFEST_CHARS,
  MAX_SIGNATURES,
  appBundleOf,
  base64Decode,
  installTypeFrom,
  judgeManifest,
  offerAssets,
  parseManifest,
  signatureComment,
  spkiKeyId,
  splitManifest,
  staleDays,
  updateSteps,
  verifyManifest,
} from "../src/updates/updates.mjs";
import type { Manifest, Offer } from "../src/updates/updates.mjs";

const HEAD = '<?xml version="1.0"?>\n';
const ROOT = 'vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261028041207"';
const MAR = "https://github.com/vimma-browser/vimma/releases/download/v0.3.1/x.mar";
const PATCH = `<patch type="complete" size="1" hashFunction="sha512" hashValue="ab" URL="${MAR}"/>`;
const UPDATE =
  'appVersion="158.0.1" buildID="20261028031500" displayVersion="0.3.1" ' +
  'detailsURL="https://github.com/vimma-browser/vimma/releases/tag/v0.3.1"';

/** A body with `<updates ROOT>` around `inner`. */
const body = (inner: string, root = ROOT) => `${HEAD}<updates ${root}>\n${inner}</updates>\n`;
/** One `<update>` with `attrs` around `children`. */
const update = (children = `  ${PATCH}\n`, attrs = UPDATE) =>
  body(`<update ${attrs}>\n${children}</update>\n`);
const reason = (text: string) => (parseManifest(text) as { reason?: string }).reason;

describe("parseManifest: the one format, and a reason for each refusal (UP5)", () => {
  test("an <update> right after <updates>, with no whitespace, is read", () => {
    const tight = `${HEAD}<updates ${ROOT}><update ${UPDATE}>${PATCH}</update></updates>\n`;
    expect(parseManifest(tight)).toMatchObject({
      ok: true,
      manifest: { update: { displayVersion: "0.3.1", marUrl: MAR } },
    });
  });

  test("a comment right after the XML declaration is skipped", () => {
    const r = parseManifest(
      `${HEAD.trimEnd()}<!-- written by update-publish.yml -->\n<updates ${ROOT}>\n</updates>\n`,
    );
    expect(r).toMatchObject({ ok: true, manifest: { update: null } });
  });

  test("a missing vimmaUrgency is a normal release; normal is not urgent", () => {
    const noUrgency = parseManifest(update()) as { manifest: Manifest };
    expect(noUrgency.manifest.update).toMatchObject({ urgent: false, advisories: [] });
    const normal = parseManifest(update(undefined, `${UPDATE} vimmaUrgency="normal"`)) as {
      manifest: Manifest;
    };
    expect(normal.manifest.update?.urgent).toBe(false);
  });

  test("advisories are read from a comma list with spaces", () => {
    const attrs = `${UPDATE} vimmaUrgency="security" vimmaAdvisories="MFSA 2026-1, MFSA 2026-22"`;
    const r = parseManifest(update(undefined, attrs)) as { manifest: Manifest };
    expect(r.manifest.update?.advisories).toEqual(["MFSA 2026-1", "MFSA 2026-22"]);
  });

  test.each([
    ["a DOCTYPE", `<!DOCTYPE updates>\n${body("")}`],
    ["an ENTITY inside <updates>", body('<!ENTITY x "y">\n')],
    ["a CDATA section inside <update>", update(`  ${PATCH}\n  <![CDATA[x]]>\n`)],
  ])("%s: declarations are not allowed", (_name, text) => {
    expect(reason(text)).toBe("manifest: declarations are not allowed");
  });

  test("a prefix of more than one letter is a prefix too", () => {
    expect(reason(update(`  ${PATCH.replace("<patch", "<ns:patch")}\n`))).toBe(
      "manifest: prefixed element names are not allowed",
    );
  });

  test.each([
    ["text before <updates>", `x${body("")}`],
    ["no root element", `${HEAD}<update ${UPDATE}/>\n`],
  ])("%s: no <updates> element", (_name, text) => {
    expect(reason(text)).toBe("manifest: no <updates> element");
  });

  test("an XML declaration anywhere but the start is content, never skipped", () => {
    const inside = `<updates ${ROOT}>\n<?xml version="1.0"?>\n</updates>\n`;
    expect(reason(inside)).toBe("manifest: unexpected content in <updates>");
  });

  test.each([
    ["no attributes", "<updates>"],
    ["no vimmaTarget", '<updates vimmaChannel="vimma" vimmaSerial="20261028041207">'],
    ["no vimmaChannel", '<updates vimmaTarget="t" vimmaSerial="20261028041207">'],
  ])("<updates> with %s is refused", (_name, open) => {
    expect(reason(`${HEAD}${open}\n</updates>\n`)).toBe("manifest: no vimmaChannel or vimmaTarget");
  });

  test("a serial that is not YYYYMMDDhhmmss is refused, with the reason", () => {
    expect(reason(body("", ROOT.replace("20261028041207", "2026102804120")))).toBe(
      "manifest: vimmaSerial is not a UTC time (YYYYMMDDhhmmss)",
    );
  });

  test.each([
    ["an unquoted value", ROOT.replace('"vimma"', "vimma")],
    ["a name with no value", `${ROOT} vimmaExtra`],
    ["a stray ampersand", ROOT.replace('"vimma"', '"vim&ma"')],
    ["a character reference", ROOT.replace('"vimma"', '"vimm&#97;"')],
    ["a value with no equals sign", ROOT.replace('vimmaChannel="vimma"', 'vimmaChannel"vimma"')],
    [
      "a quote that never closes",
      'vimmaTarget="t" vimmaSerial="20261028041207" vimmaChannel="vimma',
    ],
  ])("<updates> with %s has malformed attributes", (_name, root) => {
    expect(reason(body("", root))).toBe("manifest: <updates> has malformed attributes");
  });

  test("an <updates> that is never closed is refused", () => {
    expect(reason(`${HEAD}<updates ${ROOT}>\n`)).toBe("manifest: <updates> is not closed");
  });

  test("text or an unknown element in an empty <updates> is refused", () => {
    expect(reason(body("hello\n"))).toBe("manifest: unexpected content in <updates>");
    // <updatesX> is not an <update>, and not content this format has.
    expect(reason(body("<updatesX/>\n"))).toBe("manifest: unexpected content in <updates>");
  });

  test("a self-closing <updates/> is an empty manifest, with only whitespace after it", () => {
    expect(parseManifest(`${HEAD}<updates ${ROOT}/>\n \t\n`)).toEqual({
      ok: true,
      manifest: {
        channel: "vimma",
        target: "Linux_x86_64-gcc3",
        serial: "20261028041207",
        update: null,
      },
    });
  });

  // #1185: the pipeline never writes anything after a self-closing root (UP5).
  test.each([
    ["an <update>", `<update ${UPDATE}>\n  ${PATCH}\n</update>\n`],
    ["a stray </updates>", "</updates>\n"],
    ["text", "hello\n"],
  ])("anything after a self-closing <updates/> is refused: %s", (_name, after) => {
    expect(reason(`${HEAD}<updates ${ROOT}/>\n${after}`)).toBe(
      "manifest: content after a self-closing <updates/>",
    );
  });

  test("an <update> that never closes its tag is refused", () => {
    expect(reason(body(`<update ${UPDATE}\n`))).toBe("manifest: <update> is not closed");
    expect(reason(body(`<update ${UPDATE} <patch/>\n`))).toBe("manifest: <update> is not closed");
    expect(reason(body("<update"))).toBe("manifest: unexpected content in <updates>");
  });

  test("two <update> elements are refused, with the reason", () => {
    expect(reason(body(`<update ${UPDATE}/>\n<update ${UPDATE}/>\n`))).toBe(
      "manifest: more than one <update>",
    );
  });

  test("an <update> with malformed attributes is refused, with the reason", () => {
    expect(reason(update(undefined, `${UPDATE} x=y`))).toBe(
      "manifest: <update> has malformed attributes",
    );
  });

  test.each([
    [
      "appVersion",
      'appVersion="158.0.1"',
      'appVersion="v158"',
      "appVersion is not a Firefox version",
    ],
    ["buildID", 'buildID="20261028031500"', 'buildID="2026-10-28"', "buildID is not a build ID"],
    [
      "displayVersion",
      'displayVersion="0.3.1"',
      'displayVersion="0.3"',
      "displayVersion is not a Vimma version",
    ],
    ["detailsURL", 'detailsURL="https://', 'detailsURL="http://', "detailsURL is not https"],
  ])("a malformed %s is refused, with the reason", (_name, good, bad, why) => {
    expect(reason(update(undefined, UPDATE.replace(good, bad)))).toBe(`manifest: ${why}`);
  });

  test("an unknown urgency or an advisory that is not an MFSA ID is refused", () => {
    expect(reason(update(undefined, `${UPDATE} vimmaUrgency="critical"`))).toBe(
      "manifest: unknown vimmaUrgency",
    );
    expect(reason(update(undefined, `${UPDATE} vimmaAdvisories="CVE-2026-1"`))).toBe(
      "manifest: vimmaAdvisories is not MFSA IDs",
    );
  });

  test("a <patch> that never closes, or with malformed attributes, is refused", () => {
    expect(reason(update(`  <patch type="complete" <x/>\n`))).toBe(
      "manifest: <patch> is not closed",
    );
    expect(reason(update(`  ${PATCH.replace('type="complete"', "type=complete")}\n`))).toBe(
      "manifest: <patch> has malformed attributes",
    );
  });

  const H = "a".repeat(128);
  const deb = (attrs: string) => `  <vimmaDeb ${attrs}/>\n`;
  const DEB = `size="1" hashFunction="sha512" hashValue="${H}" URL="https://x/v.deb"`;

  test("an asset's download is read with its size, hash and URL", () => {
    const r = parseManifest(update(`  ${PATCH}\n${deb(DEB)}`)) as { manifest: Manifest };
    expect(r.manifest.update?.assets).toEqual({
      deb: { size: 1, sha512: H, url: "https://x/v.deb" },
    });
  });

  test.each([
    ["never closes", `  <vimmaDeb ${DEB} <x/>\n`, "<vimmaDeb> is not closed"],
    ["comes twice", deb(DEB) + deb(DEB), "more than one <vimmaDeb>"],
    [
      "has malformed attributes",
      deb(DEB.replace('size="1"', "size=1")),
      "<vimmaDeb> has malformed attributes",
    ],
    [
      "has no whole-number size",
      deb(DEB.replace('size="1"', 'size="1.5"')),
      "<vimmaDeb> size is not a whole number",
    ],
    [
      "is not hashed with SHA-512",
      deb(DEB.replace("sha512", "sha256")),
      "<vimmaDeb> hashFunction is not sha512",
    ],
  ])("an asset element that %s is refused, with the reason", (_name, children, why) => {
    expect(reason(update(`  ${PATCH}\n${children}`))).toBe(`manifest: ${why}`);
  });
});

describe("offerAssets: a saved result's sizes (UP8)", () => {
  const H = "c".repeat(128);
  test("a size of zero is kept; a negative one is dropped", () => {
    expect(offerAssets({ deb: { size: 0, sha512: H } })).toEqual({ deb: { size: 0, sha512: H } });
    expect(offerAssets({ deb: { size: -1, sha512: H } })).toEqual({});
  });
});

describe("the signature comment's shape (UP1)", () => {
  const pair = { key: "0123abcd", sig: "AAAA" };

  test("a file with no comment is unsigned, with that reason", () => {
    expect(splitManifest(body(""))).toEqual({
      ok: false,
      reason: "unsigned: no vimma-signature comment",
    });
  });

  test("a second comment is refused as such", () => {
    const text = body("") + signatureComment([pair]) + signatureComment([pair]);
    expect(splitManifest(text)).toEqual({
      ok: false,
      reason: "unsigned: more than one signature comment",
    });
  });

  test("a comment at the very start splits into an empty body", () => {
    expect(splitManifest(signatureComment([pair]))).toEqual({
      ok: true,
      body: "",
      signatures: [pair],
    });
  });

  test(`up to ${MAX_SIGNATURES} signatures are read; one more is refused`, () => {
    const max = Array.from({ length: MAX_SIGNATURES }, () => pair);
    expect(splitManifest(body("") + signatureComment(max))).toMatchObject({
      ok: true,
      signatures: max,
    });
    expect(splitManifest(body("") + signatureComment([...max, pair]))).toEqual({
      ok: false,
      reason: `unsigned: more than ${MAX_SIGNATURES} signatures`,
    });
  });

  test("a file of exactly 64 KiB is read; the limit is past it", async () => {
    const text = "x".repeat(MAX_MANIFEST_CHARS);
    expect(await verifyManifest(text, [], globalThis.crypto.subtle)).toEqual({
      ok: false,
      reason: "unsigned: no vimma-signature comment",
    });
  });

  test("the pinned key is imported for verifying only, and not extractable", async () => {
    const calls: unknown[][] = [];
    const subtle = {
      importKey: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
      verify: async () => true,
    } as unknown as SubtleCrypto;
    const text = body("") + signatureComment([pair]);
    const keys = [{ id: pair.key, slot: "primary" as const, spki: "AAAA" }];
    expect(await verifyManifest(text, keys, subtle)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("spki");
    expect(calls[0]?.[3]).toBe(false);
    expect(calls[0]?.[4]).toEqual(["verify"]);
  });
});

describe("base64Decode: standard base64 only", () => {
  test("one padding character decodes two bytes, two decode one", () => {
    expect([...base64Decode("AQI=")]).toEqual([1, 2]);
    expect([...base64Decode("AQ==")]).toEqual([1]);
  });

  test.each([["AQIDB"], ["!!!="], ["A="]])("%j is refused as not base64", (text) => {
    expect(() => base64Decode(text)).toThrow("not base64");
  });

  test("a key id keeps the leading zero of each byte", async () => {
    const subtle = {
      digest: async () => new Uint8Array([0, 1, 0x0a, 0xff, 9]).buffer,
    } as unknown as SubtleCrypto;
    expect(await spkiKeyId(subtle, new Uint8Array(0))).toBe("00010aff");
  });
});

describe("judgeManifest at its boundaries (UP2)", () => {
  const running = {
    channel: "vimma",
    target: "Linux_x86_64-gcc3",
    appVersion: "158.0",
    buildId: "20261020000000",
    displayVersion: "0.3.0",
    serial: null as string | null,
    now: Date.parse("2026-10-29T00:00:00Z"),
  };
  const compare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  const parsed = (parseManifest(update()) as { manifest: Manifest }).manifest;

  test("a serial exactly a day ahead of the clock is accepted", () => {
    const now = Date.parse("2026-10-27T04:12:07Z");
    expect(judgeManifest(parsed, { ...running, now }, compare)).toMatchObject({ ok: true });
  });

  test("a serial that is no UTC time is refused as from the future", () => {
    // The reason's words are incidental (serialTime reads no time in it); the refusal matters.
    const odd = { ...parsed, serial: "1" };
    expect(judgeManifest(odd, running, compare)).toEqual({
      ok: false,
      reason: "future: serial 1 is more than a day ahead of this clock",
    });
  });

  test("a serial equal to this build's ID is not a replay", () => {
    const buildId = parsed.serial;
    expect(judgeManifest(parsed, { ...running, buildId }, compare)).toMatchObject({ ok: true });
  });
});

describe("staleDays with a serial that is not YYYYMMDDhhmmss", () => {
  const now = Date.parse("2027-10-29T00:00:00Z");
  test.each([["20261028041207x"], ["x20261028041207"], ["120261028041207"], [""]])(
    "%j: no age",
    (serial) => {
      expect(staleDays(serial, "vimma", now)).toBeNull();
    },
  );
  test("a well-formed old serial has its age", () => {
    expect(staleDays("20261028041207", "vimma", now)).toBe(365);
  });
});

describe("the install marker's one line (UP6)", () => {
  const at = (marker: string) => installTypeFrom({ packaged: true, marker });
  test("the type is read with or without trailing whitespace or newline", () => {
    expect(at("vimma-package=deb")).toBe("deb");
    expect(at("vimma-package=deb \n")).toBe("deb");
    expect(at("other=1\nvimma-package=rpm\n")).toBe("rpm");
  });
  test("no marker: a tarball", () => {
    expect(installTypeFrom({ packaged: true, marker: null })).toBe("tarball");
  });
  // #1188, decision 34: $APPIMAGE is inherited by every program an AppImage starts, so it says
  // nothing about this install; only the AppDir's own marker makes an AppImage. installTypeFrom
  // takes no $APPIMAGE; these pass one as a caller that still read it would.
  const inherited = (marker: string | null) => {
    const input = { packaged: true, marker, appImage: "/home/u/Apps/Other.AppImage" };
    return installTypeFrom(input);
  };
  test("no marker with an inherited $APPIMAGE: still a tarball", () => {
    expect(inherited(null)).toBe("tarball");
  });
  test("an unknown marker with an inherited $APPIMAGE: packaged, not an AppImage", () => {
    expect(inherited("")).toBe("packaged");
    expect(inherited("vimma-package=snap\n")).toBe("packaged");
  });
  test("the AppDir's own appimage marker is an AppImage", () => {
    expect(at("vimma-package=appimage\n")).toBe("appimage");
  });
  test("a line that only contains the key, or more after the type, is not a type", () => {
    expect(at("xvimma-package=deb\n")).toBe("packaged");
    expect(at("vimma-package=deb rpm\n")).toBe("packaged");
    expect(at("vimma-package=deb_1\n")).toBe("packaged");
  });
});

describe("appBundleOf: the whole path, anchored", () => {
  test("a relative path or a folder inside Resources is no bundle", () => {
    expect(appBundleOf("Applications/Vimma.app/Contents/Resources")).toBeNull();
    expect(appBundleOf("/Applications/Vimma.app/Contents/Resources/browser")).toBeNull();
    expect(appBundleOf("/Applications/Vimma.app/Contents/Resources/")).toBe(
      "/Applications/Vimma.app",
    );
  });
});

describe("updateSteps' words for each install type", () => {
  const offer: Offer = {
    appVersion: "158.0.1",
    buildId: "20261028031500",
    displayVersion: "0.3.1",
    detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
    urgent: false,
    advisories: [],
    assets: {},
  };
  const where = { installDir: "/opt/vimma", appImage: null };
  const text = (type: Parameters<typeof updateSteps>[0]) => updateSteps(type, offer, where).text;

  test("each type says what to do", () => {
    expect(text("pkgbuild-release")).toBe(
      "Build the package again from the latest release's PKGBUILD:",
    );
    expect(text("deb")).toBe("Download the new .deb and install it over this one:");
    expect(text("appimage")).toBe(
      "Download the new AppImage and rename it over this one; the next start runs it:",
    );
    expect(text("flatpak")).toBe(
      "Update the Flatpak from Flathub, or with your software centre. Flathub builds each " +
        "release after it is published, so if nothing is found yet, try again later:",
    );
    expect(text("dmg")).toBe(
      "Quit Vimma, download the new .dmg from the release page and drag Vimma over the copy " +
        "in Applications. macOS asks again on the first open; the guide's “The first open” " +
        "shows how.",
    );
    expect(text("packaged")).toBe(
      "Update Vimma with the tool you installed it with, or from the release page.",
    );
  });

  test("an AppImage whose $APPIMAGE is unknown renames over Vimma.AppImage", () => {
    const [cmd] = updateSteps("appimage", offer, where).commands;
    expect(cmd).toMatch(/ -o Vimma\.AppImage\.new /);
    expect(cmd).toMatch(/ && mv Vimma\.AppImage\.new Vimma\.AppImage$/);
  });

  test("a tarball installed right under / unpacks into /", () => {
    const [cmd] = updateSteps("tarball", offer, { installDir: "/vimma", appImage: null }).commands;
    expect(cmd).toMatch(/ && tar -xJf vimma-0\.3\.1-linux-x86_64\.tar\.xz -C \/$/);
  });

  test("a source build gets no command", () => {
    expect(updateSteps("source", offer, where).commands).toEqual([]);
  });
});

// The command about:vimma and :update show for an AppImage names only the file this Vimma is
// (#1196): every program an AppImage starts inherits its `$APPIMAGE`, so the steps apply the
// replacement's own check (ownAppImage) and otherwise name the placeholder (UP10).
describe("the AppImage steps name only the AppImage this Vimma owns (#1196)", () => {
  const offer: Offer = {
    appVersion: "158.0.1",
    buildId: "20261028031500",
    displayVersion: "0.3.1",
    detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
    urgent: false,
    advisories: [],
    assets: {},
  };
  const own = {
    installDir: "/tmp/.mount_vimmaXYZ/usr/lib/vimma",
    appImage: "/home/u/Apps/vimma-0.3.0-x86_64.AppImage",
    appDir: "/tmp/.mount_vimmaXYZ",
    marker: "vimma-package=appimage\n",
    forced: false,
  };
  const file = "/home/u/Apps/vimma-0.3.0-x86_64.AppImage";
  const command = (where: Parameters<typeof updateSteps>[2]) =>
    updateSteps("appimage", offer, where).commands[0] ?? "";
  const placeholder = (cmd: string) => {
    expect(cmd).toMatch(/ -o Vimma\.AppImage\.new /);
    expect(cmd).toMatch(/ && mv Vimma\.AppImage\.new Vimma\.AppImage$/);
  };

  test("the AppImage this Vimma runs from: its own file", () => {
    expect(command(own)).toMatch(new RegExp(` && mv ${file}\\.new ${file}$`));
  });

  test("a hand-extracted AppDir with another AppImage's $APPIMAGE: never that file", () => {
    const other = "/home/u/Apps/Other.AppImage";
    for (const where of [
      // squashfs-root/AppRun started from another AppImage's process: $APPDIR is that one's mount
      { ...own, installDir: "/home/u/squashfs-root/usr/lib/vimma", appImage: other },
      { ...own, appDir: null, appImage: other },
      { ...own, marker: null, appImage: other },
      { ...own, marker: "vimma-package=deb\n", appImage: other },
      { installDir: "/home/u/squashfs-root/usr/lib/vimma", appImage: other },
    ]) {
      const cmd = command(where);
      expect(cmd, JSON.stringify(where)).not.toContain("Other.AppImage");
      placeholder(cmd);
    }
  });

  test("a $APPIMAGE that is not an absolute file path: the placeholder", () => {
    for (const appImage of ["", "vimma.AppImage", "/a/../b.AppImage", "/a/\nb", "/a/"]) {
      placeholder(command({ ...own, appImage }));
    }
  });

  test("a test's forced install type skips the marker, as the replacement does", () => {
    expect(command({ ...own, marker: null, appDir: null, forced: true })).toMatch(
      new RegExp(` && mv ${file}\\.new ${file}$`),
    );
  });
});
