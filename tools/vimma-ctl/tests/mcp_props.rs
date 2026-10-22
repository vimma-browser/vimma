/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Property tests of `vimma-ctl mcp`'s JSON-RPC side (docs/specs/vimma-mcp.md, security.md M9,
//! m7-fuzzing): any line from the MCP client is answered with exactly one well-formed JSON-RPC
//! message on one line, or none, and never panics; any answer from Vimma becomes one tool
//! result. `cargo test` runs a fixed seed; the nightly fuzz workflow sets `PROPTEST_RNG_SEED`
//! and `PROPTEST_CASES` for many more.

use proptest::prelude::*;
use proptest::test_runner::RngSeed;
use std::collections::BTreeMap;
use std::time::Duration;
use vimma_ctl::json::{self, Value};
use vimma_ctl::mcp::{Action, Call, Era, Failure, Protocol, ToolCall, tool_result};

const FIXED_SEED: u64 = 20_261_014;

fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_RNG_SEED").is_none() {
        config.rng_seed = RngSeed::Fixed(FIXED_SEED);
    }
    config
}

fn key() -> impl Strategy<Value = String> {
    prop_oneof![
        proptest::sample::select(vec![
            "jsonrpc",
            "id",
            "method",
            "params",
            "_meta",
            "name",
            "arguments",
            "tab",
            "url",
            "format",
            "max_chars",
            "keys",
            "requestId",
            "protocolVersion",
            "clientInfo",
            "result",
            "error",
            "cursor",
            "io.modelcontextprotocol/protocolVersion",
            "io.modelcontextprotocol/clientCapabilities",
            "io.modelcontextprotocol/clientInfo",
        ])
        .prop_map(String::from),
        any::<String>(),
    ]
}

fn scalar() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<f64>()
            .prop_filter("finite", |n| n.is_finite())
            .prop_map(Value::Number),
        (-3i32..20).prop_map(|n| Value::Number(f64::from(n))),
        proptest::sample::select(vec![
            "2.0",
            "initialize",
            "ping",
            "tools/list",
            "tools/call",
            "server/discover",
            "notifications/cancelled",
            "notifications/initialized",
            "vimma_tabs",
            "vimma_read_page",
            "vimma_open",
            "vimma_close_tab",
            "vimma_keys",
            "vimma_show",
            "vimma_elements",
            "3j /pricing<CR> gg",
            "/x",
            "100j",
            "2026-07-28",
            "2025-11-25",
            "2025-06-18",
            "https://a.example/",
            "file:///etc/passwd",
            "12",
            "text",
            "markdown",
        ])
        .prop_map(|s| Value::String(s.into())),
        any::<String>().prop_map(Value::String),
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

/// Requests shaped like MCP's, with any params: the decoder's interesting paths.
fn request_like() -> impl Strategy<Value = Value> {
    (
        proptest::option::of(scalar()),
        proptest::sample::select(vec![
            "initialize",
            "ping",
            "tools/list",
            "tools/call",
            "server/discover",
            "notifications/cancelled",
            "resources/list",
        ]),
        proptest::option::of(value()),
    )
        .prop_map(|(id, method, params)| {
            let mut map = BTreeMap::from([
                ("jsonrpc".to_string(), Value::String("2.0".into())),
                ("method".to_string(), Value::String(method.into())),
            ]);
            if let Some(id) = id {
                map.insert("id".into(), id);
            }
            if let Some(params) = params {
                map.insert("params".into(), params);
            }
            Value::Object(map)
        })
}

fn line() -> impl Strategy<Value = String> {
    prop_oneof![
        request_like().prop_map(|v| v.to_string()),
        value().prop_map(|v| v.to_string()),
        (value(), any::<usize>()).prop_map(|(v, cut)| {
            let s = v.to_string();
            let mut at = cut % (s.len() + 1);
            while !s.is_char_boundary(at) {
                at -= 1;
            }
            s[..at].to_string()
        }),
        any::<String>(),
    ]
}

