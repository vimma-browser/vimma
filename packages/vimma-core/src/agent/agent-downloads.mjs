/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Downloads from the agent workspace, pure (docs/specs/vimma-mcp.md, decision 31, sub-PR 2c):
 * what is dangerous (d) by name, type, first bytes and the names inside a zip; ClamAV's answer
 * (g); the quarantine folder (b); the notices (a, g). The browser's ctl/AgentDownloads.sys.mjs
 * reads the bytes and runs the checks; every byte here is the page's choice, so nothing here
 * throws on any input, and the zip lister only reads the central directory, never extracts.
 */

/** The gate's tool for a download: a grant covers it like any other (decision 21). */
export const DOWNLOAD_TOOL = "vimma_download";

/**
 * @typedef {"executable" | "script" | "installer" | "archive"} DangerKind
 * @typedef {{ kind: DangerKind, text: string }} Danger
 */

/** Executables and libraries by extension (decision 31 d), beside Firefox's own list. */
export const EXECUTABLE_EXTENSIONS = Object.freeze([
  "exe",
  "com",
  "scr",
  "dll",
  "so",
  "dylib",
  "bin",
  "run",
  "elf",
  "out",
  "jar",
  "app",
  "ko",
]);
/** Scripts (decision 31 d); `.desktop` launches a command, so it is one. */
export const SCRIPT_EXTENSIONS = Object.freeze([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "ksh",
  "py",
  "pyw",
  "pyz",
  "pl",
  "rb",
  "js",
  "mjs",
  "cjs",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "vbs",
  "wsf",
  "desktop",
  "command",
  "applescript",
  "lua",
  "php",
]);
/** Installers and packages (decision 31 d). */
export const INSTALLER_EXTENSIONS = Object.freeze([
  "deb",
  "rpm",
  "appimage",
  "flatpak",
  "flatpakref",
  "snap",
  "msi",
  "msix",
  "dmg",
  "pkg",
  "apk",
  "xpi",
  "crx",
]);
/**
 * Archives Vimma cannot look inside without a parser it does not ship (decision 31 d): dangerous
 * by default. A zip is listed instead (its central directory).
 */
export const ARCHIVE_EXTENSIONS = Object.freeze([
  "tar",
  "tgz",
  "tbz",
  "tbz2",
  "txz",
  "tzst",
  "gz",
  "bz2",
  "xz",
  "zst",
  "lz",
  "lzma",
  "z",
  "7z",
  "rar",
  "cab",
  "cpio",
  "iso",
  "img",
]);

/** @type {Record<DangerKind, string>} */
const KIND_TEXT = {
  executable: "an executable",
  script: "a script",
  installer: "an installer or package",
  archive: "an archive Vimma cannot look inside",
};

/** @param {DangerKind} kind @param {string} [detail] @returns {Danger} */
const danger = (kind, detail) => ({
  kind,
  text: detail ? `${KIND_TEXT[kind]} (${detail})` : KIND_TEXT[kind],
});

/** Control characters, line breaks and bidi overrides become spaces: one line, read as is. */
// eslint-disable-next-line no-control-regex -- the control characters are what it removes
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;

