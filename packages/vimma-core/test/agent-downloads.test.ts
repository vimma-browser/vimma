// docs/specs/vimma-mcp.md, decision 31 (sub-PR 2c): downloads from the agent workspace, in core.
// What counts as dangerous (d): by name, by type, by the first bytes, and by the names inside a
// zip; ClamAV's answer (g); the quarantine folder (b); the question and the notices (a).
import { describe, expect, test } from "vitest";
import {
  ARCHIVE_EXTENSIONS,
  DOWNLOAD_TOOL,
  INSTALLER_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  ZIP_TAIL_BYTES,
  clamVerdict,
  clamDefinitionsDate,
  clamVersionArguments,
  clamdArguments,
  clamdConfig,
  clamdSocketTrusted,
  dangerousContent,
  passwdUid,
  staleDefinitions,
  dangerousName,
  dangerousType,
  displayDir,
  downloadRefusedNotice,
  downloadSavedNotice,
  clamArguments,
  formatBytes,
  quarantineProblem,
  resolveDownloadDir,
  zipEntryList,
  zipEntryNames,
  zipLocate,
  zipVerdict,
} from "../src/agent/agent-downloads.mjs";

const enc = new TextEncoder();

/**
 * A zip with these entries (stored, empty files): local headers, the central directory and the
 * end-of-central-directory record, as `zip -0` writes them. An entry is a name, or a name with
 * the Unix mode `zip` records in the external attributes (version made by: Unix).
 */
export function makeZip(
  entries: (string | { name: string; mode: number })[],
  { comment = "" }: { comment?: string } = {},
) {
  const names = entries.map((e) => (typeof e === "string" ? e : e.name));
  const modes = entries.map((e) => (typeof e === "string" ? null : e.mode));
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n: number) =>
    out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const offsets: number[] = [];
  for (const name of names) {
    offsets.push(out.length);
    const bytes = enc.encode(name);
    u32(0x04034b50);
    u16(10);
    u16(0);
    u16(0);
    u32(0);
    u32(0);
    u32(0);
    u32(0);
    u16(bytes.length);
    u16(0);
    out.push(...bytes);
  }
  const cdStart = out.length;
  names.forEach((name, i) => {
    const bytes = enc.encode(name);
    const mode = modes[i];
    u32(0x02014b50);
    u16(mode === null || mode === undefined ? 20 : (3 << 8) | 20); // version made by: Unix
    u16(10);
    u16(0);
    u16(0);
    u32(0);
    u32(0);
    u32(0);
    u32(0);
    u16(bytes.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(mode === null || mode === undefined ? 0 : (mode << 16) >>> 0); // external attributes
    u32(offsets[i] as number);
    out.push(...bytes);
  });
  const cdSize = out.length - cdStart;
  const c = enc.encode(comment);
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(names.length);
  u16(names.length);
  u32(cdSize);
  u32(cdStart);
  u16(c.length);
  out.push(...c);
  return new Uint8Array(out);
}

/** The names in a zip, as the browser reads it: the tail, then the central directory. */
function list(zip: Uint8Array) {
  const tail = zip.subarray(Math.max(0, zip.length - ZIP_TAIL_BYTES));
  const at = zipLocate(tail, zip.length);
  if (at.kind !== "zip") return at.kind;
  return zipEntryNames(zip.subarray(at.offset, at.offset + at.length), at.entries);
}

describe("dangerous by name (decision 31 d)", () => {
  test.each([
    ["install.sh", "script"],
    ["run.PY", "script"],
    ["tool.pl", "script"],
    ["gem.rb", "script"],
    ["payload.js", "script"],
    ["setup.ps1", "script"],
    ["go.bat", "script"],
    ["go.cmd", "script"],
    ["app.desktop", "script"],
    ["vimma.deb", "installer"],
    ["vimma.rpm", "installer"],
    ["Vimma-x86_64.AppImage", "installer"],
    ["app.flatpak", "installer"],
    ["app.snap", "installer"],
    ["setup.msi", "installer"],
    ["app.dmg", "installer"],
    ["app.pkg", "installer"],
    ["app.apk", "installer"],
    ["src.tar.gz", "archive"],
    ["src.tgz", "archive"],
    ["src.tar.xz", "archive"],
    ["src.tar.zst", "archive"],
    ["src.tar", "archive"],
    ["src.7z", "archive"],
    ["src.rar", "archive"],
    ["notes.txt.gz", "archive"],
    ["setup.exe", "executable"],
    ["lib.so", "executable"],
    ["lib.dll", "executable"],
    ["tool.jar", "executable"],
  ])("%s is %s", (name, kind) => {
    expect(dangerousName(name)?.kind).toBe(kind);
  });

  test.each(["report.pdf", "photo.jpg", "data.csv", "notes.txt", "paper.docx", "src.zip", ""])(
    "%s is not, by its name",
    (name) => {
      expect(dangerousName(name)).toBe(null);
    },
  );

  test("Firefox's own executable list (nsIApplicationReputationService.isExecutable) counts", () => {
    const isExecutable = (n: string) => n.endsWith(".scr");
    expect(dangerousName("screen.scr", { isExecutable })?.kind).toBe("executable");
    expect(dangerousName("report.pdf", { isExecutable })).toBe(null);
  });

  test("a trailing dot or space does not hide the extension", () => {
    expect(dangerousName("install.sh.")?.kind).toBe("script");
    expect(dangerousName("install.sh ")?.kind).toBe("script");
  });

  test("the lists hold what decision 31 names", () => {
    expect(SCRIPT_EXTENSIONS).toEqual(
      expect.arrayContaining(["sh", "py", "pl", "rb", "js", "ps1", "bat", "cmd", "desktop"]),
    );
    expect(INSTALLER_EXTENSIONS).toEqual(
      expect.arrayContaining(["deb", "rpm", "appimage", "flatpak", "snap", "msi", "dmg", "pkg"]),
    );
    expect(ARCHIVE_EXTENSIONS).toEqual(expect.arrayContaining(["tar", "7z", "rar", "tgz"]));
  });
});

