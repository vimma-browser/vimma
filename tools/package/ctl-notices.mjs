#!/usr/bin/env node
/**
 * The notices for what the toolchain links into vimma-ctl, and its entry for the release SBOM
 * (#516; spec ship-vimma-ctl). Every package ships vimma-ctl, and the MIT terms of musl and of
 * Rust's standard library ask for their notices in every copy. release.yml's ctl and macos-ctl
 * jobs run this right after they build the binary, with the same toolchain, so the notices and
 * versions are those of the build:
 *
 * - Rust's standard library: `share/doc/rust/COPYRIGHT-library.html` from the toolchain's
 *   sysroot (the Rust project's own list of the library's licences and the notices of the crates
 *   it uses) and the licence texts it names from `share/doc/rust/licenses/`.
 * - musl (static Linux binary only): its version is read from the target's self-contained
 *   `libc.a`; rustup ships no musl COPYRIGHT, so it is the one in `notices/musl-<version>/`, an
 *   unchanged copy from that musl release (vendor/README.md). A toolchain that brings another
 *   musl stops here until that release's COPYRIGHT is added.
 * - LLVM's libunwind (static Linux binary only), from the target's self-contained `libunwind.a`,
 *   at the LLVM version rustc reports. Apache-2.0 WITH LLVM-exception asks for no notice in a
 *   binary; it is named for completeness.
 *
 * Usage: node tools/package/ctl-notices.mjs --out <dir> [--target <triple>] [--binary <vimma-ctl>]
 *          [--component <file.json>] [--repo vimma-browser/vimma]
 * rustc runs in tools/vimma-ctl, so rustup picks the toolchain its rust-toolchain.toml pins.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "../repo.mjs";
import { canonicalLicense } from "./sbom.mjs";

/** @typedef {import("./sbom.mjs").Component} Component */

const NOTICES = fileURLToPath(new URL("notices/", import.meta.url));

/**
 * The members of an ar archive (GNU names, long names through `//`, or BSD `#1/<n>` names).
 * @param {Buffer} archive
 * @returns {{ name: string, data: Buffer }[]}
 */
export function arMembers(archive) {
  if (archive.subarray(0, 8).toString("latin1") !== "!<arch>\n") {
    throw new Error("not an ar archive");
  }
  /** @type {{ name: string, data: Buffer }[]} */
  const members = [];
  let longNames = "";
  let offset = 8;
  while (offset + 60 <= archive.length) {
    const header = archive.subarray(offset, offset + 60).toString("latin1");
    const size = Number(header.slice(48, 58).trim());
    if (header.slice(58, 60) !== "`\n" || !Number.isInteger(size)) {
      throw new Error(`not an ar archive: bad member header at byte ${offset}`);
    }
    let name = header.slice(0, 16).trimEnd();
    let start = offset + 60;
    const end = start + size;
    const bsd = /^#1\/(\d+)$/.exec(name);
    const long = /^\/(\d+)$/.exec(name);
    if (bsd) {
      const length = Number(bsd[1]);
      name = archive
        .subarray(start, start + length)
        .toString("latin1")
        .replace(/\0+$/, "");
      start += length;
    } else if (long) {
      const at = Number(long[1]);
      name = longNames.slice(at, longNames.indexOf("/\n", at));
    } else if (name !== "/" && name !== "//" && name.endsWith("/")) {
      name = name.slice(0, -1);
    }
    const data = archive.subarray(start, end);
    if (name === "//") longNames = data.toString("latin1");
    members.push({ name, data });
    offset = end + (size % 2);
  }
  return members;
}

/**
 * The musl version a static libc.a carries: musl builds `src/internal/version.c`, whose one
 * string is VERSION, into `version.lo`.
 * @param {Buffer} libc
 * @returns {string}
 */
export function muslVersion(libc) {
  const member = arMembers(libc).find((m) => m.name === "version.lo" || m.name === "version.o");
  if (!member) throw new Error("libc.a has no version.lo: not musl's");
  const versions = [
    ...new Set(
      member.data
        .toString("latin1")
        .split("\0")
        .filter((s) => /^\d+\.\d+\.\d+$/.test(s)),
    ),
  ];
  if (versions.length !== 1) {
    throw new Error(`libc.a's version.lo has ${versions.length} versions: ${versions.join(", ")}`);
  }
  return /** @type {string} */ (versions[0]);
}

/**
 * @param {string} text the output of `rustc -vV`
 * @returns {{ line: string, release: string, commit: string, host: string, llvm: string }}
 */
export function parseRustcVersion(text) {
  /** @param {string} key */
  const field = (key) => new RegExp(`^${key}: (\\S+)$`, "m").exec(text)?.[1] ?? "";
  const line = text.split("\n")[0] ?? "";
  const release = field("release");
  if (!/^rustc \d/.test(line) || !/^\d+\.\d+\.\d+/.test(release)) {
    throw new Error(`not the output of rustc -vV: ${line}`);
  }
  return {
    line,
    release,
    commit: field("commit-hash"),
    host: field("host"),
    llvm: field("LLVM version"),
  };
}