/// A reply is one JSON-RPC response: one line, `jsonrpc` 2.0, an id, and a result or an error.
fn check_reply(reply: &Value) -> Result<(), TestCaseError> {
    let text = reply.to_string();
    prop_assert!(!text.contains('\n') && !text.contains('\r'), "{text}");
    let back = json::parse(&text).expect("a reply parses");
    prop_assert_eq!(&back, reply);
    prop_assert_eq!(reply.get("jsonrpc"), Some(&Value::String("2.0".into())));
    prop_assert!(reply.get("id").is_some(), "{text}");
    prop_assert!(
        reply.get("result").is_some() != reply.get("error").is_some(),
        "{text}"
    );
    Ok(())
}

fn tool() -> impl Strategy<Value = ToolCall> {
    prop_oneof![
        Just(ToolCall::Tabs),
        ("[0-9]{1,20}").prop_map(|tab| ToolCall::Read {
            tab,
            format: None,
            max_chars: None
        }),
        any::<String>().prop_map(|url| ToolCall::Open { url, tab: None }),
        ("[0-9]{1,20}").prop_map(|tab| ToolCall::Close { tab }),
        ("[0-9]{1,20}").prop_map(|tab| ToolCall::Show { tab }),
        ("[0-9]{1,20}", any::<String>()).prop_map(|(tab, keys)| ToolCall::Keys { tab, keys }),
    ]
}

fn failure() -> impl Strategy<Value = Failure> {
    prop_oneof![
        (any::<String>(), any::<u32>()).prop_map(|(reason, ms)| Failure::Denied {
            reason,
            waited: Duration::from_millis(u64::from(ms)),
        }),
        (any::<String>(), any::<String>())
            .prop_map(|(code, message)| Failure::Refused { code, message }),
        any::<String>().prop_map(Failure::NotRunning),
        Just(Failure::McpOff),
        any::<u64>().prop_map(Failure::TooOld),
        Just(Failure::Busy),
        Just(Failure::TooMany),
        Just(Failure::Dropped),
        any::<u32>().prop_map(|s| Failure::NoAnswer(Duration::from_secs(u64::from(s)))),
        any::<String>().prop_map(Failure::Protocol),
    ]
}

proptest! {
    #![proptest_config(config())]

    /// Any line: no panic; a reply is one well-formed message; a call is a checked tool call.
    #[test]
    fn any_line_gets_one_message_or_none(lines in proptest::collection::vec(line(), 1..4)) {
        let mut p = Protocol::new();
        for line in lines {
            match p.handle_line(&line) {
                Action::Reply(reply) => check_reply(&reply)?,
                Action::Call(call) => {
                    // What a call sends Vimma is a well-formed agent command.
                    let (command, args) = call.tool.command();
                    prop_assert!(command.starts_with("agent-"));
                    prop_assert!(matches!(args, Value::Object(_)));
                    // mcp-drive D15 (security.md M20): keys within their limits, or a tool error.
                    if let ToolCall::Keys { keys, tab } = &call.tool {
                        let n = keys.chars().count();
                        prop_assert!((1..=vimma_ctl::mcp::MAX_KEYS).contains(&n));
                        prop_assert!(!keys.chars().any(|c| c.is_control() && c != '\t'));
                        prop_assert!(!tab.is_empty() && tab.bytes().all(|b| b.is_ascii_digit()));
                    }
                    if let ToolCall::Open { url, .. } = &call.tool {
                        prop_assert!(url.encode_utf16().count() <= vimma_ctl::mcp::MAX_URL);
                        let lower = url.to_ascii_lowercase();
                        prop_assert!(lower.starts_with("http:") || lower.starts_with("https:"));
                    }
                }
                Action::Cancel(_) | Action::None => {}
            }
        }
    }

    /// Any answer from Vimma, or any failure, becomes one tool result for the call's id.
    #[test]
    fn any_outcome_is_one_tool_result(
        tool in tool(),
        modern in any::<bool>(),
        result in value(),
        failure in failure(),
        use_failure in any::<bool>(),
    ) {
        let call = Call {
            id: Value::Number(7.0),
            era: if modern { Era::Modern } else { Era::Legacy },
            tool,
        };
        let reply = if use_failure {
            tool_result(&call, Err(&failure))
        } else {
            tool_result(&call, Ok(&result))
        };
        check_reply(&reply)?;
        prop_assert_eq!(reply.get("id"), Some(&Value::Number(7.0)));
        let result = reply.get("result").expect("a tool result, never a JSON-RPC error");
        prop_assert!(matches!(result.get("content"), Some(Value::Array(items)) if !items.is_empty()));
    }
}
