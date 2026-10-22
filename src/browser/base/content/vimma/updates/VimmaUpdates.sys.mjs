/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vimma's update check (spec: docs/specs/m6a-updater.md, delivery 1). Every 12 hours it fetches
// the signed manifest from updates.vimma.dev, verifies it against the keys pinned in this build
// (core/update-keys.mjs) and tells the status bar and about:vimma whether a newer Vimma exists;
// `:update` checks at once, and a start checks a few seconds after the first window is ready
// when the last good check is older than the interval (docs/specs/update-notices.md). Only the
// AppImage installs anything: it downloads the offered AppImage next to itself, checks it against
// the signed manifest and renames it over its own file (spec §3, decision 19); every other
// install is told how to update. The request is anonymous (no cookies, no cache) and its URL may
// carry only the platform and the update channel. A host that does not answer is logged and
// otherwise quiet; a manifest that fails verification is refused and, three times in a row,
// shown. Pure rules live in core/updates.mjs.

import {
  HOMEBREW_CASKROOM,
  MAX_RESPONSE_BYTES,
  appBundleOf,
  installTypeFrom,
  judgeManifest,
  OFF_NOTICE_MS,
  offNotice,
  offerAssets,
  parseManifest,
  staleDays,
  updateNotice,
  updateSteps,
  updateVersionLine,
  updatesEnabled,
  verifyManifest,
} from "../core/updates.mjs";
import { UPDATE_KEYS } from "../core/update-keys.mjs";
import {
  appImagePlan,
  downloadProblem,
  ownAppImage,
  stagedSteps,
} from "../core/appimage-update.mjs";
import { checkDue } from "../core/update-notices.mjs";

/** @import { InstallType, Offer, PinnedKey, UpdateNotice } from "../core/updates.mjs" */
/** @import { Stage } from "../core/update-notices.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const ENABLED_PREF = "vimma.update.enabled";
const URL_PREF = "vimma.update.url";
/** The highest manifest serial this profile accepted (spec §4 rule 3). */
const SERIAL_PREF = "vimma.update.serial";
/** The last check and its result, as JSON, so an offer shows again after a restart. */
const LAST_PREF = "vimma.update.last";
/** Firefox's update interval, in seconds (decision 13: 43200 in Vimma's branding). */
const INTERVAL_PREF = "app.update.interval";
/** Test-only, honoured only in automation: extra pinned keys, and the install type. */
const TEST_KEYS_PREF = "vimma.update.testKeys";
const TEST_TYPE_PREF = "vimma.update.installType";
/**
 * After the first window's delayed startup (`browser-delayed-startup-finished`): late enough not
 * to compete with session restore, early enough that a due check is not hours away.
 */
const STARTUP_CHECK_MS = 5_000;
/** How often the timer asks whether a check is due. */
const POLL_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 30_000;
/** An AppImage download that receives nothing for this long is given up (and tried again at
 * the next check); a slow link that keeps receiving is never cut off. */
const STALL_MS = 60_000;
/** The download is written, and the file hashed, in pieces of about this size. */
const WRITE_CHUNK = 1024 * 1024;
/** No download takes longer, however slow the link (an AppImage is about 110 MB). */
const DOWNLOAD_MAX_MS = 6 * 3_600_000;
/**
 * A part file this old is a leftover of a run that was killed mid-download: a download in
 * progress writes at least every STALL_MS and ends within DOWNLOAD_MAX_MS.
 */
const STALE_PART_MS = 86_400_000;
/** The only placeholders the URL may use: nothing that identifies an install or a person. */
const ALLOWED_PLACEHOLDERS = new Set(["BUILD_TARGET", "CHANNEL"]);
const MARKER = "is-packaged-app";

/**
 * `never`: no check yet; `current`: up to date; `offer`: a newer build exists; `unreachable`:
 * the host did not answer usably; `refused`: a manifest failed verification; `off`: checks are
 * off; `source`: a source build, which never checks.
 * @typedef {"never" | "current" | "offer" | "unreachable" | "refused" | "off" | "source"} Outcome
 */
