/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Protocol messages, versions 1 and 2: encoding what the client sends (`hello`, requests) and
//! decoding what it receives (`welcome`, responses, results) and the discovery file. The rules
//! mirror `packages/vimma-core/src/control.mjs`; both are tested against
//! `tests/contract/control/v1/` and `v2/`. Protocol 2 adds the hello's role
//! (docs/specs/vimma-mcp.md, decision 2): vimma-ctl's own commands use `full`.

use crate::json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

/// The newest protocol version this client speaks; it falls back to 1 for an older Vimma.
pub const PROTOCOL: u64 = 2;
/// Longest line accepted from the server, in bytes, excluding the newline.
pub const MAX_LINE: usize = 1024 * 1024;
/// Largest request id (2^53 - 1, exact in a JSON number).
pub const MAX_ID: u64 = (1 << 53) - 1;
/// vimma-core's `MODES` (packages/vimma-core/src/modes.mjs; a test keeps them in step).
pub const MODES: [&str; 9] = [
    "normal", "insert", "visual", "command", "hint", "element", "help", "panel", "resize",
];
/// vimma-core's `ERROR_CODES`.
pub const ERROR_CODES: [&str; 11] = [
    "bad-request",
    "unauthorized",
    "unsupported-protocol",
    "unknown-command",
    "invalid-args",
    "not-implemented",
    "failed",
    "internal",
    "busy",
    "role-off",
    "denied",
];
/// vimma-core's `MAX_RETRY_AFTER`: the longest wait a used-up rate names, in ms (one minute,
/// the window of every per-connection rate).
pub const MAX_RETRY_AFTER: u64 = 60_000;
/// vimma-core's `DENY_REASONS`: why an agent request was denied.
pub const DENY_REASONS: [&str; 7] = [
    "user",
    "timeout",
    "busy",
    "muted",
    "changed",
    "cancelled",
    "in-use",
];

/// A connection's role (protocol 2). Protocol 1 is always `Full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The agent commands only, confined to the agent workspace and confirmed in Vimma.
    Agent,
    /// Protocol 1's commands: `send-keys`, `state`, `open`, `reload-theme`.
    Full,
}

impl Role {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Role::Agent => "agent",
            Role::Full => "full",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "agent" => Some(Role::Agent),
            "full" => Some(Role::Full),
            _ => None,
        }
    }
}

/// Where `open` loads the URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Where {
    Tab,
    Current,
}

/// A command the client can send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    SendKeys {
        keys: String,
    },
    State,
    Open {
        url: String,
        place: Option<Where>,
    },
    /// Re-read the Omarchy theme now (the `theme-set` hook).
    ReloadTheme,
}

/// The server's `welcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Welcome {
    pub protocol: u64,
    pub app: String,
    pub version: String,
    /// The connection's role: `Full` for protocol 1.
    pub role: Role,
}

/// The server's `challenge`: proof that it knows the token, before the client sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub protocol: u64,
    /// `HMAC-SHA256(token, CHALLENGE_CONTEXT + nonce)` in lowercase hex.
    pub proof: String,
}

/// Prefix of the challenge's HMAC message (domain separation).
pub const CHALLENGE_CONTEXT: &str = "vimma-server\0";

/// A response's `error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    /// Why, for `denied` (protocol 2); `None` for every other code.
    pub reason: Option<String>,
    /// For a `busy` denial from a used-up rate: how long until the next call is allowed.
    pub retry_after: Option<Duration>,
}

/// A decoded response envelope; `id` is `None` for handshake errors.
#[derive(Debug, Clone, PartialEq)]
pub enum Response {
    Ok { id: Option<u64>, result: Value },
    Err { id: Option<u64>, error: ErrorBody },
}

/// One tab in `state`. `url` and `title` are `None` in a private window, which withholds them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    pub id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub selected: bool,
}

/// The `state` result. `raw` keeps the whole object, unknown fields included, for `--json`.
#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub mode: String,
    pub pending: Option<String>,
    pub workspace: Option<String>,
    pub tabs: Vec<Tab>,
    pub raw: Value,
}

/// A command's decoded result.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandResult {
    SendKeys { sent: u64 },
    State(State),
    Open { tab: String },
    ReloadTheme { changed: bool },
}

/// The discovery file `<profile>/vimma-control.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovery {
    pub protocol: u64,
    pub port: u16,
    pub token: String,
    pub pid: u64,
    /// The roles the server serves: `[Full]` for protocol 1.
    pub roles: Vec<Role>,
    /// Vimma's version, when the file names it (docs/specs/ship-vimma-ctl.md, behaviour 5).
    pub version: Option<String>,
    /// `token` is an agent CLI's one-time ticket, not the discovery file's token: the
    /// connection names it by its id and is the agent role only (docs/specs/builtin-agent-cli.md
    /// C3). No discovery file sets it.
    pub ticket: bool,
}

impl Discovery {
    /// Where an agent CLI's `vimma-ctl mcp` connects: the port and ticket Vimma put in its
    /// environment, in place of a discovery file.
    #[must_use]
    pub fn for_ticket(port: u16, ticket: &str) -> Self {
        Self {
            protocol: 2,
            port,
            token: ticket.to_string(),
            pid: 0,
            roles: vec![Role::Agent],
            version: None,
            ticket: true,
        }
    }
}

/// Why a message does not follow the protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError(pub String);

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DecodeError {}

