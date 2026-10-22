/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Downloads from the agent workspace, asked and quarantined (docs/specs/vimma-mcp.md decision
// 31; docs/security.md M11-M13): an agent may download, and only what it downloads safely. All
// through Firefox's own hooks, no upstream patch:
// - Where the bytes go: every agent tab's top browsing context has `downloadFolderOverride` set
//   to the quarantine folder (AgentPages), which nsExternalAppHandler reads for its `.part` file
//   (uriloader/exthandler/nsExternalHelperAppService.cpp, GetInitialDownloadDirectory), and the
//   helper-app dialog (`@mozilla.org/helperapplauncherdialog;1`) is wrapped so an agent tab's
//   download is never shown Firefox's "open with" dialog and its final name is in the
//   quarantine too, as WebDriver BiDi's own handler does (remote/webdriver-bidi/
//   HelperAppDialogHandler.sys.mjs).
// - Integration.downloads (toolkit/components/downloads/DownloadCore.sys.mjs, Download.start
//   and _checkReputationAndMove): `shouldBlockForParentalControls` is the question (before the
//   saver runs: https only, in the quarantine, the size cap, the name and type checks);
//   `shouldBlockForReputationCheck` runs on the finished `.part` before it gets its name (the
//   first bytes, a zip's names, ClamAV); `downloadDone` sets mode 0600; `launchDownload` refuses
//   to open an agent download, ever.
// A download is the agent's when the tab it came from was opened by an agent connection that is
// still open; otherwise it asks as "a page in the agent workspace", with no grant.

import {
  DOWNLOAD_TOOL,
  HEAD_BYTES,
  ZIP_TAIL_BYTES,
  clamArguments,
  clamDefinitionsDate,
  clamVerdict,
  clamVersionArguments,
  clamdArguments,
  clamdConfig,
  clamdSocketTrusted,
  dangerousContent,
  dangerousName,
  dangerousType,
  displayDir,
  passwdUid,
  downloadRefusedNotice,
  downloadSavedNotice,
  quarantineProblem,
  resolveDownloadDir,
  staleDefinitions,
  zipEntryList,
  zipLocate,
  zipVerdict,
} from "../core/agent-downloads.mjs";
import { DEFAULT_CONFIG } from "../core/defaults.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { AgentGate } from "./AgentGate.sys.mjs";

/** @import { Refusal, Danger } from "../core/agent-downloads.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  Integration: "resource://gre/modules/Integration.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  ctypes: "resource://gre/modules/ctypes.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  nsUnknownContentTypeDialog: "resource://gre/modules/HelperAppDlg.sys.mjs",
});

const DEFAULT_DIR = /** @type {string} */ (DEFAULT_CONFIG.mcp?.download_dir);
const DEFAULT_MAX_MB = /** @type {number} */ (DEFAULT_CONFIG.mcp?.download_max_mb);
const DEFAULT_MAX_AGE_DAYS = /** @type {number} */ (DEFAULT_CONFIG.mcp?.clamav_max_age_days);
/** How often a part file is measured while its question waits (the cap, decision 31 f). */
const WATCH_MS = 250;
/** The longest ClamAV may take on one file before it counts as an error. */
const CLAM_TIMEOUT_MS = 5 * 60 * 1000;
/** Test-only: ClamAV's time limit in ms. */
const CLAM_TIMEOUT_PREF = "vimma.mcp.clamTimeoutMs";
/**
 * The only clamscan Vimma runs (security.md C2's one exception, M13): the
 * system's, never one found on PATH, and only when the user cannot write it or its folder.
 */
const CLAM_PATHS = Object.freeze(["/usr/bin/clamscan", "/usr/local/bin/clamscan"]);
/** The only clamdscan Vimma runs, checked as clamscan is (decision 45). */
const CLAMD_PATHS = Object.freeze(["/usr/bin/clamdscan", "/usr/local/bin/clamdscan"]);
/** The clamd config clamdscan is pointed at, checked as the scanners are (decision 45). */
const CLAMD_CONF = "/etc/clamav/clamd.conf";
/** How long after agent-open a download counts as that open's (security.md M11). */
const OPENER_MS = 60_000;

/**
 * @typedef {{ conn: string | number | null, name: string, what: Record<string, any>,
 *   allowedKind: string | null, scan: "none" | "clean" | "stale" | "partial" | "error",
 *   refused: boolean }} Tracked
 */

/** The agent downloads let through the question, until they are done. */
/** @type {WeakMap<any, Tracked>} */
const tracked = new WeakMap();
/**
 * The load an agent connection started in a tab (agent-open): a download is that connection's
 * only when it is that load (its URL, before redirects), soon after; once, and never after the
 * tab showed a page (security.md M11).
 * @type {WeakMap<Element, { conn: string | number, url: string, at: number }>}
 */
const openers = new WeakMap();
/** Content-Length by quarantine path, from the helper-app launcher (it knows it first). */
/** @type {Map<string, number>} */
const lengths = new Map();
let initialised = false;
/**
 * The quarantine folder's check (decision 31 b; security.md M12): made,
 * mode 0700 after a chmod (which fails on a folder that is not the user's), or why not.
 * @type {{ dir: string, problem: string | null } | null}
 */
let folder = null;

const services = /** @type {any} */ (Services);

/** @param {number | null | undefined} userContextId */
function isAgentContainer(userContextId) {
  const agent = WorkspaceStore.agent?.userContextId;
  return typeof agent === "number" && agent > 0 && userContextId === agent;
}

const home = () => services.dirsvc.get("Home", Ci.nsIFile).path;

/** The quarantine folder (decision 31 b): `[mcp] download_dir`, expanded. */
function quarantineDir() {
  return resolveDownloadDir(McpHost.config?.downloadDir ?? DEFAULT_DIR, home());
}

/** Where an agent tab's bytes go while the quarantine folder is not usable: the profile's. */
const refusedDir = () => PathUtils.join(PathUtils.profileDir, "vimma-agent-refused");

/** Why `dir` is not a quarantine, from its place alone (no disk), or null. @param {string} dir */
function placeProblem(dir) {
  const fixed = quarantineProblem(dir, home());
  if (fixed) return fixed;
  /** @type {string[]} */
  const downloads = [];
  try {
    downloads.push(services.dirsvc.get("DfltDwnld", Ci.nsIFile).path);
  } catch {
    // No default downloads folder on this system.
  }
  const pref = Services.prefs.getStringPref("browser.download.dir", "");
  if (pref) downloads.push(pref);
  return downloads.includes(dir) ? "must not be the Downloads folder itself" : null;
}

/**
 * The folder an agent tab downloads into (its `downloadFolderOverride`): the quarantine, or the
 * profile's refusal folder while the quarantine is not usable (its downloads are then refused).
 */
function overrideDir() {
  const dir = quarantineDir();
  if (placeProblem(dir)) return refusedDir();
  if (folder?.dir === dir && folder.problem) return refusedDir();
  return dir;
}

/**
 * Check the quarantine folder now: why it is not usable, or null. It is made if missing, then
 * chmod 0700: a folder of another user fails the chmod, and the mode is read back. It fails
 * closed: any error is a problem.
 * @returns {Promise<string | null>}
 */
async function checkFolder() {
  const dir = quarantineDir();
  let problem = placeProblem(dir);
  if (!problem) {
    try {
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
      try {
        await IOUtils.setPermissions(dir, 0o700, false);
      } catch {
        problem = "it is not yours";
      }
      if (!problem && ((await IOUtils.stat(dir)).permissions & 0o777) !== 0o700) {
        problem = "it is not private (mode 0700)";
      }
    } catch (e) {
      problem = `it cannot be made (${/** @type {Error} */ (e).message})`;
    }
  }
  folder = { dir, problem };
  if (problem) {
    console.error(`vimma: the agent downloads' quarantine ${dir} is not usable: ${problem}`);
    await IOUtils.makeDirectory(refusedDir(), {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700,
    }).catch(() => {});
  }
  return problem;
}

/** The cap in bytes (decision 31 f). */
const capMb = () => McpHost.config?.downloadMaxMb ?? DEFAULT_MAX_MB;
const capBytes = () => capMb() * 1_000_000;

/** Firefox's own executable list (nsIApplicationReputationService.isExecutable). */
function isExecutable(/** @type {string} */ name) {
  try {
    return Cc["@mozilla.org/reputationservice/application-reputation-service;1"]
      .getService(Ci.nsIApplicationReputationService)
      .isExecutable(name);
  } catch {
    return false;
  }
}

/** Whether a path is in the quarantine folder or the refusal folder. @param {string} [path] */
const inOurFolders = (path) =>
  !!path && [quarantineDir(), refusedDir()].includes(PathUtils.parent(path) ?? "");

/**
 * Whether a download is an agent download (security.md M11): its container,
 * its tab's container, or being written to the quarantine (or refusal) folder.
 * @param {any} download
 */
function isAgentDownload(download) {
  if (isAgentContainer(download?.source?.userContextId)) return true;
  try {
    const bc = BrowsingContext.get(download?.source?.browsingContextId);
    if (isAgentContainer(bc?.top?.originAttributes?.userContextId)) return true;
  } catch {
    // No such browsing context any more.
  }
  return inOurFolders(download?.target?.path) || inOurFolders(download?.target?.partFilePath);
}

/** @param {any} download  the download's name, as saved */
const nameOf = (download) => PathUtils.filename(download.target.path);

/**
 * The agent connection a download belongs to: the one whose agent-open started this very load
 * (its URL before redirects, within OPENER_MS), if still connected. Used once.
 * @param {any} download
 */
function connOf(download) {
  try {
    const bc = BrowsingContext.get(download.source.browsingContextId);
    const browser = bc?.top?.embedderElement;
    const opened = browser ? openers.get(browser) : undefined;
    if (!browser || !opened) return null;
    openers.delete(browser);
    const urls = [download.source.url, download.source.originalUrl];
    if (Date.now() - opened.at > OPENER_MS || !urls.includes(opened.url)) return null;
    return AgentGate.isConnected(opened.conn) ? opened.conn : null;
  } catch {
    return null;
  }
}

/**
 * What is known of a download's size before its body: -1 when unknown.
 * @param {any} download @param {boolean} [take]  forget the launcher's length once read
 */
function knownSize(download, take = true) {
  const saver = download.saver ?? {};
  const fromLauncher = lengths.get(download.target.path);
  if (take) lengths.delete(download.target.path);
  for (const n of [
    fromLauncher,
    download.totalBytes,
    saver.totalBytes,
    saver.request?.contentLength,
  ]) {
    if (typeof n === "number" && n > 0) return n;
  }
  return -1;
}

/** The part file's size now, or 0. @param {any} download */
async function partSize(download) {
  const path = download.target.partFilePath ?? download.target.path;
  try {
    return (await IOUtils.stat(path)).size ?? 0;
  } catch {
    return 0;
  }
}

/** Never launch, never "open with", never shown in Firefox's viewer (decision 31 c). */
function neutralise(/** @type {any} */ download) {
  download.launchWhenSucceeded = false;
  download.launcherPath = null;
  download.launcherId = null;
  download.handleInternally = false;
}

/** @param {string} text */
const notice = (text) => AgentGate.notify(text);

/** Whether `path` is an empty file, as Firefox's own placeholder test. @param {string} path */
const isEmpty = (path) =>
  IOUtils.stat(path).then(
    (st) => st.size === 0,
    () => false,
  );

/**
 * A refused download: its channel stopped, its part and placeholder deleted, and taken off the
 * downloads list (the notice says why, not Firefox's "blocked by parental controls").
 * @param {any} download
 */
async function discard(download) {
  for (let i = 0; i < 400 && !download.stopped; i++) {
    await new Promise((r) => lazy.setTimeout(r, 25));
  }
  // A helper-app download refused before its saver ran still has its channel open: cancel it,
  // and wait for the channel to stop before the part file is removed (it writes until then).
  const executed = download.saver?.deferExecuted?.promise;
  executed?.catch(() => {});
  try {
    download.saver?.cancel?.();
  } catch {
    // Already stopped.
  }
  if (executed) {
    await Promise.race([executed.catch(() => {}), new Promise((r) => lazy.setTimeout(r, 5000))]);
  }
  await download.finalize(true).catch(() => {});
  for (const path of [download.target.partFilePath, download.target.path]) {
    if (inOurFolders(path)) {
      await IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {});
    }
  }
  const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
  await list.remove(download).catch(() => {});
}