describe("dangerous by type", () => {
  test.each([
    ["application/x-executable", "executable"],
    ["application/x-sharedlib", "executable"],
    ["application/x-msdownload", "executable"],
    ["application/x-sh", "script"],
    ["text/x-shellscript", "script"],
    ["application/x-python", "script"],
    ["application/vnd.debian.binary-package", "installer"],
    ["application/x-rpm", "installer"],
    ["application/vnd.appimage", "installer"],
    ["application/x-desktop", "script"],
    ["application/x-7z-compressed", "archive"],
    ["application/x-tar", "archive"],
    ["application/gzip", "archive"],
    ["APPLICATION/X-SH; charset=utf-8", "script"],
  ])("%s is %s", (type, kind) => {
    expect(dangerousType(type)?.kind).toBe(kind);
  });

  test.each(["application/pdf", "text/plain", "image/png", "application/zip", "", undefined])(
    "%s is not, by its type",
    (type) => {
      expect(dangerousType(type)).toBe(null);
    },
  );
});

describe("dangerous by the first bytes (decision 31 d)", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0]);
  test.each([
    ["ELF", bytes(0x7f, 0x45, 0x4c, 0x46), "executable"],
    ["PE (MZ)", bytes(0x4d, 0x5a), "executable"],
    ["Mach-O 32", bytes(0xfe, 0xed, 0xfa, 0xce), "executable"],
    ["Mach-O 64", bytes(0xfe, 0xed, 0xfa, 0xcf), "executable"],
    ["Mach-O reversed", bytes(0xcf, 0xfa, 0xed, 0xfe), "executable"],
    ["fat binary", bytes(0xca, 0xfe, 0xba, 0xbe), "executable"],
    ["#! script", enc.encode("#!/bin/sh\necho hi\n"), "script"],
    ["gzip", bytes(0x1f, 0x8b), "archive"],
    ["xz", bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00), "archive"],
    ["bzip2", enc.encode("BZh91AY&SY"), "archive"],
    ["7z", bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), "archive"],
    ["rar", enc.encode("Rar!\u001a\u0007\u0000"), "archive"],
    ["zstd", bytes(0x28, 0xb5, 0x2f, 0xfd), "archive"],
  ])("%s", (_what, head, kind) => {
    expect(dangerousContent(head)?.kind).toBe(kind);
  });

  test("a tar has ustar at 257", () => {
    const tar = new Uint8Array(512);
    tar.set(enc.encode("ustar"), 257);
    expect(dangerousContent(tar)?.kind).toBe("archive");
  });

  test.each([
    ["a PDF", enc.encode("%PDF-1.7\n")],
    ["text", enc.encode("hello, world\n")],
    ["a PNG", bytes(0x89, 0x50, 0x4e, 0x47)],
    ["nothing", new Uint8Array(0)],
    ["one byte", new Uint8Array([0x7f])],
  ])("%s is not", (_what, head) => {
    expect(dangerousContent(head)).toBe(null);
  });
});

describe("a zip's names, from its central directory (never extracted)", () => {
  test("the names, in order", () => {
    expect(list(makeZip(["README.md", "src/main.c"]))).toEqual(["README.md", "src/main.c"]);
  });

  test("with a comment after the record", () => {
    expect(list(makeZip(["a.txt"], { comment: "made by hand" }))).toEqual(["a.txt"]);
  });

  test("an empty zip lists nothing", () => {
    expect(list(makeZip([]))).toEqual([]);
  });

  test("not a zip", () => {
    expect(list(enc.encode("%PDF-1.7 not a zip at all"))).toBe("none");
  });

  test("a central directory that points outside the file cannot be listed", () => {
    const zip = makeZip(["a.txt"]);
    const eocd = zip.length - 22;
    zip[eocd + 16] = 0xff; // the offset, far past the end
    zip[eocd + 19] = 0x7f;
    expect(list(zip)).toBe("unlistable");
  });

  test("zip64 (0xffff entries) cannot be listed", () => {
    const zip = makeZip(["a.txt"]);
    const eocd = zip.length - 22;
    zip[eocd + 10] = 0xff;
    zip[eocd + 11] = 0xff;
    expect(list(zip)).toBe("unlistable");
  });

  test("a truncated central directory gives null, never a throw", () => {
    const zip = makeZip(["a.txt", "b.txt"]);
    const at = zipLocate(zip, zip.length);
    if (at.kind !== "zip") throw new Error("expected a zip");
    expect(zipEntryNames(zip.subarray(at.offset, at.offset + 10), at.entries)).toBe(null);
  });

  test("a dangerous name inside makes the zip dangerous, and says which", () => {
    expect(zipVerdict(["README.md", "bin/install.sh"])).toEqual({
      kind: "archive",
      text: "a zip holding a script (bin/install.sh)",
    });
    expect(zipVerdict(["docs/a.pdf", "img/b.png"])).toBe(null);
    expect(zipVerdict(["inner.tar.gz"])?.text).toBe(
      "a zip holding an archive Vimma cannot look inside (inner.tar.gz)",
    );
    expect(zipVerdict(["nested.zip"])?.kind).toBe("archive");
  });

  test("names inside are checked with Firefox's list too", () => {
    const isExecutable = (n: string) => n.endsWith(".scr");
    expect(zipVerdict(["x.scr"], { isExecutable })?.kind).toBe("archive");
  });
});

