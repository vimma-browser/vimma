/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vimma's update check (spec: docs/specs/m6a-updater.md, delivery 1). Every 12 hours it fetches
// the signed manifest from updates.vimma.dev, verifies it against the keys pinned in this build
// (core/update-keys.mjs) and tells the status bar and about:vimma whether a newer Vimma exists;
// `:update` checks at once, and a start checks a few seconds after the first window is ready
// when the last good check is older than the interval (docs/specs/update-notices.md). It
// downloads and installs nothing. The request is anonymous (no cookies, no cache) and its URL may
// carry only the platform and the update channel. A host that does not answer is logged and
// otherwise quiet; a manifest that fails verification is refused and, three times in a row,
// shown. Pure rules live in core/updates.mjs.

import {
  HOMEBREW_CASKROOM,
  MAX_RESPONSE_BYTES,
  appBundleOf,
  installTypeFrom,
  judgeManifest,
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
import { checkDue } from "../core/update-notices.mjs";

/** @import { InstallType, Offer, PinnedKey, UpdateNotice } from "../core/updates.mjs" */

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
/** @type {Promise<{ type: InstallType, installDir: string, appImage: string | null }> | null} */
let install = null;
/** @type {Set<() => void>} */
const listeners = new Set();
let started = false;
/** @type {unknown} */
let firstTimer = null;
/** @type {((subject: unknown, topic: string) => void) | null} */
let firstWindow = null;
/** @type {unknown} */
let pollTimer = null;

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
    // The status bar and the notices wait for the install type: tell them it is known.
    if (first) notify();
    return where;
  });
  return install;
}

/** @returns {Promise<{ type: InstallType, installDir: string, appImage: string | null }>} */
async function detectInstall() {
  const gre = Services.dirsvc.get("GreD", Ci.nsIFile).path;
  const appImage = Services.env.get("APPIMAGE") || null;
  const forced = inAutomation() ? Services.prefs.getStringPref(TEST_TYPE_PREF, "") : "";
  if (forced) {
    return { type: /** @type {InstallType} */ (forced), installDir: gre, appImage };
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
  return { type, installDir: gre, appImage };
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
  return finish({
    outcome: judged.offer ? "offer" : "current",
    reason: null,
    offer: judged.offer,
    serial: judged.serial,
    key: verified.key,
    refusals: 0,
  });
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
    running ??= runCheck().finally(() => {
      running = null;
    });
    return running;
  },

  /** The status bar's update segment (core updateNotice), or null. @returns {UpdateNotice | null} */
  notice() {
    if (!knownType) return null;
    return updateNotice({
      enabled: enabled(),
      installType: knownType,
      offer: state.offer,
      refusals: state.refusals,
      staleDays: state.serial ? staleDays(state.serial, channel(), Date.now()) : null,
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
            steps: updateSteps(where.type, offer, where),
          }
        : null,
      serial: state.serial,
      key: state.key,
      pinnedKeys: pinnedKeys().length,
    };
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

  /** Test-only: forget every result and the cached install type. */
  _reset() {
    state = fresh();
    install = null;
    knownType = null;
    Services.prefs.clearUserPref(SERIAL_PREF);
    Services.prefs.clearUserPref(LAST_PREF);
    notify();
  },
};
