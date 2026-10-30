/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `vimma-ctl mcp`'s I/O (docs/specs/vimma-mcp.md, decision 1): MCP over stdin and stdout, and
//! one control-socket connection as the `agent` role, opened at the first tool call and kept
//! for the process's life with `agent-ping`. Only MCP messages go to stdout; logs go to stderr.
//!
//! Three threads: stdin's reader, the connection's reader, and this loop, which owns all state
//! and does every write. Vimma answers an agent's requests by id, in any order (decision 17),
//! so several tool calls can wait for the user at once.

use crate::client::{self, Client, read_message};
use crate::json::Value;
use crate::mcp::{self, Action, Call, Failure, MAX_INPUT_LINE, Protocol, tool_result};
use crate::protocol::{self, Discovery, ErrorBody, Response, Role};
use crate::version;
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

/// Timers and limits of the serve loop, and how it reaches Vimma. Tests shorten the timers.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Run by Vimma for a task, with a one-time ticket (docs/specs/builtin-agent-cli.md C3): a
    /// connection that fails means the task ended, never that MCP should be turned on.
    pub ticket: bool,
    /// An `agent-ping` after this long without a request: Vimma closes an agent connection
    /// after 60 s without a line, and its grants with it.
    pub ping_every: Duration,
    /// How long a call may wait for Vimma's answer: the longest `[mcp] ask_timeout` (300 s), a
    /// lazy tab's load (20 s) and the longest `vimma_keys` run (60 s, mcp-drive D15), plus 10 s
    /// (decision 4). Vimma itself denies at its own ask timeout first.
    pub answer_wait: Duration,
    /// Connecting and the handshake, and each write to the socket.
    pub connect_timeout: Duration,
    /// Calls waiting at once; Vimma takes 4 per connection, so more only wait here.
    pub max_pending: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ticket: false,
            ping_every: Duration::from_secs(30),
            answer_wait: Duration::from_secs(390),
            connect_timeout: Duration::from_secs(5),
            max_pending: 16,
        }
    }
}

/// What the loop waits on.
enum Event {
    /// A line from stdin, without its newline.
    Line(Vec<u8>),
    /// A line longer than [`MAX_INPUT_LINE`], dropped unread.
    TooLong,
    /// stdin closed: the client is done (MCP stdio, "Shutdown").
    Eof,
    /// A message from connection `generation`, or why it ended.
    Vimma {
        generation: u64,
        message: Result<Value, client::Error>,
    },
}

/// The open connection to Vimma.
struct Link {
    generation: u64,
    writer: TcpStream,
    next_id: u32,
    last_sent: Instant,
}

/// A tool call Vimma has not answered yet.
struct Pending {
    call: Call,
    sent: Instant,
    deadline: Instant,
}

/// Serve MCP on `input` and `output` until `input` ends; the exit code. `find` reads the
/// discovery file, the only source of the token. `via` is the parent process's name, a label
/// for Vimma's question.
pub fn serve(
    input: Box<dyn Read + Send>,
    output: &mut dyn Write,
    find: &dyn Fn() -> Result<Discovery, String>,
    via: Option<String>,
    settings: &Settings,
) -> i32 {
    let (tx, rx) = mpsc::channel();
    let input_tx = tx.clone();
    std::thread::spawn(move || read_input(input, &input_tx));
    let mut protocol = Protocol::new();
    // The discovery file names Vimma's version, so the instructions can say at once that this
    // client is older (docs/specs/ship-vimma-ctl.md, behaviour 5). Not running yet: no note.
    if let Ok(discovery) = find() {
        protocol.set_note(discovery.version.as_deref().and_then(version::older_note));
    }
    let mut server = Server {
        protocol,
        output,
        find,
        via,
        settings,
        tx,
        link: None,
        generations: 0,
        pending: BTreeMap::new(),
        note: None,
        noted: None,
        session: client::random_nonce().ok(),
    };
    let code = loop {
        let wait = server.next_wake(Instant::now());
        let event = match rx.recv_timeout(wait) {
            Ok(event) => Some(event),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break 0,
        };
        let step = match event {
            Some(Event::Eof) => break 0,
            Some(Event::Line(bytes)) => server.on_line(&bytes),
            Some(Event::TooLong) => server.write(&mcp::too_long()),
            Some(Event::Vimma {
                generation,
                message,
            }) => server.on_vimma(generation, message),
            None => Ok(()),
        };
        if let Err(e) = step.and_then(|()| server.tick(Instant::now())) {
            log(&format!("cannot write to stdout ({e}); exiting"));
            break 1;
        }
    };
    server.close_link();
    code
}

