// Issue #516: every package ships vimma-ctl (spec ship-vimma-ctl), and the libraries its toolchain
// links into it come with their notices. ctl-notices.mjs gathers them from the toolchain that
// built the binary (and musl's COPYRIGHT, which rustup does not ship, from tools/package/notices/)
// and describes the binary for the release SBOM.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arMembers, muslVersion, parseRustcVersion, writeCtlNotices } from "../ctl-notices.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../ctl-notices.mjs", import.meta.url));
const MUSL_COPYRIGHT = join(ROOT, "tools/package/notices/musl-1.2.5/COPYRIGHT");
const MUSL = "x86_64-unknown-linux-musl";

const RUSTC_VV = `rustc 1.99.1 (58cf8f9c3 2026-10-13)
binary: rustc
commit-hash: 58cf8f9c35b355199727627d07ae34a4e2846d67
commit-date: 2026-10-13
host: x86_64-unknown-linux-gnu
release: 1.99.1
LLVM version: 23.1.1
`;

// The shape of Rust's share/doc/rust/COPYRIGHT-library.html: the in-tree entries first, the
// top directory's licence among them, then each crate's notices.
const COPYRIGHT_LIBRARY = `<html><body>
<h1>Copyright notices for The Rust Standard Library</h1>
<div><p><b>File/Directory:</b> <code>.</code></p>
<p><b>License:</b> Apache-2.0 OR MIT</p></div>
<div><p><b>File/Directory:</b> <code>library/core/src/unicode</code></p>
<p><b>License:</b> Unicode-3.0</p></div>
<p><b>License:</b> Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT</p>
<p><b>License:</b> MIT/Apache-2.0</p>
<p><b>License:</b> Unlicense OR MIT</p>
</body></html>
`;

/**
 * A GNU ar archive, as musl's libc.a: a symbol table, long names for members over 15 characters.
 * @param {[string, Buffer | string][]} members
 */
function ar(members) {
  const longNames = members
    .filter(([name]) => name.length > 15)
    .map(([name]) => `${name}/\n`)
    .join("");
  /** @type {Buffer[]} */
  const parts = [Buffer.from("!<arch>\n", "latin1")];
  /**
   * @param {string} name
   * @param {Buffer} data
   */
  const member = (name, data) => {
    const header =
      name.padEnd(16) +
      "0".padEnd(12) +
      "0".padEnd(6) +
      "0".padEnd(6) +
      "644".padEnd(8) +
      String(data.length).padEnd(10) +
      "`\n";
    parts.push(Buffer.from(header, "latin1"), data);
    if (data.length % 2) parts.push(Buffer.from("\n"));
  };
  member("/", Buffer.from("\0\0\0\0"));
  if (longNames) member("//", Buffer.from(longNames, "latin1"));
  for (const [name, data] of members) {
    const ref = name.length > 15 ? `/${longNames.indexOf(`${name}/`)}` : `${name}/`;
    member(ref, Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1"));
  }
  return Buffer.concat(parts);
}

/** An object file whose .rodata holds musl's version string among others. */
const versionObject = (/** @type {string} */ version) =>
  Buffer.from(`\x7fELF\0\0\0junk\0${version}\0GCC: (GNU) 13.2.0\0`, "latin1");

/**
 * A rustup sysroot as `rustc --print sysroot` names it, with the musl target when asked.
 * @param {{ musl?: string | null, copyright?: string | null, licenses?: string[] }} [options]
 */
function fakeSysroot({
  musl = "1.2.5",
  copyright = COPYRIGHT_LIBRARY,
  licenses = ["Apache-2.0", "MIT", "LLVM-exception", "Unicode-3.0", "GPL-3.0-or-later"],
} = {}) {
  const sysroot = tempDir("vimma-sysroot-");
  /** @type {Record<string, string | Buffer>} */
  const files = {};
  if (copyright !== null) files["share/doc/rust/COPYRIGHT-library.html"] = copyright;
  for (const id of licenses) files[`share/doc/rust/licenses/${id}.txt`] = `${id} licence text\n`;
  if (musl !== null) {
    const lib = `lib/rustlib/${MUSL}/lib/self-contained`;
    files[`${lib}/libc.a`] = ar([
      ["printf.lo", "printf"],
      ["pthread_mutexattr_setrobust.lo", "long name"],
      ["version.lo", versionObject(musl)],
    ]);
    files[`${lib}/libunwind.a`] = ar([["libunwind.o", "unwind"]]);
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(sysroot, path)), { recursive: true });
    writeFileSync(join(sysroot, path), content);
  }
  return sysroot;
}

