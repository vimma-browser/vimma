/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vimma's update manifest (docs/specs/m6a-updater.md §2, §4, §5): its signature, its rules, the
 * status-bar notice and the steps that update each install type. Pure: the host passes
 * WebCrypto's `subtle` and Firefox's version comparison, and does every fetch and file read.
 */

/** The bytes a manifest signature covers start with this, so it can never pass as a MAR's. */
export const MANIFEST_PREFIX = "vimma-update-xml-v1\n";
/** A manifest is one small static file; anything larger is refused before any parsing. */
export const MAX_MANIFEST_CHARS = 64 * 1024;
/** At most this many `key=… sig=…` pairs (spec §2: rotation needs two). */
export const MAX_SIGNATURES = 4;
/** WebCrypto's name for the update key's scheme: RSASSA-PKCS1-v1_5 with SHA-384 (spec §2). */
export const SIGNATURE_ALGORITHM = Object.freeze({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" });
/** How many refused manifests in a row the status bar waits for (spec §5). */
export const REFUSALS_SHOWN = 3;
/** Days after which a feed counts as stale (spec §4 rule 5). */
export const STALE_DAYS = Object.freeze({ release: 45, nightly: 7 });
/**
 * How far ahead of the clock a serial may be (decision 33): a pipeline clock error must not lock
 * every profile out of later manifests through the replay rule.
 */
export const FUTURE_SERIAL_MS = 86_400_000;
/**
 * The most a manifest response may hold, counted after decompression (decision 32); the manifest
 * itself is at most MAX_MANIFEST_CHARS characters.
 */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Where release assets are downloaded from (m6-packaging's file names). */
export const RELEASES_URL = "https://github.com/vimma-browser/vimma/releases";
/**
 * The one command that installs or updates Vimma on Arch Linux from the latest release (spec
 * m6a-updater decision 24): the pkgbuild-release hint, and the PKGBUILD's own header through
 * tools/package/package.mjs, which re-exports it. It builds in a fixed folder so it works from
 * any directory and leaves nothing in the current one: ~/.cache is on disk (a build needs about
 * 450 MB, too much for a tmpfs), keeps the last package for a quick reinstall, and holds files
 * the user may delete.
 */
export const PKGBUILD_INSTALL_COMMAND = `mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO ${RELEASES_URL}/latest/download/PKGBUILD && makepkg -si`;

/**
 * Where the Homebrew cask installs Vimma, and the Caskroom folder it keeps beside it (spec
 * macos-homebrew, decision 8; Apple Silicon's Homebrew prefix).
 */
export const HOMEBREW_APP = "/Applications/Vimma.app";
export const HOMEBREW_CASKROOM = "/opt/homebrew/Caskroom/vimma";

/**
 * How Vimma was installed (spec §3): `source` is a build run from its objdir, `packaged` an
 * `is-packaged-app` marker this version does not know; on macOS, `homebrew` is the cask and `dmg`
 * any other copy of the app (spec macos-homebrew, decision 19).
 * @typedef {"source" | "tarball" | "appimage" | "deb" | "aur" | "pkgbuild-release" | "packaged"
 *   | "homebrew" | "dmg"} InstallType
 */
/** @typedef {{ id: string, slot: "primary" | "secondary", spki: string }} PinnedKey */
/**
 * @typedef {object} Offer
 * @property {string} appVersion      Firefox's version
 * @property {string} buildId
 * @property {string} displayVersion  Vimma's version
 * @property {string} detailsUrl      the release page
 * @property {boolean} urgent         `vimmaUrgency="security"`
 * @property {string[]} advisories    MFSA IDs
 * @property {Assets} assets          each package's size and SHA-512, as the manifest signs them
 */
/** @typedef {{ size: number, sha512: string }} Asset */
/** @typedef {{ tarball?: Asset, appimage?: Asset, deb?: Asset, dmg?: Asset }} Assets */
/**
 * @typedef {{ channel: string, target: string, serial: string, update: Offer | null }} Manifest
 */
/** @typedef {{ text: string, tone: "info" | "urgent" | "warn" }} UpdateNotice */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** @param {Uint8Array} bytes */
export function base64Encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : "=";
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : "=";
  }
  return out;
}

/**
 * Standard base64 with padding; throws on anything else.
 * @param {string} text
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function base64Decode(text) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error("not base64");
  }
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (B64.indexOf(text[i] ?? "A") << 18) |
      (B64.indexOf(text[i + 1] ?? "A") << 12) |
      (Math.max(0, B64.indexOf(text[i + 2] ?? "A")) << 6) |
      Math.max(0, B64.indexOf(text[i + 3] ?? "A"));
    for (const byte of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) {
      if (o < out.length) out[o++] = byte;
    }
  }
  return out;
}

/**
 * A key's id: the first 8 hex digits of the SHA-256 of its SPKI (spec §2).
 * @param {SubtleCrypto} subtle
 * @param {Uint8Array<ArrayBuffer>} spki
 */
export async function spkiKeyId(subtle, spki) {
  const hash = new Uint8Array(await subtle.digest("SHA-256", spki));
  return [...hash.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The bytes a signature covers: the prefix, then the body.
 * @param {string} body
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function signedBytes(body) {
  return new TextEncoder().encode(MANIFEST_PREFIX + body);
}

/**
 * The comment that ends a signed manifest.
 * @param {readonly { key: string, sig: string }[]} signatures
 */
export function signatureComment(signatures) {
  const pairs = signatures.map((s) => `key=${s.key} sig=${s.sig}`).join(" ");
  return `<!-- vimma-signature v1 ${pairs} -->\n`;
}

const COMMENT_START = "<!-- vimma-signature";
const COMMENT = /^<!-- vimma-signature v1((?: key=[0-9a-f]{8} sig=[A-Za-z0-9+/]+={0,2})+) -->\n?$/;

/**
 * Splits a manifest into its signed body and its signatures. The comment is the file's last
 * line, alone and once; the body is everything before it and ends with a newline.
 * @param {string} text
 * @returns {{ ok: true, body: string, signatures: { key: string, sig: string }[] }
 *   | { ok: false, reason: string }}
 */
export function splitManifest(text) {
  const at = text.indexOf(COMMENT_START);
  if (at < 0) return { ok: false, reason: "unsigned: no vimma-signature comment" };
  if (text.indexOf(COMMENT_START, at + 1) >= 0) {
    return { ok: false, reason: "unsigned: more than one signature comment" };
  }
  const body = text.slice(0, at);
  if (at > 0 && !body.endsWith("\n")) {
    return { ok: false, reason: "unsigned: the signature comment is not on its own line" };
  }
  const m = COMMENT.exec(text.slice(at));
  if (!m) return { ok: false, reason: "unsigned: the signature comment is malformed or not last" };
  const signatures = [
    .../** @type {string} */ (m[1]).matchAll(/key=([0-9a-f]{8}) sig=([A-Za-z0-9+/]+={0,2})/g),
  ].map((p) => ({ key: /** @type {string} */ (p[1]), sig: /** @type {string} */ (p[2]) }));
  if (signatures.length > MAX_SIGNATURES) {
    return { ok: false, reason: `unsigned: more than ${MAX_SIGNATURES} signatures` };
  }
  return { ok: true, body, signatures };
}

/**
 * Rule 1 (spec §4): the manifest is signed by a pinned key. One valid signature under a pinned
 * key is enough; signatures by other keys are ignored.
 * @param {string} text
 * @param {readonly PinnedKey[]} keys
 * @param {SubtleCrypto} subtle
 * @returns {Promise<{ ok: true, body: string, key: { id: string, slot: string } }
 *   | { ok: false, reason: string }>}
 */
export async function verifyManifest(text, keys, subtle) {
  if (text.length > MAX_MANIFEST_CHARS)
    return { ok: false, reason: "manifest: larger than 64 KiB" };
  const split = splitManifest(text);
  if (!split.ok) return split;
  if (!keys.length) return { ok: false, reason: "signature: no pinned key in this build" };
  const bytes = signedBytes(split.body);
  let named = false;
  for (const { key, sig } of split.signatures) {
    const pin = keys.find((k) => k.id === key);
    if (!pin) continue;
    named = true;
    // A malformed signature or pinned key is a failed verification, never an exception.
    try {
      const publicKey = await subtle.importKey(
        "spki",
        base64Decode(pin.spki),
        SIGNATURE_ALGORITHM,
        false,
        ["verify"],
      );
      if (await subtle.verify(SIGNATURE_ALGORITHM, publicKey, base64Decode(sig), bytes)) {
        return { ok: true, body: split.body, key: { id: pin.id, slot: pin.slot } };
      }
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    reason: named ? "signature: does not verify" : "signature: not signed by a pinned key",
  };
}

const ENTITIES = /** @type {Record<string, string>} */ ({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

/**
 * Attributes of one start tag, `name="value"` only, each name once.
 * @param {string} text  what follows the tag name
 * @returns {Map<string, string> | null}
 */
function attributes(text) {
  const map = new Map();
  let rest = text.trimEnd();
  if (rest.endsWith("/")) rest = rest.slice(0, -1).trimEnd();
  const re = /\s+([A-Za-z][A-Za-z0-9]*)="([^"<]*)"/gy;
  let end = 0;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const [, name = "", raw = ""] = m;
    if (map.has(name)) return null;
    // Only the five predefined entities; no character references, no stray ampersand.
    if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) return null;
    map.set(
      name,
      raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e] ?? ""),
    );
    end = re.lastIndex;
  }
  return end === rest.length ? map : null;
}