/// The `hello` line's value: no token, only a fresh 64-hex `nonce` the server must answer.
#[must_use]
pub fn hello(nonce: &str) -> Value {
    object([
        ("type", text("hello")),
        ("protocol", Value::Number(1.0)),
        ("nonce", text(nonce)),
    ])
}

/// A protocol 2 `hello`: the same, and the connection's `role`.
#[must_use]
pub fn hello_v2(nonce: &str, role: Role) -> Value {
    object([
        ("type", text("hello")),
        ("protocol", Value::Number(2.0)),
        ("nonce", text(nonce)),
        ("role", text(role.name())),
    ])
}

/// The message a one-time ticket's id is the HMAC of, with the ticket as the key.
pub const TICKET_CONTEXT: &str = "vimma-ticket\0";

/// A ticket's id: `HMAC-SHA256(key: ticket, message: TICKET_CONTEXT)`, lowercase hex. The hello
/// names the ticket by it, so Vimma knows which ticket to prove it knows, and a squatter on the
/// port learns nothing it could use (docs/specs/builtin-agent-cli.md C3).
#[must_use]
pub fn ticket_id(ticket: &str) -> String {
    crate::hmac::hex(&crate::hmac::hmac_sha256(
        ticket.as_bytes(),
        TICKET_CONTEXT.as_bytes(),
    ))
}

/// The `hello` of an agent CLI's connection: protocol 2, the agent role, and the ticket's id.
#[must_use]
pub fn hello_ticket(nonce: &str, id: &str) -> Value {
    object([
        ("type", text("hello")),
        ("protocol", Value::Number(2.0)),
        ("nonce", text(nonce)),
        ("role", text(Role::Agent.name())),
        ("ticket", text(id)),
    ])
}

/// The `auth` line of a ticket's connection: the ticket in place of the token, sent only after
/// the challenge proved the server knows it.
#[must_use]
pub fn auth_ticket(ticket: &str) -> Value {
    object([("type", text("auth")), ("ticket", text(ticket))])
}

/// The `auth` line's value, sent only after the challenge checked out.
#[must_use]
pub fn auth(token: &str) -> Value {
    object([("type", text("auth")), ("token", text(token))])
}

/// The `auth` line with the code this vimma-ctl printed, while MCP is on: Vimma's full-control
/// question shows it (docs/specs/vimma-mcp.md decision 29 C; docs/security.md S13).
#[must_use]
pub fn auth_with_code(token: &str, code: &str) -> Value {
    object([
        ("type", text("auth")),
        ("token", text(token)),
        ("code", text(code)),
    ])
}

/// The proof a server must send for `nonce`:
/// `HMAC-SHA256(key: token, message: CHALLENGE_CONTEXT + nonce)`, ASCII, in lowercase hex.
#[must_use]
pub fn challenge_proof(token: &str, nonce: &str) -> String {
    let message = format!("{CHALLENGE_CONTEXT}{nonce}");
    crate::hmac::hex(&crate::hmac::hmac_sha256(
        token.as_bytes(),
        message.as_bytes(),
    ))
}

/// A request's value. Ids are `u32`: a CLI invocation sends a handful, and every `u32` is exact
/// as a JSON number.
#[must_use]
pub fn request(id: u32, command: &Command) -> Value {
    let (name, args) = match command {
        Command::SendKeys { keys } => ("send-keys", object([("keys", text(keys))])),
        Command::State => ("state", object([])),
        Command::ReloadTheme => ("reload-theme", object([])),
        Command::Open { url, place } => {
            let mut args = BTreeMap::from([("url".to_string(), text(url))]);
            if let Some(place) = place {
                let place = match place {
                    Where::Tab => "tab",
                    Where::Current => "current",
                };
                args.insert("where".to_string(), text(place));
            }
            ("open", Value::Object(args))
        }
    };
    object([
        ("type", text("request")),
        ("id", Value::Number(f64::from(id))),
        ("command", text(name)),
        ("args", args),
    ])
}

/// A request for any command by name, with its `args` as given: the agent commands, which
/// `vimma-ctl mcp` builds and checks itself (docs/specs/vimma-mcp.md, decision 4).
#[must_use]
pub fn request_named(id: u32, command: &str, args: Value) -> Value {
    object([
        ("type", text("request")),
        ("id", Value::Number(f64::from(id))),
        ("command", text(command)),
        ("args", args),
    ])
}

/// Decode a `welcome`.
///
/// # Errors
/// When the value is not a v1 `welcome`.
pub fn decode_welcome(value: &Value) -> Result<Welcome, DecodeError> {
    let map = as_object(value, "welcome")?;
    expect_type(map, "welcome")?;
    let protocol = protocol_field(map)?;
    let role = if protocol >= 2 {
        match map.get("role") {
            Some(Value::String(role)) => Role::from_name(role),
            _ => None,
        }
        .ok_or_else(|| fail("role must be \"agent\" or \"full\""))?
    } else {
        Role::Full
    };
    Ok(Welcome {
        protocol,
        app: string_field(map, "app")?.to_string(),
        version: string_field(map, "version")?.to_string(),
        role,
    })
}

/// Decode a `challenge`.
///
/// # Errors
/// When the value is not a v1 `challenge`.
pub fn decode_challenge(value: &Value) -> Result<Challenge, DecodeError> {
    let map = as_object(value, "challenge")?;
    expect_type(map, "challenge")?;
    Ok(Challenge {
        protocol: protocol_field(map)?,
        proof: match map.get("proof") {
            Some(Value::String(proof)) if is_token(proof) => proof.clone(),
            _ => return Err(fail("proof must be 64 lowercase hex characters")),
        },
    })
}