/**
 * @typedef {object} UpdateState
 * @property {number | null} checkedAt    ms since the epoch, of the last attempt
 * @property {number | null} okAt         of the last check that got a verified answer
 * @property {Outcome} outcome
 * @property {string | null} reason      why it was unreachable or refused
 * @property {Offer | null} offer
 * @property {string | null} serial      of the last manifest accepted
 * @property {{ id: string, slot: string } | null} key  that signed it
 * @property {number} refusals           refused manifests in a row
 */

/** @type {readonly Outcome[]} */
const OUTCOMES = ["never", "current", "offer", "unreachable", "refused", "off", "source"];

/** @returns {UpdateState} */
const fresh = () => ({
  checkedAt: null,
  okAt: null,
  outcome: "never",
  reason: null,
  offer: null,
  serial: null,
  key: null,
  refusals: 0,
});

/** @type {UpdateState} */
let state = fresh();
/**
 * config.toml has errors and only the defaults stand in for it: no check until it is fixed
 * (decision 31).
 */
let held = false;
/** `[updates] check` of the config in force; null before config.toml is read. */
let configCheck = /** @type {boolean | null} */ (null);
/** @type {Promise<UpdateState> | null} */
let running = null;
/** The install type once installInfo has run; until then no notice can be due anyway. */
let knownType = /** @type {InstallType | null} */ (null);
/** The install, once known. @type {Install | null} */
let knownWhere = null;
/**
 * @typedef {object} Install
 * @property {InstallType} type
 * @property {string} installDir  the GRE directory
 * @property {string | null} appImage  `$APPIMAGE`
 * @property {string | null} appDir  `$APPDIR`
 * @property {string | null} marker  the `is-packaged-app` file's text
 * @property {boolean} forced  a test set the install type
 */
/** @type {Promise<Install> | null} */
let install = null;
/**
 * The AppImage's own replacement (decision 19), for this process only: after a restart the new
 * build runs and the offer is gone. `reason` says why the last attempt failed.
 * @type {{ stage: Stage, buildId: string | null, reason: string | null }}
 */
let replacement = { stage: "none", buildId: null, reason: null };
/**
 * The build ID of the offer the last check in this process verified. Only such an offer is
 * installed: one restored from the pref `vimma.update.last`, which anyone can edit, waits for a
 * check (docs/security.md UP10).
 */
let verifiedBuildId = /** @type {string | null} */ (null);
/** The build ID the replacement under way is for. */
let replacingFor = /** @type {string | null} */ (null);
/** The replacement under way, and the promise that resolves once its stage is known. */
let replacing = /** @type {Promise<void> | null} */ (null);
let replacingDecided = /** @type {Promise<void>} */ (Promise.resolve());
/** @type {Set<() => void>} */
const listeners = new Set();
let started = false;
/** @type {unknown} */
let firstTimer = null;
/** @type {((subject: unknown, topic: string) => void) | null} */
let firstWindow = null;
/** @type {unknown} */
let pollTimer = null;
/** When this session's `updates: off` notice started (decision 38), and its end's redraw. */
let offSince = /** @type {number | null} */ (null);
/** @type {unknown} */
let offTimer = null;

function inAutomation() {
  return Cu.isInAutomation === true;
}

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error("vimma: update listener failed", e);
    }
  }
}

function enabled() {
  if (held) return false;
  return updatesEnabled({
    pref: Services.prefs.getBoolPref(ENABLED_PREF, true),
    config: configCheck === null ? null : { check: configCheck },
  });
}

/** Where the install lives, and how it was installed (spec §3). */
function installInfo() {
  install ??= detectInstall().then((where) => {
    const first = knownType === null;
    knownType = where.type;
    knownWhere = where;
    // The status bar and the notices wait for the install type: tell them it is known.
    if (first) notify();
    return where;
  });
  return install;
}

