/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! vimma-ctl carries the Vimma version of the tree it is built from (docs/specs/ship-vimma-ctl.md,
//! decision 4): surfer.json's `brands.vimma.release.displayVersion`, which release-please bumps
//! with every release, becomes `VIMMA_VERSION` for src/version.rs. Cargo.toml's own version stays
//! fixed, so a release changes no Rust file and Cargo.lock never drifts from it.

use std::{env, fs, path::Path};

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let surfer = Path::new(&manifest).join("../../surfer.json");
    println!("cargo:rerun-if-changed={}", surfer.display());
    let text = fs::read_to_string(&surfer).unwrap_or_else(|e| {
        panic!(
            "vimma-ctl builds inside Vimma's repository: {}: {e}",
            surfer.display()
        )
    });
    let version = display_version(&text).unwrap_or_else(|| {
        panic!(
            "{}: no brands.vimma.release.displayVersion",
            surfer.display()
        )
    });
    println!("cargo:rustc-env=VIMMA_VERSION={version}");
}

/// The first `"displayVersion": "<x>"` in surfer.json, checked to be a version. surfer.json has
/// one brand, so the first is Vimma's; a std-only build script has no JSON parser, and the test
/// `agent_hello_names_this_vimma_ctl_version` reads the same field with a real one.
fn display_version(text: &str) -> Option<String> {
    let rest = &text[text.find("\"displayVersion\"")? + "\"displayVersion\"".len()..];
    let rest = rest
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let version = &rest[..rest.find('"')?];
    let ok = !version.is_empty()
        && version.len() <= 64
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    ok.then(|| version.to_string())
}
