/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Property tests of what `vimma-ctl` reads from the socket and the discovery file: the JSON
//! parser and the protocol decoders (docs/specs/m7-fuzzing.md). `cargo test` runs a fixed
//! seed; the nightly fuzz workflow sets `PROPTEST_RNG_SEED` (random) and `PROPTEST_CASES` for
//! many more cases. Reproducing: docs/runbook/ci-fuzzing.md, "Fuzzing: reproducing a failing seed".

use proptest::prelude::*;
use proptest::test_runner::RngSeed;
use std::collections::BTreeMap;
use std::fmt::Write;
use vimma_ctl::json::{self, MAX_DEPTH, Value};
use vimma_ctl::protocol::{
    self, Command, CommandResult, DENY_REASONS, ERROR_CODES, MAX_ID, MODES, Response, Role, Where,
};

/// [`MAX_ID`] as a float (exact: it is 2^53 - 1).
const MAX_ID_F64: f64 = 9_007_199_254_740_991.0;

/// The seed of normal runs, so a red `cargo test` stays red on re-run.
const FIXED_SEED: u64 = 20_261_010;

fn config() -> ProptestConfig {
    // default() reads PROPTEST_CASES and PROPTEST_RNG_SEED.
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_RNG_SEED").is_none() {
        config.rng_seed = RngSeed::Fixed(FIXED_SEED);
    }
    config
}

/// Keys the decoders look up, so random objects often reach the field checks.
const KEYS: [&str; 25] = [
    "type",
    "id",
    "ok",
    "result",
    "error",
    "code",
    "message",
    "protocol",
    "app",
    "version",
    "proof",
    "port",
    "token",
    "pid",
    "sent",
    "tab",
    "changed",
    "mode",
    "pending",
    "workspace",
    "tabs",
    "panes",
    // Protocol 2 (docs/specs/vimma-mcp.md).
    "role",
    "roles",
    "reason",
];

fn key() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => proptest::sample::select(KEYS.to_vec()).prop_map(String::from),
        1 => proptest::sample::select(vec!["selected", "title", "url", "__proto__", ""])
            .prop_map(String::from),
        1 => any::<String>(),
    ]
}

fn scalar() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        prop_oneof![
            any::<f64>().prop_filter("finite", |n| n.is_finite()),
            any::<u32>().prop_map(f64::from),
            Just(MAX_ID_F64),
            Just(MAX_ID_F64 + 1.0),
            Just(-0.0),
            Just(1.5),
            Just(65_535.0),
            Just(65_536.0),
        ]
        .prop_map(Value::Number),
        prop_oneof![
            any::<String>(),
            proptest::sample::select(
                MODES
                    .iter()
                    .chain(ERROR_CODES.iter())
                    .chain(DENY_REASONS.iter())
                    .chain(["agent", "full"].iter())
                    .chain(["welcome", "challenge", "response", "a".repeat(64).as_str()].iter())
                    .map(|s| (*s).to_string())
                    .collect::<Vec<_>>()
            ),
            "[0-9a-f]{64}",
        ]
        .prop_map(Value::String),
    ]
}

fn value() -> impl Strategy<Value = Value> {
    scalar().prop_recursive(4, 48, 6, |inner| {
        prop_oneof![
            proptest::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            proptest::collection::btree_map(key(), inner, 0..8).prop_map(Value::Object),
        ]
    })
}

fn command() -> impl Strategy<Value = Command> {
    prop_oneof![
        any::<String>().prop_map(|keys| Command::SendKeys { keys }),
        Just(Command::State),
        Just(Command::ReloadTheme),
        (
            any::<String>(),
            proptest::option::of(prop_oneof![Just(Where::Tab), Just(Where::Current)])
        )
            .prop_map(|(url, place)| Command::Open { url, place }),
    ]
}

fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// JSON-ish text: valid documents, their prefixes, and token soup.
fn json_text() -> impl Strategy<Value = String> {
    prop_oneof![
        value().prop_map(|v| v.to_string()),
        (value(), any::<usize>()).prop_map(|(v, cut)| {
            let s = v.to_string();
            let mut at = cut % (s.len() + 1);
            while !s.is_char_boundary(at) {
                at -= 1;
            }
            s[..at].to_string()
        }),
        proptest::collection::vec(
            proptest::sample::select(vec![
                "{", "}", "[", "]", ":", ",", "\"", "\\", "\\u", "d800", "dc00", "\\ud800",
                "\\udc00", "0", "-", "1e999", ".", "e", "true", "nul", " ", "\n", "\u{7f}", "é",
                "\"a\"",
            ]),
            0..40
        )
        .prop_map(|parts| parts.concat()),
        any::<String>(),
    ]
}

