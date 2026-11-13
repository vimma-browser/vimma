/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! A checked [`ToolCall`]'s translation into one control-protocol agent command.

use super::args::exact_f64;
use super::types::{FillField, FillSubmit, FillValue, Format, ListFilters, ToolCall};
use super::{object, text};
use crate::json::Value;
use std::collections::BTreeMap;

/// `agent-fill`'s arguments: the fields in order, the submission, and the list asked for.
fn fill_command(
    tab: &str,
    fields: &[FillField],
    submit: Option<&FillSubmit>,
    elements: bool,
    filters: &ListFilters,
) -> Value {
    let list = fields
        .iter()
        .map(|f| {
            let value = match &f.value {
                FillValue::Text(t) => text(t),
                FillValue::Flag(b) => Value::Bool(*b),
            };
            object([("label", text(&f.label)), ("value", value)])
        })
        .collect();
    let mut args = BTreeMap::from([
        ("tab".to_string(), text(tab)),
        ("fields".to_string(), Value::Array(list)),
    ]);
    match submit {
        None => {}
        Some(FillSubmit::Form) => {
            args.insert("submit".into(), Value::Bool(true));
        }
        Some(FillSubmit::Button(label)) => {
            args.insert("submit".into(), text(label));
        }
    }
    flag_into(&mut args, "elements", elements);
    filters.insert_into(&mut args);
    Value::Object(args)
}

impl ToolCall {
    /// The MCP tool's name.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            ToolCall::Tabs => "vimma_tabs",
            ToolCall::Read { .. } => "vimma_read_page",
            ToolCall::Open { .. } => "vimma_open",
            ToolCall::Close { .. } => "vimma_close_tab",
            ToolCall::Keys { .. } => "vimma_keys",
            ToolCall::Show { .. } => "vimma_show",
            ToolCall::Elements { .. } => "vimma_elements",
            ToolCall::Activate { .. } => "vimma_activate",
            ToolCall::Fill { .. } => "vimma_fill",
            ToolCall::Screenshot { .. } => "vimma_screenshot",
            ToolCall::Console { .. } => "vimma_console",
        }
    }

    /// Whether the element list asked for is filtered (builtin-agent B2), which its intro says.
    pub(super) fn filtered(&self) -> bool {
        match self {
            ToolCall::Open { filters, .. }
            | ToolCall::Elements { filters, .. }
            | ToolCall::Activate { filters, .. }
            | ToolCall::Fill { filters, .. } => filters.any(),
            _ => false,
        }
    }

    /// The agent command and its `args`.
    #[must_use]
    pub fn command(&self) -> (&'static str, Value) {
        match self {
            ToolCall::Tabs => ("agent-tabs", object([])),
            ToolCall::Read {
                tab,
                format,
                max_chars,
            } => {
                let mut args = BTreeMap::from([("tab".to_string(), text(tab))]);
                if let Some(format) = format {
                    let format = match format {
                        Format::Markdown => "markdown",
                        Format::Text => "text",
                    };
                    args.insert("format".into(), text(format));
                }
                if let Some(max) = max_chars {
                    // At most MAX_READ_CHARS, exact in a double.
                    args.insert("max_chars".into(), Value::Number(f64::from(cap_u32(*max))));
                }
                ("agent-read", Value::Object(args))
            }
            ToolCall::Open {
                url,
                tab,
                elements,
                filters,
            } => {
                let mut args = BTreeMap::from([("url".to_string(), text(url))]);
                if let Some(tab) = tab {
                    args.insert("tab".into(), text(tab));
                }
                flag_into(&mut args, "elements", *elements);
                filters.insert_into(&mut args);
                ("agent-open", Value::Object(args))
            }
            ToolCall::Close { tab } => ("agent-close", object([("tab", text(tab))])),
            ToolCall::Show { tab } => ("agent-show", object([("tab", text(tab))])),
            ToolCall::Elements { tab, filters, full } => {
                let mut args = BTreeMap::from([("tab".to_string(), text(tab))]);
                filters.insert_into(&mut args);
                flag_into(&mut args, "full", *full);
                ("agent-elements", Value::Object(args))
            }
            ToolCall::Activate {
                tab,
                label,
                elements,
                filters,
            } => {
                let mut args = BTreeMap::from([
                    ("tab".to_string(), text(tab)),
                    ("label".into(), text(label)),
                ]);
                flag_into(&mut args, "elements", *elements);
                filters.insert_into(&mut args);
                ("agent-activate", Value::Object(args))
            }
            ToolCall::Fill {
                tab,
                fields,
                submit,
                elements,
                filters,
            } => (
                "agent-fill",
                fill_command(tab, fields, submit.as_ref(), *elements, filters),
            ),
            ToolCall::Keys { tab, keys } => (
                "agent-keys",
                object([("tab", text(tab)), ("keys", text(keys))]),
            ),
            ToolCall::Screenshot { tab, labels, full } => {
                let mut args = BTreeMap::from([("tab".to_string(), text(tab))]);
                flag_into(&mut args, "labels", *labels);
                flag_into(&mut args, "full", *full);
                ("agent-screenshot", Value::Object(args))
            }
            ToolCall::Console { tab, since } => {
                let mut args = BTreeMap::from([("tab".to_string(), text(tab))]);
                if let Some(since) = since {
                    args.insert("since".into(), Value::Number(exact_f64(*since)));
                }
                ("agent-console", Value::Object(args))
            }
        }
    }
}