fn log(message: &str) {
    eprintln!("vimma-ctl mcp: {message}");
}

/// stdin, line by line; a line over the limit is skipped to its end without being kept.
fn read_input(input: Box<dyn Read + Send>, tx: &Sender<Event>) {
    let mut reader = BufReader::with_capacity(64 * 1024, input);
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let buffer = match reader.fill_buf() {
            Ok(buffer) => buffer,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if buffer.is_empty() {
            if too_long {
                let _ = tx.send(Event::TooLong);
            } else if !line.is_empty() {
                let _ = tx.send(Event::Line(std::mem::take(&mut line)));
            }
            break;
        }
        let (chunk, done) = match buffer.iter().position(|b| *b == b'\n') {
            Some(end) => (&buffer[..end], true),
            None => (buffer, false),
        };
        if !too_long {
            line.extend_from_slice(chunk);
            if line.len() > MAX_INPUT_LINE + 1 {
                too_long = true;
                line = Vec::new();
            }
        }
        let used = chunk.len() + usize::from(done);
        reader.consume(used);
        if done {
            let event = if too_long || line.len() > MAX_INPUT_LINE {
                line.clear();
                Event::TooLong
            } else {
                Event::Line(std::mem::take(&mut line))
            };
            too_long = false;
            if tx.send(event).is_err() {
                return;
            }
        }
    }
    let _ = tx.send(Event::Eof);
}

/// Connection `generation`'s messages, until it ends.
fn read_vimma(mut reader: BufReader<TcpStream>, generation: u64, tx: &Sender<Event>) {
    loop {
        let message = read_message(&mut reader);
        let end = message.is_err();
        if tx
            .send(Event::Vimma {
                generation,
                message,
            })
            .is_err()
            || end
        {
            return;
        }
    }
}

struct Server<'a> {
    protocol: Protocol,
    output: &'a mut dyn Write,
    find: &'a dyn Fn() -> Result<Discovery, String>,
    via: Option<String>,
    settings: &'a Settings,
    tx: Sender<Event>,
    link: Option<Link>,
    generations: u64,
    /// By control-protocol request id.
    pending: BTreeMap<u32, Pending>,
    /// That this client is older than the Vimma it connected to, for the next tool result.
    note: Option<String>,
    /// The Vimma version a note was given for: once per version, not per connection.
    noted: Option<String>,
    /// This process's id in every `agent-hello`, so a reconnect keeps the grant the dropped
    /// link held (docs/specs/mcp-session-grants.md S3, S4); `None` without random bytes, when
    /// a reconnect simply asks again.
    session: Option<String>,
}