/**
 * The attribute text of each `<name …>` start tag in `text`, found by one scan (no backtracking
 * regular expression), or null when a tag is not closed before the next `<`.
 * @param {string} text
 * @param {string} name
 * @returns {string[] | null}
 */
function startTags(text, name) {
  /** @type {string[]} */
  const out = [];
  const open = `<${name}`;
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
    const next = text[at + open.length] ?? "";
    if (!/[\s/>]/.test(next)) continue; // <updates>, <updateX>
    const end = text.indexOf(">", at);
    if (end < 0 || text.slice(at + 1, end).includes("<")) return null;
    out.push(text.slice(at + open.length, end));
  }
  return out;
}

/**
 * `text` without its XML comments, scanned once (no backtracking regular expression), or null
 * when one is not closed.
 * @param {string} text
 */
function withoutComments(text) {
  let out = "";
  let at = 0;
  for (let open = text.indexOf("<!--"); open >= 0; open = text.indexOf("<!--", at)) {
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return null;
    out += text.slice(at, open);
    at = close + 3;
  }
  return out + text.slice(at);
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const FIREFOX_VERSION = /^\d+\.\d+(?:\.\d+)?(?:[ab]\d+)?$/;
const BUILD_ID = /^\d{1,16}$/;
const SERIAL = /^\d{14}$/;
const ADVISORY = /^MFSA \d{4}-\d{1,4}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;
const SIZE = /^\d{1,15}$/;
/**
 * The element that carries each package's download in `<update>` (spec §2), by the key it has in
 * Offer.assets. Firefox's own parser reads only `<patch>` and ignores these.
 */
export const ASSET_ELEMENTS = Object.freeze({
  tarball: "vimmaTarball",
  appimage: "vimmaAppImage",
  deb: "vimmaDeb",
  dmg: "vimmaDmg",
});

/**
 * The asset elements in an `<update>`'s content: at most one of each, each with a whole-number
 * size, `hashFunction="sha512"`, a lower-case hex SHA-512 and an https URL.
 * @param {string} content
 * @returns {{ ok: true, assets: Assets } | { ok: false, why: string }}
 */
function readAssets(content) {
  /** @type {Assets} */
  const assets = {};
  for (const [key, element] of Object.entries(ASSET_ELEMENTS)) {
    const tags = startTags(content, element);
    if (!tags) return { ok: false, why: `<${element}> is not closed` };
    if (tags.length === 0) continue;
    if (tags.length > 1) return { ok: false, why: `more than one <${element}>` };
    const attrs = attributes(/** @type {string} */ (tags[0]));
    if (!attrs) return { ok: false, why: `<${element}> has malformed attributes` };
    const size = attrs.get("size") ?? "";
    const hash = attrs.get("hashValue") ?? "";
    if (!SIZE.test(size)) return { ok: false, why: `<${element}> size is not a whole number` };
    if (attrs.get("hashFunction") !== "sha512") {
      return { ok: false, why: `<${element}> hashFunction is not sha512` };
    }
    if (!SHA512_HEX.test(hash)) return { ok: false, why: `<${element}> hashValue is not SHA-512` };
    if (!(attrs.get("URL") ?? "").startsWith("https://")) {
      return { ok: false, why: `<${element}> URL is not https` };
    }
    assets[/** @type {keyof Assets} */ (key)] = { size: Number(size), sha512: hash };
  }
  return { ok: true, assets };
}

/**
 * The well-formed entries of a saved offer's assets (the pref `vimma.update.last`, which anyone
 * can edit): anything else is dropped, so a command never carries a hash that is not SHA-512 hex.
 * @param {unknown} value
 * @returns {Assets}
 */
export function offerAssets(value) {
  /** @type {Assets} */
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const record = /** @type {Record<string, any>} */ (value);
  for (const key of /** @type {(keyof Assets)[]} */ (Object.keys(ASSET_ELEMENTS))) {
    const a = record[key];
    if (a && Number.isSafeInteger(a.size) && a.size >= 0 && SHA512_HEX.test(a.sha512)) {
      out[key] = { size: a.size, sha512: a.sha512 };
    }
  }
  return out;
}

/**
 * Reads the manifest's body (after rule 1, so only signed text reaches it). Accepts exactly the
 * format the release pipeline writes: an XML declaration, `<updates>` with the channel, target
 * and serial, and at most one `<update>`. Anything else is refused rather than guessed at.
 * @param {string} body
 * @returns {{ ok: true, manifest: Manifest } | { ok: false, reason: string }}
 */
export function parseManifest(body) {
  /** @param {string} why */
  const bad = (why) =>
    /** @type {{ ok: false, reason: string }} */ ({ ok: false, reason: `manifest: ${why}` });
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(body)) return bad("declarations are not allowed");
  const text = withoutComments(body.replace(/^<\?xml[^>]*\?>/, ""));
  if (text === null) return bad("a comment is not closed");
  const root = /^\s*<updates(\s[^>]*?)?(\/?)>([\s\S]*)$/.exec(text);
  if (!root) return bad("no <updates> element");
  const rootAttrs = attributes(root[1] ?? "");
  if (!rootAttrs) return bad("<updates> has malformed attributes");
  const channel = rootAttrs.get("vimmaChannel");
  const target = rootAttrs.get("vimmaTarget");
  const serial = rootAttrs.get("vimmaSerial");
  if (!channel || !target) return bad("no vimmaChannel or vimmaTarget");
  if (!serial || !SERIAL.test(serial)) return bad("vimmaSerial is not a UTC time (YYYYMMDDhhmmss)");
  const inner = root[2] === "/" ? "" : (root[3] ?? "");
  const closed = inner.trimEnd();
  if (root[2] !== "/" && !closed.endsWith("</updates>")) return bad("<updates> is not closed");
  const content = closed.slice(0, -"</updates>".length);
  const updates = startTags(content, "update");
  if (!updates) return bad("<update> is not closed");
  if (root[2] === "/" || updates.length === 0) {
    if (content.trim()) return bad("unexpected content in <updates>");
    return { ok: true, manifest: { channel, target, serial, update: null } };
  }
  if (updates.length > 1) return bad("more than one <update>");
  const read = readAssets(content);
  if (!read.ok) return bad(read.why);
  const attrs = attributes(/** @type {string} */ (updates[0]));
  if (!attrs) return bad("<update> has malformed attributes");
  const appVersion = attrs.get("appVersion") ?? "";
  const buildId = attrs.get("buildID") ?? "";
  const displayVersion = attrs.get("displayVersion") ?? "";
  const detailsUrl = attrs.get("detailsURL") ?? "";
  const urgency = attrs.get("vimmaUrgency") ?? "normal";
  const advisories = (attrs.get("vimmaAdvisories") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (!FIREFOX_VERSION.test(appVersion)) return bad("appVersion is not a Firefox version");
  if (!BUILD_ID.test(buildId)) return bad("buildID is not a build ID");
  if (!SEMVER.test(displayVersion)) return bad("displayVersion is not a Vimma version");
  if (!detailsUrl.startsWith("https://")) return bad("detailsURL is not https");
  if (urgency !== "normal" && urgency !== "security") return bad("unknown vimmaUrgency");
  if (!advisories.every((a) => ADVISORY.test(a))) return bad("vimmaAdvisories is not MFSA IDs");
  return {
    ok: true,
    manifest: {
      channel,
      target,
      serial,
      update: {
        appVersion,
        buildId,
        displayVersion,
        detailsUrl,
        urgent: urgency === "security",
        advisories,
        assets: read.assets,
      },
    },
  };
}

/**
 * Rules 2 to 4 (spec §4): the right channel and target, no replay, no downgrade.
 * @param {Manifest} manifest
 * @param {{ channel: string, target: string, appVersion: string, buildId: string,
 *   serial: string | null, now: number }} running  `serial`: the highest this profile
 *   accepted; `now`: the clock, ms since the epoch
 * @param {(a: string, b: string) => number} compare  Firefox's version comparison
 * @returns {{ ok: true, serial: string, offer: Offer | null } | { ok: false, reason: string }}
 */
export function judgeManifest(manifest, running, compare) {
  if (manifest.channel !== running.channel) {
    return {
      ok: false,
      reason: `channel: the manifest is for "${manifest.channel}", this install is on "${running.channel}"`,
    };
  }
  if (manifest.target !== running.target) {
    return {
      ok: false,
      reason: `target: the manifest is for "${manifest.target}", this install is "${running.target}"`,
    };
  }
  const serial = BigInt(manifest.serial);
  const issued = serialTime(manifest.serial);
  if (issued === null || issued > running.now + FUTURE_SERIAL_MS) {
    return {
      ok: false,
      reason: `future: serial ${manifest.serial} is more than a day ahead of this clock`,
    };
  }
  if (running.serial !== null && serial < BigInt(running.serial)) {
    return {
      ok: false,
      reason: `replay: serial ${manifest.serial} is older than ${running.serial}, already accepted`,
    };
  }
  if (BUILD_ID.test(running.buildId) && serial < BigInt(running.buildId)) {
    return {
      ok: false,
      reason: `replay: serial ${manifest.serial} is older than this build (${running.buildId})`,
    };
  }
  const u = manifest.update;
  const order = u ? compare(u.appVersion, running.appVersion) : -1;
  const newer =
    !!u &&
    (order > 0 ||
      (order === 0 &&
        BUILD_ID.test(running.buildId) &&
        BigInt(u.buildId) > BigInt(running.buildId)));
  return { ok: true, serial: manifest.serial, offer: newer ? u : null };
}

/**
 * A serial (`YYYYMMDDhhmmss`, UTC) as ms since the epoch, or null.
 * @param {string} serial
 */
function serialTime(serial) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(serial);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(/** @type {number} */ (y), /** @type {number} */ (mo) - 1, d, h, mi, s);
}