/// Decode a response envelope (not its result; see [`decode_result`]).
///
/// # Errors
/// When the value is not a v1 response.
pub fn decode_response(value: &Value) -> Result<Response, DecodeError> {
    let map = as_object(value, "response")?;
    expect_type(map, "response")?;
    only_fields(map, &["type", "id", "ok", "result", "error"], "")?;
    let id = match map.get("id") {
        Some(Value::Null) => None,
        Some(id) => Some(
            id.as_u64()
                .filter(|id| *id >= 1)
                .ok_or_else(|| fail("id must be an integer from 1 to 2^53-1 or null"))?,
        ),
        None => return Err(fail("id must be an integer from 1 to 2^53-1 or null")),
    };
    let Some(Value::Bool(ok)) = map.get("ok") else {
        return Err(fail("ok must be a boolean"));
    };
    match (ok, map.get("result"), map.get("error")) {
        (true, Some(result), None) => Ok(Response::Ok {
            id,
            result: result.clone(),
        }),
        (true, _, _) => Err(fail("ok: true needs result and no error")),
        (false, None, Some(error)) => {
            let error = as_object(error, "error")?;
            only_fields(
                error,
                &["code", "message", "reason", "retryAfter"],
                "error.",
            )?;
            let code = string_field(error, "code")
                .ok()
                .filter(|code| ERROR_CODES.contains(code))
                .ok_or_else(|| {
                    fail(&format!(
                        "error.code must be one of {}",
                        ERROR_CODES.join(", ")
                    ))
                })?;
            let message = string_field(error, "message")
                .map_err(|_| fail("error.message must be a string"))?;
            // A denial says why; nothing else carries a reason.
            let reason = match (code, error.get("reason")) {
                ("denied", Some(Value::String(reason)))
                    if DENY_REASONS.contains(&reason.as_str()) =>
                {
                    Some(reason.clone())
                }
                ("denied", _) => {
                    return Err(fail(&format!(
                        "error.reason must be one of {}",
                        DENY_REASONS.join(", ")
                    )));
                }
                (_, Some(_)) => return Err(fail("error.reason is only for denied")),
                (_, None) => None,
            };
            // A used-up rate says when the next call is allowed (issue #592).
            let retry_after = match error.get("retryAfter") {
                None => None,
                Some(_) if code != "denied" || reason.as_deref() != Some("busy") => {
                    return Err(fail("error.retryAfter is only for a busy denial"));
                }
                Some(ms) => match ms.as_u64() {
                    Some(ms @ 1..=MAX_RETRY_AFTER) => Some(Duration::from_millis(ms)),
                    _ => {
                        return Err(fail(&format!(
                            "error.retryAfter must be a whole number from 1 to {MAX_RETRY_AFTER}"
                        )));
                    }
                },
            };
            Ok(Response::Err {
                id,
                error: ErrorBody {
                    code: code.to_string(),
                    message: message.to_string(),
                    reason,
                    retry_after,
                },
            })
        }
        (false, _, _) => Err(fail("ok: false needs error and no result")),
    }
}

/// Decode the result of `command`.
///
/// # Errors
/// When the result does not have the command's shape.
pub fn decode_result(command: &Command, result: &Value) -> Result<CommandResult, DecodeError> {
    let map = as_object(result, "result")?;
    match command {
        Command::SendKeys { .. } => map
            .get("sent")
            .and_then(Value::as_u64)
            .map(|sent| CommandResult::SendKeys { sent })
            .ok_or_else(|| fail("result.sent must be an integer >= 0")),
        Command::Open { .. } => match map.get("tab") {
            Some(Value::String(tab)) => Ok(CommandResult::Open { tab: tab.clone() }),
            _ => Err(fail("result.tab must be a string")),
        },
        Command::State => decode_state(map, result).map(CommandResult::State),
        Command::ReloadTheme => match map.get("changed") {
            Some(Value::Bool(changed)) => Ok(CommandResult::ReloadTheme { changed: *changed }),
            _ => Err(fail("result.changed must be a boolean")),
        },
    }
}

fn decode_state(map: &BTreeMap<String, Value>, raw: &Value) -> Result<State, DecodeError> {
    let mode = string_field(map, "mode")
        .ok()
        .filter(|mode| MODES.contains(mode))
        .ok_or_else(|| fail(&format!("result.mode must be one of {}", MODES.join(", "))))?;
    let nullable = |key: &str| match map.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(fail(&format!("result.{key} must be a string or null"))),
    };
    let pending = nullable("pending")?;
    let workspace = nullable("workspace")?;
    // A private window's state withholds every url and title (private-workspace 8d).
    let private = match map.get("private") {
        None => false,
        Some(Value::Bool(private)) => *private,
        Some(_) => return Err(fail("result.private must be a boolean")),
    };
    let Some(Value::Array(items)) = map.get("tabs") else {
        return Err(fail("result.tabs must be an array"));
    };
    let mut tabs = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let tab = as_object(item, &format!("result.tabs[{i}]"))?;
        let field = |key: &str| {
            string_field(tab, key)
                .map(String::from)
                .map_err(|_| fail(&format!("result.tabs[{i}].{key} must be a string")))
        };
        let withheld = |key: &str| match tab.get(key) {
            Some(Value::Null) if private => Ok(None),
            _ if private => Err(fail(&format!(
                "result.tabs[{i}].{key} must be null in a private window"
            ))),
            _ => field(key).map(Some),
        };
        let Some(Value::Bool(selected)) = tab.get("selected") else {
            return Err(fail(&format!(
                "result.tabs[{i}].selected must be a boolean"
            )));
        };
        tabs.push(Tab {
            id: field("id")?,
            url: withheld("url")?,
            title: withheld("title")?,
            selected: *selected,
        });
    }
    if tabs.iter().filter(|tab| tab.selected).count() > 1 {
        return Err(fail("result.tabs must have at most one selected tab"));
    }
    if !map.contains_key("panes") {
        return Err(fail(
            "result.panes must be present (null before split view)",
        ));
    }
    Ok(State {
        mode: mode.to_string(),
        pending,
        workspace,
        tabs,
        raw: raw.clone(),
    })
}