impl Server<'_> {
    fn write(&mut self, message: &Value) -> io::Result<()> {
        // The printer escapes every control character: one message, one line.
        self.output.write_all(format!("{message}\n").as_bytes())?;
        self.output.flush()
    }

    fn on_line(&mut self, bytes: &[u8]) -> io::Result<()> {
        let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
        let Ok(line) = std::str::from_utf8(bytes) else {
            return self.write(&mcp::parse_error());
        };
        if line.trim().is_empty() {
            return Ok(());
        }
        match self.protocol.handle_line(line) {
            Action::None => Ok(()),
            Action::Reply(reply) => self.write(&reply),
            Action::Call(call) => self.start(call),
            Action::Cancel(id) => {
                self.cancel(&id);
                Ok(())
            }
        }
    }

    fn start(&mut self, call: Call) -> io::Result<()> {
        if self.pending.len() >= self.settings.max_pending {
            return self.write(&tool_result(&call, Err(&Failure::TooMany)));
        }
        let (command, args) = call.tool.command();
        // A connection that died since the last call is noticed here at the latest: one retry
        // on a fresh connection.
        let mut sent = None;
        for _ in 0..2 {
            if self.link.is_none() {
                if let Err(failure) = self.connect() {
                    return self.write(&tool_result(&call, Err(&failure)));
                }
            }
            match self.send(command, args.clone()) {
                Ok(id) => {
                    sent = Some(id);
                    break;
                }
                Err(()) => self.drop_link("a write failed")?,
            }
        }
        let Some(id) = sent else {
            return self.write(&tool_result(&call, Err(&Failure::Dropped)));
        };
        let now = Instant::now();
        let deadline = now
            .checked_add(self.settings.answer_wait)
            .unwrap_or(now + Duration::from_secs(390));
        self.pending.insert(
            id,
            Pending {
                call,
                sent: now,
                deadline,
            },
        );
        Ok(())
    }

    /// Open the agent connection: the discovery file's token, the agent role, `agent-hello`.
    fn connect(&mut self) -> Result<(), Failure> {
        let ticket = self.settings.ticket;
        let ended = |failure: Failure| match failure {
            Failure::NotRunning(detail) if ticket => Failure::TaskEnded(detail),
            other => other,
        };
        let discovery = (self.find)().map_err(|e| ended(Failure::NotRunning(e)))?;
        let mut client = Client::connect_as(&discovery, self.settings.connect_timeout, Role::Agent)
            .map_err(|e| ended(failure_of(e, Duration::ZERO)))?;
        let label = self.protocol.client();
        let mut info = BTreeMap::from([(
            "name".to_string(),
            Value::String(
                label
                    .map(|l| l.name.clone())
                    .or_else(|| self.via.clone())
                    .unwrap_or_else(|| "an agent".to_string()),
            ),
        )]);
        if let Some(version) = label.and_then(|l| l.version.clone()) {
            info.insert("version".into(), Value::String(version));
        }
        let mut args = BTreeMap::from([
            ("client".to_string(), Value::Object(info)),
            (
                "ctl".to_string(),
                Value::String(version::VERSION.to_string()),
            ),
        ]);
        if let Some(via) = &self.via {
            args.insert("via".into(), Value::String(via.clone()));
        }
        if let Some(session) = &self.session {
            args.insert("session".into(), Value::String(session.clone()));
        }
        client
            .call_value("agent-hello", &Value::Object(args))
            .map_err(|e| failure_of(e, Duration::ZERO))?;
        let vimma = client.vimma_version().to_string();
        if self.noted.as_deref() != Some(vimma.as_str()) {
            self.note = version::older_note(&vimma);
            if self.note.is_some() {
                log(&format!(
                    "this vimma-ctl ({}) is older than Vimma ({vimma})",
                    version::VERSION
                ));
                self.noted = Some(vimma);
            }
        }
        let (reader, writer, next_id) = client
            .into_parts()
            .map_err(|e| Failure::Protocol(format!("cannot keep the connection: {e}")))?;
        self.generations += 1;
        let generation = self.generations;
        let tx = self.tx.clone();
        std::thread::spawn(move || read_vimma(reader, generation, &tx));
        self.link = Some(Link {
            generation,
            writer,
            next_id,
            last_sent: Instant::now(),
        });
        if discovery.ticket {
            log("connected to Vimma as the agent role, for the task that started this agent");
        } else {
            log(&format!(
                "connected to Vimma (pid {}) as the agent role",
                discovery.pid
            ));
        }
        Ok(())
    }

    /// Send an agent command; its request id.
    fn send(&mut self, command: &str, args: Value) -> Result<u32, ()> {
        let timeout = self.settings.connect_timeout;
        let link = self.link.as_mut().ok_or(())?;
        let id = link.next_id;
        link.next_id = link.next_id.checked_add(1).unwrap_or(1);
        let request = format!("{}\n", protocol::request_named(id, command, args));
        link.writer
            .set_write_timeout(Some(timeout))
            .and_then(|()| link.writer.write_all(request.as_bytes()))
            .map_err(|_| ())?;
        link.last_sent = Instant::now();
        Ok(id)
    }

    /// The connection is gone: every waiting call fails, and the next one connects again.
    fn drop_link(&mut self, why: &str) -> io::Result<()> {
        self.close_link();
        log(&format!("the connection to Vimma closed ({why})"));
        for (_, pending) in std::mem::take(&mut self.pending) {
            self.write(&tool_result(&pending.call, Err(&Failure::Dropped)))?;
        }
        Ok(())
    }

    fn close_link(&mut self) {
        if let Some(link) = self.link.take() {
            let _ = link.writer.shutdown(Shutdown::Both);
        }
    }

    fn on_vimma(
        &mut self,
        generation: u64,
        message: Result<Value, client::Error>,
    ) -> io::Result<()> {
        if self.link.as_ref().map(|l| l.generation) != Some(generation) {
            return Ok(());
        }
        let message = match message {
            Ok(message) => message,
            Err(e) => return self.drop_link(&e.to_string()),
        };
        let response = match protocol::decode_response(&message) {
            Ok(response) => response,
            Err(e) => {
                // Vimma broke the protocol: nothing it says on this connection can be trusted.
                let why = format!("Vimma sent a malformed response: {e}");
                self.close_link();
                log(&why);
                for (_, pending) in std::mem::take(&mut self.pending) {
                    let failure = Failure::Protocol(why.clone());
                    self.write(&tool_result(&pending.call, Err(&failure)))?;
                }
                return Ok(());
            }
        };
        let (id, outcome) = match response {
            Response::Ok { id, result } => (id, Ok(result)),
            Response::Err { id, error } => (id, Err(error)),
        };
        // A ping's, a withdrawal's or a cancelled call's answer: nothing waits for it.
        let Some(pending) = id
            .and_then(|id| u32::try_from(id).ok())
            .and_then(|id| self.pending.remove(&id))
        else {
            if let (None, Err(error)) = (id, &outcome) {
                log(&format!("Vimma: {}: {}", error.code, error.message));
            }
            return Ok(());
        };
        let reply = match outcome {
            Ok(result) => tool_result(&pending.call, Ok(&result)),
            Err(error) => {
                let failure = failure_of(client::Error::Server(error), pending.sent.elapsed());
                tool_result(&pending.call, Err(&failure))
            }
        };
        let reply = match self.note.take() {
            Some(note) => mcp::with_note(reply, &note),
            None => reply,
        };
        self.write(&reply)
    }

    /// `notifications/cancelled`: no response for the call, and its question is withdrawn.
    fn cancel(&mut self, mcp_id: &Value) {
        let Some(id) = self
            .pending
            .iter()
            .find(|(_, p)| &p.call.id == mcp_id)
            .map(|(id, _)| *id)
        else {
            return;
        };
        self.pending.remove(&id);
        self.withdraw(id);
    }

    /// `agent-cancel`: Vimma takes the question off the line if it still waits (decision 17).
    fn withdraw(&mut self, id: u32) {
        let args = Value::Object(BTreeMap::from([(
            "id".to_string(),
            Value::Number(f64::from(id)),
        )]));
        if self.send("agent-cancel", args).is_err() {
            self.close_link();
        }
    }

    /// Deadlines and the keep-alive.
    fn tick(&mut self, now: Instant) -> io::Result<()> {
        let expired: Vec<u32> = self
            .pending
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            if let Some(pending) = self.pending.remove(&id) {
                let failure = Failure::NoAnswer(self.settings.answer_wait);
                self.write(&tool_result(&pending.call, Err(&failure)))?;
                self.withdraw(id);
            }
        }
        let due = self
            .link
            .as_ref()
            .is_some_and(|l| now.duration_since(l.last_sent) >= self.settings.ping_every);
        if due
            && self
                .send("agent-ping", Value::Object(BTreeMap::new()))
                .is_err()
        {
            self.drop_link("a keep-alive failed")?;
        }
        Ok(())
    }

    /// How long the loop may sleep: until the next ping or deadline, at most a second.
    fn next_wake(&self, now: Instant) -> Duration {
        let mut wake = Duration::from_secs(1);
        if let Some(link) = &self.link {
            let ping = (link.last_sent + self.settings.ping_every).saturating_duration_since(now);
            wake = wake.min(ping);
        }
        for pending in self.pending.values() {
            wake = wake.min(pending.deadline.saturating_duration_since(now));
        }
        wake.max(Duration::from_millis(5))
    }
}

