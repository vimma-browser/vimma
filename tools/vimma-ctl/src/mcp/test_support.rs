/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Helpers the `mcp` modules' tests share.

use crate::json::{Value, parse};
use crate::mcp::{
    Action, Call, Era, ListFilters, META_CAPABILITIES, META_CLIENT, META_VERSION, MODERN, Protocol,
    ToolCall, tools,
};

pub(super) fn handle(p: &mut Protocol, line: &str) -> Action {
    p.handle_line(line)
}

pub(super) fn reply(p: &mut Protocol, line: &str) -> Value {
    match handle(p, line) {
        Action::Reply(v) => v,
        other => panic!("{line}: expected a reply, got {other:?}"),
    }
}

pub(super) fn s(v: &str) -> Value {
    Value::String(v.into())
}

pub(super) fn at<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(v, |v, k| {
        v.get(k).unwrap_or_else(|| panic!("no {k} in {v}"))
    })
}

pub(super) fn error_code(v: &Value) -> i64 {
    match at(v, &["error", "code"]) {
        Value::Number(n) => n.to_string().parse().unwrap(),
        other => panic!("{other}"),
    }
}

pub(super) fn modern(method: &str, id: u32, params: &str) -> String {
    let meta = format!(
        r#""_meta":{{"{META_VERSION}":"{MODERN}","{META_CAPABILITIES}":{{}},"{META_CLIENT}":{{"name":"claude-code","version":"2.1"}}}}"#
    );
    let params = if params.is_empty() {
        format!("{{{meta}}}")
    } else {
        format!("{{{meta},{params}}}")
    };
    format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#)
}

pub(super) const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.0"}}}"#;

pub(super) fn call_line(id: u32, name: &str, arguments: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{name}","arguments":{arguments}}}}}"#
    )
}

pub(super) fn tool_error_text(v: &Value) -> String {
    assert_eq!(at(v, &["result", "isError"]), &Value::Bool(true), "{v}");
    match at(v, &["result", "content"]) {
        Value::Array(items) => match items[0].get("text") {
            Some(Value::String(t)) => t.clone(),
            _ => panic!("{v}"),
        },
        _ => panic!("{v}"),
    }
}

/// A plain `vimma_elements` of `tab`: no filters, compact.
pub(super) fn elements_of(tab: &str) -> ToolCall {
    ToolCall::Elements {
        tab: tab.into(),
        filters: ListFilters::default(),
        full: false,
    }
}

pub(super) fn legacy_call(tool: ToolCall) -> Call {
    Call {
        id: Value::Number(4.0),
        era: Era::Legacy,
        tool,
    }
}

pub(super) fn texts(v: &Value) -> Vec<String> {
    match at(v, &["result", "content"]) {
        Value::Array(items) => items
            .iter()
            .map(|i| {
                assert_eq!(i.get("type"), Some(&s("text")));
                match i.get("text") {
                    Some(Value::String(t)) => t.clone(),
                    _ => panic!("{v}"),
                }
            })
            .collect(),
        _ => panic!("{v}"),
    }
}

pub(super) fn description_of(name: &str) -> String {
    let Value::Array(items) = tools() else {
        panic!("tools is a list")
    };
    let tool = items
        .iter()
        .find(|t| t.get("name") == Some(&Value::String(name.into())))
        .unwrap_or_else(|| panic!("no tool {name}"));
    match tool.get("description") {
        Some(Value::String(d)) => d.clone(),
        _ => panic!("{name} has no description"),
    }
}

pub(super) fn v2_fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/contract/control/v2")
        .join(name);
    parse(&std::fs::read_to_string(&path).unwrap()).unwrap()
}