/** @returns {Promise<Install>} */
async function detectInstall() {
  const gre = Services.dirsvc.get("GreD", Ci.nsIFile).path;
  const appImage = Services.env.get("APPIMAGE") || null;
  const appDir = Services.env.get("APPDIR") || null;
  const forced = inAutomation() ? Services.prefs.getStringPref(TEST_TYPE_PREF, "") : "";
  if (forced) {
    const type = /** @type {InstallType} */ (forced);
    return { type, installDir: gre, appImage, appDir, marker: null, forced: true };
  }
  // A build run from its objdir has no omni.ja: the chrome files are loose links into the
  // source tree. Every packaged build (tarball, AppImage, .deb, AUR, the .dmg) has one.
  const packaged = await IOUtils.exists(PathUtils.join(gre, "omni.ja"));
  const marker = await IOUtils.readUTF8(PathUtils.join(gre, MARKER)).catch(() => null);
  const platform = /** @type {string} */ (lazy.AppConstants.platform);
  // On macOS GreD is Vimma.app/Contents/Resources; the cask is the app it installs beside its
  // Caskroom folder (spec macos-homebrew, decision 8). Nothing is written into the bundle.
  const mac = platform === "macosx";
  const appPath = mac ? appBundleOf(gre) : null;
  const caskroom = mac ? await IOUtils.exists(HOMEBREW_CASKROOM).catch(() => false) : false;
  const type = installTypeFrom({ packaged, marker, appImage, platform, appPath, caskroom });
  return { type, installDir: gre, appImage, appDir, marker, forced: false };
}

/** @returns {PinnedKey[]} */
function pinnedKeys() {
  /** @type {PinnedKey[]} */
  const keys = [...UPDATE_KEYS];
  if (inAutomation()) {
    try {
      keys.push(...JSON.parse(Services.prefs.getStringPref(TEST_KEYS_PREF, "[]")));
    } catch (e) {
      console.error("vimma: vimma.update.testKeys is not JSON", e);
    }
  }
  return keys;
}

function target() {
  return `${Services.appinfo.OS}_${lazy.UpdateUtils.ABI}`;
}

function channel() {
  return /** @type {string} */ (lazy.UpdateUtils.UpdateChannel);
}

/**
 * The manifest URL from the pref, with only %BUILD_TARGET% and %CHANNEL% filled in; any other
 * placeholder, or a scheme other than https (http on a test host in automation), is refused.
 * @returns {string}
 */
function manifestUrl() {
  const template = Services.prefs.getStringPref(URL_PREF, "");
  const url = template.replace(/%(\w+)%/g, (whole, name) => {
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      throw new Error(`${URL_PREF} may not use %${name}%`);
    }
    return encodeURIComponent(name === "CHANNEL" ? channel() : target());
  });
  const scheme = url.split(":", 1)[0];
  if (scheme !== "https" && !(scheme === "http" && inAutomation())) {
    throw new Error(`${URL_PREF} is not an https URL`);
  }
  return url;
}

function save() {
  try {
    Services.prefs.setStringPref(LAST_PREF, JSON.stringify(state));
  } catch (e) {
    console.error("vimma: update state not saved", e);
  }
}

/** The running build is newer than or equal to `offer` (it was installed since). */
function alreadyHave(/** @type {Offer} */ offer) {
  const order = Services.vc.compare(offer.appVersion, Services.appinfo.version);
  return order < 0 || (order === 0 && BigInt(offer.buildId) <= BigInt(Services.appinfo.appBuildID));
}

/**
 * The saved result, if it still holds: a pref anyone can edit, so anything malformed is dropped
 * rather than trusted, and an offer the running build already has is dropped too.
 */