/// A client error as the model's tool error (decision 5).
fn failure_of(e: client::Error, waited: Duration) -> Failure {
    match e {
        client::Error::NotRunning(message) | client::Error::Impostor(message) => {
            Failure::NotRunning(message)
        }
        client::Error::RoleOff(_) => Failure::McpOff,
        client::Error::TooOld(protocol) => Failure::TooOld(protocol),
        client::Error::Busy(_) => Failure::Busy,
        client::Error::Server(ErrorBody {
            code,
            message,
            reason,
            retry_after,
        })
        | client::Error::Auth(ErrorBody {
            code,
            message,
            reason,
            retry_after,
        })
        | client::Error::Denied(ErrorBody {
            code,
            message,
            reason,
            retry_after,
        }) => match (code.as_str(), reason, retry_after) {
            // A used-up rate, not questions waiting (issue #592).
            ("denied", Some(reason), Some(retry_after)) if reason == "busy" => {
                Failure::RateLimited {
                    message,
                    retry_after,
                }
            }
            ("denied", Some(reason), _) => Failure::Denied { reason, waited },
            ("role-off", _, _) => Failure::McpOff,
            ("unsupported-protocol", _, _) => Failure::TooOld(1),
            _ => Failure::Refused { code, message },
        },
        client::Error::Protocol(message) => Failure::Protocol(message),
    }
}

