/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Argument parsing, output and exit codes of `vimma-ctl`.

use crate::client::Client;
pub use crate::client::MAX_TIMEOUT;
use crate::discovery::{Env, find_profile, read_discovery};
use crate::protocol::{Command, CommandResult, PROTOCOL, State, Where};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_NOT_RUNNING: i32 = 3;

/// Default for `--timeout`.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

pub const USAGE: &str = "\
Usage: vimma-ctl [--profile DIR] [--timeout SECS] COMMAND

Commands:
  send-keys KEYS...   send chords in Vimma's key notation, e.g. send-keys ctrl+b c
  state [--json]      print mode, workspace and tabs (--json: the raw result)
  open URL            open an http(s), file or about URL in a new tab
  reload-theme        re-read the Omarchy theme now (prints changed or unchanged)
  mcp                 serve MCP on stdin and stdout for an AI agent tool, through Vimma's
                      agent workspace; every request is confirmed in Vimma (:mcp on first)

Options:
  --profile DIR       the Vimma profile (default: VIMMA_PROFILE, else profiles.ini's default)
  --timeout SECS      give up after SECS seconds (default 5, at most 3600)
  -h, --help          show this help
  -V, --version       show the version

The control socket is off unless the pref vimma.control.enabled is true; MCP is off until
:mcp on in Vimma. --timeout does not apply to mcp, whose calls wait for the user.
Exit codes: 0 ok, 1 command failed, 2 usage, 3 not running, 4 auth failed, 5 protocol error.
";

/// A parsed command line.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub profile: Option<PathBuf>,
    pub timeout: Duration,
    pub command: Command,
    pub json: bool,
}

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Run(Options),
    /// `vimma-ctl mcp`: the MCP server over stdio (docs/specs/vimma-mcp.md, decision 1).
    Mcp {
        profile: Option<PathBuf>,
    },
    Help,
    Version,
}

/// Parse arguments (without the program name).
///
/// # Errors
/// A usage message.
pub fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut profile = None;
    let mut timeout = DEFAULT_TIMEOUT;
    let mut json = false;
    let mut timeout_given = false;
    let mut positional: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = |option: &str| {
            inline
                .clone()
                .or_else(|| iter.next().cloned())
                .ok_or_else(|| format!("{option} needs a value"))
        };
        match name {
            "--" => {
                positional.extend(iter.by_ref().cloned());
                break;
            }
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            "--json" => json = true,
            "--profile" => profile = Some(PathBuf::from(value("--profile")?)),
            "--timeout" => {
                timeout_given = true;
                timeout = value("--timeout")?
                    .parse::<f64>()
                    .ok()
                    .and_then(|secs| Duration::try_from_secs_f64(secs).ok())
                    .filter(|d| !d.is_zero())
                    .ok_or("--timeout needs a positive number of seconds")?;
                if timeout > MAX_TIMEOUT {
                    return Err(format!(
                        "--timeout must be at most {} seconds",
                        MAX_TIMEOUT.as_secs()
                    ));
                }
            }
            option if option.starts_with('-') && option.len() > 1 => {
                return Err(format!("unknown option \"{option}\""));
            }
            _ => positional.push(arg.clone()),
        }
    }
    let Some((name, rest)) = positional.split_first() else {
        return Err("missing command".to_string());
    };
    if name == "mcp" {
        if !rest.is_empty() {
            return Err("mcp takes no arguments".to_string());
        }
        if timeout_given || json {
            return Err(
                "mcp takes no --timeout or --json: each call waits for the user's answer"
                    .to_string(),
            );
        }
        return Ok(Parsed::Mcp { profile });
    }
    let command = match name.as_str() {
        "send-keys" if rest.is_empty() => return Err("send-keys needs KEYS".to_string()),
        "send-keys" => Command::SendKeys {
            keys: rest.join(" "),
        },
        "state" if !rest.is_empty() => return Err("state takes no arguments".to_string()),
        "state" => Command::State,
        "reload-theme" if !rest.is_empty() => {
            return Err("reload-theme takes no arguments".to_string());
        }
        "reload-theme" => Command::ReloadTheme,
        "open" if rest.len() != 1 => return Err("open needs exactly one URL".to_string()),
        "open" => Command::Open {
            url: rest[0].clone(),
            place: Some(Where::Tab),
        },
        other => return Err(format!("unknown command \"{other}\"")),
    };
    if json && command != Command::State {
        return Err("--json applies to state only".to_string());
    }
    Ok(Parsed::Run(Options {
        profile,
        timeout,
        command,
        json,
    }))
}

