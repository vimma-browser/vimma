/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The `vimma-ctl` binary against a fake control server (a `std::net::TcpListener` in the test).

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const TOKEN: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const WELCOME: &str = r#"{"type":"welcome","protocol":1,"app":"Vimma","version":"0.1.0"}"#;

/// The nonce of a `hello` line.
fn nonce_of(hello: &str) -> String {
    let value = vimma_ctl::json::parse(hello).expect("hello is JSON");
    match value.get("nonce") {
        Some(vimma_ctl::json::Value::String(nonce)) => nonce.clone(),
        _ => panic!("hello without a nonce: {hello}"),
    }
}

/// A challenge proving knowledge of `key` for this hello: what the real server sends with the
/// token. A squatter does not know the token.
fn challenge_with_key(hello: &str, key: &str) -> String {
    let proof = vimma_ctl::protocol::challenge_proof(key, &nonce_of(hello));
    format!(r#"{{"type":"challenge","protocol":1,"proof":"{proof}"}}"#)
}

fn challenge(hello: &str) -> String {
    challenge_with_key(hello, TOKEN)
}

/// A temp dir that is removed when dropped, also when the test panics: one left behind per test
/// and run filled a tmpfs's inodes (#207). std only, like the crate (ADR-011).
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
        "vimma-ctl-it-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

#[test]
fn temp_profiles_are_removed_after_the_test_passed_or_panicked() {
    let passed = {
        let dir = temp_profile();
        fs::write(dir.join("f"), "x").unwrap();
        dir.to_path_buf()
    };
    assert!(!passed.exists());
    let seen = std::sync::Mutex::new(PathBuf::new());
    let result = std::panic::catch_unwind(|| {
        let dir = temp_profile();
        *seen.lock().unwrap() = dir.to_path_buf();
        panic!("a failing test");
    });
    assert!(result.is_err());
    let panicked = seen.into_inner().unwrap();
    assert!(panicked.starts_with(std::env::temp_dir()));
    assert!(!panicked.exists());
}

fn write_discovery(profile: &Path, port: u16, mode: u32) {
    write_discovery_text(
        profile,
        &format!(r#"{{"protocol":1,"port":{port},"token":"{TOKEN}","pid":1}}"#),
        mode,
    );
}

fn write_discovery_text(profile: &Path, text: &str, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let path = profile.join("vimma-control.json");
    fs::write(&path, text).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
}

/// A protocol 2 discovery file serving `roles` (docs/specs/vimma-mcp.md, decision 2).
fn write_discovery_v2(profile: &Path, port: u16, roles: &str) {
    write_discovery_text(
        profile,
        &format!(r#"{{"protocol":2,"port":{port},"token":"{TOKEN}","pid":1,"roles":{roles}}}"#),
        0o600,
    );
}

/// One accepted connection: the lines it read, in order.
struct Server {
    profile: TempDir,
    handle: JoinHandle<Vec<String>>,
}

impl Server {
    /// Start a fake server; `script` gets each line read and returns the lines to answer with,
    /// or `None` to stop reading (and close).
    fn start(mut script: impl FnMut(usize, &str) -> Option<Vec<String>> + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let profile = temp_profile();
        write_discovery(&profile, listener.local_addr().unwrap().port(), 0o600);
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            let mut seen = Vec::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let line = line.trim_end().to_string();
                let reply = script(seen.len(), &line);
                seen.push(line);
                let Some(reply) = reply else { break };
                for out in reply {
                    if writer.write_all(format!("{out}\n").as_bytes()).is_err() {
                        break;
                    }
                }
            }
            seen
        });
        Self { profile, handle }
    }

    /// A server that completes the real handshake (challenge for the hello, welcome for the
    /// right token), then hands request lines to `script` numbered from 0.
    fn authed(mut script: impl FnMut(usize, &str) -> Option<Vec<String>> + Send + 'static) -> Self {
        Self::start(move |n, line| match n {
            0 => Some(vec![challenge(line)]),
            1 => {
                assert_eq!(line, format!(r#"{{"token":"{TOKEN}","type":"auth"}}"#));
                Some(vec![WELCOME.into()])
            }
            _ => script(n - 2, line),
        })
    }

    /// A well-behaved server: handshake, then `response` (with `"id":1`) to the first request.
    fn answering(response: &'static str) -> Self {
        Self::authed(move |n, _| match n {
            0 => Some(vec![response.into()]),
            _ => None,
        })
    }

    fn lines(self) -> Vec<String> {
        self.handle.join().unwrap()
    }
}

fn vimma_ctl(profile: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_vimma-ctl"))
        .arg("--profile")
        .arg(profile)
        .args(args)
        .env_remove("VIMMA_PROFILE")
        .output()
        .unwrap()
}

fn stdout(o: &Output) -> String {
    String::from_utf8(o.stdout.clone()).unwrap()
}

fn stderr(o: &Output) -> String {
    String::from_utf8(o.stderr.clone()).unwrap()
}

#[test]
fn authenticates_and_sends_keys() {
    let server = Server::answering(r#"{"type":"response","id":1,"ok":true,"result":{"sent":2}}"#);
    let out = vimma_ctl(&server.profile, &["send-keys", "ctrl+b", "c"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(stdout(&out), "");
    let lines = server.lines();
    let nonce = nonce_of(&lines[0]);
    assert!(
        nonce.len() == 64
            && nonce
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "nonce is 64 lowercase hex: {nonce}"
    );
    assert_eq!(
        lines[0],
        format!(r#"{{"nonce":"{nonce}","protocol":1,"type":"hello"}}"#),
        "the hello carries no token"
    );
    assert_eq!(lines[1], format!(r#"{{"token":"{TOKEN}","type":"auth"}}"#));
    assert_eq!(
        lines[2],
        r#"{"args":{"keys":"ctrl+b c"},"command":"send-keys","id":1,"type":"request"}"#
    );
}

#[test]
fn reports_a_refused_token_with_exit_4() {
    let server = Server::start(|n, line| {
        match n {
        0 => Some(vec![challenge(line)]),
        _ => Some(vec![
            r#"{"type":"response","id":null,"ok":false,"error":{"code":"unauthorized","message":"bad token"}}"#
                .into(),
        ]),
    }
    });
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: authentication failed: unauthorized: bad token\n"
    );
    assert_eq!(server.lines().len(), 2, "no request after a refused token");
}

#[test]
fn prints_state_for_people() {
    let server = Server::answering(
        r#"{"type":"response","id":1,"ok":true,"result":{"mode":"normal","pending":null,"workspace":null,"tabs":[{"id":"12","url":"https://example.com/","title":"Example","selected":true}],"panes":null}}"#,
    );
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(
        stdout(&out),
        "mode: normal\npending: -\nworkspace: -\ntabs: 1\n* 12  Example  https://example.com/\n"
    );
    assert_eq!(
        server.lines()[2],
        r#"{"args":{},"command":"state","id":1,"type":"request"}"#
    );
}

#[test]
fn prints_state_as_json() {
    let server = Server::answering(
        r#"{"type":"response","id":1,"ok":true,"result":{"mode":"insert","pending":null,"workspace":"work","tabs":[],"panes":null,"later":true}}"#,
    );
    let out = vimma_ctl(&server.profile, &["state", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(
        stdout(&out),
        "{\"later\":true,\"mode\":\"insert\",\"panes\":null,\"pending\":null,\"tabs\":[],\"workspace\":\"work\"}\n"
    );
    drop(server.lines());
}

#[test]
fn opens_a_url_and_prints_the_tab() {
    let server = Server::answering(r#"{"type":"response","id":1,"ok":true,"result":{"tab":"14"}}"#);
    let out = vimma_ctl(&server.profile, &["open", "https://example.com/"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(stdout(&out), "14\n");
    assert_eq!(
        server.lines()[2],
        r#"{"args":{"url":"https://example.com/","where":"tab"},"command":"open","id":1,"type":"request"}"#
    );
}

#[test]
fn reloads_the_theme_and_says_whether_it_changed() {
    for (changed, printed) in [("true", "changed\n"), ("false", "unchanged\n")] {
        let response =
            format!(r#"{{"type":"response","id":1,"ok":true,"result":{{"changed":{changed}}}}}"#);
        let server = Server::authed(move |n, _| match n {
            0 => Some(vec![response.clone()]),
            _ => None,
        });
        let out = vimma_ctl(&server.profile, &["reload-theme"]);
        assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
        assert_eq!(stdout(&out), printed);
        assert_eq!(
            server.lines()[2],
            r#"{"args":{},"command":"reload-theme","id":1,"type":"request"}"#
        );
    }
}

#[test]
fn reports_a_server_error_with_exit_1() {
    let server = Server::answering(
        r#"{"type":"response","id":1,"ok":false,"error":{"code":"invalid-args","message":"url scheme must be http, https, file or about"}}"#,
    );
    let out = vimma_ctl(&server.profile, &["open", "javascript:alert(1)"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: invalid-args: url scheme must be http, https, file or about\n"
    );
    drop(server.lines());
}

#[test]
fn rejects_malformed_responses_with_exit_5() {
    for (bad, expected) in [
        ("this is not json", "not valid JSON"),
        (
            r#"{"type":"response","id":2,"ok":true,"result":{"sent":1}}"#,
            "expected id 1, got 2",
        ),
        (
            r#"{"type":"response","id":1,"ok":true,"result":{"sent":"1"}}"#,
            "result.sent",
        ),
        (
            r#"{"type":"response","id":1,"ok":false,"error":{"code":"nope","message":"x"}}"#,
            "error.code",
        ),
    ] {
        let server = Server::answering(bad);
        let out = vimma_ctl(&server.profile, &["send-keys", "j"]);
        assert_eq!(out.status.code(), Some(5), "{bad}: {}", stderr(&out));
        let err = stderr(&out);
        assert!(err.starts_with("vimma-ctl: protocol error: "), "{err}");
        assert!(err.contains(expected), "{bad}: {err}");
        drop(server.lines());
    }
}

#[test]
fn rejects_a_malformed_welcome_and_an_early_close() {
    let server = Server::start(|_, _| Some(vec![r#"{"type":"welcome","protocol":"1"}"#.into()]));
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    drop(server.lines());

    let server = Server::start(|_, _| None);
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("connection closed"),
        "{}",
        stderr(&out)
    );
    drop(server.lines());
}

#[test]
fn rejects_an_oversized_line() {
    let server = Server::start(|_, _| Some(vec!["x".repeat(1024 * 1024 + 1)]));
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert!(stderr(&out).contains("longer than"), "{}", stderr(&out));
    drop(server.lines());
}

#[test]
fn times_out_when_the_server_is_silent() {
    let server = Server::start(|_, _| Some(vec![]));
    let started = Instant::now();
    let out = vimma_ctl(&server.profile, &["--timeout", "0.5", "state"]);
    let elapsed = started.elapsed();
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: protocol error: no reply within 0.5 s\n"
    );
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    drop(server.lines());
}

#[test]
fn times_out_after_the_handshake_too() {
    let server = Server::authed(|_, _| Some(vec![]));
    let out = vimma_ctl(&server.profile, &["--timeout", "0.5", "state"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert!(stderr(&out).contains("no reply within 0.5 s"));
    drop(server.lines());
}

#[test]
fn reports_an_absent_server_with_exit_3() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let profile = temp_profile();
    write_discovery(&profile, port, 0o600);
    let out = vimma_ctl(&profile, &["state"]);
    assert_eq!(out.status.code(), Some(3));
    let err = stderr(&out);
    assert!(
        err.starts_with(&format!(
            "vimma-ctl: Vimma is not running (or the control socket is off): cannot connect to 127.0.0.1:{port}"
        )),
        "{err}"
    );
    assert!(err.contains("stale"), "{err}");
}

#[test]
fn reports_a_missing_discovery_file_with_exit_3() {
    let profile = temp_profile();
    let out = vimma_ctl(&profile, &["state"]);
    assert_eq!(out.status.code(), Some(3));
    let err = stderr(&out);
    assert!(err.contains("vimma-control.json"), "{err}");
    assert!(err.contains("vimma.control.enabled"), "{err}");
}

#[test]
fn refuses_an_insecure_discovery_file() {
    let profile = temp_profile();
    write_discovery(&profile, 1, 0o640);
    let out = vimma_ctl(&profile, &["state"]);
    assert_eq!(out.status.code(), Some(3));
    assert!(stderr(&out).contains("chmod 600"), "{}", stderr(&out));
}

#[test]
fn finds_the_default_profile_through_profiles_ini() {
    let server = Server::answering(r#"{"type":"response","id":1,"ok":true,"result":{"sent":1}}"#);
    let config = temp_profile();
    // Where Firefox puts profiles.ini; XDG_CONFIG_HOME, set below, moves it on Linux only.
    let root = if cfg!(target_os = "macos") {
        config.join("Library/Application Support/Vimma")
    } else {
        config.join("vimma/vimma")
    };
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("profiles.ini"),
        format!(
            "[InstallABC]\nDefault={}\n\n[Profile0]\nName=default\nIsRelative=1\nPath=other\nDefault=1\n",
            server.profile.display()
        ),
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_vimma-ctl"))
        .args(["send-keys", "j"])
        .env("XDG_CONFIG_HOME", config.as_os_str())
        .env("HOME", config.as_os_str())
        .env_remove("VIMMA_PROFILE")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    drop(server.lines());
}

#[test]
fn rejects_a_huge_timeout_without_panicking() {
    let out = vimma_ctl(Path::new("/nonexistent"), &["--timeout", "1e19", "state"]);
    assert_eq!(out.status.code(), Some(2), "{}", stderr(&out));
    assert!(
        stderr(&out).starts_with("vimma-ctl: --timeout must be at most 3600 seconds\n"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn reports_a_busy_server_with_exit_3() {
    let server = Server::start(|_, _| {
        Some(vec![
            r#"{"type":"response","id":null,"ok":false,"error":{"code":"busy","message":"8 connections open"}}"#
                .into(),
        ])
    });
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: Vimma's control socket is busy (busy: 8 connections open); try again\n"
    );
    drop(server.lines());
}

#[test]
fn reports_a_drop_after_the_handshake_with_exit_5() {
    // The server's idle timeout or connection cap closing an authenticated connection.
    let server = Server::authed(|_, _| None);
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: protocol error: connection closed before a complete reply\n"
    );
    drop(server.lines());
}

#[test]
fn usage_errors_exit_2() {
    let out = vimma_ctl(Path::new("/nonexistent"), &["frobnicate"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr(&out).starts_with("vimma-ctl: unknown command \"frobnicate\"\n"));
}

#[test]
fn the_fake_server_speaks_on_loopback_only() {
    // Guard for the tests themselves: the client must dial 127.0.0.1, which this connects to.
    let server = Server::start(|_, _| None);
    let port = fs::read_to_string(server.profile.join("vimma-control.json")).unwrap();
    assert!(port.contains("\"port\":"));
    let addr = format!(
        "127.0.0.1:{}",
        port.split("\"port\":")
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap()
    );
    drop(TcpStream::connect(addr).unwrap());
    drop(server.lines());
}

#[test]
fn a_fresh_nonce_per_connection() {
    let first = Server::answering(r#"{"type":"response","id":1,"ok":true,"result":{"sent":1}}"#);
    let second = Server::answering(r#"{"type":"response","id":1,"ok":true,"result":{"sent":1}}"#);
    assert_eq!(
        vimma_ctl(&first.profile, &["send-keys", "j"]).status.code(),
        Some(0)
    );
    assert_eq!(
        vimma_ctl(&second.profile, &["send-keys", "j"])
            .status
            .code(),
        Some(0)
    );
    assert_ne!(first.lines()[0], second.lines()[0], "nonces differ");
}

/// A squatter that bound a stale discovery file's port: it answers the
/// challenge with an HMAC keyed by whatever token it has seen so far (none: the hello has no
/// token), then accepts anything. vimma-ctl must send it nothing after the hello.
#[test]
fn a_squatter_gets_neither_the_token_nor_a_command() {
    let server = Server::start(|_, line| {
        let seen = vimma_ctl::json::parse(line).ok();
        let token = match seen.as_ref().and_then(|v| v.get("token")) {
            Some(vimma_ctl::json::Value::String(t)) => t.clone(),
            _ => "0".repeat(64),
        };
        Some(vec![
            challenge_with_key(line, &token),
            WELCOME.into(),
            r#"{"type":"response","id":1,"ok":true,"result":{"sent":1}}"#.into(),
        ])
    });
    let out = vimma_ctl(&server.profile, &["send-keys", "h u n t e r 2 enter"]);
    assert_eq!(out.status.code(), Some(4), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("did not prove it knows the token"),
        "{}",
        stderr(&out)
    );
    let lines = server.lines();
    assert_eq!(lines.len(), 1, "only the hello: {lines:?}");
    assert!(
        !lines[0].contains(TOKEN),
        "the hello does not carry the token"
    );
}

#[test]
fn a_server_that_never_answers_the_challenge_times_out_cleanly() {
    let server = Server::start(|_, _| Some(vec![]));
    let out = vimma_ctl(&server.profile, &["--timeout", "0.5", "send-keys", "j"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: protocol error: no reply within 0.5 s\n"
    );
    let lines = server.lines();
    assert_eq!(lines.len(), 1, "only the hello");
    assert!(!lines[0].contains(TOKEN));
}

#[test]
fn refuses_a_welcome_in_place_of_the_challenge() {
    let server = Server::start(|_, _| Some(vec![WELCOME.into()]));
    let out = vimma_ctl(&server.profile, &["send-keys", "secret"]);
    assert_ne!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(server.lines().len(), 1, "nothing sent after the hello");
}

#[test]
fn reports_a_discovery_file_whose_process_has_exited() {
    let profile = temp_profile();
    let path = profile.join("vimma-control.json");
    fs::write(
        &path,
        format!(r#"{{"protocol":1,"port":4000,"token":"{TOKEN}","pid":999999999}}"#),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let out = vimma_ctl(&profile, &["state"]);
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("pid 999999999") && stderr(&out).contains("stale"),
        "{}",
        stderr(&out)
    );
}

// Protocol 2 (docs/specs/vimma-mcp.md, decision 2): against a Vimma whose discovery file says 2,
// vimma-ctl's commands use the `full` role; with only MCP on, it says the control socket is off.

#[test]
fn speaks_protocol_2_as_full_against_a_protocol_2_vimma() {
    let server = Server::start(|n, line| match n {
        0 => {
            let proof = vimma_ctl::protocol::challenge_proof(TOKEN, &nonce_of(line));
            Some(vec![format!(
                r#"{{"type":"challenge","protocol":2,"proof":"{proof}"}}"#
            )])
        }
        1 => Some(vec![
            r#"{"type":"welcome","protocol":2,"app":"Vimma","version":"0.1.0","role":"full"}"#
                .into(),
        ]),
        2 => Some(vec![
            r#"{"type":"response","id":1,"ok":true,"result":{"sent":1}}"#.into(),
        ]),
        _ => None,
    });
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["full","agent"]"#);
    let out = vimma_ctl(&server.profile, &["send-keys", "j"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let lines = server.lines();
    let nonce = nonce_of(&lines[0]);
    assert_eq!(
        lines[0],
        format!(r#"{{"nonce":"{nonce}","protocol":2,"role":"full","type":"hello"}}"#)
    );
}

#[test]
fn says_the_control_socket_is_off_when_only_mcp_is_on() {
    let server = Server::start(|_, _| None);
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["agent"]"#);
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("set the pref vimma.control.enabled to true"),
        "{}",
        stderr(&out)
    );
    // Nothing was sent: it did not even connect. Unblock the fake server's accept.
    drop(TcpStream::connect(("127.0.0.1", port)));
    assert_eq!(server.lines(), Vec::<String>::new());
}

#[test]
fn reports_role_off_with_exit_3() {
    let server = Server::start(|_, _| {
        Some(vec![
            r#"{"type":"response","id":null,"ok":false,"error":{"code":"role-off","message":"the control socket is off: set the pref vimma.control.enabled to true"}}"#
                .into(),
        ])
    });
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["full"]"#);
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert_eq!(
        stderr(&out),
        "vimma-ctl: role-off: the control socket is off: set the pref vimma.control.enabled to true\n"
    );
    drop(server.lines());
}

/// A protocol 2 server that holds the welcome back `delay` after the auth, then answers `state`.
fn asking_server(delay: std::time::Duration, after_auth: &'static str) -> Server {
    Server::start(move |n, line| {
        match n {
        0 => {
            let proof = vimma_ctl::protocol::challenge_proof(TOKEN, &nonce_of(line));
            Some(vec![format!(
                r#"{{"type":"challenge","protocol":2,"proof":"{proof}"}}"#
            )])
        }
        1 => {
            thread::sleep(delay);
            Some(vec![after_auth.into()])
        }
        2 => Some(vec![
            r#"{"type":"response","id":1,"ok":true,"result":{"mode":"normal","pending":null,"workspace":"main","tabs":[],"panes":null}}"#
                .into(),
        ]),
        _ => None,
    }
    })
}

const WELCOME_V2: &str =
    r#"{"type":"welcome","protocol":2,"app":"Vimma","version":"0.1.0","role":"full"}"#;

// docs/specs/vimma-mcp.md decision 29 C: while MCP is on, Vimma asks before it welcomes a full
// connection; vimma-ctl waits for that answer past its own --timeout, and says so.
#[test]
fn waits_for_the_users_answer_while_mcp_is_on() {
    let server = asking_server(std::time::Duration::from_millis(2500), WELCOME_V2);
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["agent","full"]"#);
    let out = vimma_ctl(&server.profile, &["--timeout", "1", "state", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("MCP is on: answer y in Vimma to let this vimma-ctl in"),
        "{}",
        stderr(&out)
    );
    drop(server.lines());
}

// docs/security.md S13: while MCP is on, vimma-ctl prints a code and sends it in its auth, and
// Vimma's question shows it, so the user answers for the vimma-ctl they ran.
#[test]
fn prints_and_sends_a_code_while_mcp_is_on() {
    let server = asking_server(std::time::Duration::ZERO, WELCOME_V2);
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["agent","full"]"#);
    let out = vimma_ctl(&server.profile, &["state", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let err = stderr(&out);
    let code = err
        .split("code ")
        .nth(1)
        .map(|rest| rest.chars().take(4).collect::<String>())
        .unwrap_or_default();
    assert!(
        code.len() == 4
            && code
                .chars()
                .all(|c| matches!(c, '2'..='9' | 'A'..='H' | 'J'..='N' | 'P'..='Z')),
        "{err}"
    );
    assert!(err.contains("answer y only if it shows"), "{err}");
    let lines = server.lines();
    assert_eq!(
        lines[1],
        format!(r#"{{"code":"{code}","token":"{TOKEN}","type":"auth"}}"#)
    );
}

#[test]
fn sends_no_code_while_mcp_is_off() {
    let server = asking_server(std::time::Duration::ZERO, WELCOME_V2);
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["full"]"#);
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(!stderr(&out).contains("code"), "{}", stderr(&out));
    let lines = server.lines();
    assert_eq!(lines[1], format!(r#"{{"token":"{TOKEN}","type":"auth"}}"#));
}

#[test]
fn keeps_its_timeout_for_the_welcome_while_mcp_is_off() {
    let server = asking_server(std::time::Duration::from_millis(2500), WELCOME_V2);
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["full"]"#);
    let out = vimma_ctl(&server.profile, &["--timeout", "1", "state"]);
    assert_eq!(out.status.code(), Some(5), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("no reply within 1 s"),
        "{}",
        stderr(&out)
    );
    assert!(!stderr(&out).contains("answer y"), "{}", stderr(&out));
    drop(server.lines());
}

#[test]
fn reports_refused_full_control_with_exit_4() {
    let server = asking_server(
        std::time::Duration::ZERO,
        r#"{"type":"response","id":null,"ok":false,"error":{"code":"denied","message":"the user refused full control in Vimma","reason":"user"}}"#,
    );
    let port = read_port(&server.profile);
    write_discovery_v2(&server.profile, port, r#"["agent","full"]"#);
    let out = vimma_ctl(&server.profile, &["state"]);
    assert_eq!(out.status.code(), Some(4), "{}", stderr(&out));
    assert!(
        stderr(&out).ends_with(
            "vimma-ctl: full control refused: the user refused full control in Vimma (user)\n"
        ),
        "{}",
        stderr(&out)
    );
    drop(server.lines());
}

/// The port the fake server's discovery file names.
fn read_port(profile: &Path) -> u16 {
    let text = fs::read_to_string(profile.join("vimma-control.json")).unwrap();
    let value = vimma_ctl::json::parse(&text).unwrap();
    u16::try_from(
        value
            .get("port")
            .and_then(vimma_ctl::json::Value::as_u64)
            .unwrap(),
    )
    .unwrap()
}