/**
 * The question, before the saver runs (DownloadCore's Download.start awaits this hook):
 * true refuses the download.
 * @param {any} download
 * @returns {Promise<boolean>}
 */
async function admit(download) {
  neutralise(download);
  const name = nameOf(download);
  /** @param {Refusal} why */
  const refuse = (why) => {
    notice(downloadRefusedNotice(name, why));
    discard(download);
    return true;
  };
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(download.source.url);
  } catch {
    // Not a URL: refused below.
  }
  if (url?.protocol !== "https:") return refuse({ kind: "http" });
  const problem = await checkFolder();
  if (problem) return refuse({ kind: "folder", text: problem });
  const dir = quarantineDir();
  const part = download.target.partFilePath;
  if (PathUtils.parent(download.target.path) !== dir || (part && PathUtils.parent(part) !== dir)) {
    return refuse({ kind: "place" });
  }
  // A legacy (helper-app) download learns its channel just after it starts: wait for it, so the
  // question has the size the server gave.
  for (
    let i = 0;
    i < 40 && download.saver?.request === null && knownSize(download, false) < 0;
    i++
  ) {
    await new Promise((r) => lazy.setTimeout(r, 25));
  }
  const size = knownSize(download);
  if (size > capBytes()) return refuse({ kind: "cap", mb: capMb() });
  const ext = (/\.([^./]{1,16})$/.exec(name)?.[1] ?? "").toLowerCase();
  const danger = dangerousName(name, { isExecutable }) ?? dangerousType(download.contentType);
  const what = {
    name,
    size,
    type: download.contentType ?? "",
    ext,
    host: url.host,
    ...(danger ? { danger: danger.text } : {}),
  };
  const conn = connOf(download);
  // The cap while the question waits (decision 31 f): the bytes keep coming meanwhile.
  /** @type {(() => void) | null} */
  let withdraw = null;
  let capped = false;
  const watch = lazy.setInterval(async () => {
    if ((await partSize(download)) > capBytes() && withdraw) {
      capped = true;
      withdraw();
    }
  }, WATCH_MS);
  const options = { always: !!danger, onCancel: (/** @type {() => void} */ c) => (withdraw = c) };
  let outcome;
  try {
    outcome =
      conn === null
        ? await AgentGate.askPage(DOWNLOAD_TOOL, what, options)
        : await AgentGate.request(conn, DOWNLOAD_TOOL, what, options);
  } finally {
    lazy.clearInterval(watch);
  }
  if (capped || (await partSize(download)) > capBytes())
    return refuse({ kind: "cap", mb: capMb() });
  if (!outcome.allow) {
    // The gate's own notice says no, timeout or mute; busy and muted are said here.
    if (outcome.reason === "busy" || outcome.reason === "muted") {
      notice(`refused download "${name}": agent requests ${outcome.reason}`);
    }
    discard(download);
    return true;
  }
  tracked.set(download, {
    conn,
    name,
    what,
    allowedKind: danger?.kind ?? null,
    scan: "none",
    refused: false,
  });
  return false;
}

