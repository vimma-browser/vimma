/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The JSON-RPC side: [`Protocol`] turns one input line into an [`Action`], with the revision's
//! handshake, discovery, errors and `tools/call`'s dispatch.

use super::args::{
    activate_args, console_args, elements_args, fill_args, keys_args, only, open_args, read_args,
    screenshot_args, tab_arg,
};
use super::instructions::INSTRUCTIONS;
use super::render::{finish, tool_error};
use super::tool_list::tools;
use super::types::{Action, Call, ClientLabel, Era, ToolCall};
use super::{
    INVALID_PARAMS, INVALID_REQUEST, LEGACY, MAX_INPUT_LINE, MAX_LABEL, META_CAPABILITIES,
    META_CLIENT, META_SERVER, META_VERSION, METHOD_NOT_FOUND, PARSE_ERROR, SUPPORTED,
    UNSUPPORTED_VERSION, object, text,
};
use crate::json::Value;
use std::collections::BTreeMap;

/// The process's MCP state: the legacy revision `initialize` chose, if any, and the client's
/// label for the agent connection.
#[derive(Debug, Default)]
pub struct Protocol {
    legacy: Option<String>,
    client: Option<ClientLabel>,
    /// Said after [`INSTRUCTIONS`]: that this vimma-ctl is older than Vimma.
    note: Option<String>,
}

impl Protocol {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The client's label: from `initialize`, or the latest modern request that carried one.
    #[must_use]
    pub fn client(&self) -> Option<&ClientLabel> {
        self.client.as_ref()
    }

    /// Add `note` to the server instructions (docs/specs/ship-vimma-ctl.md, behaviour 5).
    pub fn set_note(&mut self, note: Option<String>) {
        self.note = note;
    }

    /// The server instructions: [`INSTRUCTIONS`], and the note if there is one.
    #[must_use]
    pub fn instructions(&self) -> String {
        match &self.note {
            Some(note) => format!("{INSTRUCTIONS} {note}"),
            None => INSTRUCTIONS.to_string(),
        }
    }

    /// The legacy revision `initialize` chose.
    #[must_use]
    pub fn legacy_version(&self) -> Option<&str> {
        self.legacy.as_deref()
    }

    /// Handle one line from the client. Every request gets exactly one response (now, or for a
    /// [`Action::Call`] once Vimma answers); a notification or a stray response gets none.
    pub fn handle_line(&mut self, line: &str) -> Action {
        let Ok(message) = crate::json::parse(line) else {
            return Action::Reply(parse_error());
        };
        let Value::Object(map) = &message else {
            // Batches left MCP in 2025-06-18; anything but an object is not a request.
            return Action::Reply(invalid_request(&Value::Null, "not a JSON-RPC object"));
        };
        let id = map.get("id");
        let good_id = id.filter(|id| is_id(id)).cloned();
        if map.get("jsonrpc") != Some(&text("2.0")) {
            let id = good_id.unwrap_or(Value::Null);
            return Action::Reply(invalid_request(&id, "jsonrpc must be \"2.0\""));
        }
        let Some(method) = map.get("method") else {
            // A response from the client: this server sends no requests, so nothing waits on it.
            return Action::None;
        };
        let Value::String(method) = method else {
            let id = good_id.unwrap_or(Value::Null);
            return Action::Reply(invalid_request(&id, "method must be a string"));
        };
        let params = map.get("params");
        if id.is_none() {
            return notification(method, params);
        }
        let Some(id) = good_id else {
            return Action::Reply(invalid_request(
                &Value::Null,
                "id must be a string or an integer",
            ));
        };
        let params = match params {
            None => &EMPTY,
            Some(Value::Object(params)) => params,
            Some(_) => {
                return Action::Reply(error(&id, INVALID_PARAMS, "params must be an object", None));
            }
        };
        if method == "initialize" {
            return Action::Reply(self.initialize(&id, params));
        }
        match params.get("_meta").and_then(|meta| meta.get(META_VERSION)) {
            Some(version) => self.modern(&id, method, params, version),
            None => Self::legacy(&id, method, params),
        }
    }