/// Adds `name: true` to an agent command's `args` when `on`: a false flag is left out.
fn flag_into(args: &mut BTreeMap<String, Value>, name: &str, on: bool) {
    if on {
        args.insert(name.into(), Value::Bool(true));
    }
}

fn cap_u32(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::test_support::*;
    use crate::mcp::{Action, Call, Era, Protocol, tool_result};

    #[test]
    fn every_tool_maps_to_its_agent_command() {
        let tab = || "12".to_string();
        for (call, name, command) in [
            (ToolCall::Tabs, "vimma_tabs", "agent-tabs"),
            (
                ToolCall::Read {
                    tab: tab(),
                    format: None,
                    max_chars: None,
                },
                "vimma_read_page",
                "agent-read",
            ),
            (
                ToolCall::Open {
                    url: "https://a.example/".into(),
                    tab: None,
                    elements: false,
                    filters: ListFilters::default(),
                },
                "vimma_open",
                "agent-open",
            ),
            (
                ToolCall::Close { tab: tab() },
                "vimma_close_tab",
                "agent-close",
            ),
            (
                ToolCall::Keys {
                    tab: tab(),
                    keys: "3j".into(),
                },
                "vimma_keys",
                "agent-keys",
            ),
            (ToolCall::Show { tab: tab() }, "vimma_show", "agent-show"),
            (elements_of(&tab()), "vimma_elements", "agent-elements"),
            (
                ToolCall::Activate {
                    tab: tab(),
                    label: "sd".into(),
                    elements: false,
                    filters: ListFilters::default(),
                },
                "vimma_activate",
                "agent-activate",
            ),
            (
                ToolCall::Screenshot {
                    tab: tab(),
                    labels: false,
                    full: false,
                },
                "vimma_screenshot",
                "agent-screenshot",
            ),
            (
                ToolCall::Console {
                    tab: tab(),
                    since: None,
                },
                "vimma_console",
                "agent-console",
            ),
        ] {
            assert_eq!(call.name(), name);
            assert_eq!(call.command().0, command);
        }
        assert_eq!(
            ToolCall::Read {
                tab: tab(),
                format: Some(Format::Text),
                max_chars: Some(5000)
            }
            .command()
            .1
            .to_string(),
            r#"{"format":"text","max_chars":5000,"tab":"12"}"#
        );
        assert_eq!(
            ToolCall::Open {
                url: "https://a.example/".into(),
                tab: Some(tab()),
                elements: false,
                filters: ListFilters::default(),
            }
            .command()
            .1
            .to_string(),
            r#"{"tab":"12","url":"https://a.example/"}"#
        );
        assert_eq!(ToolCall::Tabs.command().1.to_string(), "{}");
        assert_eq!(
            ToolCall::Show { tab: tab() }.command().1.to_string(),
            r#"{"tab":"12"}"#
        );
    }

    #[test]
    fn tool_calls_become_agent_commands() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (arguments, name, tool) in [
            ("{}", "vimma_tabs", ToolCall::Tabs),
            (
                r#"{"tab":"12","format":"text","max_chars":5000}"#,
                "vimma_read_page",
                ToolCall::Read {
                    tab: "12".into(),
                    format: Some(Format::Text),
                    max_chars: Some(5000),
                },
            ),
            (
                r#"{"tab":12}"#,
                "vimma_read_page",
                ToolCall::Read {
                    tab: "12".into(),
                    format: None,
                    max_chars: None,
                },
            ),
            (
                r#"{"url":"HTTPS://docs.rs/serde"}"#,
                "vimma_open",
                ToolCall::Open {
                    url: "HTTPS://docs.rs/serde".into(),
                    tab: None,
                    elements: false,
                    filters: ListFilters::default(),
                },
            ),
            (
                r#"{"tab":"3"}"#,
                "vimma_close_tab",
                ToolCall::Close { tab: "3".into() },
            ),
            (
                r#"{"tab":"3","keys":"3j /pricing<CR> gg"}"#,
                "vimma_keys",
                ToolCall::Keys {
                    tab: "3".into(),
                    keys: "3j /pricing<CR> gg".into(),
                },
            ),
            (
                r#"{"tab":"3"}"#,
                "vimma_show",
                ToolCall::Show { tab: "3".into() },
            ),
            (r#"{"tab":3}"#, "vimma_elements", elements_of("3")),
            (
                r#"{"tab":3,"label":"sdf"}"#,
                "vimma_activate",
                ToolCall::Activate {
                    tab: "3".into(),
                    label: "sdf".into(),
                    elements: false,
                    filters: ListFilters::default(),
                },
            ),
        ] {
            assert_eq!(
                handle(&mut p, &call_line(8, name, arguments)),
                Action::Call(Call {
                    id: Value::Number(8.0),
                    era: Era::Legacy,
                    tool,
                }),
                "{name} {arguments}"
            );
        }
        // Without arguments at all: vimma_tabs takes none.
        assert!(matches!(
            handle(
                &mut p,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vimma_tabs"}}"#
            ),
            Action::Call(Call {
                tool: ToolCall::Tabs,
                ..
            })
        ));
        let line = modern(
            "tools/call",
            9,
            r#""name":"vimma_open","arguments":{"url":"https://a.example/"}"#,
        );
        assert!(matches!(
            handle(&mut p, &line),
            Action::Call(Call {
                era: Era::Modern,
                ..
            })
        ));
    }

    // mcp-forms F22, F23: a console read names its tab and, optionally, a time in ms since the
    // epoch; never an expression; anything else is a tool error that never reaches Vimma.
    #[test]
    fn console_calls_become_agent_commands() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (arguments, sent) in [
            (r#"{"tab":"12"}"#, r#"{"tab":"12"}"#),
            (r#"{"tab":12,"since":0}"#, r#"{"since":0,"tab":"12"}"#),
            (
                r#"{"tab":"12","since":1761000000000}"#,
                r#"{"since":1761000000000,"tab":"12"}"#,
            ),
        ] {
            let Action::Call(call) = handle(&mut p, &call_line(5, "vimma_console", arguments))
            else {
                panic!("{arguments}: not a call");
            };
            assert_eq!(call.tool.command().0, "agent-console");
            assert_eq!(call.tool.command().1.to_string(), sent, "{arguments}");
        }
        let since = "since must be a whole number of milliseconds since the epoch";
        for (arguments, says) in [
            ("{}", "tab must be a tab id"),
            (r#"{"tab":"12","since":-1}"#, since),
            (r#"{"tab":"12","since":1.5}"#, since),
            (r#"{"tab":"12","since":"1"}"#, since),
            (r#"{"tab":"12","since":9007199254740992}"#, since),
            (
                r#"{"tab":"12","expression":"document.cookie"}"#,
                "unknown argument \"expression\"",
            ),
        ] {
            let Action::Reply(r) = handle(&mut p, &call_line(6, "vimma_console", arguments)) else {
                panic!("{arguments}: reached Vimma");
            };
            let t = tool_error_text(&r);
            assert!(t.starts_with("Invalid arguments for vimma_console"), "{t}");
            assert!(t.contains(says), "{arguments}: {t}");
        }
    }

    // mcp-forms F18, F20: a screenshot names its tab and, optionally, whether to draw the labels;
    // a labels flag only when true; anything else is a tool error that never reaches Vimma.
    #[test]
    fn screenshot_calls_become_agent_commands() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (arguments, sent) in [
            (r#"{"tab":"12"}"#, r#"{"tab":"12"}"#),
            (r#"{"tab":12,"labels":false}"#, r#"{"tab":"12"}"#),
            (
                r#"{"tab":"12","labels":true}"#,
                r#"{"labels":true,"tab":"12"}"#,
            ),
        ] {
            let Action::Call(call) = handle(&mut p, &call_line(5, "vimma_screenshot", arguments))
            else {
                panic!("{arguments}: not a call");
            };
            assert_eq!(call.tool.command().0, "agent-screenshot");
            assert_eq!(call.tool.command().1.to_string(), sent, "{arguments}");
        }
        for (arguments, says) in [
            ("{}", "tab must be a tab id"),
            (
                r#"{"tab":"12","labels":"yes"}"#,
                "labels must be true or false",
            ),
            (r#"{"tab":"12","rect":{}}"#, "unknown argument \"rect\""),
        ] {
            let Action::Reply(r) = handle(&mut p, &call_line(6, "vimma_screenshot", arguments))
            else {
                panic!("{arguments}: reached Vimma");
            };
            let t = tool_error_text(&r);
            assert!(
                t.starts_with("Invalid arguments for vimma_screenshot"),
                "{t}"
            );
            assert!(t.contains(says), "{arguments}: {t}");
        }
    }

    // mcp-forms F12, F15: vimma_fill is agent-fill, with the fields as given and submit as true
    // or a label.
    #[test]
    fn fill_maps_to_agent_fill() {
        let tab = || "12".to_string();
        let call = ToolCall::Fill {
            tab: tab(),
            fields: vec![FillField {
                label: "sd".into(),
                value: FillValue::Text("x".into()),
            }],
            submit: None,
            elements: false,
            filters: ListFilters::default(),
        };
        assert_eq!(call.name(), "vimma_fill");
        assert_eq!(call.command().0, "agent-fill");
        assert_eq!(
            ToolCall::Fill {
                tab: tab(),
                fields: vec![
                    FillField {
                        label: "sd".into(),
                        value: FillValue::Text("ada@example.com".into()),
                    },
                    FillField {
                        label: "sf".into(),
                        value: FillValue::Flag(false),
                    },
                ],
                submit: Some(FillSubmit::Button("sg".into())),
                elements: false,
                filters: ListFilters::default(),
            }
            .command()
            .1
            .to_string(),
            r#"{"fields":[{"label":"sd","value":"ada@example.com"},{"label":"sf","value":false}],"submit":"sg","tab":"12"}"#
        );
        assert_eq!(
            ToolCall::Fill {
                tab: tab(),
                fields: vec![FillField {
                    label: "sd".into(),
                    value: FillValue::Flag(true),
                }],
                submit: Some(FillSubmit::Form),
                elements: false,
                filters: ListFilters::default(),
            }
            .command()
            .1
            .to_string(),
            r#"{"fields":[{"label":"sd","value":true}],"submit":true,"tab":"12"}"#
        );
    }

    #[test]
    fn fill_calls_become_agent_commands() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (arguments, name, tool) in [
            (
                r#"{"tab":3,"fields":[{"label":"sd","value":"two\nlines"},{"label":"f","value":true}],"submit":true}"#,
                "vimma_fill",
                ToolCall::Fill {
                    tab: "3".into(),
                    fields: vec![
                        FillField {
                            label: "sd".into(),
                            value: FillValue::Text("two\nlines".into()),
                        },
                        FillField {
                            label: "f".into(),
                            value: FillValue::Flag(true),
                        },
                    ],
                    submit: Some(FillSubmit::Form),
                    elements: false,
                    filters: ListFilters::default(),
                },
            ),
            (
                r#"{"tab":"3","fields":[{"label":"sd","value":""}],"submit":"kl"}"#,
                "vimma_fill",
                ToolCall::Fill {
                    tab: "3".into(),
                    fields: vec![FillField {
                        label: "sd".into(),
                        value: FillValue::Text(String::new()),
                    }],
                    submit: Some(FillSubmit::Button("kl".into())),
                    elements: false,
                    filters: ListFilters::default(),
                },
            ),
        ] {
            assert_eq!(
                handle(&mut p, &call_line(8, name, arguments)),
                Action::Call(Call {
                    id: Value::Number(8.0),
                    era: Era::Legacy,
                    tool,
                }),
                "{name} {arguments}"
            );
        }
    }

    // The agent commands vimma-ctl mcp sends and the results it decodes are the shared v2
    // fixtures' (tests/contract/control/v2), which vimma-core's validator also runs.
    #[test]
    fn agent_command_fixtures_match_what_mcp_sends_and_decodes() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (command, tool) in [
            ("agent-tabs", "vimma_tabs"),
            ("agent-read", "vimma_read_page"),
            ("agent-open", "vimma_open"),
            ("agent-close", "vimma_close_tab"),
            ("agent-keys", "vimma_keys"),
            ("agent-elements", "vimma_elements"),
            ("agent-activate", "vimma_activate"),
            ("agent-fill", "vimma_fill"),
            ("agent-screenshot", "vimma_screenshot"),
            ("agent-console", "vimma_console"),
        ] {
            let request = v2_fixture(&format!("request-{command}.valid.json"));
            let message = request.get("message").unwrap();
            let args = message.get("args").unwrap();
            // The tools take the agent commands' own argument names.
            let Action::Call(call) = handle(&mut p, &call_line(1, tool, &args.to_string())) else {
                panic!("{command}: not a call");
            };
            assert_eq!(call.tool.command(), (command, args.clone()), "{command}");
            let invalid = v2_fixture(&format!("request-{command}.invalid.json"));
            let bad_args = invalid.get("message").unwrap().get("args").unwrap();
            assert!(
                matches!(
                    handle(&mut p, &call_line(1, tool, &bad_args.to_string())),
                    Action::Reply(_)
                ),
                "{command}: the invalid fixture's args never reach Vimma"
            );
            for (validity, is_error) in [("valid", false), ("invalid", true)] {
                let response = v2_fixture(&format!("response-{command}.{validity}.json"));
                let result = response.get("message").unwrap().get("result").unwrap();
                let r = tool_result(&call, Ok(result));
                let flagged = r.get("result").unwrap().get("isError") == Some(&Value::Bool(true));
                assert_eq!(flagged, is_error, "{command} {validity}: {r}");
            }
        }
        // Issue #584: the steps that return an element list, and the full-size screenshot.
        for (name, tool, responses) in [
            ("agent-activate-elements", "vimma_activate", true),
            ("agent-open-elements", "vimma_open", true),
            ("agent-screenshot-full", "vimma_screenshot", false),
            // agent-speed S4: the filters, and a compact list naming the labels it left out.
            ("agent-elements-filters", "vimma_elements", true),
            ("agent-open-filters", "vimma_open", false),
        ] {
            let request = v2_fixture(&format!("request-{name}.valid.json"));
            let message = request.get("message").unwrap();
            let command = match message.get("command") {
                Some(Value::String(c)) => c.clone(),
                _ => panic!("{name}: no command"),
            };
            let args = message.get("args").unwrap();
            let Action::Call(call) = handle(&mut p, &call_line(1, tool, &args.to_string())) else {
                panic!("{name}: not a call");
            };
            assert_eq!(
                call.tool.command(),
                (command.as_str(), args.clone()),
                "{name}"
            );
            let invalid = v2_fixture(&format!("request-{name}.invalid.json"));
            let bad_args = invalid.get("message").unwrap().get("args").unwrap();
            assert!(
                matches!(
                    handle(&mut p, &call_line(1, tool, &bad_args.to_string())),
                    Action::Reply(_)
                ),
                "{name}: the invalid fixture's args never reach Vimma"
            );
            if !responses {
                continue;
            }
            for (validity, is_error) in [("valid", false), ("invalid", true)] {
                let response = v2_fixture(&format!("response-{name}.{validity}.json"));
                let result = response.get("message").unwrap().get("result").unwrap();
                let r = tool_result(&call, Ok(result));
                let flagged = r.get("result").unwrap().get("isError") == Some(&Value::Bool(true));
                assert_eq!(flagged, is_error, "{name} {validity}: {r}");
            }
        }
        let cancel = v2_fixture("request-agent-cancel.valid.json");
        assert_eq!(
            crate::protocol::request_named(7, "agent-cancel", object([("id", Value::Number(4.0))])),
            *cancel.get("message").unwrap()
        );
    }
}