function load() {
  state = fresh();
  try {
    const saved = JSON.parse(Services.prefs.getStringPref(LAST_PREF, "null"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    const offer = saved.offer;
    const valid =
      offer &&
      /^\d+\.\d+(?:\.\d+)?(?:[ab]\d+)?$/.test(offer.appVersion) &&
      /^\d{1,16}$/.test(offer.buildId) &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(offer.displayVersion) &&
      typeof offer.detailsUrl === "string" &&
      offer.detailsUrl.startsWith("https://") &&
      typeof offer.urgent === "boolean" &&
      Array.isArray(offer.advisories);
    const checkedAt = Number.isFinite(saved.checkedAt) ? saved.checkedAt : null;
    const outcome = OUTCOMES.includes(saved.outcome) ? saved.outcome : "never";
    state = {
      ...fresh(),
      checkedAt,
      // A result saved before okAt existed: its check counts if it got an answer.
      okAt: Number.isFinite(saved.okAt)
        ? saved.okAt
        : outcome === "current" || outcome === "offer"
          ? checkedAt
          : null,
      outcome,
      reason: typeof saved.reason === "string" ? saved.reason : null,
      offer: valid && !alreadyHave(offer) ? { ...offer, assets: offerAssets(offer.assets) } : null,
      serial: /^\d{14}$/.test(saved.serial) ? saved.serial : null,
      key: saved.key && typeof saved.key.id === "string" ? saved.key : null,
      refusals: Number.isInteger(saved.refusals) ? saved.refusals : 0,
    };
    if (state.outcome === "offer" && !state.offer) state.outcome = "current";
  } catch {
    state = fresh();
  }
}

/**
 * Ends a check: logs what went wrong, keeps the result, tells the status bars.
 * @param {Partial<UpdateState>} next
 */
function finish(next) {
  const now = Date.now();
  const answered = next.outcome === "current" || next.outcome === "offer";
  state = { ...state, ...next, checkedAt: now, okAt: answered ? now : state.okAt };
  if (state.outcome === "unreachable" || state.outcome === "refused") {
    console.warn(`vimma: update check ${state.outcome}: ${state.reason}`);
  }
  save();
  notify();
  return state;
}

const TOO_LARGE = "manifest: the response is larger than 256 KiB";

/**
 * The response body as text, or null past MAX_RESPONSE_BYTES (decision 32). The cap counts the
 * bytes fetch hands over, which are already decompressed, so a gzip or brotli bomb stops there
 * too; the rest is never read.
 * @param {Response} response
 * @param {AbortController} abort
 * @returns {Promise<string | null>}
 */
async function readCapped(response, abort) {
  const length = Number(response.headers.get("Content-Length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) {
    abort.abort();
    return null;
  }
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      abort.abort();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function runCheck() {
  const where = await installInfo();
  if (!enabled()) return finish({ outcome: "off", reason: null, offer: null });
  if (where.type === "source") return finish({ outcome: "source", reason: null, offer: null });
  /** @param {string} reason */
  const refuse = (reason) =>
    finish({ outcome: "refused", reason, offer: null, refusals: state.refusals + 1 });
  /** @type {string} */
  let text;
  // AbortSignal.timeout needs a window; a system module has none.
  const abort = new AbortController();
  const timer = lazy.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(manifestUrl(), {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      // A static manifest never moves: a redirect to http or another host is refused (decision 30).
      redirect: "error",
      // Necko adds the profile's languages; an empty value says nothing about the user.
      headers: { "Accept-Language": "" },
      signal: abort.signal,
    });
    if (!response.ok) {
      // A 404 is what updates.vimma.dev answers until a release publishes a manifest for the
      // channel; say that rather than a bare status code.
      return finish({
        outcome: "unreachable",
        reason:
          response.status === 404
            ? "no update manifest is published for this channel (404)"
            : `the update host answered ${response.status}`,
      });
    }
    const body = await readCapped(response, abort);
    if (body === null) return refuse(TOO_LARGE);
    text = body;
  } catch (e) {
    const why = /** @type {any} */ (e)?.message ?? String(e);
    return finish({ outcome: "unreachable", reason: `the update host did not answer: ${why}` });
  } finally {
    lazy.clearTimeout(timer);
  }
  const verified = await verifyManifest(text, pinnedKeys(), crypto.subtle);
  if (!verified.ok) return refuse(verified.reason);
  const parsed = parseManifest(verified.body);
  if (!parsed.ok) return refuse(parsed.reason);
  const stored = Services.prefs.getStringPref(SERIAL_PREF, "") || null;
  const judged = judgeManifest(
    parsed.manifest,
    {
      channel: channel(),
      target: target(),
      appVersion: Services.appinfo.version,
      buildId: Services.appinfo.appBuildID,
      serial: stored,
      now: Date.now(),
    },
    (a, b) => Services.vc.compare(a, b),
  );
  if (!judged.ok) return refuse(judged.reason);
  Services.prefs.setStringPref(SERIAL_PREF, judged.serial);
  verifiedBuildId = judged.offer?.buildId ?? null;
  return finish({
    outcome: judged.offer ? "offer" : "current",
    reason: null,
    offer: judged.offer,
    serial: judged.serial,
    key: verified.key,
    refusals: 0,
  });
}

/**
 * The file's SHA-512 as lower-case hex. It is read in pieces (IOUtils reads off the main thread;
 * each piece is hashed on it), so an AppImage (about 110 MB) is never held in memory whole and
 * no single step blocks a window for long.
 * @param {string} path
 */
async function sha512File(path) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA512);
  for (let offset = 0; ;) {
    const bytes = await IOUtils.read(path, { offset, maxBytes: WRITE_CHUNK });
    if (!bytes.byteLength) break;
    hash.update(/** @type {any} */ (bytes), bytes.byteLength);
    offset += bytes.byteLength;
  }
  const binary = hash.finish(false);
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Downloads `url` into `part`, which the caller created empty, anonymously, stopping past `size`
 * bytes or after STALL_MS without data. Every write is synced, so the file is on disk before
 * the rename makes it the AppImage.
 * @param {string} url @param {string} part @param {number} size
 */
async function download(url, part, size) {
  const abort = new AbortController();
  const started = Date.now();
  let complete = false;
  let stall = lazy.setTimeout(() => abort.abort(), STALL_MS);
  const alive = () => {
    lazy.clearTimeout(stall);
    stall = lazy.setTimeout(() => abort.abort(), STALL_MS);
  };
  /** @param {Uint8Array} bytes */
  const write = (bytes) => IOUtils.write(part, bytes, { mode: "append", flush: true });
  try {
    const response = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Accept-Language": "" },
      signal: abort.signal,
    });
    // GitHub answers a release download with a redirect to its asset host: the redirect is
    // followed, but the file must arrive over https.
    if (!response.url.startsWith("https://")) throw new Error("the download left https");
    if (!response.ok) throw new Error(`the download host answered ${response.status}`);
    const length = response.headers.get("Content-Length");
    // A compressed response's length is not the file's; the bytes read are counted below anyway.
    if (length !== null && !response.headers.get("Content-Encoding") && Number(length) !== size) {
      throw new Error(`the download is ${length} bytes, the signed manifest says ${size}`);
    }
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    /** @type {Uint8Array[]} */
    let pending = [];
    let buffered = 0;
    let total = 0;
    const flush = async () => {
      const bytes = new Uint8Array(buffered);
      let at = 0;
      for (const c of pending) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      pending = [];
      buffered = 0;
      await write(bytes);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      alive();
      if (!enabled()) throw new Error("update checks were turned off");
      if (Date.now() - started > DOWNLOAD_MAX_MS) throw new Error("the download took too long");
      total += value.byteLength;
      if (total > size) {
        await reader.cancel().catch(() => {});
        throw new Error(`the download is larger than the signed ${size} bytes`);
      }
      pending.push(value);
      buffered += value.byteLength;
      if (buffered >= WRITE_CHUNK) await flush();
    }
    if (buffered) await flush();
    complete = true;
  } catch (e) {
    if (abort.signal.aborted) throw new Error("the download stalled", { cause: e });
    throw e;
  } finally {
    lazy.clearTimeout(stall);
    // A failed write (a full disk) or a refusal: the response is not read on.
    if (!complete) abort.abort();
  }
}