    /// `initialize` selects legacy semantics for this process (2026-07-28, basic/versioning).
    fn initialize(&mut self, id: &Value, params: &BTreeMap<String, Value>) -> Value {
        let Some(Value::String(asked)) = params.get("protocolVersion") else {
            return error(id, INVALID_PARAMS, "protocolVersion must be a string", None);
        };
        // The client's version when we speak it, else our newest legacy one (2025-11-25,
        // basic/lifecycle, "Version Negotiation"); a client that cannot speak it disconnects.
        let chosen = LEGACY
            .iter()
            .find(|v| **v == asked.as_str())
            .unwrap_or(&LEGACY[0]);
        self.legacy = Some((*chosen).to_string());
        if let Some(label) = params.get("clientInfo").and_then(label_of) {
            self.client = Some(label);
        }
        respond(
            id,
            object([
                ("protocolVersion", text(chosen)),
                ("capabilities", capabilities()),
                ("serverInfo", server_info()),
                ("instructions", Value::String(self.instructions())),
            ]),
        )
    }

    fn legacy(id: &Value, method: &str, params: &BTreeMap<String, Value>) -> Action {
        Action::Reply(match method {
            "ping" => respond(id, object([])),
            "tools/list" => respond(id, object([("tools", tools())])),
            "tools/call" => return tools_call(id, Era::Legacy, params),
            "server/discover" => error(
                id,
                INVALID_PARAMS,
                &format!("server/discover needs _meta[\"{META_VERSION}\"]"),
                None,
            ),
            _ => method_not_found(id, method),
        })
    }

    /// A request with per-request `_meta` (2026-07-28): stateless, checked on its own.
    fn modern(
        &mut self,
        id: &Value,
        method: &str,
        params: &BTreeMap<String, Value>,
        version: &Value,
    ) -> Action {
        let supported = || Value::Array(SUPPORTED.iter().map(|v| text(v)).collect());
        let Value::String(version) = version else {
            return Action::Reply(error(
                id,
                INVALID_PARAMS,
                "protocolVersion must be a string",
                None,
            ));
        };
        if !SUPPORTED.contains(&version.as_str()) {
            let data = object([("supported", supported()), ("requested", text(version))]);
            return Action::Reply(error(
                id,
                UNSUPPORTED_VERSION,
                "Unsupported protocol version",
                Some(data),
            ));
        }
        let meta = params.get("_meta");
        if !matches!(
            meta.and_then(|m| m.get(META_CAPABILITIES)),
            Some(Value::Object(_))
        ) {
            return Action::Reply(error(
                id,
                INVALID_PARAMS,
                &format!("_meta[\"{META_CAPABILITIES}\"] must be an object"),
                None,
            ));
        }
        if let Some(label) = meta.and_then(|m| m.get(META_CLIENT)).and_then(label_of) {
            self.client = Some(label);
        }
        let result = match method {
            "server/discover" => object([
                ("supportedVersions", supported()),
                ("capabilities", capabilities()),
                ("instructions", Value::String(self.instructions())),
                ("ttlMs", Value::Number(TTL_MS)),
                ("cacheScope", text("public")),
            ]),
            "tools/list" => object([
                ("tools", tools()),
                ("ttlMs", Value::Number(TTL_MS)),
                ("cacheScope", text("public")),
            ]),
            "tools/call" => return tools_call(id, Era::Modern, params),
            _ => return Action::Reply(method_not_found(id, method)),
        };
        Action::Reply(respond(id, modern_result(result)))
    }
}

/// How long a client may cache `tools/list` and `server/discover`: the table changes only with
/// the binary.
const TTL_MS: f64 = 3_600_000.0;

static EMPTY: BTreeMap<String, Value> = BTreeMap::new();

fn notification(method: &str, params: Option<&Value>) -> Action {
    if method != "notifications/cancelled" {
        return Action::None;
    }
    match params.and_then(|p| p.get("requestId")) {
        Some(id) if is_id(id) => Action::Cancel(id.clone()),
        _ => Action::None,
    }
}

/// A JSON-RPC id MCP allows: a string, or an integer exact in a double (never null).
fn is_id(id: &Value) -> bool {
    match id {
        Value::String(_) => true,
        Value::Number(n) => n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0,
        _ => false,
    }
}

fn label_of(info: &Value) -> Option<ClientLabel> {
    let Some(Value::String(name)) = info.get("name") else {
        return None;
    };
    let version = match info.get("version") {
        Some(Value::String(v)) => clean_label(v, MAX_LABEL),
        _ => None,
    };
    clean_label(name, MAX_LABEL).map(|name| ClientLabel { name, version })
}