/// Decode the discovery file.
///
/// # Errors
/// When a field is missing or out of range.
pub fn decode_discovery(value: &Value) -> Result<Discovery, DecodeError> {
    let map = as_object(value, "discovery file")?;
    let protocol = protocol_field(map)?;
    let port = map
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port >= 1)
        .ok_or_else(|| fail("port must be an integer from 1 to 65535"))?;
    let token = match map.get("token") {
        Some(Value::String(token)) if is_token(token) => token.clone(),
        _ => return Err(fail("token must be 64 lowercase hex characters")),
    };
    let pid = map
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid >= 1)
        .ok_or_else(|| fail("pid must be an integer >= 1"))?;
    let roles = if protocol >= 2 || map.contains_key("roles") {
        decode_roles(map.get("roles"))?
    } else {
        vec![Role::Full]
    };
    let version = match map.get("version") {
        None => None,
        Some(Value::String(v)) if crate::version::compare(v, v).is_some() => Some(v.clone()),
        Some(_) => return Err(fail("version must be a Vimma version (X.Y.Z)")),
    };
    Ok(Discovery {
        protocol,
        port,
        token,
        pid,
        roles,
        version,
        ticket: false,
    })
}

/// The discovery file's `roles`: one or both, each once.
fn decode_roles(value: Option<&Value>) -> Result<Vec<Role>, DecodeError> {
    let bad = || fail("roles must be a list of \"agent\" and \"full\", each once");
    let Some(Value::Array(items)) = value else {
        return Err(bad());
    };
    let mut roles = Vec::with_capacity(items.len());
    for item in items {
        let role = match item {
            Value::String(name) => Role::from_name(name),
            _ => None,
        }
        .ok_or_else(bad)?;
        if roles.contains(&role) {
            return Err(bad());
        }
        roles.push(role);
    }
    if roles.is_empty() {
        return Err(bad());
    }
    Ok(roles)
}

fn fail(message: &str) -> DecodeError {
    DecodeError(message.to_string())
}

fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

fn object<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn is_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn as_object<'a>(value: &'a Value, what: &str) -> Result<&'a BTreeMap<String, Value>, DecodeError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(fail(&format!("{what} must be an object"))),
    }
}

fn expect_type(map: &BTreeMap<String, Value>, kind: &str) -> Result<(), DecodeError> {
    match map.get("type") {
        Some(Value::String(t)) if t == kind => Ok(()),
        _ => Err(fail(&format!("type must be \"{kind}\""))),
    }
}

fn only_fields(
    map: &BTreeMap<String, Value>,
    allowed: &[&str],
    prefix: &str,
) -> Result<(), DecodeError> {
    match map.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(fail(&format!("unknown field \"{prefix}{key}\""))),
        None => Ok(()),
    }
}

fn string_field<'a>(map: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a str, DecodeError> {
    match map.get(key) {
        Some(Value::String(s)) => Ok(s),
        _ => Err(fail(&format!("{key} must be a string"))),
    }
}

