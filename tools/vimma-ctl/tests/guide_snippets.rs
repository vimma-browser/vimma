/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The guide's setup snippets for agent tools ("Connecting an agent's tool" in docs/guide.md)
//! must start a `vimma-ctl mcp` this binary accepts. A reader copies them verbatim, so a renamed
//! flag or a typo in a snippet would leave the agent's tool with a server that exits at once.

use std::path::Path;

use vimma_ctl::cli::{Parsed, parse_args};
use vimma_ctl::json::{self, Value};

const SECTION: &str = "#### Connecting an agent's tool";

/// The section's fenced code blocks, as (language, body).
fn blocks() -> Vec<(String, String)> {
    let guide = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/guide.md");
    let text = std::fs::read_to_string(guide).expect("docs/guide.md");
    let start = text.find(SECTION).expect("the guide has the section");
    let rest = &text[start + SECTION.len()..];
    let section = &rest[..rest.find("\n#### ").unwrap_or(rest.len())];
    let mut out = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in section.lines() {
        let trimmed = line.trim_start();
        if let Some(lang) = trimmed.strip_prefix("```") {
            match current.take() {
                Some(block) => out.push(block),
                None => current = Some((lang.trim().to_string(), String::new())),
            }
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(trimmed);
            body.push('\n');
        }
    }
    out
}

/// `vimma-ctl` and its arguments must parse as the MCP server.
fn assert_mcp(argv: &[String], snippet: &str) {
    assert_eq!(
        argv.first().map(String::as_str),
        Some("vimma-ctl"),
        "in {snippet}"
    );
    let parsed = parse_args(&argv[1..]);
    assert!(
        matches!(parsed, Ok(Parsed::Mcp { .. })),
        "{argv:?} is not vimma-ctl mcp ({parsed:?}) in {snippet}"
    );
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                other => panic!("not a string: {other:?}"),
            })
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        other => panic!("not a string or a list: {other:?}"),
    }
}

#[test]
fn every_agent_tool_snippet_starts_vimma_ctl_mcp() {
    let mut tools = Vec::new();
    for (lang, body) in blocks() {
        match lang.as_str() {
            "sh" => {
                for line in body
                    .lines()
                    .filter(|l| !l.is_empty() && !l.starts_with('#'))
                {
                    let (tool, command) = line.split_once(" -- ").expect("`tool ... -- command`");
                    let argv: Vec<String> =
                        command.split_whitespace().map(str::to_string).collect();
                    assert_mcp(&argv, line);
                    tools.push(tool.split_whitespace().next().unwrap().to_string());
                }
            }
            // Other JSON blocks there (the agent tool's own settings) start no server.
            "json" if body.contains("vimma-ctl") => {
                let value = json::parse(&body).unwrap_or_else(|e| panic!("{e:?} in {body}"));
                if let Some(server) = value.get("mcp").and_then(|m| m.get("vimma")) {
                    assert_eq!(server.get("type"), Some(&Value::String("local".into())));
                    assert_mcp(&strings(server.get("command")), &body);
                    tools.push("opencode.json".to_string());
                } else {
                    let server = value
                        .get("mcpServers")
                        .and_then(|m| m.get("vimma"))
                        .unwrap_or_else(|| panic!("no mcpServers.vimma in {body}"));
                    let mut argv = strings(server.get("command"));
                    argv.extend(strings(server.get("args")));
                    assert_mcp(&argv, &body);
                    tools.push("mcpServers".to_string());
                }
            }
            "toml" if body.contains("[mcp_servers.vimma]") => {
                let field = |key: &str| {
                    body.lines()
                        .find_map(|l| l.strip_prefix(key)?.trim_start().strip_prefix('='))
                        .unwrap_or_else(|| panic!("no {key} in {body}"))
                        .trim()
                        .to_string()
                };
                let mut argv = strings(Some(&json::parse(&field("command")).unwrap()));
                argv.extend(strings(Some(&json::parse(&field("args")).unwrap())));
                assert_mcp(&argv, &body);
                tools.push("codex-toml".to_string());
            }
            _ => {}
        }
    }
    for tool in [
        "claude",
        "codex",
        "copilot",
        "opencode.json",
        "mcpServers",
        "codex-toml",
    ] {
        assert!(
            tools.iter().any(|t| t == tool),
            "no {tool} snippet; found {tools:?}"
        );
    }
}