/**
 * Rule 5 (spec §4): how many whole days old the feed is, when that is past its channel's limit;
 * else null.
 * @param {string} serial
 * @param {string} channel
 * @param {number} now  ms since the epoch
 */
export function staleDays(serial, channel, now) {
  const at = serialTime(serial);
  if (at === null) return null;
  const days = Math.floor((now - at) / 86400000);
  const limit = channel.endsWith("-nightly") ? STALE_DAYS.nightly : STALE_DAYS.release;
  return days > limit ? days : null;
}

/**
 * What the status bar shows (spec §5, the rows a check alone produces), or null.
 * @param {{ enabled: boolean, installType: InstallType,
 *   offer: { displayVersion: string, urgent: boolean } | null, refusals: number,
 *   staleDays: number | null }} state
 * @returns {UpdateNotice | null}
 */
export function updateNotice(state) {
  if (!state.enabled || state.installType === "source") return null;
  const { offer } = state;
  if (offer) {
    return offer.urgent
      ? { text: `⇡ ${offer.displayVersion} security: :update`, tone: "urgent" }
      : { text: `⇡ ${offer.displayVersion} available`, tone: "info" };
  }
  if (state.refusals >= REFUSALS_SHOWN) return { text: "updates: check failed", tone: "warn" };
  if (state.staleDays !== null) {
    return { text: `updates: no news for ${state.staleDays} days`, tone: "warn" };
  }
  return null;
}