/**
 * Block a finished agent download, for _checkReputationAndMove: its `.part` and the empty
 * placeholder Firefox made at its name are deleted before the verdict returns, so nothing of it
 * is left once the download has stopped. Firefox itself keeps the placeholder (its
 * shouldKeepBlockedData is true for Firefox's app ID and takes no download to answer per file).
 * @param {any} download @param {Refusal} why
 */
async function block(download, why) {
  const t = tracked.get(download);
  if (t) t.refused = true;
  const { partFilePath, path } = download.target;
  await IOUtils.remove(partFilePath ?? path, { ignoreAbsent: true }).catch(() => {});
  if (partFilePath && inOurFolders(path) && (await isEmpty(path))) {
    await IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {});
  }
  notice(downloadRefusedNotice(nameOf(download), why));
  // Off the list once it has failed.
  download.whenSucceeded().catch(() => {});
  lazy.setTimeout(() => discard(download), 0);
  return {
    shouldBlock: true,
    verdict: Ci.nsIApplicationReputationService.VERDICT_DANGEROUS,
  };
}

/**
 * What the finished file is (decision 31 d): its first bytes, and a zip's names.
 * @param {string} path @returns {Promise<Danger | null>}
 */
async function contentDanger(path) {
  const size = (await IOUtils.stat(path)).size ?? 0;
  const head = await IOUtils.read(path, { maxBytes: Math.min(size, HEAD_BYTES) });
  const byBytes = dangerousContent(head);
  if (byBytes) return byBytes;
  const start = Math.max(0, size - ZIP_TAIL_BYTES);
  const tail = size ? await IOUtils.read(path, { offset: start, maxBytes: size - start }) : head;
  const at = zipLocate(tail, size);
  if (at.kind === "none") return null;
  if (at.kind === "unlistable") return { kind: "archive", text: "a zip Vimma cannot list" };
  const cd = at.length
    ? await IOUtils.read(path, { offset: at.offset, maxBytes: at.length })
    : new Uint8Array(0);
  const entries = zipEntryList(cd, at.entries);
  if (!entries) return { kind: "archive", text: "a zip Vimma cannot list" };
  return zipVerdict(entries, { isExecutable });
}