const CONFIG = { brands: { vimma: { release: { displayVersion: "0.1.8" } } } };
const CARGO_TOML = '[package]\nname = "vimma-ctl"\nversion = "0.1.0"\nlicense = "MPL-2.0"\n';

/** @param {Partial<Parameters<typeof writeCtlNotices>[0]>} [options] */
function notices(options = {}) {
  const out = join(tempDir("vimma-ctl-notices-"), "vimma-ctl-licenses");
  const component = writeCtlNotices({
    sysroot: fakeSysroot(),
    rustc: RUSTC_VV,
    target: MUSL,
    cargoToml: CARGO_TOML,
    config: CONFIG,
    repo: "vimma-browser/vimma",
    out,
    ...options,
  });
  return { out, component };
}

/** @param {string} dir */
const listing = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();

describe("arMembers", () => {
  it("reads short and long member names and skips no data", () => {
    const members = arMembers(
      ar([
        ["a.lo", "odd"],
        ["a_very_long_member_name.lo", "x"],
        ["b.lo", "even"],
      ]),
    );
    expect(members.map((m) => [m.name, m.data.toString()])).toEqual([
      ["/", "\0\0\0\0"],
      ["//", "a_very_long_member_name.lo/\n"],
      ["a.lo", "odd"],
      ["a_very_long_member_name.lo", "x"],
      ["b.lo", "even"],
    ]);
  });

  it("reads BSD names, as macOS's ar writes them", () => {
    const name = "version.lo";
    const data = Buffer.from(`${name}\0\0` + "data");
    const header = `#1/12`.padEnd(16) + "0".padEnd(32) + String(data.length).padEnd(10) + "`\n";
    const archive = Buffer.concat([Buffer.from(`!<arch>\n${header}`, "latin1"), data]);
    expect(arMembers(archive).map((m) => [m.name, m.data.toString()])).toEqual([
      ["version.lo", "data"],
    ]);
  });

  it("refuses a file that is not an ar archive", () => {
    expect(() => arMembers(Buffer.from("\x7fELF"))).toThrow(/not an ar archive/);
  });
});

describe("muslVersion", () => {
  it("reads the version musl's version.lo carries", () => {
    expect(muslVersion(ar([["version.lo", versionObject("1.2.5")]]))).toBe("1.2.5");
  });

  it("refuses a libc.a without one version", () => {
    expect(() => muslVersion(ar([["printf.lo", "x"]]))).toThrow(/version\.lo/);
    const two = Buffer.from("\0" + "1.2.5\0" + "1.2.4\0", "latin1");
    expect(() => muslVersion(ar([["version.lo", two]]))).toThrow(/1\.2\.5, 1\.2\.4/);
  });
});

describe("parseRustcVersion", () => {
  it("reads the release, commit, host and LLVM version from rustc -vV", () => {
    expect(parseRustcVersion(RUSTC_VV)).toEqual({
      line: "rustc 1.99.1 (58cf8f9c3 2026-10-13)",
      release: "1.99.1",
      commit: "58cf8f9c35b355199727627d07ae34a4e2846d67",
      host: "x86_64-unknown-linux-gnu",
      llvm: "23.1.1",
    });
  });

  it("refuses output without a release", () => {
    expect(() => parseRustcVersion("rustc\n")).toThrow(/rustc -vV/);
  });
});