// What an entry becomes when unpacked counts too (security.md M13).
describe("a zip entry's mode and path", () => {
  test("an entry with an exec bit is an executable, whatever its name", () => {
    expect(list(makeZip([{ name: "tool", mode: 0o100755 }]))).toEqual(["tool"]);
    expect(zipVerdict(zipEntries(makeZip([{ name: "tool", mode: 0o100755 }])))).toEqual({
      kind: "executable",
      text: "a zip holding an executable (tool, exec bit)",
    });
    expect(zipVerdict(zipEntries(makeZip([{ name: "notes.txt", mode: 0o100644 }])))).toBe(null);
  });

  test("a symbolic link is dangerous", () => {
    expect(zipVerdict(zipEntries(makeZip([{ name: "docs", mode: 0o120777 }])))?.text).toBe(
      "a zip holding a symbolic link (docs)",
    );
  });

  test.each(["../evil.txt", "a/../../evil.txt", "/etc/passwd", "a\\..\\b.txt", "C:/x.txt"])(
    "%s leaves its folder",
    (name) => {
      expect(zipVerdict(zipEntries(makeZip([name])))?.text).toMatch(
        /^a zip with a path outside its folder \(/,
      );
    },
  );

  test("modes from another system (version made by not Unix) are not read", () => {
    const zip = makeZip([{ name: "tool", mode: 0o100755 }]);
    const at = zipLocate(zip, zip.length);
    if (at.kind !== "zip") throw new Error("expected a zip");
    zip[at.offset + 5] = 0; // made by MS-DOS
    expect(zipVerdict(zipEntries(zip))).toBe(null);
  });
});

/** A zip's entries, as the browser reads them. */
function zipEntries(zip: Uint8Array) {
  const at = zipLocate(zip.subarray(Math.max(0, zip.length - ZIP_TAIL_BYTES)), zip.length);
  if (at.kind !== "zip") throw new Error("expected a zip");
  return zipEntryList(zip.subarray(at.offset, at.offset + at.length), at.entries) as any[];
}

describe("ClamAV's definitions and clamd (decision 31 g, decisions 43-45)", () => {
  test("the definitions date comes from --version, in local time; none without it", () => {
    expect(clamVersionArguments()).toEqual(["--version"]);
    expect(clamVersionArguments("/etc/clamav/clamd.conf")).toEqual([
      "--config-file=/etc/clamav/clamd.conf",
      "--version",
    ]);
    expect(clamDefinitionsDate("ClamAV 1.5.4/28156/Sat Oct 17 09:25:46 2026\n")).toBe(
      new Date(2026, 9, 17, 9, 25, 46).getTime(),
    );
    expect(clamDefinitionsDate("ClamAV 0.103.12/27500/Mon Jan  1 00:00:01 2024")).toBe(
      new Date(2024, 0, 1, 0, 0, 1).getTime(),
    );
    // clamdscan with no clamd to ask prints only its own version.
    expect(clamDefinitionsDate("ClamAV 1.5.4\n")).toBeNull();
    expect(clamDefinitionsDate("")).toBeNull();
    expect(clamDefinitionsDate("ClamAV 1.5.4/1/Xyz Foo 99 99:99:99 2026")).toBeNull();
  });

  test("stale past the set age, or with no date; never otherwise", () => {
    const day = 86_400_000;
    const now = new Date(2026, 9, 17, 12).getTime();
    expect(staleDefinitions(now - 2 * day, now, 7)).toBeNull();
    expect(staleDefinitions(now - 7 * day, now, 7)).toBeNull();
    expect(staleDefinitions(now - 7 * day - 1, now, 7)).toBe(
      "ClamAV's definitions are 7 days old (over [mcp] clamav_max_age_days, 7)",
    );
    expect(staleDefinitions(now - 30 * day, now, 7)).toBe(
      "ClamAV's definitions are 30 days old (over [mcp] clamav_max_age_days, 7)",
    );
    expect(staleDefinitions(now - 30 * day, now, 60)).toBeNull();
    expect(staleDefinitions(null, now, 7)).toBe("ClamAV's definitions have no date");
    // A clock behind the mirror's is not stale.
    expect(staleDefinitions(now + day, now, 7)).toBeNull();
  });

  test("clamdscan's arguments: the checked config, the file passed open, the path after --", () => {
    expect(clamdArguments("/etc/clamav/clamd.conf", "/q/-x.part")).toEqual([
      "--config-file=/etc/clamav/clamd.conf",
      "--fdpass",
      "--no-summary",
      "--stdout",
      "--",
      "/q/-x.part",
    ]);
  });

  test("clamd.conf: a local socket, no TCP, alerting as clamscan is asked to", () => {
    const conf = (...lines: string[]) => clamdConfig(lines.join("\n"));
    const good = [
      "# comment",
      "LocalSocket /run/clamav/clamd.ctl",
      "AlertEncrypted yes",
      "AlertExceedsMax true",
    ];
    expect(conf(...good)).toEqual({ socket: "/run/clamav/clamd.ctl" });
    expect(
      conf(" \tLocalSocket \t /run/c.ctl \t", "\tAlertEncrypted YES", "AlertExceedsMax 1"),
    ).toEqual({
      socket: "/run/c.ctl",
    });
    expect(conf(...good, "TCPSocket 3310")).toEqual({ problem: "clamd listens on TCP" });
    expect(conf(...good.slice(2))).toEqual({ problem: "no LocalSocket" });
    expect(conf("LocalSocket clamd.ctl", ...good.slice(2))).toEqual({ problem: "no LocalSocket" });
    expect(conf(...good.slice(0, 2), "AlertExceedsMax yes")).toEqual({
      problem: "clamd does not alert on encrypted files",
    });
    expect(conf(...good.slice(0, 2), "AlertEncrypted yes", "#AlertExceedsMax yes")).toEqual({
      problem: "clamd does not alert on files over its limits",
    });
    expect(conf(...good.slice(0, 2), "AlertEncrypted no", "AlertExceedsMax yes")).toEqual({
      problem: "clamd does not alert on encrypted files",
    });
  });

  test("clamav's uid from /etc/passwd", () => {
    const passwd =
      "root:x:0:0::/root:/bin/bash\nclamav:x:64:64::/var/lib/clamav:/usr/bin/nologin\n";
    expect(passwdUid(passwd, "clamav")).toBe(64);
    expect(passwdUid(passwd, "root")).toBe(0);
    expect(passwdUid(passwd, "clam")).toBeNull();
    expect(passwdUid("clamav:x:abc:64::/:/bin/false", "clamav")).toBeNull();
  });

  test("the socket: a socket owned by root or clamav, never by the user or anyone else", () => {
    expect(clamdSocketTrusted({ isSocket: true, uid: 0 }, 64)).toBe(true);
    expect(clamdSocketTrusted({ isSocket: true, uid: 64 }, 64)).toBe(true);
    expect(clamdSocketTrusted({ isSocket: true, uid: 1000 }, 64)).toBe(false);
    expect(clamdSocketTrusted({ isSocket: true, uid: 64 }, null)).toBe(false);
    expect(clamdSocketTrusted({ isSocket: false, uid: 0 }, 64)).toBe(false);
  });
});

describe("ClamAV's answer (decision 31 g)", () => {
  // What ClamAV could not open is "not fully scanned" (security.md M13).
  test("encrypted or over ClamAV's limits: not fully scanned, not infected", () => {
    expect(
      clamVerdict({ exitCode: 1, stdout: "/q/a.part: Heuristics.Encrypted.Zip FOUND\n" }),
    ).toEqual({ kind: "partial", reason: "encrypted" });
    expect(
      clamVerdict({
        exitCode: 1,
        stdout: "/q/a.part: Heuristics.Limits.Exceeded.MaxFileSize FOUND\n",
      }),
    ).toEqual({ kind: "partial", reason: "over ClamAV's limits" });
    expect(
      clamVerdict({
        exitCode: 1,
        stdout: "/q/a: Heuristics.Encrypted.Zip FOUND\n/q/a: Win.Trojan.X FOUND\n",
      }),
    ).toEqual({ kind: "infected", signature: "Win.Trojan.X" });
  });

  test("the arguments: fixed, alerting on what it cannot open, the path after --", () => {
    expect(clamArguments("/q/-x.part")).toEqual([
      "--no-summary",
      "--stdout",
      "--alert-encrypted=yes",
      "--alert-exceeds-max=yes",
      "--",
      "/q/-x.part",
    ]);
  });

  test("exit 0 is clean, 1 infected with the signature, anything else an error", () => {
    expect(clamVerdict({ exitCode: 0, stdout: "/q/a.part: OK\n" })).toEqual({ kind: "clean" });
    expect(clamVerdict({ exitCode: 1, stdout: "/q/a.part: Eicar-Test-Signature FOUND\n" })).toEqual(
      { kind: "infected", signature: "Eicar-Test-Signature" },
    );
    expect(clamVerdict({ exitCode: 1, stdout: "" })).toEqual({
      kind: "infected",
      signature: "a virus",
    });
    expect(clamVerdict({ exitCode: 2, stdout: "" })).toEqual({ kind: "error" });
    expect(clamVerdict({ exitCode: -1, stdout: "" })).toEqual({ kind: "error" });
  });

  test("a hostile signature name is one plain line, cut", () => {
    const v = clamVerdict({ exitCode: 1, stdout: `/q/a: ${"\u202eX".repeat(100)}\n FOUND\n` });
    expect(v.kind).toBe("infected");
    if (v.kind === "infected") {
      // eslint-disable-next-line no-control-regex -- control characters are what it checks for
      expect(v.signature).not.toMatch(/[\u0000-\u001f\u202e]/);
      expect(v.signature.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("the quarantine folder (decision 31 b)", () => {
  const home = "/home/u";
  // Never a hidden folder of home, or one anyone can write (security.md M12).
  test.each([
    ["/home/u", "your home folder"],
    ["/home/u/Downloads", "the Downloads folder itself"],
    ["/home/u/.local/bin", "in a hidden folder (.local)"],
    ["/home/u/x/.cache/q", "in a hidden folder (.cache)"],
    ["/tmp/q", "in /tmp, /var/tmp or /dev/shm"],
    ["/var/tmp", "in /tmp, /var/tmp or /dev/shm"],
    ["/dev/shm/q", "in /tmp, /var/tmp or /dev/shm"],
    ["/", "/"],
  ])("%s is refused: %s", (dir, why) => {
    expect(quarantineProblem(dir, home)).toBe(`must not be ${why}`);
  });

  test.each(["/home/u/Downloads/vimma-agent", "/srv/agent", "/home/u/agent.files"])(
    "%s is fine",
    (dir) => {
      expect(quarantineProblem(dir, home)).toBe(null);
    },
  );

  test("~ expands; an absolute path stays; trailing slashes go", () => {
    expect(resolveDownloadDir("~/Downloads/vimma-agent/", home)).toBe(
      "/home/u/Downloads/vimma-agent",
    );
    expect(resolveDownloadDir("/srv/q", home)).toBe("/srv/q");
    expect(resolveDownloadDir("/srv/a/../q/./", home)).toBe("/srv/q");
  });

  test("shown with ~ for the home folder", () => {
    expect(displayDir("/home/u/Downloads/vimma-agent", home)).toBe("~/Downloads/vimma-agent");
    expect(displayDir("/srv/q", home)).toBe("/srv/q");
  });
});

describe("the question and the notices (decision 31 a, g)", () => {
  test("the tool is vimma_download", () => {
    expect(DOWNLOAD_TOOL).toBe("vimma_download");
  });

  test.each([
    [-1, "unknown size"],
    [0, "0 B"],
    [999, "999 B"],
    [1500, "1.5 kB"],
    [2_100_000, "2.1 MB"],
    [200_000_000, "200 MB"],
    [3_200_000_000, "3.2 GB"],
  ])("%d bytes: %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  test("not fully scanned, and kept after a yes when ClamAV failed", () => {
    expect(downloadSavedNotice({ name: "a.zip", dir: "/q", scan: "partial" })).toBe(
      'saved "a.zip" to /q, not fully scanned (ClamAV)',
    );
    expect(downloadSavedNotice({ name: "a.zip", dir: "/q", scan: "error" })).toBe(
      'saved "a.zip" to /q, not scanned (ClamAV failed)',
    );
    expect(downloadSavedNotice({ name: "a.zip", dir: "/q", scan: "stale" })).toBe(
      'saved "a.zip" to /q, scanned with outdated definitions (ClamAV)',
    );
    expect(downloadRefusedNotice("a.bin", { kind: "folder", text: "it is not yours" })).toBe(
      'refused download "a.bin": the quarantine folder is not usable: it is not yours',
    );
  });

  test("saved: where, and whether ClamAV scanned it", () => {
    const at = "~/Downloads/vimma-agent";
    expect(downloadSavedNotice({ name: "report.pdf", dir: at, scan: "clean" })).toBe(
      'saved "report.pdf" to ~/Downloads/vimma-agent, scanned (ClamAV)',
    );
    expect(downloadSavedNotice({ name: "report.pdf", dir: at, scan: "none" })).toBe(
      'saved "report.pdf" to ~/Downloads/vimma-agent, not scanned',
    );
    expect(downloadSavedNotice({ name: "report.pdf", dir: at, scan: "error" })).toBe(
      'saved "report.pdf" to ~/Downloads/vimma-agent, not scanned (ClamAV failed)',
    );
  });

  test("refused and deleted: why", () => {
    expect(downloadRefusedNotice("a.bin", { kind: "http" })).toBe(
      'refused download "a.bin": not https',
    );
    expect(downloadRefusedNotice("a.bin", { kind: "cap", mb: 200 })).toBe(
      'refused download "a.bin": over [mcp] download_max_mb (200 MB)',
    );
    expect(downloadRefusedNotice("a.bin", { kind: "infected", signature: "Eicar" })).toBe(
      'deleted download "a.bin": ClamAV found Eicar',
    );
    expect(downloadRefusedNotice("a.bin", { kind: "danger", text: "an executable (ELF)" })).toBe(
      'deleted download "a.bin": an executable (ELF), not allowed',
    );
    expect(downloadRefusedNotice("a.bin", { kind: "place" })).toBe(
      'refused download "a.bin": not in the quarantine folder',
    );
  });

  test("a file name in a notice is one line, cut", () => {
    const n = downloadSavedNotice({ name: `a\nb${"x".repeat(200)}`, dir: "/q", scan: "none" });
    expect(n).not.toMatch(/\n/);
    expect(n.length).toBeLessThan(140);
  });
});

// Issue #1119: edges the weekly mutation run found unpinned.
describe("the download checks' edges (mutation-tested)", () => {
  /** One central directory record, as `zip` writes it, with an extra field and a comment. */
  function cdRecord(name: string, { extra = 0, comment = 0, nameLength = -1 } = {}) {
    const bytes = enc.encode(name);
    const out = new Uint8Array(46 + bytes.length + extra + comment);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(28, nameLength < 0 ? bytes.length : nameLength, true);
    view.setUint16(30, extra, true);
    view.setUint16(32, comment, true);
    out.set(bytes, 46);
    // The extra field and the comment hold bytes that look like the next record's start.
    out.fill(0x50, 46 + bytes.length);
    return out;
  }
  const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  /** The offset of a zip's end record (no comment). */
  const eocd = (zip: Uint8Array) => zip.length - 22;
  const set16 = (zip: Uint8Array, at: number, n: number) =>
    new DataView(zip.buffer).setUint16(at, n, true);
  const set32 = (zip: Uint8Array, at: number, n: number) =>
    new DataView(zip.buffer).setUint32(at, n, true);

  test("each signature names what it found", () => {
    const head = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0]);
    const tar = new Uint8Array(512);
    tar.set(enc.encode("ustar"), 257);
    expect(dangerousContent(head(0x7f, 0x45, 0x4c, 0x46))?.text).toBe("an executable (ELF)");
    expect(dangerousContent(head(0x4d, 0x5a))?.text).toBe("an executable (PE)");
    expect(dangerousContent(head(0xfe, 0xed, 0xfa, 0xce))?.text).toBe("an executable (Mach-O)");
    expect(dangerousContent(enc.encode("#!/bin/sh"))?.text).toBe("a script (#!)");
    const archive = "an archive Vimma cannot look inside";
    expect(dangerousContent(head(0x1f, 0x8b))?.text).toBe(`${archive} (gzip)`);
    expect(dangerousContent(head(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00))?.text).toBe(
      `${archive} (xz)`,
    );
    expect(dangerousContent(enc.encode("BZh9"))?.text).toBe(`${archive} (bzip2)`);
    expect(dangerousContent(head(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))?.text).toBe(
      `${archive} (7z)`,
    );
    expect(dangerousContent(enc.encode("Rar!\u001a\u0007"))?.text).toBe(`${archive} (rar)`);
    expect(dangerousContent(head(0x28, 0xb5, 0x2f, 0xfd))?.text).toBe(`${archive} (zstd)`);
    expect(dangerousContent(tar)?.text).toBe(`${archive} (tar)`);
  });

  test("a head exactly as long as a signature matches it; 512 zero bytes are no tar", () => {
    expect(dangerousContent(new Uint8Array([0x4d, 0x5a]))?.kind).toBe("executable");
    expect(dangerousContent(new Uint8Array(512))).toBe(null);
  });

  test("a name: trailing dots and spaces all go, and a bare word has no extension", () => {
    expect(dangerousName("install.sh. .")?.kind).toBe("script");
    expect(dangerousName("install.sh..")?.kind).toBe("script");
    expect(dangerousName("sh")).toBe(null);
    expect(dangerousName("exe")).toBe(null);
    expect(dangerousName("dir/deb")).toBe(null);
  });

  test("Firefox's list is asked of an unlisted extension, with trailing dots and spaces gone", () => {
    const asked: string[] = [];
    const isExecutable = (n: string) => {
      asked.push(n);
      return n.endsWith(".pif");
    };
    expect(dangerousName("old.pif. ", { isExecutable })).toEqual({
      kind: "executable",
      text: "an executable",
    });
    expect(asked).toEqual(["old.pif"]);
    // A name without an extension, or with nothing in it, is not asked about.
    expect(dangerousName("README", { isExecutable: () => true })).toBe(null);
    expect(dangerousName("", { isExecutable: () => true })).toBe(null);
    expect(dangerousName("...", { isExecutable: () => true })).toBe(null);
    // A check that throws leaves the name alone to decide.
    const throws = () => {
      throw new Error("no service");
    };
    expect(dangerousName("old.pif", { isExecutable: throws })).toBe(null);
  });

  test("a type: spaces before its parameters go; a name of Object's own is no type", () => {
    expect(dangerousType("application/x-sh ; charset=utf-8")?.kind).toBe("script");
    expect(dangerousType(" Application/X-Sh")?.kind).toBe("script");
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(dangerousType(type), type).toBe(null);
    }
  });

  test("a zip: 22 zero bytes are not one, and a record faked in the comment is skipped", () => {
    expect(zipLocate(new Uint8Array(22), 22)).toEqual({ kind: "none" });
    // A comment that holds an end record of its own, followed by one more byte: its comment
    // length does not reach the end of the file, so it is not the end record.
    const fake = `PK\u0005\u0006${"\u0000".repeat(18)}x`;
    const zip = makeZip(["a.txt"], { comment: fake });
    expect(list(zip)).toEqual(["a.txt"]);
  });

  test("a zip whose directory runs one byte into its end record cannot be listed", () => {
    const zip = makeZip(["a.txt"]);
    const at = eocd(zip);
    set32(zip, at + 16, new DataView(zip.buffer).getUint32(at + 16, true) + 1);
    expect(list(zip)).toBe("unlistable");
  });

  test("zip64's markers each make a zip unlistable, also when nothing else is wrong", () => {
    const entries = makeZip(["a.txt"]);
    set16(entries, eocd(entries) + 8, 0xffff);
    set16(entries, eocd(entries) + 10, 0xffff);
    expect(list(entries)).toBe("unlistable");
    // In a file past 4 GiB a directory at 0xffffffff would be inside it.
    const offset = makeZip(["a.txt"]);
    set32(offset, eocd(offset) + 16, 0xffffffff);
    expect(zipLocate(offset, 5_000_000_000)).toEqual({ kind: "unlistable" });
  });

  test("a directory of 16 MiB is listed, one byte more is not; the two counts must agree", () => {
    const big = 16 * 1024 * 1024;
    const zip = makeZip(["a.txt"]);
    set32(zip, eocd(zip) + 16, 0);
    set32(zip, eocd(zip) + 12, big);
    expect(zipLocate(zip, 5_000_000_000)).toMatchObject({ kind: "zip", length: big });
    set32(zip, eocd(zip) + 12, big + 1);
    expect(zipLocate(zip, 5_000_000_000)).toEqual({ kind: "unlistable" });
    const counts = makeZip(["a.txt", "b.txt"]);
    set16(counts, eocd(counts) + 8, 1);
    expect(list(counts)).toBe("unlistable");
  });

  test("a directory: the most entries it lists, and every record checked", () => {
    const record = cdRecord("");
    const many = (n: number) => {
      const cd = new Uint8Array(n * record.length);
      for (let i = 0; i < n; i++) cd.set(record, i * record.length);
      return cd;
    };
    expect(zipEntryList(many(65534), 65534)).toHaveLength(65534);
    expect(zipEntryList(many(65535), 65535)).toBe(null);
    // One record of exactly 46 bytes, with an empty name.
    expect(zipEntryList(record, 1)).toEqual([{ name: "", mode: null }]);
    // A record without its signature.
    const unsigned = cdRecord("a.txt");
    unsigned[0] = 0;
    expect(zipEntryList(unsigned, 1)).toBe(null);
    // A name longer than what is left.
    expect(zipEntryList(cdRecord("a.txt", { nameLength: 6 }), 1)).toBe(null);
  });

  test("a directory: each record's extra field and comment are skipped to reach the next", () => {
    const cd = join(
      cdRecord("a.txt", { extra: 4, comment: 3 }),
      cdRecord("b.txt", { extra: 2 }),
      cdRecord("c.txt", { comment: 5 }),
    );
    expect(zipEntryNames(cd, 3)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(zipEntryNames(cd.subarray(0, cd.length - 1), 3)).toBe(null);
  });

  test("a name that is not UTF-8 is read with replacement characters, never a throw", () => {
    const cd = cdRecord("ab");
    cd[46] = 0xff;
    expect(zipEntryNames(cd, 1)).toEqual(["\uFFFDb"]);
  });

  test("a zip's verdict: its kind, a colon inside a name, a folder with an exec bit", () => {
    expect(zipVerdict(["../evil.txt"])).toEqual({
      kind: "archive",
      text: "a zip with a path outside its folder (../evil.txt)",
    });
    expect(zipVerdict([{ name: "docs", mode: 0o120777 }])?.kind).toBe("archive");
    expect(zipVerdict(["notes/re:plan.txt"])).toBe(null);
    expect(zipVerdict([{ name: "bin/", mode: 0o40755 }])).toBe(null);
    expect(zipVerdict([{ name: "docs/a.pdf", mode: 0o100644 }, "img/b.png"])).toBe(null);
    expect(zipVerdict(["nested.zip"])).toEqual({
      kind: "archive",
      text: "a zip holding an archive Vimma cannot look inside (nested.zip)",
    });
  });

  test("ClamAV's FOUND lines: no space needed after the colon, FOUND ends the line", () => {
    const run = (stdout: string) => clamVerdict({ exitCode: 1, stdout });
    expect(run("/q/a:Eicar FOUND\n")).toEqual({ kind: "infected", signature: "Eicar" });
    expect(run("/q/a: Eicar FOUND")).toEqual({ kind: "infected", signature: "Eicar" });
    expect(run("/q/a: Eicar FOUND \n")).toEqual({ kind: "infected", signature: "Eicar" });
    expect(run("/q/a: Eicar FOUND later\n")).toEqual({ kind: "infected", signature: "a virus" });
    expect(run("/q/a:  FOUND\n")).toEqual({ kind: "infected", signature: "a virus" });
  });

  test("the definitions' date: each field in its range, and a day the month has", () => {
    const date = (text: string) => clamDefinitionsDate(`ClamAV 1.5.4/28156/${text}`);
    expect(date("Sat Oct 31 23:59:59 2026")).toBe(new Date(2026, 9, 31, 23, 59, 59).getTime());
    // A leap second is read as the next minute.
    expect(date("Sat Oct 17 09:25:60 2026")).toBe(new Date(2026, 9, 17, 9, 26, 0).getTime());
    expect(date("Sat Foo 17 09:25:46 2026")).toBeNull();
    expect(date("Sat Oct 0 09:25:46 2026")).toBeNull();
    expect(date("Sat Oct 32 09:25:46 2026")).toBeNull();
    expect(date("Sat Oct 17 24:25:46 2026")).toBeNull();
    expect(date("Sat Oct 17 09:60:46 2026")).toBeNull();
    expect(date("Sat Oct 17 09:25:61 2026")).toBeNull();
    expect(date("Sat Nov 31 09:25:46 2026")).toBeNull();
  });

  test("the definitions' date: the version line alone, from its start to its end", () => {
    const line = "ClamAV 1.5.4/28156/Sat Oct 17 09:25:46 2026";
    const at = new Date(2026, 9, 17, 9, 25, 46).getTime();
    expect(clamDefinitionsDate(line)).toBe(at);
    expect(clamDefinitionsDate(`${line} \n`)).toBe(at);
    expect(clamDefinitionsDate(`clamdscan: ${line}`)).toBeNull();
    expect(clamDefinitionsDate(`${line} UTC`)).toBeNull();
    expect(clamDefinitionsDate(`other output\n${line}\nmore`)).toBe(at);
  });

  test("clamd.conf: a key alone, a # after a value, a line broken by a carriage return", () => {
    const good = ["LocalSocket /run/c.ctl", "AlertEncrypted yes", "AlertExceedsMax yes"];
    expect(clamdConfig([...good, "TCPSocket"].join("\n"))).toEqual({
      problem: "clamd listens on TCP",
    });
    expect(clamdConfig([...good, "TCPSocket 3310 #"].join("\n"))).toEqual({
      problem: "clamd listens on TCP",
    });
    expect(clamdConfig(["LocalSocket /run/a\r/b", ...good.slice(1)].join("\n"))).toEqual({
      problem: "line 1 has a control character",
    });
  });

  // clamd's own parser (ClamAV common/optparser.c) reads a line with fgets, so a carriage return,
  // a form feed or a NUL is part of the line to it, and a NUL ends what it reads. Any such line
  // makes the whole file unused: Vimma cannot be sure it reads it as clamd does.
  test("clamd.conf: a control character on any line refuses the whole file", () => {
    const good = ["LocalSocket /run/c.ctl", "AlertEncrypted yes", "AlertExceedsMax yes"];
    const conf = (...lines: string[]) => clamdConfig(lines.join("\n"));
    expect(conf(...good, "TCPSocket 3310\r#x")).toEqual({
      problem: "line 4 has a control character",
    });
    expect(conf(...good, "AlertEncrypted no\rX")).toEqual({
      problem: "line 4 has a control character",
    });
    // clamd strips only spaces, tabs and the LF: `yes\r` is no boolean to it, so CRLF is refused.
    expect(clamdConfig(good.join("\r\n"))).toEqual({ problem: "line 1 has a control character" });
    expect(clamdConfig(`${good.join("\n")}\r\n`)).toEqual({
      problem: "line 3 has a control character",
    });
    for (const c of ["\u0000", "\f", "\v", "\u001b", "\u007f", "\u0085"]) {
      expect(conf(...good, `TCPSocket 3310${c}`)).toEqual({
        problem: "line 4 has a control character",
      });
      expect(conf(`${c}TCPSocket 3310`, ...good)).toEqual({
        problem: "line 1 has a control character",
      });
      expect(conf(...good, `# a comment${c}`)).toEqual({
        problem: "line 4 has a control character",
      });
    }
    expect(conf("LocalSocket\t/run/c.ctl", "AlertEncrypted\tyes", "AlertExceedsMax yes")).toEqual({
      socket: "/run/c.ctl",
    });
    expect(clamdConfig(`${good.join("\n")}\n`)).toEqual({ socket: "/run/c.ctl" });
  });

  // clamd reads at most 1023 bytes of a line at once (512 in older releases) and parses the rest
  // as a line of its own, so a long comment could hide a setting.
  test("clamd.conf: a line clamd would read in two parts refuses the whole file", () => {
    const good = ["LocalSocket /run/c.ctl", "AlertEncrypted yes", "AlertExceedsMax yes"];
    const conf = (...lines: string[]) => clamdConfig(lines.join("\n"));
    expect(conf(...good, `#${"x".repeat(1100)}TCPSocket 3310`)).toEqual({
      problem: "line 4 is too long for clamd to read whole",
    });
    expect(conf(...good, `#${"x".repeat(509)}`)).toEqual({ socket: "/run/c.ctl" });
    expect(conf(...good, `#${"x".repeat(510)}`)).toEqual({
      problem: "line 4 is too long for clamd to read whole",
    });
    // Bytes, not characters: 2 + 2 * 255 bytes.
    expect(conf(...good, `# ${"\u00e9".repeat(255)}`)).toEqual({
      problem: "line 4 is too long for clamd to read whole",
    });
  });

  test("clamd.conf: names as clamd spells them, each set once, spaces and tabs only", () => {
    const good = ["LocalSocket /run/c.ctl", "AlertEncrypted yes", "AlertExceedsMax yes"];
    const conf = (...lines: string[]) => clamdConfig(lines.join("\n"));
    // clamd matches names case-sensitively and refuses the file over an unknown one.
    expect(conf("localsocket /run/c.ctl", ...good.slice(1))).toEqual({
      problem: "clamd does not read localsocket (line 1)",
    });
    expect(conf(...good, "alertencrypted no")).toEqual({
      problem: "clamd does not read alertencrypted (line 4)",
    });
    expect(conf(...good, "TCPAddr 127.0.0.1", "tcpaddr ::1")).toEqual({
      problem: "clamd does not read tcpaddr (line 5)",
    });
    expect(conf(...good, "Alert-Encrypted no")).toEqual({
      problem: "clamd does not read Alert-Encrypted (line 4)",
    });
    // Only a space or a tab ends a name in clamd; a name that runs into another kind of space is
    // unknown to it.
    expect(conf(...good, "TCPSocket\u00a03310")).toEqual({
      problem: "clamd does not read TCPSocket\u00a03310 (line 4)",
    });
    expect(conf(...good, "\ufeffTCPSocket 3310")).toEqual({
      problem: "clamd does not read \ufeffTCPSocket (line 4)",
    });
    expect(conf("LocalSocket /run/c.ctl\u00a0", ...good.slice(1))).toEqual({
      socket: "/run/c.ctl\u00a0",
    });
    // clamd also reads an option by its command-line name.
    expect(conf("LocalSocket /run/c.ctl", "alert-encrypted yes", "alert-exceeds-max 1")).toEqual({
      socket: "/run/c.ctl",
    });
    // clamd keeps the first setting of an option and ignores the rest: a second one is refused
    // rather than guessed at.
    expect(conf("AlertEncrypted no", ...good)).toEqual({
      problem: "clamd.conf sets AlertEncrypted twice",
    });
    expect(conf(...good, "alert-encrypted no")).toEqual({
      problem: "clamd.conf sets AlertEncrypted twice",
    });
    expect(conf(...good, "AlertExceedsMax yes")).toEqual({
      problem: "clamd.conf sets AlertExceedsMax twice",
    });
    expect(conf(...good, "LocalSocket /run/other.ctl")).toEqual({
      problem: "clamd.conf sets LocalSocket twice",
    });
    expect(conf(...good, "TCPSocket 3310", "TCPSocket 3311")).toEqual({
      problem: "clamd.conf sets TCPSocket twice",
    });
    // TCPAddr may be given more than once; it opens nothing without TCPSocket.
    expect(conf(...good, "TCPAddr 127.0.0.1", "TCPAddr ::1")).toEqual({ socket: "/run/c.ctl" });
  });

  test("clamd.conf: comments and quotes as clamd reads them", () => {
    const good = ["LocalSocket /run/c.ctl", "AlertEncrypted yes", "AlertExceedsMax yes"];
    const conf = (...lines: string[]) => clamdConfig(lines.join("\n"));
    expect(conf(...good, " \t# TCPSocket 3310")).toEqual({ socket: "/run/c.ctl" });
    // clamd drops a # and what follows it from a value.
    expect(
      conf("LocalSocket /run/c.ctl", "AlertEncrypted yes # all", "AlertExceedsMax TRUE#"),
    ).toEqual({ socket: "/run/c.ctl" });
    expect(conf(...good.slice(0, 2), "AlertExceedsMax no # yes")).toEqual({
      problem: "clamd does not alert on files over its limits",
    });
    // clamd's booleans are yes, true and 1 (any case) and no, false and 0; it refuses the rest.
    for (const value of ["on", "yes please", '"yes"', "#yes", "2"]) {
      expect(conf(good[0] ?? "", `AlertEncrypted ${value}`, good[2] ?? "")).toEqual({
        problem: "clamd does not alert on encrypted files",
      });
    }
    // A quoted or commented socket path is read differently by clamd: not used.
    for (const value of ['"/run/c.ctl"', "/run/c.ctl # main", "/run/c#ctl"]) {
      expect(conf(`LocalSocket ${value}`, ...good.slice(1))).toEqual({
        problem: "LocalSocket has a quote or a #",
      });
    }
  });

  test("a uid in /etc/passwd is digits only", () => {
    expect(passwdUid("clamav:x:x64:64::/:/bin/false", "clamav")).toBeNull();
    expect(passwdUid("clamav:x:64x:64::/:/bin/false", "clamav")).toBeNull();
    expect(passwdUid("clamav", "clamav")).toBeNull();
  });

  test("download_dir: spaces around it go, and ~ alone is home", () => {
    expect(resolveDownloadDir("  ~/q  ", "/home/u")).toBe("/home/u/q");
    expect(resolveDownloadDir(" /srv/q ", "/home/u")).toBe("/srv/q");
    expect(resolveDownloadDir("~", "/home/u")).toBe("/home/u");
  });

  test("a hidden folder is refused only below home, and home's own path is not read", () => {
    expect(quarantineProblem("/srv/abc/.x", "/home/u")).toBe(null);
    expect(quarantineProblem("/var/.home/u/q", "/var/.home/u")).toBe(null);
    expect(quarantineProblem("/home/j./q", "/home/j.")).toBe(null);
    expect(quarantineProblem("/home/j./q/.x", "/home/j.")).toBe(
      "must not be in a hidden folder (.x)",
    );
  });

  test("home itself is shown as ~", () => {
    expect(displayDir("/home/u", "/home/u")).toBe("~");
    expect(displayDir("/home/user", "/home/u")).toBe("/home/user");
  });

  test("sizes at each unit's edge", () => {
    expect(formatBytes(1000)).toBe("1 kB");
    expect(formatBytes(10_060)).toBe("10 kB");
    expect(formatBytes(123_400)).toBe("123 kB");
    expect(formatBytes(1_000_000)).toBe("1 MB");
    expect(formatBytes(3_200_000_000_000)).toBe("3.2 TB");
    expect(formatBytes(12.5)).toBe("12.5 B");
  });

  test("a notice's file name: one line, spaces collapsed and trimmed, cut at 60 with …", () => {
    const refused = (name: unknown) =>
      downloadRefusedNotice(name as string, { kind: "http" }).slice("refused download ".length);
    expect(refused(" a\u202Eb\n c  d ")).toBe('"a b c d": not https');
    expect(refused(undefined)).toBe('"": not https');
    const sixty = "x".repeat(60);
    expect(refused(sixty)).toBe(`"${sixty}": not https`);
    expect(refused(`${sixty}y`)).toBe(`"${"x".repeat(59)}…": not https`);
  });
});