/**
 * Whether a file is owned by someone else: a no-op chmod fails on another's.
 * @param {string} path
 */
async function ownedByAnother(path) {
  try {
    const { permissions } = await IOUtils.stat(path);
    await IOUtils.setPermissions(path, permissions, false);
    return false;
  } catch {
    return true;
  }
}

/**
 * The first of `paths` that is a regular file (and executable, when asked) another user (root)
 * owns, that the user cannot write, in a folder the user cannot write: a scanner or config
 * the user's own processes cannot replace. Never one found on PATH. Null when there is none.
 * @param {readonly string[]} paths @param {boolean} trusted  test-only: skip the ownership
 *   and write checks @param {boolean} [executable]
 * @returns {Promise<string | null>}
 */
async function findSystemFile(paths, trusted, executable = true) {
  for (const path of paths) {
    try {
      const file = new lazy.FileUtils.File(path);
      if (!file.exists() || !file.isFile() || file.isSymlink()) continue;
      if (executable && !file.isExecutable()) continue;
      if (trusted) return path;
      if (file.isWritable() || file.parent?.isWritable()) continue;
      if (!(await ownedByAnother(path))) continue;
      return path;
    } catch {
      // Not usable: the next.
    }
  }
  return null;
}

/** The system's clamscan (decision 31 g; C2's one exception), or null. */
function findClam() {
  const hook = AgentDownloads._clamForTests;
  return findSystemFile(hook?.paths ?? CLAM_PATHS, !!hook?.trusted);
}

