/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! This vimma-ctl's version and how it compares with Vimma's (docs/specs/ship-vimma-ctl.md).
//! vimma-ctl ships with Vimma and carries Vimma's version, so a client older than the browser
//! it reaches is one that was not updated with it: it still works, with the tools it knows, and
//! says so to the agent. vimma-core's ctl-version.mjs compares the same way.

use std::cmp::Ordering;

/// Vimma's version of the tree this binary was built from: surfer.json's displayVersion, read
/// by build.rs.
pub const VERSION: &str = env!("VIMMA_VERSION");

/// Major, minor and patch, and whether it has a pre-release.
fn parse(version: &str) -> Option<([u64; 3], bool)> {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    if let Some(pre) = pre {
        let ok = !pre.is_empty()
            && pre
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
        if !ok {
            return None;
        }
    }
    let mut parts = core.split('.');
    let mut numbers = [0; 3];
    for n in &mut numbers {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *n = part.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some((numbers, pre.is_some()))
}

/// `a` against `b`; `None` when either is not a version. A pre-release sorts before its release,
/// and two pre-releases of one release compare equal, so a nightly never warns about another
/// nightly of the same release.
#[must_use]
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let (x, x_pre) = parse(a)?;
    let (y, y_pre) = parse(b)?;
    Some(x.cmp(&y).then(y_pre.cmp(&x_pre)))
}

/// What `vimma-ctl mcp` tells the agent when this client is older than Vimma `vimma`; `None`
/// when it is not, or when `vimma` is not a version.
#[must_use]
pub fn older_note(vimma: &str) -> Option<String> {
    (compare(VERSION, vimma)? == Ordering::Less).then(|| {
        format!(
            "This vimma-ctl ({VERSION}) is older than Vimma ({vimma}), so it offers fewer tools \
             than Vimma has. Tell the user to update vimma-ctl: it ships with Vimma, and the \
             user guide's \"Agent workspace\" section says where."
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_by_number_not_text() {
        assert_eq!(compare("0.1.7", "0.1.8"), Some(Ordering::Less));
        assert_eq!(compare("0.1.10", "0.1.9"), Some(Ordering::Greater));
        assert_eq!(compare("1.0.0", "0.99.99"), Some(Ordering::Greater));
        assert_eq!(compare("0.2.0", "0.2.0"), Some(Ordering::Equal));
    }

    #[test]
    fn a_pre_release_sorts_before_its_release() {
        assert_eq!(compare("0.1.8-nightly.1", "0.1.8"), Some(Ordering::Less));
        assert_eq!(compare("0.1.8", "0.1.8-nightly.1"), Some(Ordering::Greater));
        assert_eq!(
            compare("0.1.8-nightly.1", "0.1.8-nightly.2"),
            Some(Ordering::Equal)
        );
        assert_eq!(compare("0.1.8-nightly.1", "0.1.7"), Some(Ordering::Greater));
    }

    #[test]
    fn anything_else_is_not_a_version() {
        for bad in [
            "",
            "1.2",
            "v0.1.8",
            "0.1.8 ",
            "0.1.8+b",
            "0.1.8-",
            "0..8",
            "157.0.1.2",
        ] {
            assert_eq!(compare(bad, "0.1.8"), None, "{bad:?}");
        }
    }

    #[test]
    fn the_note_only_for_a_newer_vimma() {
        assert_eq!(older_note(VERSION), None);
        assert_eq!(older_note("0.0.1"), None);
        assert_eq!(older_note("not a version"), None);
        let note = older_note("999.0.0").unwrap();
        assert!(note.starts_with(&format!(
            "This vimma-ctl ({VERSION}) is older than Vimma (999.0.0)"
        )));
    }
}