/** @param {Partial<typeof replacement>} next */
function setReplacement(next) {
  replacement = { ...replacement, ...next };
  if (replacement.reason) console.warn(`vimma: AppImage update: ${replacement.reason}`);
  notify();
}

/**
 * Replaces `$APPIMAGE` with the offered build (decision 19): a hidden part file next to it,
 * checked against the signed size and SHA-512, mode 0755, then renamed over the file. Anything
 * that fails leaves the AppImage as it was, removes the part file, and falls back to the steps
 * `:update` shows; the next check tries again.
 * @param {() => void} decided  called once the stage is known (pending, or done without a download)
 */
async function replaceAppImage(decided) {
  const where = await installInfo();
  const offer = state.offer;
  if (where.type !== "appimage" || !offer || !enabled()) return;
  if (offer.buildId !== verifiedBuildId) return;
  if (replacement.stage === "staged" && replacement.buildId === offer.buildId) return;
  const plan = appImagePlan({
    installType: where.type,
    marker: where.marker,
    appImage: where.appImage,
    appDir: where.appDir,
    greDir: where.installDir,
    offer,
    automation: inAutomation(),
    forced: where.forced,
  });
  if (!plan.ok) {
    setReplacement({ stage: "none", buildId: offer.buildId, reason: plan.why });
    return;
  }
  const expected = { size: plan.size, sha512: plan.sha512 };
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(plan.target);
    // A rename would replace the link itself and leave the file it names as it was.
    if (file.isSymlink()) throw new Error("$APPIMAGE is a symbolic link");
    const info = await IOUtils.stat(plan.target);
    if (info.type !== "regular") throw new Error("$APPIMAGE is not a regular file");
    // Already replaced, by this Vimma before a session restore or by another one running the
    // same file: nothing to download.
    if (
      info.size === plan.size &&
      !downloadProblem(expected, { size: info.size, sha512: await sha512File(plan.target) })
    ) {
      setReplacement({ stage: "staged", buildId: offer.buildId, reason: null });
      return;
    }
  } catch (e) {
    const why = /** @type {any} */ (e)?.message ?? String(e);
    setReplacement({
      stage: "none",
      buildId: offer.buildId,
      reason: `cannot read $APPIMAGE: ${why}`,
    });
    return;
  }
  await removeLeftovers(plan.target);
  /** @type {string} */
  let part;
  try {
    // A name no other file has (createUniqueFile adds a number), created by this process alone:
    // a second Vimma running the same AppImage downloads into a file of its own.
    part = await IOUtils.createUniqueFile(
      /** @type {string} */ (PathUtils.parent(plan.target)),
      PathUtils.filename(plan.part),
      0o600,
    );
  } catch (e) {
    const why = /** @type {any} */ (e)?.message ?? String(e);
    setReplacement({
      stage: "none",
      buildId: offer.buildId,
      reason: `cannot write next to the AppImage: ${why}`,
    });
    return;
  }
  setReplacement({ stage: "pending", buildId: offer.buildId, reason: null });
  decided();
  let ours = true;
  try {
    await download(plan.url, part, plan.size);
    const size = (await IOUtils.stat(part)).size;
    const problem = downloadProblem(expected, { size, sha512: await sha512File(part) });
    if (problem) throw new Error(problem);
    await IOUtils.setPermissions(part, 0o755);
    // The offer may have changed while the file downloaded (a newer check, checks turned off).
    if (state.offer?.buildId !== offer.buildId || !enabled()) {
      throw new Error("the offer changed during the download");
    }
    await IOUtils.move(part, plan.target);
    ours = false;
    setReplacement({ stage: "staged", buildId: offer.buildId, reason: null });
  } catch (e) {
    const why = /** @type {any} */ (e)?.message ?? String(e);
    setReplacement({ stage: "none", buildId: offer.buildId, reason: why });
  } finally {
    if (ours) await IOUtils.remove(part).catch(() => {});
  }
}