/** lstat's symbol in libSystem by architecture (XPCOMABI's first part): on x86_64 the plain
 * `lstat` takes the old 32-bit-inode struct; on arm64 there is only the 64-bit-inode one. */
const LSTAT = { aarch64: "lstat", x86_64: "lstat$INODE64" };

/**
 * A socket's type and owner, or null. Neither IOUtils nor nsIFile gives a file's owner, and the
 * no-op chmod of `ownedByAnother` proves only "not the user's", not "root or clamav". Linux
 * uses statx(2), macOS lstat(2); any other system gives null, so clamd is not used there. A
 * symlink is not followed, so it never counts as a socket.
 * @param {string} path
 * @returns {{ isSocket: boolean, uid: number } | null}
 */
function socketOwner(path) {
  const os = Services.appinfo.OS;
  if (os === "Linux") return statxOwner(path);
  if (os === "Darwin") return lstatOwner(path);
  return null;
}

/**
 * statx(2) from glibc. statx is used, not stat, because struct statx has one layout on every
 * architecture (linux/include/uapi/linux/stat.h), where struct stat differs between x86_64 and
 * aarch64.
 * @param {string} path
 * @returns {{ isSocket: boolean, uid: number } | null}
 */
function statxOwner(path) {
  const ctypes = lazy.ctypes;
  /** @type {any} */
  let libc;
  try {
    libc = ctypes.open("libc.so.6");
    const Statx = new ctypes.StructType("statx", [
      { stx_mask: ctypes.uint32_t },
      { stx_blksize: ctypes.uint32_t },
      { stx_attributes: ctypes.uint64_t },
      { stx_nlink: ctypes.uint32_t },
      { stx_uid: ctypes.uint32_t },
      { stx_gid: ctypes.uint32_t },
      { stx_mode: ctypes.uint16_t },
      { spare: ctypes.uint8_t.array(226) },
    ]);
    const statx = libc.declare(
      "statx",
      ctypes.default_abi,
      ctypes.int,
      ctypes.int,
      ctypes.char.ptr,
      ctypes.int,
      ctypes.unsigned_int,
      Statx.ptr,
    );
    const AT_FDCWD = -100;
    const AT_SYMLINK_NOFOLLOW = 0x100;
    const STATX_TYPE_UID = 0x1 | 0x8;
    const st = new Statx();
    if (statx(AT_FDCWD, path, AT_SYMLINK_NOFOLLOW, STATX_TYPE_UID, st.address()) !== 0) {
      return null;
    }
    if ((st.stx_mask & STATX_TYPE_UID) !== STATX_TYPE_UID) return null;
    return { isSocket: (st.stx_mode & 0o170000) === 0o140000, uid: st.stx_uid };
  } catch (e) {
    console.error("vimma: statx failed", e);
    return null;
  } finally {
    libc?.close();
  }
}

/**
 * lstat(2) from libSystem. Darwin's struct stat with 64-bit inodes (`__DARWIN_STRUCT_STAT64` in
 * the SDK's sys/stat.h) is 144 bytes on arm64 and x86_64 alike: st_dev (int32), st_mode
 * (uint16), st_nlink (uint16), st_ino (uint64), st_uid (uint32), st_gid (uint32), then fields
 * this does not read. An architecture not in LSTAT, or a struct of another size, gives null.
 * @param {string} path
 * @returns {{ isSocket: boolean, uid: number } | null}
 */
function lstatOwner(path) {
  const ctypes = lazy.ctypes;
  /** @type {any} */
  let libc;
  try {
    // XPCOMABI throws when it is not known.
    const arch = Services.appinfo.XPCOMABI.split("-")[0] ?? "";
    if (!Object.hasOwn(LSTAT, arch)) return null;
    const symbol = LSTAT[/** @type {keyof typeof LSTAT} */ (arch)];
    libc = ctypes.open("libSystem.B.dylib");
    const Stat = new ctypes.StructType("stat", [
      { st_dev: ctypes.int32_t },
      { st_mode: ctypes.uint16_t },
      { st_nlink: ctypes.uint16_t },
      { st_ino: ctypes.uint64_t },
      { st_uid: ctypes.uint32_t },
      { st_gid: ctypes.uint32_t },
      { rest: ctypes.uint8_t.array(120) },
    ]);
    if (Stat.size !== 144) return null;
    const lstat = libc.declare(symbol, ctypes.default_abi, ctypes.int, ctypes.char.ptr, Stat.ptr);
    const st = new Stat();
    if (lstat(path, st.address()) !== 0) return null;
    return { isSocket: (st.st_mode & 0o170000) === 0o140000, uid: st.st_uid };
  } catch (e) {
    console.error("vimma: lstat failed", e);
    return null;
  } finally {
    libc?.close();
  }
}