/**
 * The licence of the top directory in Rust's COPYRIGHT-library.html: the standard library's own.
 * @param {string} html
 */
function rustLibraryLicense(html) {
  const license = /<code>\.<\/code>[\s\S]*?<b>License:<\/b>\s*([^<]+?)\s*</.exec(html)?.[1];
  if (!license) throw new Error("COPYRIGHT-library.html names no licence for its top directory");
  return license;
}

/**
 * Every SPDX id the `License:` lines of COPYRIGHT-library.html name.
 * @param {string} html
 */
function licenseIds(html) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const match of html.matchAll(/<b>License:<\/b>\s*([^<]+)</g)) {
    for (const token of (match[1] ?? "").split(/[\s()/]+/)) {
      if (token && !/^(OR|AND|WITH)$/i.test(token)) ids.add(token);
    }
  }
  return ids;
}

/** @param {string} file */
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * @param {{ version: string, rustc: ReturnType<typeof parseRustcVersion>, target: string,
 *   ctlLicense: string, rustLicense: string, musl?: { version: string, license: string } }} input
 */
function readme({ version, rustc, target, ctlLicense, rustLicense, musl }) {
  const lines = [
    `vimma-ctl ${version}, the command-line client for Vimma's control socket,`,
    `is licensed under ${ctlLicense}. It was built with`,
    `${rustc.line} for ${target},`,
    "which put these libraries into it; their notices are in this directory.",
    "",
    `- The Rust standard library, Rust ${rustc.release} (${rustLicense}):`,
    "  rust-std-COPYRIGHT.html, with the notices of the crates it uses. It is",
    "  share/doc/rust/COPYRIGHT-library.html from the Rust toolchain.",
  ];
  if (musl) {
    lines.push(
      `- musl libc ${musl.version} (${musl.license}): musl-COPYRIGHT, from that musl release.`,
      `- LLVM's libunwind, from Rust's LLVM ${rustc.llvm} (Apache-2.0 WITH LLVM-exception).`,
    );
  }
  lines.push(
    "",
    "licenses/ holds the licence texts these notices name, from the Rust",
    "toolchain's share/doc/rust/licenses/.",
    "",
  );
  return lines.join("\n");
}

/**
 * Writes vimma-ctl's notices into `out` (which must not exist) and returns its SBOM component.
 * @param {{ sysroot: string, rustc: string, target?: string, out: string, cargoToml: string,
 *   config: { brands?: Record<string, { release?: { displayVersion?: unknown } }> },
 *   repo: string, binary?: string }} options
 *   rustc: `rustc -vV`'s output; target: the triple built for (default: rustc's host);
 *   cargoToml: tools/vimma-ctl/Cargo.toml; binary: the built vimma-ctl, hashed into the entry
 * @returns {Component & { components?: Component[], properties?: { name: string, value: string }[] }}
 */