/**
 * `vimma-package=<type>` in the `is-packaged-app` marker (spec §3), with `$APPIMAGE`; `packaged`
 * is false for a build that runs from its objdir (no omni.ja). On macOS no build has a marker:
 * the cask's app beside its Caskroom is `homebrew`, any other `dmg` (spec macos-homebrew,
 * decisions 8 and 19).
 * @param {{ packaged: boolean, marker: string | null, appImage: string | null,
 *   platform?: string, appPath?: string | null, caskroom?: boolean }} input
 *   `marker`: the file's text, null when there is none; `platform`: AppConstants.platform;
 *   `appPath`: the running app bundle (appBundleOf); `caskroom`: HOMEBREW_CASKROOM exists
 * @returns {InstallType}
 */
export function installTypeFrom({ packaged, marker, appImage, platform, appPath, caskroom }) {
  if (!packaged) return "source";
  if (platform === "macosx") {
    return appPath === HOMEBREW_APP && caskroom === true ? "homebrew" : "dmg";
  }
  if (marker === null) return appImage ? "appimage" : "tarball";
  const m = /^vimma-package=([a-z-]+)\s*$/m.exec(marker);
  const name = m?.[1];
  if (name === "deb" || name === "aur" || name === "pkgbuild-release" || name === "appimage") {
    return name;
  }
  return appImage ? "appimage" : "packaged";
}