proptest! {
    #![proptest_config(config())]

    /// The parser returns, never panics, on any text; what it accepts prints back to itself.
    #[test]
    fn json_parse_never_panics(text in json_text()) {
        if let Ok(v) = json::parse(&text) {
            prop_assert_eq!(json::parse(&v.to_string()), Ok(v));
        }
    }

    /// Every value the client can hold prints as one line of JSON that parses back to it.
    #[test]
    fn json_round_trips_on_one_line(v in value()) {
        let line = v.to_string();
        prop_assert!(!line.contains('\n'));
        prop_assert_eq!(json::parse(&line), Ok(v));
    }

    /// A request is always exactly one line, whatever its keys or URL hold, and decodes back.
    #[test]
    fn requests_are_one_line(id in any::<u32>(), command in command()) {
        let line = protocol::request(id, &command).to_string();
        prop_assert!(!line.contains('\n') && !line.contains('\r'));
        let parsed = json::parse(&line).expect("a request parses");
        prop_assert_eq!(parsed.get("id").and_then(Value::as_u64), Some(u64::from(id)));
    }

    /// The decoders return, never panic, on any value; what they accept is in range.
    #[test]
    fn decoders_never_panic_and_accept_only_the_schema(v in value(), command in command()) {
        if let Ok(w) = protocol::decode_welcome(&v) {
            // Protocol 1 is always the full role; from 2 the welcome names it.
            prop_assert!(w.protocol >= 2 || w.role == Role::Full);
        }
        if let Ok(c) = protocol::decode_challenge(&v) {
            prop_assert!(is_token(&c.proof) && c.protocol >= 1);
        }
        if let Ok(d) = protocol::decode_discovery(&v) {
            prop_assert!(d.port >= 1 && is_token(&d.token) && (1..=MAX_ID).contains(&d.pid));
            // One or both roles, each once.
            prop_assert!((1..=2).contains(&d.roles.len()));
            prop_assert!(d.roles.len() == 1 || d.roles[0] != d.roles[1]);
        }
        match protocol::decode_response(&v) {
            Ok(Response::Ok { id, result }) => {
                prop_assert!(id.is_none_or(|id| (1..=MAX_ID).contains(&id)));
                if let Ok(r) = protocol::decode_result(&command, &result) {
                    match r {
                        CommandResult::SendKeys { sent } => prop_assert!(sent <= MAX_ID),
                        CommandResult::State(s) => {
                            prop_assert!(MODES.contains(&s.mode.as_str()));
                            prop_assert!(s.tabs.iter().filter(|t| t.selected).count() <= 1);
                        }
                        CommandResult::Open { .. } | CommandResult::ReloadTheme { .. } => {}
                    }
                }
            }
            Ok(Response::Err { id, error }) => {
                prop_assert!(id.is_none_or(|id| (1..=MAX_ID).contains(&id)));
                prop_assert!(ERROR_CODES.contains(&error.code.as_str()));
                // Only a denial has a reason, and always one of the protocol's.
                prop_assert_eq!(error.code == "denied", error.reason.is_some());
                prop_assert!(error.reason.is_none_or(|r| DENY_REASONS.contains(&r.as_str())));
            }
            Err(_) => {}
        }
        for command in [Command::State, Command::ReloadTheme] {
            let _ = protocol::decode_result(&command, &v);
        }
    }

    /// Integers outside 0..=2^53-1, or not integers, are never read as a u64.
    #[test]
    fn as_u64_is_exact(n in any::<f64>()) {
        match Value::Number(n).as_u64() {
            // Same decimal digits: the u64 is the float's exact value.
            Some(u) => prop_assert!(u <= MAX_ID && u.to_string() == n.abs().to_string()),
            None => prop_assert!(!(n.fract() == 0.0 && (0.0..=MAX_ID_F64).contains(&n))),
        }
    }
}

/// Nesting far beyond the limit is an error, not a stack overflow.
#[test]
fn deep_nesting_is_an_error_not_a_crash() {
    for open in ["[", "{\"a\":", "[{\"a\":"] {
        let text = open.repeat(200_000);
        assert!(json::parse(&text).is_err(), "{open} x 200000");
    }
    let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
    assert!(json::parse(&ok).is_ok(), "exactly MAX_DEPTH levels parse");
}

/// A megabyte line of any shape parses or fails in well under a second.
#[test]
fn huge_lines_parse_in_bounded_time() {
    let mib = 1024 * 1024;
    let cases = [
        format!("\"{}\"", "a".repeat(mib)),
        format!("\"{}\"", "\\u00e9".repeat(mib / 6)),
        format!("[{}0]", "0,".repeat(mib / 2)),
        "1".repeat(mib),
        format!(
            "{{{}\"z\":0}}",
            (0..mib / 16).fold(String::new(), |mut s, i| {
                let _ = write!(s, "\"k{i}\":0,");
                s
            })
        ),
        format!("\"{}", "\\\\".repeat(mib / 2)),
    ];
    for text in &cases {
        let start = std::time::Instant::now();
        let _ = json::parse(text);
        assert!(
            start.elapsed().as_secs() < 2,
            "{} bytes took {:?}",
            text.len(),
            start.elapsed()
        );
    }
    let mut map = BTreeMap::new();
    map.insert("tabs".to_string(), Value::Array(vec![Value::Null; mib / 8]));
    let _ = protocol::decode_result(&Command::State, &Value::Object(map));
}