fn protocol_field(map: &BTreeMap<String, Value>) -> Result<u64, DecodeError> {
    map.get("protocol")
        .and_then(Value::as_u64)
        .filter(|p| *p >= 1)
        .ok_or_else(|| fail("protocol must be an integer >= 1"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;
    use std::fs;
    use std::path::{Path, PathBuf};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/contract/control/v1")
    }

    /// (file name, fixture value)
    fn fixtures() -> Vec<(String, Value)> {
        let mut out: Vec<(String, Value)> = fs::read_dir(fixtures_dir())
            .expect("fixtures directory")
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "json"))
            .map(|name| {
                let text = fs::read_to_string(fixtures_dir().join(&name)).unwrap();
                let value = parse(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
                (name, value)
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
        match value.get(key) {
            Some(Value::String(s)) => Some(s),
            _ => None,
        }
    }

    fn command_named(name: &str) -> Command {
        match name {
            "send-keys" => Command::SendKeys { keys: "j".into() },
            "state" => Command::State,
            "reload-theme" => Command::ReloadTheme,
            "open" => Command::Open {
                url: "about:blank".into(),
                place: None,
            },
            other => panic!("no client command {other}"),
        }
    }

    /// Decode a server-direction fixture the way the client would.
    fn decode_fixture(fixture: &Value) -> Result<(), DecodeError> {
        let message = fixture.get("message").unwrap();
        match str_field(fixture, "kind").unwrap() {
            "welcome" => decode_welcome(message).map(drop),
            "challenge" => decode_challenge(message).map(drop),
            "discovery" => decode_discovery(message).map(drop),
            "response" => match decode_response(message)? {
                Response::Ok { result, .. } => match str_field(fixture, "command") {
                    Some(name) => decode_result(&command_named(name), &result).map(drop),
                    None => Ok(()),
                },
                Response::Err { .. } => Ok(()),
            },
            other => panic!("not a server-direction kind: {other}"),
        }
    }

    /// The request a valid client-direction fixture describes, built with our encoder.
    fn encode_fixture(fixture: &Value) -> Value {
        let message = fixture.get("message").unwrap();
        if str_field(fixture, "kind") == Some("hello") {
            return hello(str_field(message, "nonce").unwrap());
        }
        if str_field(fixture, "kind") == Some("auth") {
            return auth(str_field(message, "token").unwrap());
        }
        let id = u32::try_from(message.get("id").and_then(Value::as_u64).unwrap()).unwrap();
        let args = message.get("args").unwrap();
        let command = match str_field(message, "command").unwrap() {
            "send-keys" => Command::SendKeys {
                keys: str_field(args, "keys").unwrap().into(),
            },
            "state" => Command::State,
            "reload-theme" => Command::ReloadTheme,
            "open" => Command::Open {
                url: str_field(args, "url").unwrap().into(),
                place: match str_field(args, "where") {
                    Some("tab") => Some(Where::Tab),
                    Some("current") => Some(Where::Current),
                    _ => None,
                },
            },
            other => panic!("client does not send {other}"),
        };
        request(id, &command)
    }

    /// Client-direction fixtures the client never decodes, and requests it never sends: the
    /// server (vimma-core's validator) owns them. Listed so a new fixture cannot go untested.
    const SERVER_ONLY: [&str; 8] = [
        "auth.invalid.json",
        "hello.invalid.json",
        "request-open.invalid.json",
        "request-reload-theme.invalid.json",
        "request-reserved.invalid.json",
        "request-reserved.valid.json",
        "request-send-keys.invalid.json",
        "request-state.invalid.json",
    ];

    #[test]
    fn every_fixture_is_covered() {
        let all = fixtures();
        assert!(all.len() >= 26, "only {} fixtures", all.len());
        for (name, fixture) in &all {
            let kind = str_field(fixture, "kind").unwrap();
            let client_direction = matches!(kind, "hello" | "auth" | "request");
            if client_direction && !name.ends_with(".valid.json") {
                assert!(SERVER_ONLY.contains(&name.as_str()), "{name} untested");
            }
        }
    }

    #[test]
    fn decodes_server_direction_fixtures_as_named() {
        for (name, fixture) in fixtures() {
            let kind = str_field(&fixture, "kind").unwrap();
            if matches!(kind, "hello" | "auth" | "request") {
                continue;
            }
            let result = decode_fixture(&fixture);
            if name.ends_with(".valid.json") {
                assert_eq!(result, Ok(()), "{name}");
            } else {
                assert!(result.is_err(), "{name} decoded but is invalid");
            }
        }
    }

    #[test]
    fn encodes_client_direction_fixtures_exactly() {
        for (name, fixture) in fixtures() {
            let kind = str_field(&fixture, "kind").unwrap();
            if !matches!(kind, "hello" | "auth" | "request") || SERVER_ONLY.contains(&name.as_str())
            {
                continue;
            }
            assert_eq!(
                &encode_fixture(&fixture),
                fixture.get("message").unwrap(),
                "{name}"
            );
        }
    }

    #[test]
    fn modes_and_error_codes_match_vimma_core() {
        let src = |file: &str| {
            fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../packages/vimma-core/src")
                    .join(file),
            )
            .unwrap()
        };
        let quoted_after = |text: &str, marker: &str| -> Vec<String> {
            let start = text.find(marker).expect(marker);
            let rest = &text[start..];
            let end = rest.find("])").unwrap();
            rest[..end]
                .split('"')
                .skip(1)
                .step_by(2)
                .map(String::from)
                .collect()
        };
        assert_eq!(
            quoted_after(&src("modes.mjs"), "MODES = Object.freeze(["),
            MODES
        );
        assert_eq!(
            quoted_after(&src("control.mjs"), "ERROR_CODES = Object.freeze(["),
            ERROR_CODES
        );
        assert_eq!(
            quoted_after(&src("control.mjs"), "DENY_REASONS = Object.freeze(["),
            DENY_REASONS
        );
    }

    #[test]
    fn reload_theme_result_is_a_changed_flag() {
        let decode =
            |text: &str| decode_result(&Command::ReloadTheme, &crate::json::parse(text).unwrap());
        assert_eq!(
            decode(r#"{"changed":true,"later":1}"#),
            Ok(CommandResult::ReloadTheme { changed: true })
        );
        assert_eq!(
            decode(r#"{"changed":false}"#),
            Ok(CommandResult::ReloadTheme { changed: false })
        );
        assert!(decode(r#"{"changed":"yes"}"#).is_err());
        assert!(decode("{}").is_err());
    }

    #[test]
    fn request_omits_where_when_unset() {
        let value = request(
            9,
            &Command::Open {
                url: "about:blank".into(),
                place: None,
            },
        );
        assert_eq!(
            value.to_string(),
            r#"{"args":{"url":"about:blank"},"command":"open","id":9,"type":"request"}"#
        );
        let current = request(
            1,
            &Command::Open {
                url: "about:blank".into(),
                place: Some(Where::Current),
            },
        );
        assert_eq!(
            current.get("args").unwrap().get("where"),
            Some(&Value::String("current".into()))
        );
    }

    #[test]
    fn hello_carries_the_nonce_and_never_the_token() {
        // The test nonce comes from the shared contract fixture, so the client's hello is
        // checked against the very message the server's tests decode.
        let all = fixtures();
        let fixture = all.iter().find(|(n, _)| n == "hello.valid.json").unwrap();
        let message = fixture.1.get("message").unwrap();
        let nonce = str_field(message, "nonce").unwrap();
        assert_eq!(hello(nonce), *message);
        assert_eq!(
            hello(nonce).to_string(),
            format!(r#"{{"nonce":"{nonce}","protocol":1,"type":"hello"}}"#)
        );
        assert_eq!(
            auth(TOKEN).to_string(),
            format!(r#"{{"token":"{TOKEN}","type":"auth"}}"#)
        );
    }

    #[test]
    fn challenge_fixture_proof_is_the_domain_separated_hmac() {
        let all = fixtures();
        let find = |name: &str| all.iter().find(|(n, _)| n == name).unwrap().1.clone();
        let nonce = find("hello.valid.json");
        let nonce = str_field(nonce.get("message").unwrap(), "nonce")
            .unwrap()
            .to_string();
        let token = find("auth.valid.json");
        let token = str_field(token.get("message").unwrap(), "token")
            .unwrap()
            .to_string();
        let challenge =
            decode_challenge(find("challenge.valid.json").get("message").unwrap()).unwrap();
        assert_eq!(challenge.proof, challenge_proof(&token, &nonce));
        // Not the plain HMAC of the nonce: the proof is good for this purpose only.
        let plain = crate::hmac::hex(&crate::hmac::hmac_sha256(
            token.as_bytes(),
            nonce.as_bytes(),
        ));
        assert_ne!(challenge.proof, plain);
    }

    #[test]
    fn decode_challenge_needs_a_64_hex_proof() {
        let base = r#""type":"challenge","protocol":1"#;
        assert!(decode_challenge(&parse(&format!("{{{base}}}")).unwrap()).is_err());
        assert!(decode_challenge(&parse(&format!(r#"{{{base},"proof":"ab"}}"#)).unwrap()).is_err());
        let ok = "ab".repeat(32);
        assert_eq!(
            decode_challenge(&parse(&format!(r#"{{{base},"proof":"{ok}"}}"#)).unwrap())
                .unwrap()
                .proof,
            ok
        );
        let welcome = r#"{"type":"welcome","protocol":1,"app":"Vimma","version":"0.1.0"}"#;
        assert!(decode_challenge(&parse(welcome).unwrap()).is_err());
    }

    #[test]
    fn decode_response_reads_ok_and_error() {
        let ok = parse(r#"{"type":"response","id":3,"ok":true,"result":{"tab":"7"}}"#).unwrap();
        let Response::Ok { id, result } = decode_response(&ok).unwrap() else {
            panic!()
        };
        assert_eq!(id, Some(3));
        assert_eq!(
            decode_result(&command_named("open"), &result),
            Ok(CommandResult::Open { tab: "7".into() })
        );
        let err = parse(
            r#"{"type":"response","id":null,"ok":false,"error":{"code":"unauthorized","message":"no"}}"#,
        )
        .unwrap();
        assert_eq!(
            decode_response(&err),
            Ok(Response::Err {
                id: None,
                error: ErrorBody {
                    code: "unauthorized".into(),
                    message: "no".into(),
                    reason: None,
                    retry_after: None,
                }
            })
        );
    }

    #[test]
    fn decode_response_rejects_broken_envelopes() {
        for bad in [
            r"[]",
            r#"{"type":"welcome","id":1,"ok":true,"result":{}}"#,
            r#"{"type":"response","ok":true,"result":{}}"#,
            r#"{"type":"response","id":0,"ok":true,"result":{}}"#,
            r#"{"type":"response","id":1.5,"ok":true,"result":{}}"#,
            r#"{"type":"response","id":9007199254740992,"ok":true,"result":{}}"#,
            r#"{"type":"response","id":1,"ok":"yes","result":{}}"#,
            r#"{"type":"response","id":1,"ok":true}"#,
            r#"{"type":"response","id":1,"ok":false,"result":{}}"#,
            r#"{"type":"response","id":1,"ok":false,"error":"x"}"#,
            r#"{"type":"response","id":1,"ok":false,"error":{"code":"failed"}}"#,
            r#"{"type":"response","id":1,"ok":true,"result":{},"extra":1}"#,
        ] {
            assert!(
                decode_response(&parse(bad).unwrap()).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn decode_state_keeps_raw_and_ignores_unknown_fields() {
        let raw = parse(
            r#"{"mode":"insert","pending":null,"workspace":"work","tabs":[{"id":"1","url":"about:blank","title":"","selected":true}],"panes":null,"future":1}"#,
        )
        .unwrap();
        let Ok(CommandResult::State(state)) = decode_result(&Command::State, &raw) else {
            panic!()
        };
        assert_eq!(state.mode, "insert");
        assert_eq!(state.pending, None);
        assert_eq!(state.workspace.as_deref(), Some("work"));
        assert_eq!(state.tabs.len(), 1);
        assert!(state.tabs[0].selected);
        assert_eq!(state.raw, raw);
    }

    #[test]
    fn decode_private_state_has_no_urls_or_titles() {
        let raw = parse(
            r#"{"mode":"normal","pending":null,"workspace":"private","private":true,"tabs":[{"id":"1","url":null,"title":null,"selected":true}],"panes":null}"#,
        )
        .unwrap();
        let Ok(CommandResult::State(state)) = decode_result(&Command::State, &raw) else {
            panic!()
        };
        assert_eq!(state.workspace.as_deref(), Some("private"));
        assert_eq!(state.tabs[0].url, None);
        assert_eq!(state.tabs[0].title, None);
    }

    #[test]
    fn decode_state_rejects_broken_fields() {
        for bad in [
            r#"{"mode":"normal","pending":null,"workspace":null,"tabs":[]}"#,
            r#"{"mode":"normal","pending":1,"workspace":null,"tabs":[],"panes":null}"#,
            r#"{"mode":"normal","pending":null,"workspace":null,"tabs":{},"panes":null}"#,
            r#"{"mode":"normal","pending":null,"workspace":null,"tabs":[1],"panes":null}"#,
            r#"{"mode":"normal","pending":null,"workspace":null,"tabs":[{"id":"1","url":"u","title":"t","selected":1}],"panes":null}"#,
            r#"{"mode":"normal","pending":null,"workspace":null,"tabs":[{"id":"1","url":null,"title":null,"selected":true}],"panes":null}"#,
            r#"{"mode":"normal","pending":null,"workspace":null,"private":true,"tabs":[{"id":"1","url":"u","title":null,"selected":true}],"panes":null}"#,
            r#"{"pending":null,"workspace":null,"tabs":[],"panes":null}"#,
            r#""state""#,
        ] {
            assert!(
                decode_result(&Command::State, &parse(bad).unwrap()).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn decode_send_keys_result() {
        let sent = |text: &str| {
            decode_result(
                &Command::SendKeys { keys: "j".into() },
                &parse(text).unwrap(),
            )
        };
        assert_eq!(
            sent(r#"{"sent":2}"#),
            Ok(CommandResult::SendKeys { sent: 2 })
        );
        assert!(sent(r#"{"sent":-1}"#).is_err());
        assert!(sent(r#"{"sent":"2"}"#).is_err());
    }

    #[test]
    fn decode_discovery_checks_ranges() {
        let file = |port: &str, token: &str, pid: &str| {
            parse(&format!(
                r#"{{"protocol":1,"port":{port},"token":"{token}","pid":{pid}}}"#
            ))
            .unwrap()
        };
        assert_eq!(
            decode_discovery(&file("1", TOKEN, "1")),
            Ok(Discovery {
                protocol: 1,
                port: 1,
                token: TOKEN.into(),
                pid: 1,
                roles: vec![Role::Full],
                version: None,
                ticket: false,
            })
        );
        assert!(decode_discovery(&file("0", TOKEN, "1")).is_err());
        assert!(decode_discovery(&file("65536", TOKEN, "1")).is_err());
        assert!(decode_discovery(&file("1", &TOKEN.to_uppercase(), "1")).is_err());
        assert!(decode_discovery(&file("1", "abc", "1")).is_err());
        assert!(decode_discovery(&file("1", TOKEN, "0")).is_err());
    }

    // Protocol 2 (docs/specs/vimma-mcp.md, decision 2; fixtures tests/contract/control/v2/).

    fn v2_fixtures() -> Vec<(String, Value)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/contract/control/v2");
        let mut out: Vec<(String, Value)> = fs::read_dir(&dir)
            .expect("v2 fixtures")
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "json"))
            .map(|name| {
                let text = fs::read_to_string(dir.join(&name)).unwrap();
                (
                    name.clone(),
                    parse(&text).unwrap_or_else(|e| panic!("{name}: {e}")),
                )
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Agent commands and their results: `vimma-ctl mcp` sends and decodes them; mcp.rs tests
    /// them against these fixtures.
    fn agent_only(name: &str) -> bool {
        name.starts_with("request-agent-") || name.starts_with("response-agent-")
    }

    #[test]
    fn decodes_v2_server_direction_fixtures_as_named() {
        let mut seen = 0;
        for (name, fixture) in v2_fixtures() {
            let kind = str_field(&fixture, "kind").unwrap();
            if matches!(kind, "hello" | "auth" | "request") || agent_only(&name) {
                continue;
            }
            seen += 1;
            let result = decode_fixture(&fixture);
            if name.ends_with(".valid.json") {
                assert_eq!(result, Ok(()), "{name}");
            } else {
                assert!(result.is_err(), "{name} decoded but is invalid");
            }
        }
        assert!(seen >= 8, "only {seen} v2 server-direction fixtures");
    }

    // The full client's code (docs/security.md S13), sent in its auth while MCP is on.
    #[test]
    fn encodes_v2_auth_with_a_code_exactly() {
        let (_, fixture) = v2_fixtures()
            .into_iter()
            .find(|(name, _)| name == "auth-code.valid.json")
            .expect("auth-code.valid.json");
        let message = fixture.get("message").unwrap();
        assert_eq!(
            &auth_with_code(
                str_field(message, "token").unwrap(),
                str_field(message, "code").unwrap()
            ),
            message
        );
    }

    // An agent CLI's one-time ticket (docs/specs/builtin-agent-cli.md C3): the hello names it by
    // its id, and the auth carries it in place of the token.
    #[test]
    fn encodes_v2_auth_with_a_ticket_exactly() {
        let fixtures = v2_fixtures();
        let find = |name: &str| {
            fixtures.iter().find(|(n, _)| n == name).map_or_else(
                || panic!("{name}"),
                |(_, f)| f.get("message").unwrap().clone(),
            )
        };
        let auth = find("auth-ticket.valid.json");
        let ticket = str_field(&auth, "ticket").unwrap();
        assert_eq!(auth_ticket(ticket), auth);
        let hello = find("hello-ticket.valid.json");
        assert_eq!(ticket_id(ticket), str_field(&hello, "ticket").unwrap());
        assert!(
            !hello.to_string().contains(ticket),
            "the hello never names the ticket"
        );
    }

    #[test]
    fn encodes_v2_hellos_exactly() {
        for (name, fixture) in v2_fixtures() {
            if str_field(&fixture, "kind") != Some("hello") || !name.ends_with(".valid.json") {
                continue;
            }
            let message = fixture.get("message").unwrap();
            let role = match str_field(message, "role") {
                Some("agent") => Role::Agent,
                Some("full") => Role::Full,
                other => panic!("{name}: role {other:?}"),
            };
            let nonce = str_field(message, "nonce").unwrap();
            let encoded = match str_field(message, "ticket") {
                Some(id) => hello_ticket(nonce, id),
                None => hello_v2(nonce, role),
            };
            assert_eq!(&encoded, message, "{name}");
        }
        assert_eq!(
            hello_v2(&"ab".repeat(32), Role::Full).to_string(),
            format!(
                r#"{{"nonce":"{}","protocol":2,"role":"full","type":"hello"}}"#,
                "ab".repeat(32)
            )
        );
    }

    #[test]
    fn decode_discovery_reads_the_roles() {
        let file = |text: &str| decode_discovery(&parse(text).unwrap());
        let v1 = format!(r#"{{"protocol":1,"port":9,"token":"{TOKEN}","pid":3}}"#);
        assert_eq!(file(&v1).unwrap().roles, vec![Role::Full]);
        let v2 = |roles: &str| {
            format!(r#"{{"protocol":2,"port":9,"token":"{TOKEN}","pid":3,"roles":{roles}}}"#)
        };
        assert_eq!(file(&v2(r#"["agent"]"#)).unwrap().roles, vec![Role::Agent]);
        assert_eq!(
            file(&v2(r#"["full","agent"]"#)).unwrap().roles,
            vec![Role::Full, Role::Agent]
        );
        for bad in ["[]", r#"["root"]"#, r#"["full","full"]"#, r#""full""#] {
            assert!(file(&v2(bad)).is_err(), "{bad}");
        }
        let missing = format!(r#"{{"protocol":2,"port":9,"token":"{TOKEN}","pid":3}}"#);
        assert!(file(&missing).is_err());
    }

    #[test]
    fn a_denial_carries_its_reason_and_nothing_else_does() {
        let decode = |text: &str| decode_response(&parse(text).unwrap());
        let denied = decode(
            r#"{"type":"response","id":2,"ok":false,"error":{"code":"denied","message":"no","reason":"timeout"}}"#,
        );
        assert_eq!(
            denied,
            Ok(Response::Err {
                id: Some(2),
                error: ErrorBody {
                    code: "denied".into(),
                    message: "no".into(),
                    reason: Some("timeout".into()),
                    retry_after: None,
                },
            })
        );
        assert!(
            decode(
                r#"{"type":"response","id":2,"ok":false,"error":{"code":"denied","message":"no"}}"#
            )
            .is_err()
        );
        assert!(decode(r#"{"type":"response","id":2,"ok":false,"error":{"code":"denied","message":"no","reason":"bored"}}"#).is_err());
        assert!(decode(r#"{"type":"response","id":2,"ok":false,"error":{"code":"failed","message":"no","reason":"user"}}"#).is_err());
    }

    // Issue #592: a used-up rate is a busy denial with the milliseconds until the next call.
    #[test]
    fn a_busy_denial_may_say_when_the_next_call_is_allowed() {
        let decode = |text: &str| decode_response(&parse(text).unwrap());
        let error = |rest: &str| {
            format!(
                r#"{{"type":"response","id":2,"ok":false,"error":{{"code":"denied","message":"too many",{rest}}}}}"#
            )
        };
        assert_eq!(
            decode(&error(r#""reason":"busy","retryAfter":12000"#)),
            Ok(Response::Err {
                id: Some(2),
                error: ErrorBody {
                    code: "denied".into(),
                    message: "too many".into(),
                    reason: Some("busy".into()),
                    retry_after: Some(Duration::from_secs(12)),
                },
            })
        );
        for bad in ["0", "-1", "1.5", "60001", r#""5""#, "null"] {
            let text = error(&format!(r#""reason":"busy","retryAfter":{bad}"#));
            assert!(decode(&text).is_err(), "{bad}");
        }
        assert!(decode(&error(r#""reason":"user","retryAfter":5"#)).is_err());
        assert!(
            decode(r#"{"type":"response","id":2,"ok":false,"error":{"code":"failed","message":"m","retryAfter":5}}"#)
                .is_err()
        );
    }
}
