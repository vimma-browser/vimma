/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `vimma-ctl mcp` against a fake control server speaking protocol 2 as the agent role
//! (docs/specs/vimma-mcp.md, sub-PR 3's test plan): the binary over real stdio, and the serve
//! loop through the library where a test needs short timers.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use vimma_ctl::json::{Value, parse};
use vimma_ctl::mcp_serve::{Settings, serve};

const TOKEN: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
/// A one-time ticket an agent CLI's vimma-ctl gets in its environment (builtin-agent-cli C3).
const TICKET: &str = "a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718";
// Vimma's version in the welcome is older than this vimma-ctl's, so only the version tests at
// the end see the note for an older client (docs/specs/ship-vimma-ctl.md).
const WELCOME: &str =
    r#"{"type":"welcome","protocol":2,"app":"Vimma","version":"0.1.0","role":"agent"}"#;
/// A Vimma newer than any vimma-ctl.
const NEWER_WELCOME: &str =
    r#"{"type":"welcome","protocol":2,"app":"Vimma","version":"999.0.0","role":"agent"}"#;
const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.0"}}}"#;

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

fn temp_profile() -> TempDir {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "vimma-ctl-mcp-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

fn write_discovery(profile: &Path, text: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = profile.join("vimma-control.json");
    fs::write(&path, text).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn discovery_v2(port: u16, roles: &str) -> String {
    format!(r#"{{"protocol":2,"port":{port},"token":"{TOKEN}","pid":1,"roles":{roles}}}"#)
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    match v.get(key) {
        Some(Value::String(s)) => s,
        other => panic!("{key}: {other:?} in {v}"),
    }
}

fn id_of(v: &Value) -> u64 {
    v.get("id").and_then(Value::as_u64).unwrap()
}

/// What the fake Vimma saw: the hello's role and each request's command and args.
#[derive(Debug, Default, Clone)]
struct Seen {
    hellos: Vec<Value>,
    auths: Vec<Value>,
    requests: Vec<Value>,
    closed: usize,
}

/// A fake Vimma: the real handshake for the agent role, `agent-hello`, then `answer` for each
/// later request (its value, or `None` to send nothing yet). Accepts connection after
/// connection. `push` sends a line on the newest connection.
struct FakeVimma {
    profile: TempDir,
    port: u16,
    seen: Arc<Mutex<Seen>>,
    latest: Arc<Mutex<Option<TcpStream>>>,
}

type Answer = Box<dyn FnMut(&Value) -> Option<String> + Send>;

impl FakeVimma {
    fn start(answer: Answer) -> Self {
        Self::start_as(WELCOME, answer)
    }

    /// [`FakeVimma::start`] with its own `welcome` line, which names Vimma's version.
    fn start_as(welcome: &'static str, answer: Answer) -> Self {
        Self::start_with(welcome, None, answer)
    }

    /// A Vimma that takes only `TICKET` (docs/specs/builtin-agent-cli.md C3): the hello must
    /// name it by its id, the proof is made with it, and the auth must carry it, never a token.
    fn with_ticket(answer: Answer) -> Self {
        Self::start_with(WELCOME, Some(TICKET), answer)
    }

    fn start_with(welcome: &'static str, ticket: Option<&'static str>, answer: Answer) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let profile = temp_profile();
        write_discovery(&profile, &discovery_v2(port, r#"["agent"]"#));
        let seen = Arc::new(Mutex::new(Seen::default()));
        let latest = Arc::new(Mutex::new(None));
        let answer = Arc::new(Mutex::new(answer));
        let (s, l) = (seen.clone(), latest.clone());
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                *l.lock().unwrap() = Some(stream.try_clone().unwrap());
                let (s, answer) = (s.clone(), answer.clone());
                thread::spawn(move || serve_one(stream, welcome, ticket, &s, &answer));
            }
        });
        Self {
            profile,
            port,
            seen,
            latest,
        }
    }

    /// A Vimma that answers every request with `result` (an `ok: true` body).
    fn answering(result: &'static str) -> Self {
        Self::start(Box::new(move |req| {
            Some(format!(
                r#"{{"type":"response","id":{},"ok":true,"result":{result}}}"#,
                id_of(req)
            ))
        }))
    }

    fn seen(&self) -> Seen {
        self.seen.lock().unwrap().clone()
    }

    fn push(&self, line: &str) {
        let mut guard = self.latest.lock().unwrap();
        let stream = guard.as_mut().unwrap();
        stream.write_all(format!("{line}\n").as_bytes()).unwrap();
    }

    fn drop_connection(&self) {
        if let Some(s) = self.latest.lock().unwrap().take() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }

    /// Wait until `pred` holds for what the fake saw.
    fn wait_for(&self, what: &str, pred: impl Fn(&Seen) -> bool) -> Seen {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen = self.seen();
            if pred(&seen) {
                return seen;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {seen:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// A ticket's id, computed here from the HMAC primitive: `HMAC-SHA256(ticket, "vimma-ticket\0")`.
fn ticket_id(ticket: &str) -> String {
    vimma_ctl::hmac::hex(&vimma_ctl::hmac::hmac_sha256(
        ticket.as_bytes(),
        b"vimma-ticket\0",
    ))
}

fn serve_one(
    stream: TcpStream,
    welcome: &str,
    ticket: Option<&str>,
    seen: &Mutex<Seen>,
    answer: &Mutex<Answer>,
) {
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    let mut n = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let msg = parse(line.trim_end()).unwrap();
        let out = match n {
            0 => {
                seen.lock().unwrap().hellos.push(msg.clone());
                if let Some(ticket) = ticket {
                    if msg.get("ticket") != Some(&Value::String(ticket_id(ticket))) {
                        let _ = writer.write_all(
                            b"{\"type\":\"response\",\"id\":null,\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"no ticket\"}}\n",
                        );
                        break;
                    }
                }
                let key = ticket.unwrap_or(TOKEN);
                let proof = vimma_ctl::protocol::challenge_proof(key, str_of(&msg, "nonce"));
                Some(format!(
                    r#"{{"type":"challenge","protocol":2,"proof":"{proof}"}}"#
                ))
            }
            1 => {
                seen.lock().unwrap().auths.push(msg.clone());
                if let Some(ticket) = ticket {
                    assert_eq!(str_of(&msg, "ticket"), ticket);
                    assert!(msg.get("token").is_none(), "a ticket's auth has no token");
                } else {
                    assert_eq!(str_of(&msg, "token"), TOKEN);
                }
                assert!(
                    msg.get("code").is_none(),
                    "an agent sends no full-control code"
                );
                Some(welcome.to_string())
            }
            _ => {
                seen.lock().unwrap().requests.push(msg.clone());
                if str_of(&msg, "command") == "agent-hello" {
                    Some(format!(
                        r#"{{"type":"response","id":{},"ok":true,"result":{{"workspace":"agent","exists":true}}}}"#,
                        id_of(&msg)
                    ))
                } else if str_of(&msg, "command") == "agent-ping" {
                    Some(format!(
                        r#"{{"type":"response","id":{},"ok":true,"result":{{}}}}"#,
                        id_of(&msg)
                    ))
                } else {
                    (answer.lock().unwrap())(&msg)
                }
            }
        };
        n += 1;
        if let Some(out) = out {
            if writer.write_all(format!("{out}\n").as_bytes()).is_err() {
                break;
            }
        }
    }
    seen.lock().unwrap().closed += 1;
}

/// `vimma-ctl mcp` as an agent tool runs it: stdin and stdout are pipes.
struct Mcp {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
}

impl Mcp {
    fn start(profile: &Path) -> Self {
        Self::start_env(profile, &[])
    }

    /// [`Mcp::start`] with `env` added to its environment.
    fn start_env(profile: &Path, env: &[(&str, &str)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vimma-ctl"))
            .arg("--profile")
            .arg(profile)
            .arg("mcp")
            .env_remove("VIMMA_PROFILE")
            .env_remove("VIMMA_AGENT_TICKET")
            .env_remove("VIMMA_AGENT_PORT")
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout: ChildStdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let mut err = child.stderr.take().unwrap();
        let sink = stderr.clone();
        thread::spawn(move || {
            let mut text = String::new();
            let _ = err.read_to_string(&mut text);
            sink.lock().unwrap().push_str(&text);
        });
        Self {
            stdin: child.stdin.take(),
            child,
            lines,
            stderr,
        }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(format!("{line}\n").as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    /// The next stdout line, which must be one JSON-RPC message.
    fn next(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(10))
            .expect("a line on stdout");
        let v = parse(&line).unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {line}"));
        assert_eq!(
            v.get("jsonrpc"),
            Some(&Value::String("2.0".into())),
            "{line}"
        );
        v
    }

    fn call(&mut self, id: u32, name: &str, arguments: &str) -> Value {
        self.send(&format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{name}","arguments":{arguments}}}}}"#
        ));
        let r = self.next();
        assert_eq!(id_of(&r), u64::from(id), "{r}");
        r
    }

    /// Close stdin and wait for the exit code.
    fn finish(mut self) -> (Option<i32>, String) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                thread::sleep(Duration::from_millis(50));
                let err = self.stderr.lock().unwrap().clone();
                return (status.code(), err);
            }
            assert!(
                Instant::now() < deadline,
                "vimma-ctl mcp did not exit on stdin EOF"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn content_texts(r: &Value) -> Vec<String> {
    let result = r.get("result").unwrap_or_else(|| panic!("no result: {r}"));
    match result.get("content") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| str_of(i, "text").to_string())
            .collect(),
        _ => panic!("no content: {r}"),
    }
}

fn is_error(r: &Value) -> bool {
    r.get("result").and_then(|res| res.get("isError")) == Some(&Value::Bool(true))
}

const READ_RESULT: &str = r#"{"url":"https://docs.rs/serde","title":"serde - Rust","text":"<untrusted-web-content>\nSerde is a framework.\n</untrusted-web-content>","truncated":false,"selection":null,"language":"en","background":true}"#;

#[test]
fn initialize_and_tools_list_need_no_vimma() {
    let profile = temp_profile();
    let mut mcp = Mcp::start(&profile);
    mcp.send(INIT);
    let r = mcp.next();
    assert_eq!(
        r.get("result").unwrap().get("protocolVersion"),
        Some(&Value::String("2025-11-25".into()))
    );
    mcp.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    mcp.send(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
    let r = mcp.next();
    assert_eq!(id_of(&r), 2);
    let fixture = parse(include_str!("fixtures/mcp/tools-list.json")).unwrap();
    assert_eq!(r.get("result"), Some(&fixture));
    let (code, _) = mcp.finish();
    assert_eq!(code, Some(0));
}

// Spec: given the fake server answers, two text items, the header first. The connection is the
// agent role's, opened with agent-hello carrying the client's name.
#[test]
fn a_read_reaches_vimma_as_the_agent_role() {
    let vimma = FakeVimma::answering(READ_RESULT);
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_read_page", r#"{"tab":"12","format":"text"}"#);
    assert!(!is_error(&r), "{r}");
    let texts = content_texts(&r);
    assert_eq!(texts.len(), 2);
    assert!(texts[0].starts_with("Untrusted web content from https://docs.rs/serde"));
    assert!(texts[0].contains("background"));
    assert!(texts[1].starts_with("<untrusted-web-content>"));

    let seen = vimma.seen();
    assert_eq!(seen.hellos.len(), 1);
    assert_eq!(
        str_of(&seen.hellos[0], "role"),
        "agent",
        "never the full role"
    );
    assert_eq!(
        seen.hellos[0].get("protocol").and_then(Value::as_u64),
        Some(2)
    );
    let hello = &seen.requests[0];
    assert_eq!(str_of(hello, "command"), "agent-hello");
    let client = hello.get("args").unwrap().get("client").unwrap();
    assert_eq!(str_of(client, "name"), "claude-code");
    assert_eq!(str_of(client, "version"), "2.1.0");
    let read = &seen.requests[1];
    assert_eq!(str_of(read, "command"), "agent-read");
    assert_eq!(
        read.get("args").unwrap().to_string(),
        r#"{"format":"text","tab":"12"}"#
    );
    // Every command an agent connection sent is an agent command.
    for r in &seen.requests {
        assert!(str_of(r, "command").starts_with("agent-"), "{r}");
    }
    let (code, _) = mcp.finish();
    assert_eq!(code, Some(0));
}

// Spec: given the fake server denies, the tool result is isError with the denial text and the
// process keeps running.
#[test]
fn a_denial_is_a_tool_error_and_the_server_goes_on() {
    let vimma = FakeVimma::start(Box::new(|req| {
        Some(format!(
            r#"{{"type":"response","id":{},"ok":false,"error":{{"code":"denied","message":"the user denied this request in Vimma","reason":"user"}}}}"#,
            id_of(req)
        ))
    }));
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_open", r#"{"url":"https://docs.rs/serde"}"#);
    assert!(is_error(&r), "{r}");
    assert_eq!(
        content_texts(&r),
        ["The user denied this request in Vimma."]
    );
    let r = mcp.call(3, "vimma_tabs", "{}");
    assert!(is_error(&r));
    // One connection for both calls (decision 1): grants live as long as it does.
    assert_eq!(vimma.seen().hellos.len(), 1);
    let (code, _) = mcp.finish();
    assert_eq!(code, Some(0));
}

// Spec: given the fake server is protocol 1 only, a tool error saying Vimma is too old.
#[test]
fn a_protocol_1_vimma_is_too_old() {
    let profile = temp_profile();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    write_discovery(
        &profile,
        &format!(r#"{{"protocol":1,"port":{port},"token":"{TOKEN}","pid":1}}"#),
    );
    let mut mcp = Mcp::start(&profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(is_error(&r));
    assert!(
        content_texts(&r)[0].contains("This Vimma is too old for MCP (protocol 1)"),
        "{r}"
    );
    let (code, _) = mcp.finish();
    assert_eq!(code, Some(0));
}

// Spec: given the discovery file without agent in roles, "MCP is off in Vimma: run :mcp on",
// without connecting.
#[test]
fn mcp_off_says_to_run_mcp_on_without_connecting() {
    let vimma = FakeVimma::answering("{}");
    write_discovery(&vimma.profile, &discovery_v2(vimma.port, r#"["full"]"#));
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(is_error(&r));
    assert!(
        content_texts(&r)[0].starts_with("MCP is off in Vimma: run :mcp on"),
        "{r}"
    );
    assert_eq!(
        vimma.seen().hellos,
        Vec::<Value>::new(),
        "no connection, so no full role either"
    );
    mcp.finish();
}

#[test]
fn role_off_at_the_hello_says_mcp_is_off() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let profile = temp_profile();
    write_discovery(&profile, &discovery_v2(port, r#"["agent"]"#));
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut w = stream.try_clone().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        let _ = w.write_all(
            b"{\"type\":\"response\",\"id\":null,\"ok\":false,\"error\":{\"code\":\"role-off\",\"message\":\"MCP is off: run :mcp on\"}}\n",
        );
    });
    let mut mcp = Mcp::start(&profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(
        content_texts(&r)[0].starts_with("MCP is off in Vimma"),
        "{r}"
    );
    mcp.finish();
}

#[test]
fn not_running_says_to_start_vimma() {
    let profile = temp_profile();
    let mut mcp = Mcp::start(&profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(is_error(&r));
    assert!(
        content_texts(&r)[0].starts_with("Vimma is not running"),
        "{r}"
    );
    mcp.finish();
}

// Spec: given stdin EOF, exit 0 and the socket closed.
#[test]
fn stdin_eof_exits_0_and_closes_the_socket() {
    let vimma = FakeVimma::answering(r#"{"tabs":[]}"#);
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    mcp.call(2, "vimma_tabs", "{}");
    let (code, stderr) = mcp.finish();
    assert_eq!(code, Some(0), "{stderr}");
    vimma.wait_for("the socket to close", |s| s.closed == 1);
}

// The connection dropped while a call waited: a tool error, and the next call reconnects. Both
// hellos carry the same session id, so Vimma gives the new connection the grant the dropped one
// held (docs/specs/mcp-session-grants.md S3, S4).
#[test]
fn a_dropped_connection_fails_the_waiting_call_and_the_next_call_reconnects() {
    let vimma = FakeVimma::start(Box::new(|req| match str_of(req, "command") {
        "agent-tabs" => Some(format!(
            r#"{{"type":"response","id":{},"ok":true,"result":{{"tabs":[]}}}}"#,
            id_of(req)
        )),
        _ => None,
    }));
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    mcp.send(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vimma_open","arguments":{"url":"https://a.example/"}}}"#,
    );
    vimma.wait_for("the open", |s| s.requests.len() == 2);
    vimma.drop_connection();
    let r = mcp.next();
    assert_eq!(id_of(&r), 2);
    assert!(
        content_texts(&r)[0].starts_with("The connection to Vimma closed"),
        "{r}"
    );
    let r = mcp.call(3, "vimma_tabs", "{}");
    assert!(!is_error(&r), "{r}");
    assert_eq!(vimma.seen().hellos.len(), 2);
    let sessions: Vec<String> = vimma
        .seen()
        .requests
        .iter()
        .filter(|r| str_of(r, "command") == "agent-hello")
        .map(|r| str_of(r.get("args").unwrap(), "session").to_string())
        .collect();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0], sessions[1]);
    mcp.finish();
}

// mcp-session-grants S4: the session id is random per process, 64 lowercase hex characters.
#[test]
fn each_process_has_its_own_session_id() {
    let session = || {
        let vimma = FakeVimma::answering(r#"{"tabs":[]}"#);
        let mut mcp = Mcp::start(&vimma.profile);
        mcp.send(INIT);
        mcp.next();
        mcp.call(2, "vimma_tabs", "{}");
        mcp.finish();
        let hello = &vimma.seen().requests[0];
        str_of(hello.get("args").unwrap(), "session").to_string()
    };
    let (a, b) = (session(), session());
    for s in [&a, &b] {
        assert_eq!(s.len(), 64, "{s}");
        assert!(
            s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "{s}"
        );
    }
    assert_ne!(a, b);
}

// MCP notifications/cancelled withdraws the question in Vimma (decision 17): agent-cancel with
// the request's id, and no response for the cancelled call.
#[test]
fn a_cancelled_call_withdraws_its_question_and_gets_no_response() {
    let vimma = FakeVimma::start(Box::new(|req| match str_of(req, "command") {
        "agent-cancel" => Some(format!(
            r#"{{"type":"response","id":{},"ok":true,"result":{{"cancelled":true}}}}"#,
            id_of(req)
        )),
        "agent-tabs" => Some(format!(
            r#"{{"type":"response","id":{},"ok":true,"result":{{"tabs":[]}}}}"#,
            id_of(req)
        )),
        _ => None,
    }));
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    mcp.send(
        r#"{"jsonrpc":"2.0","id":"open-1","method":"tools/call","params":{"name":"vimma_open","arguments":{"url":"https://a.example/"}}}"#,
    );
    let seen = vimma.wait_for("the open", |s| s.requests.len() == 2);
    let open_id = id_of(&seen.requests[1]);
    mcp.send(
        r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"open-1","reason":"user pressed esc"}}"#,
    );
    let seen = vimma.wait_for("the cancel", |s| s.requests.len() == 3);
    let cancel = &seen.requests[2];
    assert_eq!(str_of(cancel, "command"), "agent-cancel");
    assert_eq!(
        cancel
            .get("args")
            .unwrap()
            .get("id")
            .and_then(Value::as_u64),
        Some(open_id)
    );
    // Vimma's late answer to the cancelled open is dropped: the next line is the tabs call's.
    vimma.push(&format!(
        r#"{{"type":"response","id":{open_id},"ok":false,"error":{{"code":"denied","message":"the request was cancelled","reason":"cancelled"}}}}"#
    ));
    let r = mcp.call(5, "vimma_tabs", "{}");
    assert_eq!(id_of(&r), 5);
    mcp.finish();
}

// Bad arguments never reach Vimma: no connection is even made for them.
#[test]
fn bad_arguments_never_reach_vimma() {
    let vimma = FakeVimma::answering("{}");
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_open", r#"{"url":"file:///etc/passwd"}"#);
    assert!(is_error(&r));
    let r = mcp.call(3, "vimma_open", r#"{"url":"javascript:alert(1)"}"#);
    assert!(is_error(&r));
    assert_eq!(
        vimma.seen().hellos,
        Vec::<Value>::new(),
        "no connection was made"
    );
    mcp.finish();
}

// Nothing but protocol on stdout: garbage, an over-long line and binary bytes each get one
// JSON-RPC error line, notifications none, and the process still answers afterwards.
#[test]
fn stdout_carries_only_json_rpc_messages() {
    let profile = temp_profile();
    let mut mcp = Mcp::start(&profile);
    mcp.send("hello");
    assert!(mcp.next().get("error").is_some());
    let long = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"ping","x":"{}"}}"#,
        "a".repeat(1 << 21)
    );
    mcp.send(&long);
    let r = mcp.next();
    assert_eq!(r.get("id"), Some(&Value::Null));
    assert!(r.get("error").is_some());
    {
        let stdin = mcp.stdin.as_mut().unwrap();
        stdin.write_all(b"\xff\xfe{\n").unwrap();
    }
    assert!(mcp.next().get("error").is_some());
    mcp.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    mcp.send(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#);
    let r = mcp.next();
    assert_eq!(id_of(&r), 2);
    let (code, stderr) = mcp.finish();
    assert_eq!(code, Some(0), "{stderr}");
}

// The token comes from the discovery file only: an environment variable or argument cannot
// supply one, and nothing in the output carries it.
#[test]
fn the_token_never_leaves_the_handshake() {
    let vimma = FakeVimma::answering(r#"{"tabs":[]}"#);
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(!r.to_string().contains(TOKEN));
    let (_, stderr) = mcp.finish();
    assert!(!stderr.contains(TOKEN), "{stderr}");
}

// docs/specs/builtin-agent-cli.md C3: an agent CLI's vimma-ctl gets a one-time ticket and the
// port in its environment. It connects with the ticket alone, as the agent role, and never reads
// the discovery file, so it never holds the token.
#[test]
fn mcp_connects_with_a_ticket_from_the_environment() {
    let vimma = FakeVimma::with_ticket(Box::new(|req| {
        Some(format!(
            r#"{{"type":"response","id":{},"ok":true,"result":{{"tabs":[]}}}}"#,
            id_of(req)
        ))
    }));
    // A Vimma with the token, named by the profile's discovery file: never dialled.
    let other = FakeVimma::answering(r#"{"tabs":[]}"#);
    let port = vimma.port.to_string();
    let env = [
        ("VIMMA_AGENT_TICKET", TICKET),
        ("VIMMA_AGENT_PORT", port.as_str()),
    ];
    let mut mcp = Mcp::start_env(&other.profile, &env);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(!is_error(&r), "{r}");
    let seen = vimma.seen();
    assert_eq!(seen.hellos.len(), 1);
    assert_eq!(str_of(&seen.hellos[0], "role"), "agent");
    assert_eq!(str_of(&seen.hellos[0], "ticket"), ticket_id(TICKET));
    assert!(
        !seen.hellos[0].to_string().contains(TICKET),
        "the hello names only the id"
    );
    assert_eq!(str_of(&seen.auths[0], "ticket"), TICKET);
    assert_eq!(str_of(&seen.requests[0], "command"), "agent-hello");
    let session = seen.requests[0].get("args").unwrap().get("session");
    assert!(
        session.is_some(),
        "a reconnect keeps its connection by session id"
    );
    assert_eq!(str_of(&seen.requests[1], "command"), "agent-tabs");
    assert!(
        other.seen().hellos.is_empty(),
        "the token's Vimma was never dialled"
    );
    let (code, stderr) = mcp.finish();
    assert_eq!(code, Some(0), "{stderr}");
}

// The ticket reaches only the auth line of a server that proved it knows it: never stdout,
// stderr or a tool result, whether the connection works, is refused or the value is malformed.
#[test]
fn the_ticket_is_never_printed() {
    let vimma = FakeVimma::with_ticket(Box::new(|req| {
        Some(format!(
            r#"{{"type":"response","id":{},"ok":true,"result":{{"tabs":[]}}}}"#,
            id_of(req)
        ))
    }));
    let profile = temp_profile();
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port().to_string();
    drop(closed);
    let good = vimma.port.to_string();
    let upper = TICKET.to_uppercase();
    let cases: [(&str, &str); 4] = [
        (TICKET, good.as_str()),
        (TICKET, closed_port.as_str()),
        (TICKET, "not-a-port"),
        (upper.as_str(), good.as_str()),
    ];
    for (ticket, port) in cases {
        let env = [("VIMMA_AGENT_TICKET", ticket), ("VIMMA_AGENT_PORT", port)];
        let mut mcp = Mcp::start_env(&profile, &env);
        mcp.send(INIT);
        let init = mcp.next();
        let r = mcp.call(2, "vimma_tabs", "{}");
        for text in [init.to_string(), r.to_string()] {
            assert!(!text.to_lowercase().contains(TICKET), "{port}: {text}");
        }
        let (_, stderr) = mcp.finish();
        assert!(!stderr.to_lowercase().contains(TICKET), "{port}: {stderr}");
    }
    // A malformed ticket or port is refused before any connection.
    assert_eq!(vimma.seen().hellos.len(), 1, "only the good case connected");
}

// A task Vimma ran has ended (stopped, or finished) when its ticket's port no longer listens:
// the model is told so, and never to turn MCP on, which would open Vimma to every local process.
#[test]
fn a_ticket_whose_task_ended_never_says_to_turn_on_mcp() {
    let profile = temp_profile();
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closed.local_addr().unwrap().port().to_string();
    drop(closed);
    for (ticket, port) in [(TICKET, port.as_str()), ("not-a-ticket", port.as_str())] {
        let env = [("VIMMA_AGENT_TICKET", ticket), ("VIMMA_AGENT_PORT", port)];
        let mut mcp = Mcp::start_env(&profile, &env);
        mcp.send(INIT);
        mcp.next();
        let r = mcp.call(2, "vimma_tabs", "{}");
        assert!(is_error(&r), "{r}");
        let text = &content_texts(&r)[0];
        assert!(!text.contains(":mcp on"), "{text}");
        assert!(text.contains("this task's connection to Vimma"), "{text}");
        mcp.finish();
    }
}

// S4 with the ticket as the key: a squatter on the port that cannot prove it knows the ticket
// sees the hello (the nonce and the ticket's id) and nothing more.
#[test]
fn a_ticket_handshake_proves_the_server_first() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let after = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = after.clone();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut w = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut hello = String::new();
        reader.read_line(&mut hello).unwrap();
        let nonce = str_of(&parse(hello.trim_end()).unwrap(), "nonce").to_string();
        // The squatter knows the token, not the ticket.
        let proof = vimma_ctl::protocol::challenge_proof(TOKEN, &nonce);
        let _ = w.write_all(
            format!("{{\"type\":\"challenge\",\"protocol\":2,\"proof\":\"{proof}\"}}\n").as_bytes(),
        );
        for line in reader.lines() {
            let Ok(line) = line else { break };
            sink.lock().unwrap().push(line);
        }
    });
    let profile = temp_profile();
    let env = [
        ("VIMMA_AGENT_TICKET", TICKET),
        ("VIMMA_AGENT_PORT", port.as_str()),
    ];
    let mut mcp = Mcp::start_env(&profile, &env);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert!(is_error(&r), "{r}");
    assert!(content_texts(&r)[0].contains("did not prove"), "{r}");
    mcp.finish();
    let after = after.lock().unwrap();
    assert!(after.is_empty(), "nothing after the hello: {after:?}");
}

#[test]
fn mcp_takes_no_arguments() {
    let out = Command::new(env!("CARGO_BIN_EXE_vimma-ctl"))
        .args(["mcp", "extra"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("mcp takes no arguments"));
    let out = Command::new(env!("CARGO_BIN_EXE_vimma-ctl"))
        .args(["--timeout", "3", "mcp"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--timeout"));
}

/// stdin for the library's serve loop: lines sent through a channel; EOF when it is dropped.
struct ChannelInput {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
}

impl Read for ChannelInput {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.buf.is_empty() {
            match self.rx.recv() {
                Ok(bytes) => self.buf = bytes,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

#[derive(Clone, Default)]
struct SharedOut(Arc<Mutex<Vec<u8>>>);

impl Write for SharedOut {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl SharedOut {
    fn lines(&self) -> Vec<Value> {
        let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
        text.lines().map(|l| parse(l).unwrap()).collect()
    }

    fn wait_lines(&self, n: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let lines = self.lines();
            if lines.len() >= n {
                return lines;
            }
            assert!(
                Instant::now() < deadline,
                "only {} lines: {lines:?}",
                lines.len()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// The serve loop in a thread, with `settings`; returns the input sender and the output.
fn serve_in_thread(profile: &Path, settings: Settings) -> (Sender<Vec<u8>>, SharedOut) {
    let (tx, rx) = mpsc::channel();
    let out = SharedOut::default();
    let mut writer = out.clone();
    let profile = profile.to_path_buf();
    thread::spawn(move || {
        let input = ChannelInput {
            rx,
            buf: Vec::new(),
        };
        let find = move || vimma_ctl::discovery::read_discovery(&profile).map_err(|e| e.0);
        serve(Box::new(input), &mut writer, &find, None, &settings)
    });
    (tx, out)
}

fn short(ping_every: Duration, answer_wait: Duration) -> Settings {
    Settings {
        ping_every,
        answer_wait,
        ..Settings::default()
    }
}

// Spec: given no request for a while, agent-ping was sent, so Vimma's 60 s idle limit never
// closes the connection (and its grants) between calls.
#[test]
fn an_idle_connection_is_kept_alive_with_agent_ping() {
    let vimma = FakeVimma::answering(r#"{"tabs":[]}"#);
    let (tx, out) = serve_in_thread(
        &vimma.profile,
        short(Duration::from_millis(200), Duration::from_secs(60)),
    );
    tx.send(format!("{INIT}\n").into_bytes()).unwrap();
    tx.send(
        br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vimma_tabs"}}
"#
        .to_vec(),
    )
    .unwrap();
    out.wait_lines(2);
    let seen = vimma.wait_for("two pings", |s| {
        s.requests
            .iter()
            .filter(|r| str_of(r, "command") == "agent-ping")
            .count()
            >= 2
    });
    assert_eq!(seen.hellos.len(), 1, "one connection, kept");
    // Pings never reach stdout.
    assert_eq!(out.lines().len(), 2);
    drop(tx);
}

// A call Vimma never answers ends as a tool error at the deadline, and its question is
// withdrawn.
#[test]
fn a_call_without_an_answer_ends_at_the_deadline() {
    let vimma = FakeVimma::start(Box::new(|req| match str_of(req, "command") {
        "agent-cancel" => Some(format!(
            r#"{{"type":"response","id":{},"ok":true,"result":{{"cancelled":true}}}}"#,
            id_of(req)
        )),
        _ => None,
    }));
    let (tx, out) = serve_in_thread(
        &vimma.profile,
        short(Duration::from_secs(30), Duration::from_millis(300)),
    );
    tx.send(format!("{INIT}\n").into_bytes()).unwrap();
    tx.send(
        br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vimma_tabs"}}
"#
        .to_vec(),
    )
    .unwrap();
    let lines = out.wait_lines(2);
    let r = &lines[1];
    assert_eq!(id_of(r), 2);
    assert!(
        content_texts(r)[0].starts_with("Vimma did not answer within"),
        "{r}"
    );
    vimma.wait_for("the withdrawal", |s| {
        s.requests
            .iter()
            .any(|r| str_of(r, "command") == "agent-cancel")
    });
    drop(tx);
}

// A timeout denial names how long the call waited.
#[test]
fn a_timeout_denial_names_the_wait() {
    let vimma = FakeVimma::start(Box::new(|req| {
        thread::sleep(Duration::from_millis(1100));
        Some(format!(
            r#"{{"type":"response","id":{},"ok":false,"error":{{"code":"denied","message":"no answer in Vimma in time; treated as denied","reason":"timeout"}}}}"#,
            id_of(req)
        ))
    }));
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let r = mcp.call(2, "vimma_tabs", "{}");
    assert_eq!(
        content_texts(&r),
        ["No answer in Vimma within 1 s; treated as denied. Ask the user before trying again."]
    );
    mcp.finish();
}

/// The note an older vimma-ctl adds for a Vimma of version 999.0.0.
fn older_note() -> String {
    format!(
        "This vimma-ctl ({}) is older than Vimma (999.0.0), so it offers fewer tools than Vimma \
         has. Tell the user to update vimma-ctl: it ships with Vimma, and the user guide's \
         \"Agent workspace\" section says where.",
        vimma_ctl::version::VERSION
    )
}

// Spec: docs/specs/ship-vimma-ctl.md, behaviour 4: agent-hello names this vimma-ctl's version,
// which is Vimma's version of the tree it was built from (surfer.json's displayVersion).
#[test]
fn agent_hello_names_this_vimma_ctl_version() {
    let surfer =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../surfer.json"))
            .unwrap();
    let surfer = parse(&surfer).unwrap();
    let release = surfer
        .get("brands")
        .and_then(|b| b.get("vimma"))
        .and_then(|b| b.get("release"))
        .unwrap();
    let display = str_of(release, "displayVersion").to_string();
    assert_eq!(vimma_ctl::version::VERSION, display);

    let vimma = FakeVimma::answering(r#"{"tabs":[]}"#);
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    mcp.call(2, "vimma_tabs", "{}");
    let hello = &vimma.seen().requests[0];
    assert_eq!(str_of(hello, "command"), "agent-hello");
    assert_eq!(str_of(hello.get("args").unwrap(), "ctl"), display);
    let (code, _) = mcp.finish();
    assert_eq!(code, Some(0));
}

// Spec: behaviour 5: a vimma-ctl older than the Vimma it reaches still serves its tools, and
// says so once, at the top of the first tool result after it connects.
#[test]
fn an_older_client_says_so_in_its_first_tool_result() {
    let vimma = FakeVimma::start_as(
        NEWER_WELCOME,
        Box::new(|req| {
            Some(format!(
                r#"{{"type":"response","id":{},"ok":true,"result":{{"tabs":[]}}}}"#,
                id_of(req)
            ))
        }),
    );
    let mut mcp = Mcp::start(&vimma.profile);
    mcp.send(INIT);
    mcp.next();
    let first = mcp.call(2, "vimma_tabs", "{}");
    assert!(!is_error(&first), "{first}");
    let texts = content_texts(&first);
    assert_eq!(texts.len(), 2, "{first}");
    assert_eq!(texts[0], older_note());
    assert!(texts[1].contains("no tabs"), "{first}");
    let second = mcp.call(3, "vimma_tabs", "{}");
    assert_eq!(
        content_texts(&second).len(),
        1,
        "only the first result: {second}"
    );
    let (code, _) = mcp.finish();
    assert_eq!(code, Some(0));
}

// Spec: behaviour 5: when the discovery file already names a newer Vimma, the server
// instructions say so too; without a version, or for a Vimma no newer, they are unchanged.
#[test]
fn the_instructions_name_an_older_client_when_the_discovery_file_does() {
    let instructions = |discovery: Option<String>| {
        let profile = temp_profile();
        if let Some(text) = discovery {
            write_discovery(&profile, &text);
        }
        let mut mcp = Mcp::start(&profile);
        mcp.send(INIT);
        let r = mcp.next();
        let text = str_of(r.get("result").unwrap(), "instructions").to_string();
        mcp.finish();
        text
    };
    let with_version = |version: &str| {
        Some(format!(
            r#"{{"protocol":2,"port":1,"token":"{TOKEN}","pid":1,"roles":["agent"],"version":"{version}"}}"#
        ))
    };
    assert_eq!(instructions(None), vimma_ctl::mcp::INSTRUCTIONS);
    assert_eq!(
        instructions(Some(discovery_v2(1, r#"["agent"]"#))),
        vimma_ctl::mcp::INSTRUCTIONS
    );
    assert_eq!(
        instructions(with_version(vimma_ctl::version::VERSION)),
        vimma_ctl::mcp::INSTRUCTIONS
    );
    assert_eq!(
        instructions(with_version("999.0.0")),
        format!("{} {}", vimma_ctl::mcp::INSTRUCTIONS, older_note())
    );
}