/**
 * clamdscan, when clamd can be used (decision 45): a system clamdscan, a system clamd.conf
 * that `clamdConfig` accepts, and its socket owned by root or clamav. Null otherwise.
 * @returns {Promise<{ path: string, conf: string } | null>}
 */
async function findClamd() {
  const hook = AgentDownloads._clamForTests;
  if (hook && !hook.clamd) return null;
  const trusted = !!hook?.trusted;
  const path = await findSystemFile(hook?.clamd?.paths ?? CLAMD_PATHS, trusted);
  if (!path) return null;
  const conf = await findSystemFile([hook?.clamd?.conf ?? CLAMD_CONF], trusted, false);
  if (!conf) return null;
  const read = clamdConfig(await IOUtils.readUTF8(conf).catch(() => ""));
  if ("problem" in read) return null;
  if (trusted) return { path, conf };
  const passwd = await IOUtils.readUTF8("/etc/passwd").catch(() => "");
  const owner = socketOwner(read.socket);
  if (!owner || !clamdSocketTrusted(owner, passwdUid(passwd, "clamav"))) return null;
  return { path, conf };
}

/**
 * @typedef {{ kind: "clean" } | { kind: "infected", signature: string }
 *   | { kind: "partial", reason: string } | { kind: "error", why: string }} ClamAnswer
 */

/**
 * Run one of the scanners with arguments from `clamArguments`, `clamdArguments` or
 * `clamVersionArguments` (the only process Vimma starts, C2), its output read to the end
 * (stdout kept, stderr drained), within the time limit.
 * @param {string} program  from findClam or findClamd @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string } | "late" | null>}  null when it
 *   could not run
 */
async function runProgram(program, args) {
  /** @type {any} */
  let proc;
  /** @type {any} */
  let timer;
  try {
    proc = await lazy.Subprocess.call({ command: program, arguments: args, stderr: "pipe" });
    const ms = Services.prefs.getIntPref(CLAM_TIMEOUT_PREF, 0) || CLAM_TIMEOUT_MS;
    proc.stdin.close().catch(() => {});
    const run = (async () => {
      const drain = (async () => {
        while (await proc.stderr.readString()) {
          // Read and dropped, so a full pipe never stops the scanner.
        }
      })().catch(() => {});
      let stdout = "";
      for (let s; (s = await proc.stdout.readString());) {
        if (stdout.length < 65536) stdout += s;
      }
      await drain;
      const { exitCode } = await proc.wait();
      return { exitCode, stdout };
    })();
    // Past the limit it is killed and not waited for: a child it left may hold the pipes open.
    const late = new Promise((resolve) => {
      timer = lazy.setTimeout(() => resolve(null), ms);
    });
    const done = await Promise.race([run, late]);
    if (!done) {
      run.catch(() => {});
      proc.kill();
      return "late";
    }
    return done;
  } catch (e) {
    console.error("vimma: ClamAV failed", e);
    return null;
  } finally {
    lazy.clearTimeout(timer);
  }
}

/**
 * Why a scanner's definitions are too old to call a scan clean (decisions 43-44), or null.
 * @param {string} program @param {string[]} args  from clamVersionArguments
 */
async function definitionsProblem(program, args) {
  const run = await runProgram(program, args);
  const date = run && run !== "late" && run.exitCode === 0 ? clamDefinitionsDate(run.stdout) : null;
  const maxDays = McpHost.config?.clamavMaxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  return staleDefinitions(date, Date.now(), maxDays);
}

/**
 * A scan's answer, from a run of `runProgram`.
 * @param {{ exitCode: number, stdout: string } | "late" | null} run
 * @returns {ClamAnswer}
 */
function answer(run) {
  if (run === "late") return { kind: "error", why: "ClamAV took too long" };
  const verdict = run ? clamVerdict(run) : { kind: /** @type {const} */ ("error") };
  return verdict.kind === "error" ? { kind: "error", why: "ClamAV failed" } : verdict;
}

/**
 * Scan `path`: with clamd when it can be used and its definitions are current, else with
 * clamscan (decision 45: any clamd failure, stale or undated definitions included, ends in a
 * full clamscan). Null when there is no scanner.
 * @param {string} path
 * @returns {Promise<{ verdict: ClamAnswer, stale: string | null } | null>}
 */
async function scan(path) {
  const clamd = await findClamd();
  if (clamd && !(await definitionsProblem(clamd.path, clamVersionArguments(clamd.conf)))) {
    const verdict = answer(await runProgram(clamd.path, clamdArguments(clamd.conf, path)));
    if (verdict.kind !== "error") return { verdict, stale: null };
  }
  const clam = await findClam();
  if (!clam) return null;
  const stale = await definitionsProblem(clam, clamVersionArguments());
  return { verdict: answer(await runProgram(clam, clamArguments(path))), stale };
}

/**
 * The finished `.part`, before it gets its name (_checkReputationAndMove): the bytes, a second
 * question if they are dangerous and the first was not a `!`, then ClamAV.
 * @param {any} download @param {any} base
 */