/// Human-readable `state`.
#[must_use]
pub fn format_state(state: &State) -> String {
    let or_dash = |s: &str| {
        if s.is_empty() {
            "-".to_string()
        } else {
            s.to_string()
        }
    };
    let mut out = format!(
        "mode: {}\npending: {}\nworkspace: {}\ntabs: {}\n",
        state.mode,
        or_dash(state.pending.as_deref().unwrap_or_default()),
        or_dash(state.workspace.as_deref().unwrap_or_default()),
        state.tabs.len()
    );
    out.extend(state.tabs.iter().map(|tab| {
        let mark = if tab.selected { '*' } else { ' ' };
        // A private window withholds them (private-workspace 8d).
        let title = tab
            .title
            .as_deref()
            .map_or_else(|| "(private)".to_string(), or_dash);
        let url = tab.url.as_deref().unwrap_or("(private)");
        format!("{mark} {}  {title}  {url}\n", tab.id)
    }));
    out
}

/// Run `vimma-ctl` and return its exit code.
pub fn run(args: &[String], env: &Env, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    run_with_input(args, env, Box::new(std::io::empty()), out, err)
}

/// [`run`] with stdin, which `vimma-ctl mcp` reads.
pub fn run_with_input(
    args: &[String],
    env: &Env,
    input: Box<dyn std::io::Read + Send>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // Output errors (a closed pipe) cannot be reported anywhere better; the exit code stands.
    let options = match parse_args(args) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Mcp { profile }) => {
            // The token comes from the discovery file only, read again at each connect so a
            // restarted Vimma is found (decision 1). An agent CLI Vimma runs gets a one-time
            // ticket instead, and then the discovery file is never read, so that process never
            // holds the token (docs/specs/builtin-agent-cli.md C3).
            let settings = crate::mcp_serve::Settings {
                ticket: env.agent.is_some(),
                ..crate::mcp_serve::Settings::default()
            };
            let env = env.clone();
            let find = move || match &env.agent {
                Some(agent) => agent.discovery().map_err(|e| e.0),
                None => find_profile(profile.as_deref(), &env)
                    .and_then(|profile| read_discovery(&profile))
                    .map_err(|e| e.0),
            };
            return crate::mcp_serve::serve(
                input,
                out,
                &find,
                crate::mcp_serve::parent_name(),
                &settings,
            );
        }
        Ok(Parsed::Help) => {
            let _ = out.write_all(USAGE.as_bytes());
            return EXIT_OK;
        }
        Ok(Parsed::Version) => {
            let _ = writeln!(
                out,
                "vimma-ctl {} (protocol {PROTOCOL})",
                crate::version::VERSION
            );
            return EXIT_OK;
        }
        Err(message) => {
            let _ = write!(err, "vimma-ctl: {message}\n\n{USAGE}");
            return EXIT_USAGE;
        }
    };
    let discovery =
        find_profile(options.profile.as_deref(), env).and_then(|profile| read_discovery(&profile));
    let discovery = match discovery {
        Ok(discovery) => discovery,
        Err(e) => {
            let _ = writeln!(err, "vimma-ctl: {e}");
            return EXIT_NOT_RUNNING;
        }
    };
    let result = Client::connect(&discovery, options.timeout)
        .and_then(|mut client| client.call(&options.command));
    match result {
        Ok(CommandResult::SendKeys { .. }) => {}
        Ok(CommandResult::Open { tab }) => {
            let _ = writeln!(out, "{tab}");
        }
        Ok(CommandResult::ReloadTheme { changed }) => {
            let _ = writeln!(out, "{}", if changed { "changed" } else { "unchanged" });
        }
        Ok(CommandResult::State(state)) if options.json => {
            let _ = writeln!(out, "{}", state.raw);
        }
        Ok(CommandResult::State(state)) => {
            let _ = out.write_all(format_state(&state).as_bytes());
        }
        Err(e) => {
            let _ = writeln!(err, "vimma-ctl: {e}");
            return e.exit_code();
        }
    }
    EXIT_OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;
    use crate::protocol::{Tab, Where};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn run_opts(list: &[&str]) -> Options {
        match parse_args(&args(list)) {
            Ok(Parsed::Run(options)) => options,
            other => panic!("{list:?}: {other:?}"),
        }
    }

    #[test]
    fn parses_each_command() {
        let o = run_opts(&["send-keys", "ctrl+b", "c"]);
        assert_eq!(
            o.command,
            Command::SendKeys {
                keys: "ctrl+b c".into()
            }
        );
        assert_eq!(o.timeout, DEFAULT_TIMEOUT);
        assert_eq!(o.profile, None);
        assert!(!o.json);
        let o = run_opts(&["state", "--json"]);
        assert_eq!(o.command, Command::State);
        assert!(o.json);
        assert_eq!(run_opts(&["reload-theme"]).command, Command::ReloadTheme);
        let o = run_opts(&["open", "https://example.com/"]);
        assert_eq!(
            o.command,
            Command::Open {
                url: "https://example.com/".into(),
                place: Some(Where::Tab)
            }
        );
    }

    #[test]
    fn options_go_anywhere() {
        let o = run_opts(&["--profile", "/p", "state", "--timeout", "1.5"]);
        assert_eq!(o.profile, Some(PathBuf::from("/p")));
        assert_eq!(o.timeout, Duration::from_millis(1500));
        assert_eq!(
            run_opts(&["state", "--timeout", "3600"]).timeout,
            MAX_TIMEOUT
        );
        let o = run_opts(&["state", "--profile=/q", "--timeout=2"]);
        assert_eq!(o.profile, Some(PathBuf::from("/q")));
        assert_eq!(o.timeout, Duration::from_secs(2));
    }

    #[test]
    fn double_dash_ends_options() {
        let o = run_opts(&["send-keys", "--", "--json"]);
        assert_eq!(
            o.command,
            Command::SendKeys {
                keys: "--json".into()
            }
        );
    }

    #[test]
    fn help_and_version() {
        assert_eq!(parse_args(&args(&["--help"])), Ok(Parsed::Help));
        assert_eq!(parse_args(&args(&["state", "-h"])), Ok(Parsed::Help));
        assert_eq!(parse_args(&args(&["-V"])), Ok(Parsed::Version));
    }

    #[test]
    fn usage_errors() {
        for (list, message) in [
            (&[][..], "missing command"),
            (&["frob"][..], "unknown command \"frob\""),
            (&["send-keys"][..], "send-keys needs KEYS"),
            (&["open"][..], "open needs exactly one URL"),
            (&["open", "a", "b"][..], "open needs exactly one URL"),
            (&["state", "x"][..], "state takes no arguments"),
            (
                &["reload-theme", "x"][..],
                "reload-theme takes no arguments",
            ),
            (
                &["reload-theme", "--json"][..],
                "--json applies to state only",
            ),
            (&["open", "a", "--json"][..], "--json applies to state only"),
            (&["state", "--profile"][..], "--profile needs a value"),
            (
                &["state", "--timeout", "0"][..],
                "--timeout needs a positive number of seconds",
            ),
            (
                &["state", "--timeout", "x"][..],
                "--timeout needs a positive number of seconds",
            ),
            (
                &["state", "--timeout", "inf"][..],
                "--timeout needs a positive number of seconds",
            ),
            (
                &["state", "--timeout", "1e19"][..],
                "--timeout must be at most 3600 seconds",
            ),
            (
                &["state", "--timeout", "3600.5"][..],
                "--timeout must be at most 3600 seconds",
            ),
            (&["state", "--bogus"][..], "unknown option \"--bogus\""),
        ] {
            assert_eq!(
                parse_args(&args(list)),
                Err(message.to_string()),
                "{list:?}"
            );
        }
    }

    #[test]
    fn formats_state_for_people() {
        let state = State {
            mode: "normal".into(),
            pending: Some("ctrl+b".into()),
            workspace: None,
            tabs: vec![
                Tab {
                    id: "12".into(),
                    url: Some("https://example.com/".into()),
                    title: Some("Example".into()),
                    selected: true,
                },
                Tab {
                    id: "13".into(),
                    url: Some("about:blank".into()),
                    title: Some(String::new()),
                    selected: false,
                },
                Tab {
                    id: "14".into(),
                    url: None,
                    title: None,
                    selected: false,
                },
            ],
            raw: parse("{}").unwrap(),
        };
        assert_eq!(
            format_state(&state),
            "mode: normal\npending: ctrl+b\nworkspace: -\ntabs: 3\n\
             * 12  Example  https://example.com/\n  13  -  about:blank\n  14  (private)  (private)\n"
        );
    }

    #[test]
    fn run_prints_usage_errors_with_exit_2() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&args(&[]), &Env::default(), &mut out, &mut err);
        assert_eq!(code, EXIT_USAGE);
        let err = String::from_utf8(err).unwrap();
        assert!(err.starts_with("vimma-ctl: missing command\n"), "{err}");
        assert!(err.contains("Usage:"), "{err}");
    }

    #[test]
    fn run_prints_help_and_version() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(
            run(&args(&["--help"]), &Env::default(), &mut out, &mut err),
            EXIT_OK
        );
        assert_eq!(String::from_utf8(out).unwrap(), USAGE);
        let mut out = Vec::new();
        assert_eq!(
            run(&args(&["--version"]), &Env::default(), &mut out, &mut err),
            EXIT_OK
        );
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!("vimma-ctl {} (protocol 2)\n", crate::version::VERSION)
        );
    }

    #[test]
    fn run_without_a_profile_is_not_running() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&args(&["state"]), &Env::default(), &mut out, &mut err);
        assert_eq!(code, EXIT_NOT_RUNNING);
        assert!(String::from_utf8(err).unwrap().starts_with("vimma-ctl: "));
    }
}
