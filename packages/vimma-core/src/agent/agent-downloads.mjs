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
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;

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
  // Stryker disable next-line StringLiteral: no name has no extension, as a name without a dot has none
  const path = String(name ?? "");
  // Stryker disable next-line StringLiteral: split() always gives pop() a part
  const base = path.split(/[/\\]/).pop() ?? "";
  return base
    .replace(/[. ]+$/, "")
    .toLowerCase()
    .split(".")
    .slice(1)
    .reverse();
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
    // Stryker disable next-line OptionalChaining: with no isExecutable the call throws, and the catch gives the same null
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
  // Stryker disable next-line OptionalChaining,StringLiteral: split() always gives a first part, and no type is no dangerous type
  const bare = String(type ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  const kind = bare ? DANGEROUS_TYPES[bare] : undefined;
  return kind && Object.hasOwn(DANGEROUS_TYPES, /** @type {string} */ (bare)) ? danger(kind) : null;
}

/**
 * Whether `b` holds `sig` at `at`: a byte past the end is undefined, never equal to one.
 * @param {Uint8Array} b @param {number[]} sig @param {number} [at]
 */
const starts = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);

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
  // Stryker disable next-line ArithmeticOperator: a record starting in the last 21 bytes cannot end with its comment where the tail ends
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) !== 0x06054b50) continue;
    const commentLength = u16(tail, i + 20);
    if (i + 22 + commentLength !== tail.length) continue;
    const entries = u16(tail, i + 10);
    const length = u32(tail, i + 12);
    const offset = u32(tail, i + 16);
    // zip64's markers; its length marker, 0xffffffff, is over ZIP_MAX_DIRECTORY below.
    if (entries === 0xffff || offset === 0xffffffff) return { kind: "unlistable" };
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
  // Stryker disable next-line ObjectLiteral: fatal is false by default; written out, as a name that is not UTF-8 must never throw
  const decoder = new TextDecoder("utf-8", { fatal: false });
  /** @type {ZipEntry[]} */
  const out = [];
  let at = 0;
  for (let n = 0; n < entries; n++) {
    // A record cut short reads 0 past the end (byte()), and `next` below is then past the end.
    if (u32(cd, at) !== 0x02014b50) return null;
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
    // No mode (not made on Unix) has no type and no exec bit.
    const bits = mode ?? 0;
    const shown = oneLine(name, 60);
    if (leaves(name))
      return { kind: "archive", text: `a zip with a path outside its folder (${shown})` };
    if ((bits & S_IFMT) === S_IFLNK) {
      return { kind: "archive", text: `a zip holding a symbolic link (${shown})` };
    }
    if (name.endsWith("/")) continue;
    const [last] = extensions(name);
    const inner = dangerousName(name, options) ?? (last === "zip" ? danger("archive") : null);
    if (inner) return { kind: "archive", text: `a zip holding ${inner.text} (${shown})` };
    if ((bits & 0o111) !== 0) {
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
  // Stryker disable next-line StringLiteral: no output has no FOUND line, as "" has none
  const found = [...String(stdout ?? "").matchAll(/:\s*([^\n]*?)\s+FOUND\s*$/gm)].map((m) =>
    // Stryker disable next-line StringLiteral: the group always takes part in a match
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
      // Stryker disable next-line StringLiteral: no output has no date, as "" has none
      String(text ?? ""),
    );
  if (!m) return null;
  const month = MONTHS.indexOf(String(m[1]));
  const [day = 0, h = 0, min = 0, sec = 0, year = 0] = m.slice(2).map(Number);
  if (month < 0 || min > 59 || sec > 60) return null;
  const date = new Date(year, month, day, h, min, sec);
  // A day the month does not have (0 to 99) or an hour past 23 (up to 99) moves the date to
  // another day of the month: refused here.
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

/**
 * clamd's true, after it has dropped an inline comment: its optparser checks a boolean against
 * `^(yes|true|1|no|false|0)(( +)?#(.*))?$` (any case) and takes yes, true and 1 as true.
 */
const CLAMD_TRUE = /^(yes|true|1) *(#.*)?$/i;
/** clamd's false, read the same way. */
const CLAMD_FALSE = /^(no|false|0) *(#.*)?$/i;

/** @param {string} value */
const scanOn = (value) => CLAMD_TRUE.test(value);
/** @param {string} value */
const scanOff = (value) => CLAMD_FALSE.test(value);
/**
 * A size limit of 0, which clamd reads as no limit (optparser.c turns a size of 0 into the
 * largest it can hold). Any other size is refused: clamscan's own limits are libclamav's
 * CLI_DEFAULT_* values, defined outside optparser.c, so no size can be compared with them.
 * clamd matches a size with `^[0-9]+[KMG]?(( +)?#(.*))?$`, any case.
 * @param {string} value
 */
const sizeUnlimited = (value) => /^0+[kmg]? *(#.*)?$/i.test(value);
/**
 * A number limit of 0, for the limits optparser.c says 0 disables. clamd matches a number with
 * `^[0-9]+((( +)?#(.*))?)$` and reads it with atoi.
 * @param {string} value
 */
const numberUnlimited = (value) => /^0+ *(#.*)?$/.test(value);
/**
 * An option that must not be set: a limit whose default is not in optparser.c and that 0 is
 * not said to disable, an option with no default to compare with, or a developer option.
 */
const neverSet = () => false;
/**
 * BytecodeTimeout: at least optparser.c's default, 10000 ms, and small enough for clamd's atoi
 * to read as written.
 * @param {string} value
 */
const bytecodeTimeout = (value) => {
  const n = Number(/^(\d+) *(#.*)?$/.exec(value)?.[1] ?? Number.NaN);
  return n >= 10_000 && n <= 2_147_483_647;
};
/**
 * ExcludePath: clamdscan skips a path that matches it and calls it clean, while clamscan as
 * Vimma runs it excludes nothing. Only optparser.c's own examples are taken, written exactly so:
 * no download can be under /proc or /sys.
 * @param {string} value
 */
const systemExclude = (value) => value === "^/proc/" || value === "^/sys/";
/**
 * DatabaseDirectory: clamscan loads its signatures from CONST_DATADIR, its `--database` default
 * (optparser.c), a build setting that is /var/lib/clamav in the packages Vimma uses. clamd must
 * load the same ones, written exactly so.
 * @param {string} value
 */
const packagedDatadir = (value) => value === "/var/lib/clamav";

/**
 * @typedef {object} ClamdOption
 * @property {string} [alias]  the command-line name clamd also reads in the file
 * @property {boolean} [multiple]  clamd allows it more than once (FLAG_MULTIPLE)
 * @property {(value: string) => boolean} [scans]  the values with which clamd scans at least as
 *   much as clamscan with its defaults; left unset, the option has the same default in both
 */

/**
 * The clamd.conf options Vimma reads, with their names, command-line names and defaults from
 * ClamAV's common/optparser.c. An option not FLAG_MULTIPLE is refused when set twice.
 * @type {Map<string, ClamdOption>}
 */
const CLAMD_OPTIONS = new Map([
  ["LocalSocket", {}],
  ["TCPSocket", {}],
  ["TCPAddr", { multiple: true }],
  ["AlertEncrypted", { alias: "alert-encrypted" }],
  ["AlertExceedsMax", { alias: "alert-exceeds-max" }],
  // On by default; off, clamd skips what clamscan looks into.
  ["ScanPE", { alias: "scan-pe", scans: scanOn }],
  ["ScanELF", { alias: "scan-elf", scans: scanOn }],
  ["ScanMail", { alias: "scan-mail", scans: scanOn }],
  ["PhishingSignatures", { alias: "phishing-sigs", scans: scanOn }],
  ["PhishingScanURLs", { alias: "phishing-scan-urls", scans: scanOn }],
  ["HeuristicAlerts", { alias: "heuristic-alerts", scans: scanOn }],
  ["ScanHTML", { alias: "scan-html", scans: scanOn }],
  ["ScanOLE2", { alias: "scan-ole2", scans: scanOn }],
  ["ScanPDF", { alias: "scan-pdf", scans: scanOn }],
  ["ScanSWF", { alias: "scan-swf", scans: scanOn }],
  ["ScanXMLDOCS", { alias: "scan-xmldocs", scans: scanOn }],
  ["ScanHWP3", { alias: "scan-hwp3", scans: scanOn }],
  ["ScanOneNote", { alias: "scan-onenote", scans: scanOn }],
  ["ScanArchive", { alias: "scan-archive", scans: scanOn }],
  ["ScanImage", { alias: "scan-image", scans: scanOn }],
  ["ScanImageFuzzyHash", { alias: "scan-image-fuzzy-hash", scans: scanOn }],
  ["Bytecode", { alias: "bytecode", scans: scanOn }],
  ["AlgorithmicDetection", { alias: "algorithmic-detection", scans: scanOn }],
  // Off by default; on, clamd loads fewer signatures or skips a check.
  ["OfficialDatabaseOnly", { alias: "official-db-only", scans: scanOff }],
  ["DisableCertCheck", { alias: "nocerts", scans: scanOff }],
  // Limits: lower than clamscan's, clamd stops looking sooner.
  ["MaxScanSize", { alias: "max-scansize", scans: sizeUnlimited }],
  ["MaxFileSize", { alias: "max-filesize", scans: sizeUnlimited }],
  ["MaxEmbeddedPE", { alias: "max-embeddedpe", scans: sizeUnlimited }],
  ["MaxHTMLNormalize", { alias: "max-htmlnormalize", scans: sizeUnlimited }],
  ["MaxHTMLNoTags", { alias: "max-htmlnotags", scans: sizeUnlimited }],
  ["MaxScriptNormalize", { alias: "max-scriptnormalize", scans: sizeUnlimited }],
  ["MaxZipTypeRcg", { alias: "max-ziptypercg", scans: sizeUnlimited }],
  ["PCREMaxFileSize", { alias: "pcre-max-filesize", scans: sizeUnlimited }],
  ["MaxScanTime", { alias: "max-scantime", scans: numberUnlimited }],
  ["MaxRecursion", { alias: "max-recursion", scans: numberUnlimited }],
  ["MaxFiles", { alias: "max-files", scans: numberUnlimited }],
  ["MaxPartitions", { alias: "max-partitions", scans: neverSet }],
  ["MaxIconsPE", { alias: "max-iconspe", scans: neverSet }],
  ["MaxRecHWP3", { alias: "max-rechwp3", scans: neverSet }],
  ["PCREMatchLimit", { alias: "pcre-match-limit", scans: neverSet }],
  ["PCRERecMatchLimit", { alias: "pcre-recmatch-limit", scans: neverSet }],
  ["BytecodeTimeout", { alias: "bytecode-timeout", scans: bytecodeTimeout }],
  ["ExcludePath", { multiple: true, scans: systemExclude }],
  // The signatures clamscan loads, verified as clamscan verifies them. CVDCertsDirectory has no
  // default in optparser.c to compare with: never set.
  ["DatabaseDirectory", { alias: "datadir", scans: packagedDatadir }],
  ["CVDCertsDirectory", { alias: "cvdcertsdir", scans: neverSet }],
  // Hidden developer options (FLAG_HIDDEN): never set.
  ["DevACOnly", { alias: "dev-ac-only", scans: neverSet }],
  ["DevACDepth", { alias: "dev-ac-depth", scans: neverSet }],
  ["DevPerformance", { alias: "dev-performance", scans: neverSet }],
  ["DevLiblog", { alias: "dev-liblog", scans: neverSet }],
]);

/** Every name clamd reads for those options in the file, case as clamd matches it. */
const CLAMD_NAMES = new Map(
  [...CLAMD_OPTIONS].flatMap(([option, { alias }]) =>
    alias
      ? [
          [option, option],
          [alias, option],
        ]
      : [[option, option]],
  ),
);
const CLAMD_NAMES_LOWER = new Set([...CLAMD_NAMES.keys()].map((k) => k.toLowerCase()));

/**
 * clamd reads a line with fgets into 1024 bytes (512 in older releases) and parses what is left
 * as a line of its own; a line this long, with its LF, could be split, so it is refused.
 */
const CLAMD_LINE_BYTES = 512;

/**
 * A control character clamd would keep inside a line (it strips only spaces, tabs and the LF):
 * a CR, so CRLF too; a NUL, which ends what clamd reads of the line; anything else C0 or C1.
 * @param {string} line
 */
function hasControl(line) {
  for (const ch of line) {
    const c = ch.charCodeAt(0);
    if ((c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * What clamd.conf says that matters here: the local socket, or why clamd is not used. clamd
 * must not listen on TCP (anyone on the network could answer), and must alert on encrypted
 * files and files over its limits, as `clamscan` is asked to, or such a file would scan clean.
 * Nor may it scan less than clamscan with its defaults: a scan turned off, fewer signatures, a
 * lower limit, an excluded path, another signature folder or a developer option
 * (CLAMD_OPTIONS). It reads the file as clamd's optparser does (ClamAV common/optparser.c), and
 * wherever the two readings could differ for these options it refuses the file instead: clamd
 * is then not used and clamscan scans.
 * @param {string} text
 * @returns {{ socket: string } | { problem: string }}
 */
export function clamdConfig(text) {
  /** @type {Map<string, string[]>} */
  const keys = new Map();
  // Stryker disable next-line StringLiteral: no file sets no LocalSocket, as "" sets none
  const conf = String(text ?? "");
  const lines = conf.split("\n");
  const encoder = new TextEncoder();
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    if (hasControl(raw)) return { problem: `line ${n} has a control character` };
    if (encoder.encode(raw).length + 1 >= CLAMD_LINE_BYTES) {
      return { problem: `line ${n} is too long for clamd to read whole` };
    }
    // clamd strips leading spaces and tabs only, then skips a comment; a blank line or a
    // comment (`#…`, a name no option has) is skipped below.
    const line = raw.replace(/^[ \t]+/, "");
    const m = /^([^ \t]*)[ \t]*(.*?)[ \t]*$/.exec(line);
    const name = m?.[1] ?? "";
    const option = CLAMD_NAMES.get(name);
    if (!option) {
      // A name that only looks like one of these (other case, or run into a space clamd does
      // not split on) makes clamd refuse the whole file; it is not guessed at here.
      // `looks` is `name` too, lower case, whenever `name` is such a name: it has no space.
      // Stryker disable next-line StringLiteral: a line with no word names no option, as "" does not
      const looks = (/\S+/.exec(line)?.[0] ?? "").toLowerCase();
      if (CLAMD_NAMES_LOWER.has(looks)) {
        return { problem: `clamd does not read ${name} (line ${n})` };
      }
      continue;
    }
    // clamd keeps the first setting and ignores later ones: a second one is refused.
    const values = keys.get(option) ?? [];
    // Stryker disable next-line OptionalChaining: every name in CLAMD_NAMES is an option of CLAMD_OPTIONS
    if (values.length && !CLAMD_OPTIONS.get(option)?.multiple) {
      return { problem: `clamd.conf sets ${option} twice` };
    }
    // Stryker disable next-line OptionalChaining,StringLiteral: a line with a name matched, and its value group always takes part
    keys.set(option, [...values, m?.[2] ?? ""]);
  }
  // An option's first value, or "" when it is not set.
  // Stryker disable next-line StringLiteral: an unset LocalSocket, AlertEncrypted or AlertExceedsMax is refused below whatever stands in for it, as long as it has no / first and is no yes
  const first = (/** @type {string} */ option) => keys.get(option)?.[0] ?? "";
  if (keys.has("TCPSocket")) return { problem: "clamd listens on TCP" };
  const socket = first("LocalSocket");
  // clamd unquotes a value and drops an inline comment; a socket path written so is not used.
  if (/["#]/.test(socket)) return { problem: "LocalSocket has a quote or a #" };
  if (!socket.startsWith("/")) return { problem: "no LocalSocket" };
  if (!CLAMD_TRUE.test(first("AlertEncrypted"))) {
    return { problem: "clamd does not alert on encrypted files" };
  }
  if (!CLAMD_TRUE.test(first("AlertExceedsMax"))) {
    return { problem: "clamd does not alert on files over its limits" };
  }
  // Decision 45: clamd may make a scan faster, never weaker than clamscan's with its defaults.
  for (const [option, values] of keys) {
    // Stryker disable next-line OptionalChaining: every key is an option of CLAMD_OPTIONS
    const scans = CLAMD_OPTIONS.get(option)?.scans;
    if (scans && !values.every(scans)) {
      return { problem: `clamd would scan less than clamscan (${option})` };
    }
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
  // Stryker disable next-line StringLiteral: no file names no user, as "" names none
  const passwd = String(text ?? "");
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name) continue;
    // Stryker disable next-line StringLiteral: no uid field is not digits, as "" is not
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
  // A uid is a number, never equal to a null clamavUid.
  return isSocket && (uid === 0 || uid === clamavUid);
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
  // Stryker disable next-line StringLiteral: n is 1000 or more here, so the loop always sets a unit
  let unit = "B";
  for (const u of units) {
    if (v < 1000) break;
    v /= 1000;
    unit = u;
  }
  // Stryker disable next-line Regex: under 10, toFixed(1) gives one digit, a dot and one digit, so .0 is only ever at the end
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