/** @param {unknown} s  one line, without control or bidi characters, cut at `max` */
function oneLine(s, max = 80) {
  const text = String(s ?? "")
    .replace(UNSAFE, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * A file name's extensions, lower case, last first: `a.tar.gz` → `["gz", "tar"]`. Trailing dots
 * and spaces (which some systems drop) do not hide one.
 * @param {string} name
 */
function extensions(name) {
  const base = String(name ?? "")
    .split(/[/\\]/)
    .pop()
    ?.replace(/[. ]+$/, "")
    .toLowerCase();
  if (!base) return [];
  const parts = base.split(".");
  parts.shift();
  return parts.reverse();
}

/**
 * Whether a file is dangerous by its name (decision 31 d): core's lists, and Firefox's own
 * executable list when the browser passes it (nsIApplicationReputationService.isExecutable).
 * @param {string} name
 * @param {{ isExecutable?: (name: string) => boolean }} [options]
 * @returns {Danger | null}
 */
export function dangerousName(name, { isExecutable } = {}) {
  const [last] = extensions(name);
  if (!last) return null;
  if (SCRIPT_EXTENSIONS.includes(last)) return danger("script");
  if (INSTALLER_EXTENSIONS.includes(last)) return danger("installer");
  if (EXECUTABLE_EXTENSIONS.includes(last)) return danger("executable");
  if (ARCHIVE_EXTENSIONS.includes(last)) return danger("archive");
  try {
    if (isExecutable?.(String(name).replace(/[. ]+$/, ""))) return danger("executable");
  } catch {
    // Firefox's check failed: the name alone decides.
  }
  return null;
}

/** MIME types (decision 31 d), without parameters, lower case. */
const DANGEROUS_TYPES = /** @type {Record<string, DangerKind>} */ ({
  "application/x-executable": "executable",
  "application/x-elf": "executable",
  "application/x-sharedlib": "executable",
  "application/x-pie-executable": "executable",
  "application/x-mach-binary": "executable",
  "application/x-msdownload": "executable",
  "application/x-msdos-program": "executable",
  "application/vnd.microsoft.portable-executable": "executable",
  "application/java-archive": "executable",
  "application/x-sh": "script",
  "application/x-shellscript": "script",
  "text/x-shellscript": "script",
  "text/x-sh": "script",
  "application/x-python": "script",
  "text/x-python": "script",
  "application/x-perl": "script",
  "text/x-perl": "script",
  "application/x-ruby": "script",
  "application/x-bat": "script",
  "application/x-msbatch": "script",
  "application/x-desktop": "script",
  "application/vnd.debian.binary-package": "installer",
  "application/x-debian-package": "installer",
  "application/x-rpm": "installer",
  "application/x-redhat-package-manager": "installer",
  "application/vnd.appimage": "installer",
  "application/x-iso9660-appimage": "installer",
  "application/vnd.flatpak": "installer",
  "application/vnd.snap": "installer",
  "application/x-msi": "installer",
  "application/x-ms-installer": "installer",
  "application/x-apple-diskimage": "installer",
  "application/vnd.android.package-archive": "installer",
  "application/x-xpinstall": "installer",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/x-gzip": "archive",
  "application/x-bzip2": "archive",
  "application/x-xz": "archive",
  "application/zstd": "archive",
  "application/x-7z-compressed": "archive",
  "application/vnd.rar": "archive",
  "application/x-rar-compressed": "archive",
  "application/x-iso9660-image": "archive",
});

/**
 * Whether a file is dangerous by the type its server gave.
 * @param {string | undefined | null} type  a Content-Type
 * @returns {Danger | null}
 */
export function dangerousType(type) {
  const bare = String(type ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  const kind = bare ? DANGEROUS_TYPES[bare] : undefined;
  return kind && Object.hasOwn(DANGEROUS_TYPES, /** @type {string} */ (bare)) ? danger(kind) : null;
}

/** @param {Uint8Array} b @param {number[]} sig @param {number} [at] */
const starts = (b, sig, at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** How many bytes from the start dangerousContent reads. */
export const HEAD_BYTES = 512;

/**
 * Whether a file is dangerous by its first bytes (decision 31 d): ELF, PE, Mach-O, a `#!` line,
 * and archives Vimma cannot list (gzip, xz, bzip2, 7z, rar, zstd, tar).
 * @param {Uint8Array} head  the first HEAD_BYTES bytes (or fewer: the whole file)
 * @returns {Danger | null}
 */
export function dangerousContent(head) {
  if (starts(head, [0x7f, 0x45, 0x4c, 0x46])) return danger("executable", "ELF");
  if (starts(head, [0x4d, 0x5a])) return danger("executable", "PE");
  for (const sig of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ]) {
    if (starts(head, sig)) return danger("executable", "Mach-O");
  }
  if (starts(head, [0x23, 0x21])) return danger("script", "#!");
  if (starts(head, [0x1f, 0x8b])) return danger("archive", "gzip");
  if (starts(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return danger("archive", "xz");
  if (starts(head, [0x42, 0x5a, 0x68])) return danger("archive", "bzip2");
  if (starts(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return danger("archive", "7z");
  if (starts(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return danger("archive", "rar");
  if (starts(head, [0x28, 0xb5, 0x2f, 0xfd])) return danger("archive", "zstd");
  if (starts(head, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return danger("archive", "tar");
  return null;
}

// ---------------------------------------------------------------------------------------------
// The zip lister: the end-of-central-directory record, then the central directory's names.

/** The end record is 22 bytes and its comment at most 65535: the tail to read. */
export const ZIP_TAIL_BYTES = 22 + 0xffff;
/** The largest central directory listed; a bigger one makes the zip dangerous (unlistable). */
export const ZIP_MAX_DIRECTORY = 16 * 1024 * 1024;
/** The most names listed. */
export const ZIP_MAX_ENTRIES = 65534;

/** A byte, 0 past the end. @param {Uint8Array} b @param {number} at */
const byte = (b, at) => b[at] ?? 0;
/** @param {Uint8Array} b @param {number} at */
const u16 = (b, at) => byte(b, at) | (byte(b, at + 1) << 8);
/** @param {Uint8Array} b @param {number} at */
const u32 = (b, at) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/**
 * Where a zip's central directory is, from the file's tail.
 * @param {Uint8Array} tail  the last ZIP_TAIL_BYTES of the file (or all of it)
 * @param {number} size  the file's size
 * @returns {{ kind: "none" } | { kind: "unlistable" }
 *   | { kind: "zip", offset: number, length: number, entries: number }}
 *   `none`: not a zip; `unlistable`: a zip Vimma will not list (zip64, out of bounds, too big)
 */
export function zipLocate(tail, size) {
  const base = size - tail.length;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) !== 0x06054b50) continue;
    const commentLength = u16(tail, i + 20);
    if (i + 22 + commentLength !== tail.length) continue;
    const entries = u16(tail, i + 10);
    const length = u32(tail, i + 12);
    const offset = u32(tail, i + 16);
    if (entries === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
      return { kind: "unlistable" };
    }
    const end = base + i;
    if (offset + length > end || length > ZIP_MAX_DIRECTORY || u16(tail, i + 8) !== entries) {
      return { kind: "unlistable" };
    }
    return { kind: "zip", offset, length, entries };
  }
  return { kind: "none" };
}

/**
 * @typedef {{ name: string, mode: number | null }} ZipEntry  `mode`: the Unix mode `zip` keeps
 *   in the external attributes when the entry was made on Unix (version made by, high byte 3),
 *   else null
 */

/**
 * The entries of a central directory, or null when it does not hold `entries` well-formed
 * records.
 * @param {Uint8Array} cd
 * @param {number} entries
 * @returns {ZipEntry[] | null}
 */
export function zipEntryList(cd, entries) {
  if (entries > ZIP_MAX_ENTRIES) return null;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  /** @type {ZipEntry[]} */
  const out = [];
  let at = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > cd.length || u32(cd, at) !== 0x02014b50) return null;
    const madeOnUnix = byte(cd, at + 5) === 3;
    const attributes = u32(cd, at + 38);
    const nameLength = u16(cd, at + 28);
    const extra = u16(cd, at + 30);
    const comment = u16(cd, at + 32);
    const next = at + 46 + nameLength + extra + comment;
    if (next > cd.length) return null;
    out.push({
      name: decoder.decode(cd.subarray(at + 46, at + 46 + nameLength)),
      mode: madeOnUnix ? attributes >>> 16 : null,
    });
    at = next;
  }
  return out;
}

/**
 * The names in a central directory, or null when it does not hold `entries` well-formed records.
 * @param {Uint8Array} cd
 * @param {number} entries
 * @returns {string[] | null}
 */
export function zipEntryNames(cd, entries) {
  return zipEntryList(cd, entries)?.map((e) => e.name) ?? null;
}

/** S_IFMT and S_IFLNK (sys/stat.h). */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Whether an entry's path leaves the folder it is unpacked in: `..`, `/…`, `C:`. */
const leaves = (/** @type {string} */ name) =>
  /^[/\\]/.test(name) || /^[A-Za-z]:/.test(name) || name.split(/[/\\]/).some((seg) => seg === "..");

/**
 * Whether a zip is dangerous by what it holds (decision 31 d; security.md
 * M13): any dangerous name inside, a nested zip (it cannot be listed without extracting), an entry
 * that unpacks with an exec bit or as a symbolic link, or a path that leaves its folder.
 * @param {(string | ZipEntry)[]} entries
 * @param {{ isExecutable?: (name: string) => boolean }} [options]
 * @returns {Danger | null}
 */
export function zipVerdict(entries, options) {
  for (const entry of entries) {
    const { name, mode } = typeof entry === "string" ? { name: entry, mode: null } : entry;
    const shown = oneLine(name, 60);
    if (leaves(name))
      return { kind: "archive", text: `a zip with a path outside its folder (${shown})` };
    if (mode !== null && (mode & S_IFMT) === S_IFLNK) {
      return { kind: "archive", text: `a zip holding a symbolic link (${shown})` };
    }
    if (name.endsWith("/")) continue;
    const [last] = extensions(name);
    const inner = dangerousName(name, options) ?? (last === "zip" ? danger("archive") : null);
    if (inner) return { kind: "archive", text: `a zip holding ${inner.text} (${shown})` };
    if (mode !== null && (mode & 0o111) !== 0) {
      return { kind: "executable", text: `a zip holding an executable (${shown}, exec bit)` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// ClamAV (decision 31 g).

/**
 * `clamscan`'s arguments: fixed, alerting on files it cannot open (encrypted, over its limits),
 * and the path after `--`, so a name starting with `-` is never an option.
 * @param {string} path
 */
export function clamArguments(path) {
  return [
    "--no-summary",
    "--stdout",
    "--alert-encrypted=yes",
    "--alert-exceeds-max=yes",
    "--",
    path,
  ];
}

/** Heuristics that say ClamAV could not look inside, not that it found something. */
const PARTIAL = /** @type {const} */ ([
  [/^Heuristics\.Encrypted\./, "encrypted"],
  [/^Heuristics\.Limits\.Exceeded/, "over ClamAV's limits"],
]);

/**
 * `clamscan`'s answer: exit 0 clean, 1 infected, anything else an error. Found only by the
 * encrypted or over-the-limits heuristics, it is `partial`: not fully scanned.
 * @param {{ exitCode: number, stdout: string }} run
 * @returns {{ kind: "clean" } | { kind: "infected", signature: string }
 *   | { kind: "partial", reason: string } | { kind: "error" }}
 */
export function clamVerdict({ exitCode, stdout }) {
  if (exitCode === 0) return { kind: "clean" };
  if (exitCode !== 1) return { kind: "error" };
  const found = [...String(stdout ?? "").matchAll(/:\s*([^\n]*?)\s+FOUND\s*$/gm)].map((m) =>
    String(m[1] ?? ""),
  );
  /** @type {string | null} */
  let partial = null;
  for (const signature of found) {
    const heuristic = PARTIAL.find(([re]) => re.test(signature));
    if (!heuristic) return { kind: "infected", signature: oneLine(signature, 60) || "a virus" };
    partial ??= heuristic[1];
  }
  if (partial) return { kind: "partial", reason: partial };
  return { kind: "infected", signature: "a virus" };
}

// ---------------------------------------------------------------------------------------------
// ClamAV's definitions and clamd (decisions 43-45).

/**
 * The arguments that make a scanner print its version and its definitions' version and date.
 * `clamdscan` asks clamd for them, so it gets the same config file as the scan.
 * @param {string} [configFile]
 */
export function clamVersionArguments(configFile) {
  return configFile ? [`--config-file=${configFile}`, "--version"] : ["--version"];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The definitions' date from `--version` output (`ClamAV 1.5.4/28156/Sat Oct 17 09:25:46 2026`),
 * in milliseconds. ClamAV prints it with ctime(3), in local time. Null when the output has no
 * date: `clamdscan` with no clamd to ask prints only its own version.
 * @param {string} text
 * @returns {number | null}
 */
export function clamDefinitionsDate(text) {
  const m =
    /^ClamAV [^/\n]+\/\d+\/\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/m.exec(
      String(text ?? ""),
    );
  if (!m) return null;
  const month = MONTHS.indexOf(String(m[1]));
  const [day = 0, h = 0, min = 0, sec = 0, year = 0] = m.slice(2).map(Number);
  if (month < 0 || day < 1 || day > 31 || h > 23 || min > 59 || sec > 60) return null;
  const date = new Date(year, month, day, h, min, sec);
  return date.getDate() === day ? date.getTime() : null;
}

/**
 * Why the definitions are too old to call a scan clean, or null when they are not. A date in
 * the future (a clock behind the mirror's) is not stale.
 * @param {number | null} definitionsMs
 * @param {number} nowMs
 * @param {number} maxDays  `[mcp] clamav_max_age_days`
 * @returns {string | null}
 */
export function staleDefinitions(definitionsMs, nowMs, maxDays) {
  if (definitionsMs === null) return "ClamAV's definitions have no date";
  const age = nowMs - definitionsMs;
  if (age <= maxDays * 86_400_000) return null;
  const days = Math.floor(age / 86_400_000);
  return `ClamAV's definitions are ${days} days old (over [mcp] clamav_max_age_days, ${maxDays})`;
}

/**
 * `clamdscan`'s arguments: the config file whose socket and alerts were checked, the file
 * passed as an open descriptor (clamd runs as another user and may not read the quarantine),
 * and the path after `--`. clamdscan has no `--alert-*` options; `clamdConfig` checks that
 * clamd.conf turns them on.
 * @param {string} configFile
 * @param {string} path
 */
export function clamdArguments(configFile, path) {
  return [`--config-file=${configFile}`, "--fdpass", "--no-summary", "--stdout", "--", path];
}

/** clamd.conf's booleans (clamd's optparser accepts these spellings for true). */
const YES = new Set(["yes", "true", "1", "on"]);

/**
 * What clamd.conf says that matters here: the local socket, or why clamd is not used. clamd
 * must not listen on TCP (anyone on the network could answer), and must alert on encrypted
 * files and files over its limits, as `clamscan` is asked to, or such a file would scan clean.
 * The last setting of a key wins, as in clamd.
 * @param {string} text
 * @returns {{ socket: string } | { problem: string }}
 */
export function clamdConfig(text) {
  /** @type {Map<string, string>} */
  const keys = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)\s*(.*)$/.exec(line);
    if (m) keys.set(String(m[1]).toLowerCase(), String(m[2]).trim());
  }
  if (keys.has("tcpsocket")) return { problem: "clamd listens on TCP" };
  const socket = keys.get("localsocket") ?? "";
  if (!socket.startsWith("/")) return { problem: "no LocalSocket" };
  if (!YES.has((keys.get("alertencrypted") ?? "").toLowerCase())) {
    return { problem: "clamd does not alert on encrypted files" };
  }
  if (!YES.has((keys.get("alertexceedsmax") ?? "").toLowerCase())) {
    return { problem: "clamd does not alert on files over its limits" };
  }
  return { socket };
}

/**
 * A user's uid from /etc/passwd, or null.
 * @param {string} text
 * @param {string} name
 * @returns {number | null}
 */
export function passwdUid(text, name) {
  for (const line of String(text ?? "").split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name) continue;
    return /^\d+$/.test(fields[2] ?? "") ? Number(fields[2]) : null;
  }
  return null;
}

/**
 * Whether clamd's socket can be trusted: a socket owned by root or by clamav. One owned by the
 * user (or anyone else) could be a fake clamd that answers clean.
 * @param {{ isSocket: boolean, uid: number }} stat
 * @param {number | null} clamavUid
 */
export function clamdSocketTrusted({ isSocket, uid }, clamavUid) {
  return isSocket && (uid === 0 || (clamavUid !== null && uid === clamavUid));
}

// ---------------------------------------------------------------------------------------------
// The quarantine folder (decision 31 b).

/**
 * `[mcp] download_dir` as a path: `~` expanded, `.` and `..` resolved, no trailing slash.
 * @param {string} raw  valid (config.mjs): `~/…` or absolute
 * @param {string} home
 */
export function resolveDownloadDir(raw, home) {
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  /** @type {string[]} */
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** Folders anyone can write to: never a quarantine. */
const SHARED_DIRS = ["/tmp", "/var/tmp", "/dev/shm"];

/**
 * Why a resolved folder is not a quarantine (decision 31 b; security.md
 * M12), or null: never `/`, home, the Downloads folder itself, a hidden folder of home (where
 * autostart, shell and app configs live) or a folder anyone can write to.
 * @param {string} dir  absolute, resolved
 * @param {string} home
 * @returns {string | null}
 */
export function quarantineProblem(dir, home) {
  const why = (/** @type {string} */ what) => `must not be ${what}`;
  if (dir === "/") return why("/");
  if (dir === home) return why("your home folder");
  if (dir.toLowerCase() === `${home}/downloads`.toLowerCase()) {
    return why("the Downloads folder itself");
  }
  if (SHARED_DIRS.some((d) => dir === d || dir.startsWith(`${d}/`))) {
    return why("in /tmp, /var/tmp or /dev/shm");
  }
  if (dir.startsWith(`${home}/`)) {
    const hidden = dir
      .slice(home.length + 1)
      .split("/")
      .find((seg) => seg.startsWith("."));
    if (hidden) return why(`in a hidden folder (${oneLine(hidden, 30)})`);
  }
  return null;
}

/**
 * A folder as notices show it: `~` for the home folder.
 * @param {string} dir @param {string} home
 */
export function displayDir(dir, home) {
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}

// ---------------------------------------------------------------------------------------------
// The question's size and the notices (decision 31 a, g).

/**
 * A size for the question: SI units, one decimal under 10.
 * @param {number} n  bytes, or -1 when unknown
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n;
  let unit = "B";
  for (const u of units) {
    if (v < 1000) break;
    v /= 1000;
    unit = u;
  }
  const shown = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
  return `${shown} ${unit}`;
}

/**
 * The notice once a download is out of quarantine.
 * @param {{ name: string, dir: string, scan: "clean" | "stale" | "partial" | "none" | "error" }} a
 *   `dir` as shown
 */
export function downloadSavedNotice({ name, dir, scan }) {
  const how =
    scan === "clean"
      ? "scanned (ClamAV)"
      : scan === "stale"
        ? "scanned with outdated definitions (ClamAV)"
        : scan === "partial"
          ? "not fully scanned (ClamAV)"
          : scan === "error"
            ? "not scanned (ClamAV failed)"
            : "not scanned";
  return `saved "${oneLine(name, 60)}" to ${oneLine(dir, 60)}, ${how}`;
}

/**
 * @typedef {{ kind: "http" } | { kind: "cap", mb: number } | { kind: "place" }
 *   | { kind: "folder", text: string }
 *   | { kind: "infected", signature: string } | { kind: "danger", text: string }} Refusal
 */

/**
 * The notice when a download is refused before it is saved, or deleted after.
 * @param {string} name @param {Refusal} why
 */
export function downloadRefusedNotice(name, why) {
  const file = `"${oneLine(name, 60)}"`;
  switch (why.kind) {
    case "http":
      return `refused download ${file}: not https`;
    case "cap":
      return `refused download ${file}: over [mcp] download_max_mb (${why.mb} MB)`;
    case "place":
      return `refused download ${file}: not in the quarantine folder`;
    case "folder":
      return `refused download ${file}: the quarantine folder is not usable: ${oneLine(why.text, 80)}`;
    case "infected":
      return `deleted download ${file}: ClamAV found ${oneLine(why.signature, 60)}`;
    default:
      return `deleted download ${file}: ${oneLine(why.text, 80)}, not allowed`;
  }
}