async function check(download, base) {
  const t = /** @type {Tracked} */ (tracked.get(download));
  const before = await base.shouldBlockForReputationCheck(download);
  if (before?.shouldBlock) return before;
  const path = download.target.partFilePath ?? download.target.path;
  const size = await IOUtils.stat(path).then(
    (st) => st.size ?? 0,
    () => null,
  );
  if (size === null) return block(download, { kind: "place" });
  if (size > capBytes()) return block(download, { kind: "cap", mb: capMb() });
  const danger = await contentDanger(path).catch((e) => {
    console.error("vimma: agent download check failed", e);
    return { kind: /** @type {const} */ ("archive"), text: "a file Vimma could not read" };
  });
  /**
   * Ask again, as the same agent (or the page), always: no grant covers it.
   * @param {object} more
   */
  const askAgain = (more) => {
    const what = { ...t.what, size, ...more };
    const options = { always: true };
    return AgentGate.isConnected(t.conn)
      ? AgentGate.request(/** @type {string | number} */ (t.conn), DOWNLOAD_TOOL, what, options)
      : AgentGate.askPage(DOWNLOAD_TOOL, what, options);
  };
  // A `!` for one kind of danger is not one for another (security.md M13).
  if (danger && danger.kind !== t.allowedKind) {
    const outcome = await askAgain({ danger: danger.text });
    if (!outcome.allow) return block(download, { kind: "danger", text: danger.text });
  }
  const scanned = await scan(path);
  if (scanned) {
    const { verdict, stale } = scanned;
    if (verdict.kind === "infected") {
      return block(download, { kind: "infected", signature: verdict.signature });
    }
    if (verdict.kind === "partial" || verdict.kind === "error") {
      // What ClamAV could not do is the user's call, default no (security.md M13).
      const unscanned =
        verdict.kind === "partial" ? `not fully scanned (${verdict.reason})` : verdict.why;
      const outcome = await askAgain({ unscanned });
      if (!outcome.allow) {
        return block(download, { kind: "danger", text: `${unscanned}; you said no` });
      }
      t.scan = verdict.kind;
    } else if (stale) {
      // Clean by old definitions is never reported clean (decision 43).
      const outcome = await askAgain({ unscanned: stale });
      if (!outcome.allow) {
        return block(download, { kind: "danger", text: `${stale}; you said no` });
      }
      t.scan = "stale";
    } else {
      t.scan = verdict.kind;
    }
  }
  return before ?? { shouldBlock: false, verdict: "" };
}

/** Over the cap while it streams (decision 31 f): cancelled, its part removed. */
const capView = {
  /** @param {any} download */
  onDownloadChanged(download) {
    const t = tracked.get(download);
    if (!t || t.refused || download.stopped) return;
    if (download.currentBytes > capBytes() || download.totalBytes > capBytes()) {
      t.refused = true;
      notice(downloadRefusedNotice(t.name, { kind: "cap", mb: capMb() }));
      discard(download);
    }
  },
};

/** @param {any} base  DownloadIntegration */
const downloadOverride = (base) => ({
  __proto__: base,
  /** @param {any} download */
  shouldBlockForParentalControls(download) {
    if (!isAgentDownload(download)) return base.shouldBlockForParentalControls(download);
    return admit(download).catch((e) => {
      console.error("vimma: agent download refused", e);
      discard(download);
      return true;
    });
  },
  /** @param {any} download */
  shouldBlockForReputationCheck(download) {
    if (!tracked.has(download)) return base.shouldBlockForReputationCheck(download);
    return check(download, base).catch((e) => {
      console.error("vimma: agent download check failed", e);
      return block(download, { kind: "danger", text: "a file Vimma could not check" });
    });
  },
  /** @param {any} download */
  async downloadDone(download) {
    if (!isAgentDownload(download)) return base.downloadDone(download);
    // No exec bit, no one else (decision 31 c); and no desktop "recent files" entry.
    await IOUtils.setPermissions(download.target.path, 0o600);
    const t = tracked.get(download);
    tracked.delete(download);
    notice(
      downloadSavedNotice({
        name: nameOf(download),
        dir: displayDir(PathUtils.parent(download.target.path) ?? "", home()),
        scan: t?.scan ?? "none",
      }),
    );
    return undefined;
  },
  /** @param {any} download @param {any} options */
  launchDownload(download, options) {
    const dir = quarantineDir();
    if (isAgentDownload(download)) {
      notice(`agent downloads are never opened by Vimma: they are in ${displayDir(dir, home())}`);
      return Promise.reject(new Error("vimma: agent downloads are never opened"));
    }
    return base.launchDownload(download, options);
  },
});