/**
 * The `.app` bundle whose `Contents/Resources` is `greDir` (GreD on macOS), or null.
 * @param {string} greDir
 */
export function appBundleOf(greDir) {
  const m = /^(\/.*\.app)\/Contents\/Resources\/?$/.exec(greDir);
  return m?.[1] ?? null;
}

/**
 * A word for a POSIX shell: as it is when it has only safe characters, else single-quoted.
 * @param {string} word
 */
export function shellQuote(word) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * How to update this install to `offer` (`:update`, about:vimma): a sentence, the exact
 * commands, and the release page. Versions come from a verified manifest and are SemVer
 * (parseManifest); paths are quoted.
 * @param {InstallType} type
 * @param {Offer} offer
 * @param {{ installDir: string, appImage: string | null }} where
 * @returns {{ text: string, commands: string[], link: string }}
 */
export function updateSteps(type, offer, where) {
  const v = offer.displayVersion;
  const dl = `${RELEASES_URL}/download/v${v}`;
  const link = offer.detailsUrl;
  /**
   * Downloads `url` to `file`, failing on an HTTP error and on anything but https (redirects
   * included), then checks the SHA-512 the signed manifest gives for it, when it gives one.
   * @param {string} url
   * @param {string} file
   * @param {Asset | undefined} asset
   */
  const fetchChecked = (url, file, asset) =>
    `curl -fL --proto =https -o ${shellQuote(file)} ${url}` +
    (asset ? ` && echo ${shellQuote(`${asset.sha512}  ${file}`)} | sha512sum -c -` : "");
  const assets = offer.assets ?? {};
  switch (type) {
    case "pkgbuild-release":
      return {
        text: "Build the package again from the latest release's PKGBUILD:",
        commands: [PKGBUILD_INSTALL_COMMAND],
        link,
      };
    case "aur":
      return {
        text: "Update vimma-bin with your AUR helper, for example:",
        commands: ["yay -Syu vimma-bin"],
        link,
      };
    case "deb": {
      const file = `vimma_${v.replace("-", "~")}_amd64.deb`;
      return {
        text: "Download the new .deb and install it over this one:",
        commands: [
          `${fetchChecked(`${dl}/${file}`, file, assets.deb)} && sudo apt install ./${file}`,
        ],
        link,
      };
    }
    case "tarball": {
      const parent = where.installDir.replace(/\/[^/]*\/?$/, "") || "/";
      const file = `vimma-${v}-linux-x86_64.tar.xz`;
      return {
        text: "Quit Vimma, then unpack the new tarball over this install:",
        commands: [
          `${fetchChecked(`${dl}/${file}`, file, assets.tarball)}` +
            ` && tar -xJf ${file} -C ${shellQuote(parent)}`,
        ],
        link,
      };
    }
    case "appimage": {
      const file = where.appImage ?? "Vimma.AppImage";
      const next = `${file}.new`;
      return {
        text: "Download the new AppImage and rename it over this one; the next start runs it:",
        commands: [
          `${fetchChecked(`${dl}/vimma-${v}-x86_64.AppImage`, next, assets.appimage)}` +
            ` && chmod +x ${shellQuote(next)} && mv ${shellQuote(next)} ${shellQuote(file)}`,
        ],
        link,
      };
    }
    case "homebrew":
      return {
        text: "Upgrade the Homebrew cask:",
        commands: ["brew upgrade --cask vimma"],
        link,
      };
    case "dmg":
      // No command: a .dmg that curl fetches has no quarantine flag, so Gatekeeper would never
      // check it (spec macos-homebrew, decision 19).
      return {
        text:
          "Quit Vimma, download the new .dmg from the release page and drag Vimma over the copy " +
          "in Applications. macOS asks again on the first open; the guide's “The first open” " +
          "shows how.",
        commands: [],
        link,
      };
    case "source":
      return { text: "A source build: pull and rebuild to update.", commands: [], link };
    default:
      return {
        text: "Update Vimma with the tool you installed it with, or from the release page.",
        commands: [],
        link,
      };
  }
}