export function writeCtlNotices({ sysroot, rustc, target, out, cargoToml, config, repo, binary }) {
  const license = /^license = "([^"]+)"$/m.exec(cargoToml)?.[1];
  if (!license) throw new Error("tools/vimma-ctl/Cargo.toml has no license");
  const version = String(config.brands?.vimma?.release?.displayVersion ?? "");
  const toolchain = parseRustcVersion(rustc);
  const triple = target ?? toolchain.host;
  const doc = join(sysroot, "share/doc/rust");
  const copyright = join(doc, "COPYRIGHT-library.html");
  if (!existsSync(copyright)) {
    throw new Error(`${copyright} is missing: not a rustup toolchain's sysroot?`);
  }
  const html = readFileSync(copyright, "utf8");
  const rustLicense = rustLibraryLicense(html);

  /** @type {{ version: string, license: string, copyright: string } | undefined} */
  let musl;
  if (/-musl/.test(triple)) {
    const lib = join(sysroot, "lib/rustlib", triple, "lib/self-contained");
    const libc = join(lib, "libc.a");
    if (!existsSync(libc)) throw new Error(`${libc} is missing: rustup target add ${triple}`);
    const muslRelease = muslVersion(readFileSync(libc));
    const muslCopyright = join(NOTICES, `musl-${muslRelease}`, "COPYRIGHT");
    if (!existsSync(muslCopyright)) {
      throw new Error(
        `the toolchain links musl ${muslRelease}, and tools/package/notices/musl-${muslRelease}/COPYRIGHT ` +
          `is missing: add it from musl-${muslRelease}.tar.gz (tools/package/vendor/README.md)`,
      );
    }
    const license = /licensed under the following standard (\S+) license/.exec(
      readFileSync(muslCopyright, "utf8"),
    )?.[1];
    if (!license) throw new Error(`${muslCopyright} names no licence`);
    if (!existsSync(join(lib, "libunwind.a"))) throw new Error(`${lib}/libunwind.a is missing`);
    musl = { version: muslRelease, license, copyright: muslCopyright };
  }

  const texts = join(doc, "licenses");
  const available = existsSync(texts) ? readdirSync(texts) : [];
  const ids = [...licenseIds(html)].filter((id) => available.includes(`${id}.txt`)).sort();
  // Unicode-3.0 covers core's Unicode tables, an AND term next to the library's own licence.
  for (const id of ["MIT", "Apache-2.0", ...(musl ? ["LLVM-exception"] : []), "Unicode-3.0"]) {
    if (!ids.includes(id)) throw new Error(`${texts}/${id}.txt is missing`);
  }

  if (existsSync(out)) throw new Error(`${out} exists: notices go into a new directory`);
  mkdirSync(join(out, "licenses"), { recursive: true });
  copyFileSync(copyright, join(out, "rust-std-COPYRIGHT.html"));
  for (const id of ids) copyFileSync(join(texts, `${id}.txt`), join(out, "licenses", `${id}.txt`));
  if (musl) copyFileSync(musl.copyright, join(out, "musl-COPYRIGHT"));
  writeFileSync(
    join(out, "README.txt"),
    readme({ version, rustc: toolchain, target: triple, ctlLicense: license, rustLicense, musl }),
  );

  const stdPurl = `pkg:generic/rust-lang/rust-std@${toolchain.release}`;
  /** @type {Component[]} */
  const components = [
    {
      type: "library",
      "bom-ref": `${stdPurl}#vimma-ctl`,
      group: "rust-lang",
      name: "rust-std",
      version: toolchain.release,
      purl: stdPurl,
      licenses: [canonicalLicense(rustLicense)],
      externalReferences: [
        { type: "vcs", url: `https://github.com/rust-lang/rust/tree/${toolchain.commit}` },
      ],
    },
  ];
  if (musl) {
    const muslPurl = `pkg:generic/musl@${musl.version}`;
    const unwindPurl = `pkg:generic/llvm/libunwind@${toolchain.llvm}`;
    components.push(
      {
        type: "library",
        "bom-ref": `${muslPurl}#vimma-ctl`,
        name: "musl",
        version: musl.version,
        purl: muslPurl,
        licenses: [canonicalLicense(musl.license)],
        externalReferences: [{ type: "website", url: "https://musl.libc.org/" }],
      },
      {
        type: "library",
        "bom-ref": `${unwindPurl}#vimma-ctl`,
        group: "llvm",
        name: "libunwind",
        version: toolchain.llvm,
        purl: unwindPurl,
        licenses: [canonicalLicense("Apache-2.0 WITH LLVM-exception")],
        externalReferences: [{ type: "vcs", url: "https://github.com/rust-lang/llvm-project" }],
      },
    );
  }
  const purl = `pkg:github/${repo}@v${version}#tools/vimma-ctl`;
  return {
    type: "application",
    "bom-ref": purl,
    name: "vimma-ctl",
    version,
    purl,
    licenses: [canonicalLicense(license)],
    ...(binary ? { hashes: [{ alg: "SHA-256", content: sha256(binary) }] } : {}),
    properties: [
      { name: "vimma:rust-target", value: triple },
      { name: "vimma:rustc", value: toolchain.line },
    ],
    components,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      target: { type: "string" },
      binary: { type: "string" },
      component: { type: "string" },
      repo: { type: "string", default: REPO },
    },
  });
  if (!values.out) {
    console.error(
      "usage: ctl-notices.mjs --out <dir> [--target <triple>] [--binary <vimma-ctl>] [--component <file>]",
    );
    process.exit(2);
  }
  const root = new URL("../../", import.meta.url);
  const crate = fileURLToPath(new URL("tools/vimma-ctl/", root));
  /** @param {string[]} args */
  const rustc = (args) => execFileSync("rustc", args, { cwd: crate, encoding: "utf8" });
  const component = writeCtlNotices({
    sysroot: rustc(["--print", "sysroot"]).trim(),
    rustc: rustc(["-vV"]),
    target: values.target,
    out: values.out,
    binary: values.binary,
    cargoToml: readFileSync(join(crate, "Cargo.toml"), "utf8"),
    config: JSON.parse(readFileSync(new URL("surfer.json", root), "utf8")),
    repo: values.repo ?? REPO,
  });
  if (values.component) writeFileSync(values.component, `${JSON.stringify(component, null, 2)}\n`);
  console.log(`ctl-notices: ${values.out}${values.component ? `, ${values.component}` : ""}`);
}