/// The parent process's name, a label for Vimma's question: at most 32 printable characters.
/// Linux reads `/proc/<ppid>/comm`; macOS has no `/proc` and asks `/bin/ps`. Never proof of
/// anything (decision 4).
#[must_use]
pub fn parent_name() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let ppid = std::os::unix::process::parent_id();
        let comm = std::fs::read_to_string(format!("/proc/{ppid}/comm")).ok()?;
        mcp::clean_label(comm.trim_end_matches('\n'), 32)
    }
    #[cfg(target_os = "macos")]
    {
        let ppid = std::os::unix::process::parent_id();
        let output = std::process::Command::new("/bin/ps")
            .args(["-o", "comm=", "-p", &ppid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        name_from_ps(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// `ps -o comm=` on macOS prints the executable's path; the label is its last component.
#[cfg(any(test, target_os = "macos"))]
fn name_from_ps(output: &str) -> Option<String> {
    let path = output.trim_end_matches('\n');
    mcp::clean_label(path.rsplit('/').next()?, 32)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Issue #592: a busy denial with retryAfter is a used-up rate, not questions waiting.
    #[test]
    fn a_busy_denial_with_retry_after_is_a_rate_limit() {
        let denied = |retry_after| {
            client::Error::Denied(ErrorBody {
                code: "denied".into(),
                message: "too many vimma_keys calls".into(),
                reason: Some("busy".into()),
                retry_after,
            })
        };
        let waited = Duration::from_millis(3);
        assert_eq!(
            failure_of(denied(Some(Duration::from_secs(12))), waited),
            Failure::RateLimited {
                message: "too many vimma_keys calls".into(),
                retry_after: Duration::from_secs(12),
            }
        );
        assert_eq!(
            failure_of(denied(None), waited),
            Failure::Denied {
                reason: "busy".into(),
                waited,
            }
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn parent_name_names_the_parent_process() {
        let name = parent_name().expect("the test runner has a name");
        assert!(!name.is_empty() && !name.contains('/'), "{name}");
    }

    #[test]
    fn name_from_ps_keeps_the_executable_name() {
        assert_eq!(
            name_from_ps("/Applications/Claude.app/Contents/MacOS/claude\n"),
            Some("claude".into())
        );
        assert_eq!(name_from_ps("-zsh\n"), Some("-zsh".into()));
        assert_eq!(
            name_from_ps(&format!("/bin/{}\n", "a".repeat(40))),
            Some("a".repeat(32))
        );
        assert_eq!(name_from_ps("/bin/x\u{202e}y\n"), Some("xy".into()));
        assert_eq!(name_from_ps("\n"), None);
        assert_eq!(name_from_ps("/usr/bin/\n"), None);
    }
}