describe("writeCtlNotices for the static Linux binary", () => {
  it("copies Rust's library notices, the licence texts they name and musl's COPYRIGHT", () => {
    const sysroot = fakeSysroot();
    const { out } = notices({ sysroot });
    expect(listing(out)).toEqual([
      "README.txt",
      "licenses/Apache-2.0.txt",
      "licenses/LLVM-exception.txt",
      "licenses/MIT.txt",
      "licenses/Unicode-3.0.txt",
      "musl-COPYRIGHT",
      "rust-std-COPYRIGHT.html",
    ]);
    const doc = join(sysroot, "share/doc/rust");
    expect(readFileSync(join(out, "rust-std-COPYRIGHT.html"), "utf8")).toBe(COPYRIGHT_LIBRARY);
    expect(readFileSync(join(out, "licenses/MIT.txt"), "utf8")).toBe(
      readFileSync(join(doc, "licenses/MIT.txt"), "utf8"),
    );
    expect(readFileSync(join(out, "musl-COPYRIGHT"), "utf8")).toBe(
      readFileSync(MUSL_COPYRIGHT, "utf8"),
    );
  });

  it("says in README.txt what the binary links, with versions read from the build", () => {
    const readme = readFileSync(join(notices().out, "README.txt"), "utf8");
    expect(readme).toContain("vimma-ctl 0.1.8");
    expect(readme).toContain("MPL-2.0");
    expect(readme).toContain(`rustc 1.99.1 (58cf8f9c3 2026-10-13) for ${MUSL}`);
    expect(readme).toMatch(/Rust standard library, Rust 1\.99\.1 \(Apache-2\.0 OR MIT\)/);
    expect(readme).toMatch(/musl libc 1\.2\.5 \(MIT\): musl-COPYRIGHT/);
    expect(readme).toMatch(
      /libunwind, from Rust's LLVM 23\.1\.1 \(Apache-2\.0 WITH LLVM-exception\)/,
    );
    for (const line of readme.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("names vimma-ctl's own licence as its Cargo.toml does, as the SBOM entry does", () => {
    const cargoToml = CARGO_TOML.replace('"MPL-2.0"', '"Apache-2.0"');
    const { out, component } = notices({ cargoToml });
    const readme = readFileSync(join(out, "README.txt"), "utf8");
    expect(readme).toContain("is licensed under Apache-2.0.");
    expect(readme).not.toContain("MPL-2.0");
    expect(component.licenses).toEqual([{ license: { id: "Apache-2.0" } }]);
  });

  it("describes vimma-ctl and what it links as one SBOM component", () => {
    const binary = join(tempDir("vimma-ctl-bin-"), "vimma-ctl");
    writeFileSync(binary, "static binary");
    const { component } = notices({ binary });
    const purl = "pkg:github/vimma-browser/vimma@v0.1.8#tools/vimma-ctl";
    expect(component).toMatchObject({
      type: "application",
      "bom-ref": purl,
      name: "vimma-ctl",
      version: "0.1.8",
      purl,
      licenses: [{ license: { id: "MPL-2.0" } }],
      hashes: [
        { alg: "SHA-256", content: createHash("sha256").update("static binary").digest("hex") },
      ],
      properties: [
        { name: "vimma:rust-target", value: MUSL },
        { name: "vimma:rustc", value: "rustc 1.99.1 (58cf8f9c3 2026-10-13)" },
      ],
    });
    expect(component.components).toEqual([
      {
        type: "library",
        "bom-ref": "pkg:generic/rust-lang/rust-std@1.99.1#vimma-ctl",
        group: "rust-lang",
        name: "rust-std",
        version: "1.99.1",
        purl: "pkg:generic/rust-lang/rust-std@1.99.1",
        licenses: [{ expression: "Apache-2.0 OR MIT" }],
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/rust-lang/rust/tree/58cf8f9c35b355199727627d07ae34a4e2846d67",
          },
        ],
      },
      {
        type: "library",
        "bom-ref": "pkg:generic/musl@1.2.5#vimma-ctl",
        name: "musl",
        version: "1.2.5",
        purl: "pkg:generic/musl@1.2.5",
        licenses: [{ license: { id: "MIT" } }],
        externalReferences: [{ type: "website", url: "https://musl.libc.org/" }],
      },
      {
        type: "library",
        "bom-ref": "pkg:generic/llvm/libunwind@23.1.1#vimma-ctl",
        group: "llvm",
        name: "libunwind",
        version: "23.1.1",
        purl: "pkg:generic/llvm/libunwind@23.1.1",
        licenses: [{ expression: "Apache-2.0 WITH LLVM-exception" }],
        externalReferences: [{ type: "vcs", url: "https://github.com/rust-lang/llvm-project" }],
      },
    ]);
  });

  it("refuses a musl version it has no COPYRIGHT for", () => {
    expect(() => notices({ sysroot: fakeSysroot({ musl: "1.2.6" }) })).toThrow(
      /musl 1\.2\.6.*notices\/musl-1\.2\.6\/COPYRIGHT/,
    );
  });

  it("refuses a toolchain without its library notices or the MIT and Apache texts", () => {
    expect(() => notices({ sysroot: fakeSysroot({ copyright: null }) })).toThrow(
      /COPYRIGHT-library\.html/,
    );
    const noTopLicence = COPYRIGHT_LIBRARY.replace("<code>.</code>", "<code>library</code>");
    expect(() => notices({ sysroot: fakeSysroot({ copyright: noTopLicence }) })).toThrow(
      /COPYRIGHT-library\.html/,
    );
    for (const missing of ["MIT", "Apache-2.0", "LLVM-exception", "Unicode-3.0"]) {
      const licenses = ["Apache-2.0", "MIT", "LLVM-exception", "Unicode-3.0"].filter(
        (id) => id !== missing,
      );
      expect(() => notices({ sysroot: fakeSysroot({ licenses }) }), missing).toThrow(
        new RegExp(`licenses/${missing}\\.txt`),
      );
    }
  });

  it("refuses a sysroot without the target's libc.a, and an output dir that exists", () => {
    expect(() => notices({ sysroot: fakeSysroot({ musl: null }) })).toThrow(/libc\.a/);
    const out = tempDir("vimma-ctl-notices-");
    expect(() => notices({ out })).toThrow(/exists/);
  });
});

describe("writeCtlNotices for the Mac binary", () => {
  const darwin = () =>
    notices({
      sysroot: fakeSysroot({ musl: null }),
      rustc: RUSTC_VV.replace("x86_64-unknown-linux-gnu", "aarch64-apple-darwin"),
      target: undefined,
    });

  it("has Rust's notices and no musl or libunwind, which macOS provides", () => {
    const { out, component } = darwin();
    expect(listing(out)).toEqual([
      "README.txt",
      "licenses/Apache-2.0.txt",
      "licenses/LLVM-exception.txt",
      "licenses/MIT.txt",
      "licenses/Unicode-3.0.txt",
      "rust-std-COPYRIGHT.html",
    ]);
    const readme = readFileSync(join(out, "README.txt"), "utf8");
    expect(readme).toContain("for aarch64-apple-darwin");
    expect(readme).not.toMatch(/musl|libunwind/);
    expect(component.components?.map((c) => c.name)).toEqual(["rust-std"]);
    expect(component.hashes).toBeUndefined();
  });
});

describe("the vendored musl COPYRIGHT", () => {
  it("is the release tarball's file, pinned in vendor/README.md by its SHA-256", () => {
    const readme = readFileSync(join(ROOT, "tools/package/vendor/README.md"), "utf8");
    const row = readme.split("\n").find((l) => l.includes("`../notices/musl-1.2.5/COPYRIGHT`"));
    expect(row).toContain("https://musl.libc.org/releases/musl-1.2.5.tar.gz");
    const sha = createHash("sha256").update(readFileSync(MUSL_COPYRIGHT)).digest("hex");
    expect(row).toContain(`\`${sha}\``);
  });
});

describe("ctl-notices.mjs", () => {
  it("asks the pinned toolchain in tools/vimma-ctl for its sysroot and version", () => {
    const dir = tempDir("vimma-ctl-notices-cli-");
    const sysroot = fakeSysroot();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "rustc.log");
    writeFileSync(
      join(bin, "rustc"),
      `#!/bin/sh
echo "$PWD $*" >> "${log}"
case "$*" in
  "--print sysroot") echo "${sysroot}" ;;
  -vV) cat <<'EOF'
${RUSTC_VV}EOF
  ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(join(bin, "rustc"), 0o755);
    const binary = join(dir, "vimma-ctl");
    writeFileSync(binary, "static binary");
    const out = join(dir, "out/vimma-ctl-licenses");
    const component = join(dir, "out/vimma-ctl.cdx.json");
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--target", MUSL, "--binary", binary, "--out", out, "--component", component],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const ctlDir = join(ROOT, "tools/vimma-ctl");
    expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual(
      [`${ctlDir} --print sysroot`, `${ctlDir} -vV`].sort(),
    );
    expect(existsSync(join(out, "musl-COPYRIGHT"))).toBe(true);
    const json = JSON.parse(readFileSync(component, "utf8"));
    expect(json.name).toBe("vimma-ctl");
    expect(json.version).toBe(
      JSON.parse(readFileSync(join(ROOT, "surfer.json"), "utf8")).brands.vimma.release
        .displayVersion,
    );
    expect(json.licenses).toEqual([{ license: { id: "MPL-2.0" } }]);
  });
});