/// A label as `agent-hello` takes it: printable characters only, at most `max`; `None` if
/// nothing is left.
#[must_use]
pub fn clean_label(text: &str, max: usize) -> Option<String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !unprintable(*c))
        .take(max)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// vimma-core's `unprintable` (control.mjs): C0, DEL, C1 and the bidi controls.
fn unprintable(c: char) -> bool {
    let cp = u32::from(c);
    cp <= 0x1f
        || (0x7f..=0x9f).contains(&cp)
        || cp == 0x200e
        || cp == 0x200f
        || (0x202a..=0x202e).contains(&cp)
        || (0x2066..=0x2069).contains(&cp)
}

fn capabilities() -> Value {
    object([("tools", object([("listChanged", Value::Bool(false))]))])
}

fn server_info() -> Value {
    object([
        ("name", text("vimma")),
        ("version", text(crate::version::VERSION)),
    ])
}

/// A 2026-07-28 result: `resultType` and the server's identity in `_meta`.
pub(super) fn modern_result(result: Value) -> Value {
    let Value::Object(mut map) = result else {
        return result;
    };
    map.insert("resultType".into(), text("complete"));
    map.insert("_meta".into(), object([(META_SERVER, server_info())]));
    Value::Object(map)
}

pub(super) fn respond(id: &Value, result: Value) -> Value {
    object([
        ("jsonrpc", text("2.0")),
        ("id", id.clone()),
        ("result", result),
    ])
}

fn error(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut body = BTreeMap::from([
        // Every code here is a small integer, exact in a double.
        ("code".to_string(), Value::Number(code_number(code))),
        ("message".to_string(), text(message)),
    ]);
    if let Some(data) = data {
        body.insert("data".into(), data);
    }
    object([
        ("jsonrpc", text("2.0")),
        ("id", id.clone()),
        ("error", Value::Object(body)),
    ])
}

fn code_number(code: i64) -> f64 {
    // The codes are constants from -32700 to -32022: i32 holds them, and f64 holds every i32.
    f64::from(i32::try_from(code).unwrap_or(INTERNAL_ERROR))
}

const INTERNAL_ERROR: i32 = -32603;

fn invalid_request(id: &Value, why: &str) -> Value {
    error(
        id,
        INVALID_REQUEST,
        &format!("Invalid Request: {why}"),
        None,
    )
}

fn method_not_found(id: &Value, method: &str) -> Value {
    let shown: String = method.chars().take(100).collect();
    error(
        id,
        METHOD_NOT_FOUND,
        &format!("Method not found: {shown}"),
        None,
    )
}

/// The response to a line that is not UTF-8, so not JSON.
#[must_use]
pub fn parse_error() -> Value {
    error(&Value::Null, PARSE_ERROR, "Parse error", None)
}

/// The response to an input line longer than [`MAX_INPUT_LINE`]: its id was never read.
#[must_use]
pub fn too_long() -> Value {
    invalid_request(
        &Value::Null,
        &format!("the line is longer than {MAX_INPUT_LINE} bytes"),
    )
}