/** Firefox's helper-app dialog (toolkit/mozapps/downloads/HelperAppDlg.sys.mjs). */
const DIALOG_CONTRACT = "@mozilla.org/helperapplauncherdialog;1";
const DIALOG_CID = Components.ID("{6b1a3f3c-6c1e-4d73-9a4f-5f5a1e2b9c41}");

/** Whether a helper-app launcher's download comes from an agent tab. @param {any} launcher */
function fromAgentTab(launcher) {
  try {
    const bc = BrowsingContext.get(launcher.browsingContextId);
    return isAgentContainer(bc?.top?.originAttributes?.userContextId);
  } catch {
    return false;
  }
}

/**
 * An agent tab's download is saved into the quarantine under its suggested name, without a
 * dialog (no "open with").
 * @param {any} launcher @param {string} name @param {string} ext
 */
async function saveToQuarantine(launcher, name, ext) {
  try {
    // Not usable: into the refusal folder, where the question refuses it.
    const dir = (await checkFolder()) ? refusedDir() : quarantineDir();
    const leaf =
      lazy.DownloadPaths.sanitize(name || `download${ext || ""}`, { compressWhitespaces: true }) ||
      "download";
    const file = new lazy.FileUtils.File(PathUtils.join(dir, leaf));
    const target = lazy.DownloadPaths.createNiceUniqueFile(file);
    if (lengths.size > 64) lengths.clear();
    lengths.set(target.path, Number(launcher.contentLength));
    launcher.saveDestinationAvailable(target);
  } catch (e) {
    console.error("vimma: agent download has no place", e);
    launcher.saveDestinationAvailable(null);
  }
}

/**
 * Wraps Firefox's download dialog, constructing upstream's class
 * (toolkit/mozapps/downloads/components.conf) directly: Firefox 158 removed
 * nsIComponentManager.getClassObject, and script cannot create an instance by CID once the
 * contract points at our factory.
 */
function wrapDialog() {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const factory = {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    /** @param {any} iid */
    createInstance(iid) {
      const inner = new lazy.nsUnknownContentTypeDialog();
      const dialog = {
        QueryInterface: ChromeUtils.generateQI(["nsIHelperAppLauncherDialog"]),
        /** @param {any} launcher @param {any} context @param {number} reason */
        show(launcher, context, reason) {
          if (!fromAgentTab(launcher)) return inner.show(launcher, context, reason);
          return launcher.promptForSaveDestination();
        },
        /** @param {any} launcher @param {any} context @param {string} name @param {string} ext
         *  @param {boolean} force */
        promptForSaveToFileAsync(launcher, context, name, ext, force) {
          if (!fromAgentTab(launcher)) {
            return inner.promptForSaveToFileAsync(launcher, context, name, ext, force);
          }
          saveToQuarantine(launcher, name, ext);
          return undefined;
        },
      };
      return dialog.QueryInterface(iid);
    },
  };
  registrar.registerFactory(DIALOG_CID, "Vimma: agent downloads", DIALOG_CONTRACT, factory);
}

export const AgentDownloads = {
  /**
   * Test-only: the clamscan candidates in place of CLAM_PATHS; `clamd`, clamdscan's in place
   * of CLAMD_PATHS and the config in place of CLAMD_CONF (no clamd without it); `trusted` skips
   * the ownership and write checks and the socket's (a test's fakes are the user's own).
   * @type {{ paths: string[], trusted?: boolean,
   *   clamd?: { paths: string[], conf: string } } | null}
   */
  _clamForTests: null,

  /** Test-only: `socketOwner`. @param {string} path */
  _socketOwnerForTests(path) {
    return socketOwner(path);
  },

  /** Once per app (AgentPages.init): the hooks stay for the session. */
  init() {
    if (initialised) return;
    initialised = true;
    lazy.Integration.downloads.register(downloadOverride);
    try {
      wrapDialog();
    } catch (e) {
      console.error("vimma agent downloads: the download dialog is not wrapped", e);
    }
    lazy.Downloads.getList(lazy.Downloads.ALL)
      .then((/** @type {any} */ list) => list.addView(capView))
      .catch(console.error);
  },

  /** The folder agent tabs download into (AgentPages sets it on each tab). */
  overrideDir,

  /** Check (and make) the quarantine folder now: at startup and when `[mcp]` changes. */
  ensureQuarantine() {
    return checkFolder().catch((e) => console.error("vimma: quarantine", e));
  },

  /**
   * An agent connection started loading `url` in this tab (agent-open): a download of that load,
   * soon after, is that connection's, and a grant of its vimma_download covers it.
   * @param {Element} browser @param {string | number} conn @param {string} url
   */
  openedBy(browser, conn, url) {
    openers.set(browser, { conn, url, at: Date.now() });
  },

  /**
   * The tab showed a page: what it downloads from now on is the page's (security.md M11).
   * @param {Element} browser
   */
  committed(browser) {
    openers.delete(browser);
  },
};