/**
 * Removes part files next to `target` that a killed run left (older than STALE_PART_MS), so
 * they do not pile up at about 110 MB each.
 * @param {string} target
 */
async function removeLeftovers(target) {
  const dir = /** @type {string} */ (PathUtils.parent(target));
  const children = await IOUtils.getChildren(dir).catch(() => []);
  for (const path of children) {
    if (!/^\.vimma-update-\d+(?:-\d+)?\.AppImage(?:-\d+)?\.part$/.test(PathUtils.filename(path)))
      continue;
    const info = await IOUtils.stat(path).catch(() => null);
    if (info?.type === "regular" && Date.now() - info.lastModified > STALE_PART_MS) {
      await IOUtils.remove(path).catch(() => {});
    }
  }
}

/**
 * How far the AppImage got with the offer shown now. An AppImage offer it has not tried yet
 * counts as pending, so the one-time message waits for the outcome instead of showing a
 * command the replacement is about to make unnecessary.
 * @returns {Stage}
 */
function stage() {
  const offer = state.offer;
  if (!offer) return "none";
  if (replacement.buildId === offer.buildId) return replacement.stage;
  return knownType === "appimage" && enabled() && offer.buildId === verifiedBuildId
    ? "pending"
    : "none";
}

/**
 * Starts the AppImage's replacement when one is due, one at a time.
 * @returns {Promise<void>} resolves once the stage is known, before any download ends
 */