/// `tools/call`: an unknown tool or malformed params are protocol errors; bad arguments are a
/// tool error the model can correct (2026-07-28, server/tools, "Error Handling").
fn tools_call(id: &Value, era: Era, params: &BTreeMap<String, Value>) -> Action {
    let Some(Value::String(name)) = params.get("name") else {
        return Action::Reply(error(id, INVALID_PARAMS, "name must be a string", None));
    };
    let arguments = match params.get("arguments") {
        None => &EMPTY,
        Some(Value::Object(arguments)) => arguments,
        Some(_) => {
            return Action::Reply(error(
                id,
                INVALID_PARAMS,
                "arguments must be an object",
                None,
            ));
        }
    };
    let checked = match name.as_str() {
        "vimma_tabs" => only(arguments, &[]).map(|()| ToolCall::Tabs),
        "vimma_read_page" => read_args(arguments),
        "vimma_open" => open_args(arguments),
        "vimma_close_tab" => only(arguments, &["tab"])
            .and_then(|()| tab_arg(arguments.get("tab")))
            .map(|tab| ToolCall::Close { tab }),
        "vimma_keys" => keys_args(arguments),
        "vimma_show" => only(arguments, &["tab"])
            .and_then(|()| tab_arg(arguments.get("tab")))
            .map(|tab| ToolCall::Show { tab }),
        "vimma_elements" => elements_args(arguments),
        "vimma_activate" => activate_args(arguments),
        "vimma_fill" => fill_args(arguments),
        "vimma_screenshot" => screenshot_args(arguments),
        "vimma_console" => console_args(arguments),
        _ => {
            let shown: String = name.chars().take(100).collect();
            return Action::Reply(error(
                id,
                INVALID_PARAMS,
                &format!("Unknown tool: {shown}"),
                None,
            ));
        }
    };
    match checked {
        Ok(tool) => Action::Call(Call {
            id: id.clone(),
            era,
            tool,
        }),
        Err(why) => Action::Reply(respond(
            id,
            finish(
                era,
                tool_error(&format!("Invalid arguments for {name}: {why}.")),
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::MODERN;
    use crate::mcp::test_support::*;

    // Spec test plan, Rust: initialize with 2025-11-25 names that version and the tools
    // capability, and selects legacy semantics (no resultType) for the process.
    #[test]
    fn initialize_selects_a_legacy_revision() {
        let mut p = Protocol::new();
        let r = reply(&mut p, INIT);
        assert_eq!(at(&r, &["jsonrpc"]), &s("2.0"));
        assert_eq!(at(&r, &["id"]), &Value::Number(1.0));
        assert_eq!(at(&r, &["result", "protocolVersion"]), &s("2025-11-25"));
        assert!(at(&r, &["result", "capabilities"]).get("tools").is_some());
        assert_eq!(at(&r, &["result", "serverInfo", "name"]), &s("vimma"));
        assert_eq!(
            at(&r, &["result", "serverInfo", "version"]),
            &s(crate::version::VERSION)
        );
        assert_eq!(at(&r, &["result", "instructions"]), &s(INSTRUCTIONS));
        assert!(r.get("result").unwrap().get("resultType").is_none());
        assert_eq!(p.legacy_version(), Some("2025-11-25"));
        assert_eq!(
            p.client(),
            Some(&ClientLabel {
                name: "claude-code".into(),
                version: Some("2.1.0".into())
            })
        );
    }

    #[test]
    fn initialize_answers_an_older_or_unknown_version_with_the_newest_legacy_one() {
        for (asked, got) in [
            ("2025-06-18", "2025-06-18"),
            ("2025-03-26", "2025-11-25"),
            ("1900-01-01", "2025-11-25"),
        ] {
            let mut p = Protocol::new();
            let line = INIT.replace("2025-11-25", asked);
            let r = reply(&mut p, &line);
            assert_eq!(at(&r, &["result", "protocolVersion"]), &s(got), "{asked}");
        }
    }

    #[test]
    fn initialize_without_a_version_is_invalid_params() {
        let mut p = Protocol::new();
        let r = reply(
            &mut p,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        );
        assert_eq!(error_code(&r), INVALID_PARAMS);
    }

    // Spec: server/discover lists 2026-07-28, 2025-11-25 and 2025-06-18.
    #[test]
    fn discover_lists_every_supported_version() {
        let mut p = Protocol::new();
        let r = reply(&mut p, &modern("server/discover", 7, ""));
        let result = at(&r, &["result"]);
        assert_eq!(
            at(result, &["supportedVersions"]),
            &Value::Array(SUPPORTED.iter().map(|v| s(v)).collect())
        );
        assert_eq!(at(result, &["resultType"]), &s("complete"));
        assert!(at(result, &["capabilities"]).get("tools").is_some());
        assert_eq!(at(result, &["_meta", META_SERVER, "name"]), &s("vimma"));
        assert_eq!(at(result, &["instructions"]), &s(INSTRUCTIONS));
        assert!(matches!(at(result, &["ttlMs"]), Value::Number(_)));
        assert_eq!(at(result, &["cacheScope"]), &s("public"));
        assert_eq!(
            p.client().map(|c| c.name.as_str()),
            Some("claude-code"),
            "a modern request's clientInfo labels the connection"
        );
    }

    // Spec: a modern request with 1900-01-01 is -32022 with data.supported.
    #[test]
    fn an_unsupported_modern_version_is_minus_32022() {
        let mut p = Protocol::new();
        let line = modern("tools/list", 3, "").replace(MODERN, "1900-01-01");
        let r = reply(&mut p, &line);
        assert_eq!(error_code(&r), UNSUPPORTED_VERSION);
        assert_eq!(at(&r, &["id"]), &Value::Number(3.0));
        assert_eq!(
            at(&r, &["error", "data", "supported"]),
            &Value::Array(SUPPORTED.iter().map(|v| s(v)).collect())
        );
        assert_eq!(at(&r, &["error", "data", "requested"]), &s("1900-01-01"));
    }

    #[test]
    fn a_modern_request_without_client_capabilities_is_invalid_params() {
        let mut p = Protocol::new();
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{{"_meta":{{"{META_VERSION}":"{MODERN}"}}}}}}"#
        );
        assert_eq!(error_code(&reply(&mut p, &line)), INVALID_PARAMS);
    }

    #[test]
    fn server_discover_without_meta_is_invalid_params() {
        let mut p = Protocol::new();
        let r = reply(
            &mut p,
            r#"{"jsonrpc":"2.0","id":2,"method":"server/discover"}"#,
        );
        assert_eq!(error_code(&r), INVALID_PARAMS);
    }

    // Spec: an unknown method is -32601; a notification gets no reply.
    #[test]
    fn unknown_methods_and_notifications() {
        let mut p = Protocol::new();
        let r = reply(
            &mut p,
            r#"{"jsonrpc":"2.0","id":"x","method":"resources/list"}"#,
        );
        assert_eq!(error_code(&r), METHOD_NOT_FOUND);
        assert_eq!(at(&r, &["id"]), &s("x"));
        for note in [
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/whatever","params":{"a":1}}"#,
            r#"{"jsonrpc":"2.0","method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":5,"result":{}}"#,
        ] {
            assert_eq!(handle(&mut p, note), Action::None, "{note}");
        }
    }

    #[test]
    fn legacy_ping_answers_an_empty_result() {
        let mut p = Protocol::new();
        let r = reply(&mut p, r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#);
        assert_eq!(at(&r, &["result"]).to_string(), "{}");
    }

    #[test]
    fn cancellation_names_the_request() {
        let mut p = Protocol::new();
        assert_eq!(
            handle(
                &mut p,
                r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"7","reason":"esc"}}"#
            ),
            Action::Cancel(s("7"))
        );
        assert_eq!(
            handle(
                &mut p,
                r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}"#
            ),
            Action::None
        );
    }

    #[test]
    fn malformed_lines_get_json_rpc_errors_with_a_null_id() {
        let mut p = Protocol::new();
        for (line, code) in [
            ("not json", PARSE_ERROR),
            ("", PARSE_ERROR),
            ("[1,2]", INVALID_REQUEST),
            ("42", INVALID_REQUEST),
            (r#"{"id":1,"method":"ping"}"#, INVALID_REQUEST),
            (
                r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
                INVALID_REQUEST,
            ),
            (
                r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#,
                INVALID_REQUEST,
            ),
            (
                r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#,
                INVALID_REQUEST,
            ),
            (
                r#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#,
                INVALID_REQUEST,
            ),
            (r#"{"jsonrpc":"2.0","id":1,"method":3}"#, INVALID_REQUEST),
        ] {
            let r = reply(&mut p, line);
            assert_eq!(error_code(&r), code, "{line}");
            assert_eq!(at(&r, &["jsonrpc"]), &s("2.0"));
            assert!(r.get("id").is_some(), "{line}: an error response has an id");
        }
        let r = too_long();
        assert_eq!(error_code(&r), INVALID_REQUEST);
        assert_eq!(at(&r, &["id"]), &Value::Null);
    }

    #[test]
    fn unknown_tools_and_malformed_calls_are_protocol_errors() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for line in [
            call_line(1, "vimma_send_keys", "{}"),
            call_line(1, "vimma_open", "[]"),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#.to_string(),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call"}"#.to_string(),
        ] {
            assert_eq!(error_code(&reply(&mut p, &line)), INVALID_PARAMS, "{line}");
        }
    }

    #[test]
    fn client_labels_are_cleaned() {
        assert_eq!(clean_label("claude-code", 64), Some("claude-code".into()));
        assert_eq!(
            clean_label("evil\u{202e}name\n\u{7}", 64),
            Some("evilname".into())
        );
        assert_eq!(clean_label(&"é".repeat(80), 64), Some("é".repeat(64)));
        assert_eq!(clean_label("\u{1}\u{2}", 64), None);
        assert_eq!(clean_label("", 64), None);
    }

    #[test]
    fn every_reply_is_one_line() {
        let mut p = Protocol::new();
        let r = reply(
            &mut p,
            "{\"jsonrpc\":\"2.0\",\"id\":\"a\\nb\",\"method\":\"nope\"}",
        );
        assert!(!r.to_string().contains('\n'));
    }
}