/**
 * The version line (spec firefox-versions): `Vimma 0.3.1 · Firefox 158.0.1`.
 * @param {{ displayVersion: string, appVersion: string }} offer
 */
export function updateVersionLine(offer) {
  return `Vimma ${offer.displayVersion} · Firefox ${offer.appVersion}`;
}

/**
 * `[updates] check` after a read of config.toml (decision 31). A file with errors never turns
 * checks on: a `check = false` still readable in it holds; otherwise the config in force before
 * keeps its value, and when only the defaults stand in for the broken file checks are held off
 * until it is fixed.
 * @param {{ errors: number, inForce: boolean, raw: boolean | null, hadConfig: boolean }} read
 *   `inForce`: `updates.check` of the config in force after the read; `raw`: rawUpdatesCheck;
 *   `hadConfig`: a config (not the fallback) was in force before the read
 * @returns {{ check: boolean, held: boolean }}
 */
export function updatesCheckAfterRead({ errors, inForce, raw, hadConfig }) {
  if (!errors) return { check: inForce, held: false };
  if (raw === false) return { check: false, held: false };
  if (!hadConfig) return { check: false, held: true };
  return { check: inForce, held: false };
}

/**
 * Checks run unless the pref `vimma.update.enabled` or `[updates] check` turns them off.
 * @param {{ pref: boolean, config: { check: boolean } | null }} input
 */
export function updatesEnabled({ pref, config }) {
  return pref && config?.check !== false;
}