function maybeReplace() {
  if (knownType !== "appimage" || !state.offer) return Promise.resolve();
  // A newer offer arrived during an older one's download: its turn comes when that one ends.
  if (replacing && replacingFor !== state.offer.buildId) {
    replacing.then(() => maybeReplace());
    return Promise.resolve();
  }
  if (!replacing) {
    replacingFor = state.offer.buildId;
    /** @type {() => void} */
    let decided = () => {};
    replacingDecided = new Promise((resolve) => {
      decided = resolve;
    });
    replacing = replaceAppImage(decided)
      .catch((e) => console.error("vimma: AppImage update failed", e))
      .finally(() => {
        decided();
        replacing = null;
      });
  }
  return replacingDecided;
}

/** A due check found config.toml not read yet: configure() runs it. */
let waitingForConfig = false;

/** Checks when one is due (core checkDue): at startup and on the hourly timer. */
async function maybeCheck() {
  const where = await installInfo();
  // Before config.toml is read, its `[updates] check = false` is unknown: no request until it is.
  if (configCheck === null && !held) {
    waitingForConfig = true;
    return;
  }
  const due = checkDue({
    enabled: enabled(),
    installType: where.type,
    okAt: state.okAt,
    triedAt: state.checkedAt,
    now: Date.now(),
    intervalSeconds: Services.prefs.getIntPref(INTERVAL_PREF, 43200),
  });
  if (due) await VimmaUpdates.check();
  // A verified offer the AppImage has not tried yet (a newer check came during a download). A
  // failed attempt waits for the next check, not the hourly timer.
  else if (verifiedBuildId === state.offer?.buildId && replacement.buildId !== verifiedBuildId) {
    maybeReplace();
  }
}

export const VimmaUpdates = {
  /**
   * Once per process (vimma.js): the saved result now; a check STARTUP_CHECK_MS after the first
   * window's delayed startup if one is due, then the hourly question whether one is due.
   */
  init() {
    if (started) return;
    started = true;
    load();
    const tick = () => maybeCheck().catch((e) => console.error("vimma: update check failed", e));
    firstWindow = () => {
      if (firstWindow) Services.obs.removeObserver(firstWindow, "browser-delayed-startup-finished");
      firstWindow = null;
      firstTimer = lazy.setTimeout(tick, STARTUP_CHECK_MS);
    };
    Services.obs.addObserver(firstWindow, "browser-delayed-startup-finished");
    pollTimer = lazy.setInterval(tick, POLL_MS);
    Services.obs.addObserver(() => {
      if (firstWindow) Services.obs.removeObserver(firstWindow, "browser-delayed-startup-finished");
      firstWindow = null;
      lazy.clearTimeout(firstTimer);
      lazy.clearTimeout(offTimer);
      lazy.clearInterval(pollTimer);
    }, "quit-application");
  },

  /**
   * `[updates]` of the config in force (ConfigHost, through core updatesCheckAfterRead).
   * @param {{ check: boolean, held?: boolean }} updates
   */
  configure(updates) {
    const heldNow = updates.held === true;
    if (configCheck === updates.check && held === heldNow) return;
    configCheck = updates.check;
    held = heldNow;
    notify();
    if (waitingForConfig) {
      waitingForConfig = false;
      maybeCheck().catch((e) => console.error("vimma: update check failed", e));
    }
  },

  /**
   * Checks now (`:update`, the timer), one check at a time.
   * @returns {Promise<UpdateState>}
   */
  check() {
    running ??= runCheck()
      .then(async (result) => {
        await maybeReplace();
        return result;
      })
      .finally(() => {
        running = null;
      });
    return running;
  },

  /** The status bar's update segment (core updateNotice), or null. @returns {UpdateNotice | null} */
  notice() {
    if (!knownType) return null;
    const on = enabled();
    const off = offNotice({
      enabled: on,
      installType: knownType,
      since: offSince,
      now: Date.now(),
    });
    if (offSince === null && off.since !== null) {
      offSince = off.since;
      // Redraw every status bar when the notice ends.
      offTimer = lazy.setTimeout(notify, OFF_NOTICE_MS);
    }
    return updateNotice({
      enabled: on,
      installType: knownType,
      offer: state.offer,
      refusals: state.refusals,
      staleDays: state.serial ? staleDays(state.serial, channel(), Date.now()) : null,
      staged: stage() === "staged",
      offShown: off.shown,
    });
  },

  /** What about:vimma shows. */
  async describe() {
    const where = await installInfo();
    const { offer } = state;
    return {
      enabled: enabled(),
      from: held ? "config-errors" : configCheck === false ? "config" : "pref",
      installType: where.type,
      channel: channel(),
      intervalHours: Services.prefs.getIntPref(INTERVAL_PREF, 43200) / 3600,
      checkedAt: state.checkedAt,
      outcome: state.outcome,
      reason: state.reason,
      offer: offer
        ? {
            line: updateVersionLine(offer),
            urgent: offer.urgent,
            advisories: offer.advisories,
            steps:
              stage() === "staged" ? stagedSteps(offer) : updateSteps(where.type, offer, where),
          }
        : null,
      // The AppImage's own replacement (decision 19): under way, done, or why it failed.
      appImage:
        where.type === "appimage" && offer
          ? {
              stage: stage(),
              reason: replacement.buildId === offer.buildId ? replacement.reason : null,
            }
          : null,
      serial: state.serial,
      key: state.key,
      pinnedKeys: pinnedKeys().length,
    };
  },

  /**
   * `$APPIMAGE` when this Vimma is the AppImage it names, else null: what `:restart` starts
   * again (core ownAppImage, the replacement's own rule).
   * @returns {Promise<string | null>}
   */
  async ownAppImage() {
    await installInfo();
    return this.ownAppImageNow;
  },

  /** ownAppImage, synchronously: null until the install is known. */
  get ownAppImageNow() {
    const where = knownWhere;
    if (!where) return null;
    return ownAppImage({
      installType: where.type,
      marker: where.marker,
      appImage: where.appImage,
      appDir: where.appDir,
      greDir: where.installDir,
      forced: where.forced,
    });
  },

  /** How this copy was installed, once known (null before the first look). */
  get installType() {
    return knownType;
  },

  /** Vimma's own version (version_display.txt), as about:vimma shows it. */
  get runningVersion() {
    return /** @type {string} */ (lazy.AppConstants.MOZ_APP_VERSION_DISPLAY);
  },

  /** The current result, synchronously (tests, the status bar). */
  status() {
    return {
      ...state,
      stage: stage(),
      enabled: enabled(),
      from: held ? "config-errors" : configCheck === false ? "config" : "pref",
    };
  },

  /** @param {() => void} fn  called after every check and configure */
  addListener(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Test-only: read the saved result again, as at startup. */
  _load() {
    load();
    notify();
  },

  /** Test-only: what the startup check does, without its delay. */
  _startupCheck() {
    return maybeCheck();
  },

  /** Test-only: the AppImage replacement under way, if any. */
  _replacing() {
    return replacing ?? Promise.resolve();
  },

  /** Test-only: forget every result and the cached install type. */
  _reset() {
    state = fresh();
    replacement = { stage: "none", buildId: null, reason: null };
    verifiedBuildId = null;
    install = null;
    knownType = null;
    knownWhere = null;
    lazy.clearTimeout(offTimer);
    offSince = null;
    Services.prefs.clearUserPref(SERIAL_PREF);
    Services.prefs.clearUserPref(LAST_PREF);
    notify();
  },
};
