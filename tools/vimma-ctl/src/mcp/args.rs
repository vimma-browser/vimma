/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Each tool's arguments, checked as vimma-core checks them before anything reaches Vimma.

use super::types::{FillField, FillSubmit, FillValue, Format, ListFilters, ToolCall};
use super::{MAX_COUNT, MAX_KEYS, MAX_QUERY, MAX_READ_CHARS, MAX_URL, text};
use crate::json::Value;
use std::collections::BTreeMap;

/// vimma-core's `ELEMENT_KINDS`: what an element list says an element is (mcp-forms F5).
pub(super) const ELEMENT_KINDS: [&str; 7] = [
    "link", "button", "field", "checkbox", "radio", "select", "click",
];

/// The longest `query` of an element list, in code points (builtin-agent B2).
const MAX_LIST_QUERY: u16 = 200;

/// `query` and `kinds`, checked as vimma-core checks them; the browser checks again.
fn list_filters(arguments: &BTreeMap<String, Value>) -> Result<ListFilters, String> {
    let query = match arguments.get("query") {
        None => None,
        Some(Value::String(q))
            if !q.trim().is_empty()
                && q.chars().count() <= usize::from(MAX_LIST_QUERY)
                && !q.chars().any(|c| c == '\t' || keys_control(c)) =>
        {
            Some(q.clone())
        }
        Some(_) => {
            return Err(format!(
                "query must be 1 to {MAX_LIST_QUERY} characters of one line"
            ));
        }
    };
    let kinds = match arguments.get("kinds") {
        None => None,
        Some(Value::Array(items)) if !items.is_empty() => {
            let mut kinds: Vec<String> = Vec::new();
            for item in items {
                match item {
                    Value::String(k)
                        if ELEMENT_KINDS.contains(&k.as_str()) && !kinds.contains(k) =>
                    {
                        kinds.push(k.clone());
                    }
                    _ => return Err(kinds_error()),
                }
            }
            Some(kinds)
        }
        Some(_) => return Err(kinds_error()),
    };
    Ok(ListFilters { query, kinds })
}

fn kinds_error() -> String {
    format!(
        "kinds must be distinct kinds of {}",
        ELEMENT_KINDS.join(", ")
    )
}

/// A step's filters: only with the element list it returns (issue #584).
fn step_filters(
    arguments: &BTreeMap<String, Value>,
    elements: bool,
) -> Result<ListFilters, String> {
    let filters = list_filters(arguments)?;
    if filters.any() && !elements {
        return Err("query and kinds come only with elements: true".into());
    }
    Ok(filters)
}

/// `vimma_elements`' arguments: a tab, its filters, and whether to list every line.
pub(super) fn elements_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["tab", "query", "kinds", "full"])?;
    let tab = tab_arg(arguments.get("tab"))?;
    let filters = list_filters(arguments)?;
    let full = flag_arg(arguments, "full")?;
    Ok(ToolCall::Elements { tab, filters, full })
}

pub(super) fn only(arguments: &BTreeMap<String, Value>, allowed: &[&str]) -> Result<(), String> {
    match arguments.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(key) => {
            let shown: String = key.chars().take(64).collect();
            Err(format!("unknown argument {}", text(&shown)))
        }
        None => Ok(()),
    }
}

/// A tab id: 1 to 20 digits, as a string or a non-negative integer.
pub(super) fn tab_arg(value: Option<&Value>) -> Result<String, String> {
    let bad = || "tab must be a tab id (1 to 20 digits) from vimma_tabs or vimma_open".to_string();
    let tab = match value {
        Some(Value::String(tab)) => tab.clone(),
        Some(n @ Value::Number(_)) => n.as_u64().ok_or_else(bad)?.to_string(),
        _ => return Err(bad()),
    };
    if tab.is_empty() || tab.len() > 20 || !tab.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    Ok(tab)
}

/// vimma-core's `DEFAULT_HINT_CHARS`: the characters of an element's label (mcp-forms F3).
pub(super) const LABEL_CHARS: &str = "asdfghjkl";

/// vimma-core's `isAgentLabel`: 1 to 3 of the hint characters, as `vimma_elements` labels.
pub(super) fn label_arg(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::String(label))
            if (1..=3).contains(&label.len()) && label.chars().all(|c| LABEL_CHARS.contains(c)) =>
        {
            Ok(label.clone())
        }
        _ => Err(format!(
            "label must be 1 to 3 of the characters {LABEL_CHARS}, from vimma_elements"
        )),
    }
}

/// An optional true or false argument, false when absent.
fn flag_arg(arguments: &BTreeMap<String, Value>, name: &str) -> Result<bool, String> {
    match arguments.get(name) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("{name} must be true or false")),
    }
}

pub(super) fn activate_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["tab", "label", "elements", "query", "kinds"])?;
    let tab = tab_arg(arguments.get("tab"))?;
    let label = label_arg(arguments.get("label"))?;
    let elements = flag_arg(arguments, "elements")?;
    let filters = step_filters(arguments, elements)?;
    Ok(ToolCall::Activate {
        tab,
        label,
        elements,
        filters,
    })
}

/// mcp-forms F14: at most this many fields a call, each value at most this many characters.
pub const MAX_FILL_FIELDS: usize = 32;
pub const MAX_FILL_VALUE: usize = 1024;

/// vimma-core's `FILL_INVISIBLE`: characters that draw nothing (format characters, line and
/// paragraph separators, variation selectors, fillers), so text hidden in them would pass the
/// question unseen (mcp-forms F14, security.md M27).
const FILL_INVISIBLE: [(u32, u32); 27] = [
    (0xAD, 0xAD),
    (0x34F, 0x34F),
    (0x600, 0x605),
    (0x61C, 0x61C),
    (0x6DD, 0x6DD),
    (0x70F, 0x70F),
    (0x890, 0x891),
    (0x8E2, 0x8E2),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x2028, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
    // Control characters but the line break, as is_control has them.
    (0x0, 0x9),
    (0xB, 0x1F),
];

fn fill_char_ok(c: char) -> bool {
    let n = u32::from(c);
    !(0x7F..=0x9F).contains(&n) && !FILL_INVISIBLE.iter().any(|&(a, b)| (a..=b).contains(&n))
}

/// vimma-core's `isFillValue`: true, false, or a text within its limit with no control or
/// invisible character but a line break.
fn fill_value(value: Option<&Value>) -> Result<FillValue, String> {
    match value {
        Some(Value::Bool(b)) => Ok(FillValue::Flag(*b)),
        Some(Value::String(v))
            if v.chars().count() <= MAX_FILL_VALUE && v.chars().all(fill_char_ok) =>
        {
            Ok(FillValue::Text(v.clone()))
        }
        _ => Err(format!(
            "each field's value must be true, false (a checkbox or radio) or a text of at most \
             {MAX_FILL_VALUE} characters without control or invisible characters but line breaks"
        )),
    }
}

pub(super) fn fill_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(
        arguments,
        &["tab", "fields", "submit", "elements", "query", "kinds"],
    )?;
    let tab = tab_arg(arguments.get("tab"))?;
    let bad_list = || {
        format!(
            "fields must be a list of 1 to {MAX_FILL_FIELDS} fields, each {{\"label\": a label \
             from vimma_elements, \"value\": its value}}"
        )
    };
    let Some(Value::Array(list)) = arguments.get("fields") else {
        return Err(bad_list());
    };
    if list.is_empty() || list.len() > MAX_FILL_FIELDS {
        return Err(bad_list());
    }
    let mut fields: Vec<FillField> = Vec::with_capacity(list.len());
    for item in list {
        let Value::Object(f) = item else {
            return Err(bad_list());
        };
        only(f, &["label", "value"])?;
        let label = label_arg(f.get("label"))?;
        if fields.iter().any(|g| g.label == label) {
            return Err(format!("fields must name each label once ({label} twice)"));
        }
        let value = fill_value(f.get("value"))?;
        fields.push(FillField { label, value });
    }
    let submit = match arguments.get("submit") {
        None => None,
        Some(Value::Bool(true)) => Some(FillSubmit::Form),
        Some(v @ Value::String(_)) => {
            Some(FillSubmit::Button(label_arg(Some(v)).map_err(|_| {
                "submit must be true or a submit button's label from vimma_elements".to_string()
            })?))
        }
        Some(_) => {
            return Err(
                "submit must be true or a submit button's label from vimma_elements".to_string(),
            );
        }
    };
    let elements = flag_arg(arguments, "elements")?;
    let filters = step_filters(arguments, elements)?;
    Ok(ToolCall::Fill {
        tab,
        fields,
        submit,
        elements,
        filters,
    })
}

/// mcp-forms F18, F20: a tab, whether to draw the labels of its last element list, and whether
/// to take it at full size (issue #584).
pub(super) fn screenshot_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["tab", "labels", "full"])?;
    let tab = tab_arg(arguments.get("tab"))?;
    let labels = flag_arg(arguments, "labels")?;
    let full = flag_arg(arguments, "full")?;
    Ok(ToolCall::Screenshot { tab, labels, full })
}

/// The largest time `since` takes: what a double holds exactly, as vimma-core's check.
pub(super) const MAX_SINCE: u64 = 9_007_199_254_740_991;

/// mcp-forms F22, F23: a tab, and only entries after a time; never an expression.
pub(super) fn console_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["tab", "since"])?;
    let tab = tab_arg(arguments.get("tab"))?;
    let since = match arguments.get("since") {
        None => None,
        Some(n) => Some(
            n.as_u64()
                .filter(|n| *n <= MAX_SINCE)
                .ok_or("since must be a whole number of milliseconds since the epoch")?,
        ),
    };
    Ok(ToolCall::Console { tab, since })
}

/// `n` as a double, exact up to [`MAX_SINCE`].
pub(super) fn exact_f64(n: u64) -> f64 {
    let high = u32::try_from(n >> 32).unwrap_or(u32::MAX);
    let low = u32::try_from(n & 0xffff_ffff).unwrap_or(0);
    f64::from(high) * 4_294_967_296.0 + f64::from(low)
}

pub(super) fn read_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["tab", "format", "max_chars"])?;
    let tab = tab_arg(arguments.get("tab"))?;
    let format = match arguments.get("format") {
        None => None,
        Some(Value::String(f)) if f == "markdown" => Some(Format::Markdown),
        Some(Value::String(f)) if f == "text" => Some(Format::Text),
        Some(_) => return Err("format must be \"markdown\" or \"text\"".into()),
    };
    let max_chars = match arguments.get("max_chars") {
        None => None,
        Some(n) => Some(
            n.as_u64()
                .filter(|n| (1..=MAX_READ_CHARS).contains(n))
                .ok_or_else(|| {
                    format!("max_chars must be an integer from 1 to {MAX_READ_CHARS}")
                })?,
        ),
    };
    Ok(ToolCall::Read {
        tab,
        format,
        max_chars,
    })
}

/// vimma-core's `checkAgentOpenArgs`: http or https only, no spaces or control characters, at
/// most [`MAX_URL`] UTF-16 code units. The browser checks again; this only fails early.
pub(super) fn open_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["url", "tab", "elements", "query", "kinds"])?;
    let Some(Value::String(url)) = arguments.get("url") else {
        return Err("url must be a string".into());
    };
    if url.encode_utf16().count() > MAX_URL {
        return Err(format!("url must be at most {MAX_URL} characters"));
    }
    if url.chars().any(|c| c <= ' ' || c == '\u{7f}') {
        return Err("url must not contain spaces or control characters".into());
    }
    let scheme = url.split_once(':').map(|(s, _)| s.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http" | "https")) {
        return Err("url must be http or https (no file:, about:, javascript: or data:)".into());
    }
    let tab = match arguments.get("tab") {
        None => None,
        Some(tab) => Some(tab_arg(Some(tab))?),
    };
    let elements = flag_arg(arguments, "elements")?;
    let filters = step_filters(arguments, elements)?;
    Ok(ToolCall::Open {
        url: url.clone(),
        tab,
        elements,
        filters,
    })
}

/// C0 but the tab, DEL, C1, and the bidirectional and invisible characters (vimma-core's
/// `agent-keys` check): the question in Vimma must show the keys that run.
fn keys_control(c: char) -> bool {
    (c <= '\u{1f}' && c != '\t')
        || ('\u{7f}'..='\u{9f}').contains(&c)
        || matches!(c, '\u{ad}' | '\u{61c}' | '\u{feff}')
        || ('\u{200b}'..='\u{200f}').contains(&c)
        || ('\u{2028}'..='\u{202e}').contains(&c)
        || ('\u{2060}'..='\u{2069}').contains(&c)
}

/// `vimma_keys`'s arguments (mcp-drive D15): the size and characters of the keys, each find
/// query (`/` or `?` up to `<CR>`) and each run of count digits. Which keys run is the browser's
/// parse (vimma-core's agent-keys.mjs), which checks all of this again with the whitelist and
/// the 32 actions a call; this only fails early.
pub(super) fn keys_args(arguments: &BTreeMap<String, Value>) -> Result<ToolCall, String> {
    only(arguments, &["tab", "keys"])?;
    let tab = tab_arg(arguments.get("tab"))?;
    let Some(Value::String(keys)) = arguments.get("keys") else {
        return Err(format!(
            "keys must be a string of 1 to {MAX_KEYS} characters"
        ));
    };
    let chars: Vec<char> = keys.chars().collect();
    if chars.is_empty() || chars.len() > MAX_KEYS {
        return Err(format!(
            "keys must be a string of 1 to {MAX_KEYS} characters"
        ));
    }
    if chars.iter().any(|c| keys_control(*c)) {
        return Err(
            "keys must not contain control characters, bidirectional controls or invisible \
                    characters"
                .into(),
        );
    }
    let mut i = 0;
    let mut digits = String::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            digits.push(c);
            if digits.parse::<u32>().map_or(true, |n| n > MAX_COUNT) {
                return Err(format!("a count must be at most {MAX_COUNT}"));
            }
            i += 1;
            continue;
        }
        digits.clear();
        if c == '<' {
            // A key in Vim's brackets (`<C-d>`): its insides are no count and no query.
            if let Some(close) = chars[i..]
                .iter()
                .take_while(|c| !c.is_whitespace())
                .position(|c| *c == '>')
            {
                i += close + 1;
                continue;
            }
        }
        if c == '/' || c == '?' {
            let rest: String = chars[i + 1..].iter().collect();
            let Some(end) = rest.to_ascii_lowercase().find("<cr>") else {
                return Err(format!("the find {c} needs its query to end with <CR>"));
            };
            let query = &rest[..end];
            if query.is_empty() {
                return Err("a find query must not be empty".into());
            }
            if query.chars().count() > MAX_QUERY {
                return Err(format!(
                    "a find query must be at most {MAX_QUERY} characters"
                ));
            }
            i += 1 + query.chars().count() + "<CR>".len();
            continue;
        }
        i += 1;
    }
    Ok(ToolCall::Keys {
        tab,
        keys: keys.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::test_support::*;
    use crate::mcp::{Action, Protocol};

    // Inputs are size-limited and checked before anything reaches Vimma: a bad argument is a
    // tool error the model can correct, and nothing is asked.
    #[test]
    fn bad_arguments_are_tool_errors_and_never_reach_vimma() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        let long = format!(r#"{{"url":"https://a.example/{}"}}"#, "a".repeat(MAX_URL));
        for (name, arguments, says) in [
            ("vimma_tabs", r#"{"x":1}"#, "unknown argument \"x\""),
            ("vimma_read_page", "{}", "tab"),
            ("vimma_read_page", r#"{"tab":"x1"}"#, "tab"),
            (
                "vimma_read_page",
                r#"{"tab":"123456789012345678901"}"#,
                "tab",
            ),
            ("vimma_read_page", r#"{"tab":-1}"#, "tab"),
            (
                "vimma_read_page",
                r#"{"tab":"1","format":"html"}"#,
                "format",
            ),
            (
                "vimma_read_page",
                r#"{"tab":"1","max_chars":0}"#,
                "max_chars",
            ),
            (
                "vimma_read_page",
                r#"{"tab":"1","max_chars":500001}"#,
                "max_chars",
            ),
            (
                "vimma_read_page",
                r#"{"tab":"1","max_chars":1.5}"#,
                "max_chars",
            ),
            ("vimma_open", "{}", "url"),
            (
                "vimma_open",
                r#"{"url":"file:///etc/passwd"}"#,
                "http or https",
            ),
            (
                "vimma_open",
                r#"{"url":"javascript:alert(1)"}"#,
                "http or https",
            ),
            ("vimma_open", r#"{"url":"about:config"}"#, "http or https"),
            (
                "vimma_open",
                r#"{"url":"data:text/html,x"}"#,
                "http or https",
            ),
            ("vimma_open", r#"{"url":"https://a.example/ x"}"#, "spaces"),
            ("vimma_open", r#"{"url":"https://a.example/\n"}"#, "spaces"),
            ("vimma_open", &long, "65536"),
            (
                "vimma_open",
                r#"{"url":"https://a.example/","tab":"x"}"#,
                "tab",
            ),
            (
                "vimma_close_tab",
                r#"{"tab":"1","url":"x"}"#,
                "unknown argument \"url\"",
            ),
            // mcp-drive D2: a show names one agent tab, never a workspace.
            ("vimma_show", "{}", "tab"),
            ("vimma_show", r#"{"tab":"x"}"#, "tab"),
            (
                "vimma_show",
                r#"{"tab":"1","workspace":"main"}"#,
                "unknown argument \"workspace\"",
            ),
            // mcp-forms F2: a list names one agent tab and takes no selector.
            ("vimma_elements", "{}", "tab"),
            ("vimma_elements", r#"{"tab":"x"}"#, "tab"),
            (
                "vimma_elements",
                r#"{"tab":"1","selector":"form"}"#,
                "unknown argument \"selector\"",
            ),
            // mcp-forms F8: a click names a label from vimma_elements, never a selector.
            ("vimma_activate", r#"{"tab":"1"}"#, "label"),
            ("vimma_activate", r#"{"label":"sd"}"#, "tab"),
            ("vimma_activate", r#"{"tab":"1","label":"x"}"#, "label"),
            ("vimma_activate", r#"{"tab":"1","label":"SD"}"#, "label"),
            ("vimma_activate", r#"{"tab":"1","label":"asdf"}"#, "label"),
            (
                "vimma_activate",
                r##"{"tab":"1","label":"#submit"}"##,
                "label",
            ),
            ("vimma_activate", r#"{"tab":"1","label":3}"#, "label"),
            (
                "vimma_activate",
                r#"{"tab":"1","label":"sd","submit":true}"#,
                "unknown argument \"submit\"",
            ),
        ] {
            let r = reply(&mut p, &call_line(5, name, arguments));
            assert_eq!(at(&r, &["id"]), &Value::Number(5.0));
            let text = tool_error_text(&r);
            assert!(text.contains(says), "{name} {arguments}: {text}");
        }
    }

    // mcp-drive D15 (security.md M20): the keys' limits, checked before Vimma is asked.
    #[test]
    fn bad_keys_are_tool_errors_and_never_reach_vimma() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        let long = format!(r#"{{"tab":"1","keys":"{}"}}"#, "j".repeat(513));
        let query = format!(r#"{{"tab":"1","keys":"/{}<CR>"}}"#, "a".repeat(257));
        for (name, arguments, says) in [
            ("vimma_keys", r#"{"tab":"1"}"#, "keys must be"),
            ("vimma_keys", r#"{"keys":"j"}"#, "tab"),
            ("vimma_keys", r#"{"tab":"1","keys":""}"#, "1 to 512"),
            ("vimma_keys", &long, "1 to 512"),
            (
                "vimma_keys",
                r#"{"tab":"1","keys":"j\u0007"}"#,
                "control characters",
            ),
            ("vimma_keys", r#"{"tab":"1","keys":"/foo"}"#, "<CR>"),
            ("vimma_keys", r#"{"tab":"1","keys":"/<CR>"}"#, "empty"),
            ("vimma_keys", &query, "256"),
            ("vimma_keys", r#"{"tab":"1","keys":"100j"}"#, "99"),
            (
                "vimma_keys",
                r#"{"tab":"1","keys":"/a\u202eb<CR>"}"#,
                "control characters",
            ),
            ("vimma_keys", r#"{"tab":"1","keys":"<C-d /x"}"#, "<CR>"),
            (
                "vimma_keys",
                r#"{"tab":"1","keys":"j","show":true}"#,
                "unknown argument \"show\"",
            ),
        ] {
            let r = reply(&mut p, &call_line(5, name, arguments));
            let text = tool_error_text(&r);
            assert!(text.contains(says), "{name} {arguments}: {text}");
        }
    }

    #[test]
    fn bad_fill_arguments_are_tool_errors_and_never_reach_vimma() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (name, arguments, says) in [
            // mcp-forms F12, F14: fields by label, 1 to 32, values within their limits.
            ("vimma_fill", r#"{"tab":"1"}"#, "fields"),
            ("vimma_fill", r#"{"tab":"1","fields":[]}"#, "fields"),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":{"label":"sd"}}"#,
                "fields",
            ),
            (
                "vimma_fill",
                r#"{"fields":[{"label":"sd","value":"x"}]}"#,
                "tab",
            ),
            (
                "vimma_fill",
                r##"{"tab":"1","fields":[{"label":"#email","value":"x"}]}"##,
                "label",
            ),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd"}]}"#,
                "value",
            ),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd","value":3}]}"#,
                "value",
            ),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd","value":"a\tb"}]}"#,
                "value",
            ),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd","value":"a\u0000b"}]}"#,
                "value",
            ),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd","value":"a\rb"}]}"#,
                "value",
            ),
            (
                "vimma_fill",
                r##"{"tab":"1","fields":[{"label":"sd","value":"x","selector":"#a"}]}"##,
                "unknown argument \"selector\"",
            ),
            ("vimma_fill", r#"{"tab":"1","fields":["sd"]}"#, "fields"),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd","value":"x"},{"label":"sd","value":"y"}]}"#,
                "once",
            ),
            (
                "vimma_fill",
                r#"{"tab":"1","fields":[{"label":"sd","value":"x"}],"submit":false}"#,
                "submit",
            ),
            (
                "vimma_fill",
                r##"{"tab":"1","fields":[{"label":"sd","value":"x"}],"submit":"#go"}"##,
                "submit",
            ),
        ] {
            let r = reply(&mut p, &call_line(5, name, arguments));
            assert_eq!(at(&r, &["id"]), &Value::Number(5.0));
            let text = tool_error_text(&r);
            assert!(text.contains(says), "{name} {arguments}: {text}");
        }
    }

    // mcp-forms F14 (security.md M27): characters that draw nothing could hide text in the
    // question, so a value holding one never reaches Vimma.
    #[test]
    fn fill_values_with_invisible_characters_are_tool_errors() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for c in [
            "\\u200b",
            "\\u200d",
            "\\u2060",
            "\\ufeff",
            "\\u202e",
            "\\u2028",
            "\\ufe0f",
            "\\udb40\\udc41",
            "\\udb40\\udd00",
            "\\u00ad",
            "\\u034f",
            "\\u3164",
        ] {
            let arguments = format!(r#"{{"tab":"1","fields":[{{"label":"sd","value":"a{c}b"}}]}}"#);
            let r = reply(&mut p, &call_line(5, "vimma_fill", &arguments));
            assert!(tool_error_text(&r).contains("invisible"), "{c}: {r}");
        }
    }

    // mcp-forms F12, F14 (security.md M27): over-long values and too many fields never reach
    // Vimma; the limits count characters, as vimma-core does.
    #[test]
    fn fill_limits_are_tool_errors() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        let fields = |n: usize, value: &str| {
            let one = format!(
                r#"{{"label":"{{}}","value":{}}}"#,
                Value::String(value.into())
            );
            let labels = ["a", "s", "d", "f", "g", "h", "j", "k", "l"];
            let mut all = Vec::new();
            'outer: for x in labels {
                for y in labels {
                    if all.len() == n {
                        break 'outer;
                    }
                    all.push(one.replace("{}", &format!("{x}{y}")));
                }
            }
            format!(r#"{{"tab":"1","fields":[{}]}}"#, all.join(","))
        };
        assert!(matches!(
            handle(
                &mut p,
                &call_line(5, "vimma_fill", &fields(32, &"é".repeat(1024)))
            ),
            Action::Call(_)
        ));
        for (arguments, says) in [
            (fields(33, "x"), "fields must be a list of 1 to 32 fields"),
            (
                fields(1, &"x".repeat(1025)),
                "a text of at most 1024 characters",
            ),
        ] {
            let r = reply(&mut p, &call_line(5, "vimma_fill", &arguments));
            assert!(tool_error_text(&r).contains(says), "{r}");
        }
    }

    // Issue #584: vimma_open, vimma_activate and vimma_fill take elements, and vimma_screenshot
    // full, each sent to Vimma only when true; anything else is a tool error that never reaches
    // Vimma.
    #[test]
    fn steps_take_an_elements_flag_and_screenshots_a_full_one() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (tool, arguments, command, sent) in [
            (
                "vimma_open",
                r#"{"url":"https://a/","elements":true}"#,
                "agent-open",
                r#"{"elements":true,"url":"https://a/"}"#,
            ),
            (
                "vimma_open",
                r#"{"url":"https://a/","tab":"4","elements":false}"#,
                "agent-open",
                r#"{"tab":"4","url":"https://a/"}"#,
            ),
            (
                "vimma_activate",
                r#"{"tab":"12","label":"sd","elements":true}"#,
                "agent-activate",
                r#"{"elements":true,"label":"sd","tab":"12"}"#,
            ),
            (
                "vimma_fill",
                r#"{"tab":"12","fields":[{"label":"sd","value":"x"}],"elements":true}"#,
                "agent-fill",
                r#"{"elements":true,"fields":[{"label":"sd","value":"x"}],"tab":"12"}"#,
            ),
            (
                "vimma_screenshot",
                r#"{"tab":"12","full":true}"#,
                "agent-screenshot",
                r#"{"full":true,"tab":"12"}"#,
            ),
            (
                "vimma_screenshot",
                r#"{"tab":"12","full":false,"labels":true}"#,
                "agent-screenshot",
                r#"{"labels":true,"tab":"12"}"#,
            ),
        ] {
            let Action::Call(call) = handle(&mut p, &call_line(5, tool, arguments)) else {
                panic!("{tool} {arguments}: not a call");
            };
            assert_eq!(call.tool.command().0, command);
            assert_eq!(call.tool.command().1.to_string(), sent, "{arguments}");
        }
        let flag = "elements must be true or false";
        for (tool, arguments, says) in [
            (
                "vimma_open",
                r#"{"url":"https://a/","elements":"yes"}"#,
                flag,
            ),
            (
                "vimma_activate",
                r#"{"tab":"12","label":"sd","elements":1}"#,
                flag,
            ),
            (
                "vimma_fill",
                r#"{"tab":"12","fields":[{"label":"sd","value":"x"}],"elements":null}"#,
                flag,
            ),
            (
                "vimma_screenshot",
                r#"{"tab":"12","full":4000}"#,
                "full must be true or false",
            ),
            (
                "vimma_elements",
                r#"{"tab":"12","elements":true}"#,
                "unknown argument \"elements\"",
            ),
        ] {
            let Action::Reply(r) = handle(&mut p, &call_line(6, tool, arguments)) else {
                panic!("{arguments}: reached Vimma");
            };
            let t = tool_error_text(&r);
            assert!(t.contains(says), "{arguments}: {t}");
        }
    }

    // agent-speed Behaviour 4 (builtin-agent B2): vimma_elements takes query, kinds and full;
    // a step takes query and kinds with elements: true; anything else never reaches Vimma.
    #[test]
    fn element_lists_take_query_kinds_and_full() {
        let mut p = Protocol::new();
        reply(&mut p, INIT);
        for (tool, arguments, sent) in [
            (
                "vimma_elements",
                r#"{"tab":"12","query":"oat drink","kinds":["button","link"],"full":true}"#,
                r#"{"full":true,"kinds":["button","link"],"query":"oat drink","tab":"12"}"#,
            ),
            (
                "vimma_elements",
                r#"{"tab":"12","full":false}"#,
                r#"{"tab":"12"}"#,
            ),
            (
                "vimma_open",
                r#"{"url":"https://a/","elements":true,"query":"oat"}"#,
                r#"{"elements":true,"query":"oat","url":"https://a/"}"#,
            ),
            (
                "vimma_activate",
                r#"{"tab":"12","label":"sd","elements":true,"kinds":["field"]}"#,
                r#"{"elements":true,"kinds":["field"],"label":"sd","tab":"12"}"#,
            ),
            (
                "vimma_fill",
                r#"{"tab":"12","fields":[{"label":"sd","value":"x"}],"elements":true,"query":"a b"}"#,
                r#"{"elements":true,"fields":[{"label":"sd","value":"x"}],"query":"a b","tab":"12"}"#,
            ),
        ] {
            let Action::Call(call) = handle(&mut p, &call_line(5, tool, arguments)) else {
                panic!("{tool} {arguments}: not a call");
            };
            assert_eq!(call.tool.command().1.to_string(), sent, "{arguments}");
        }
        let query = "query must be 1 to 200 characters of one line";
        let kinds = "kinds must be distinct kinds of link, button, field, checkbox, radio, select, \
                     click";
        let with = "query and kinds come only with elements: true";
        let long = format!(r#"{{"tab":"12","query":"{}"}}"#, "a".repeat(201));
        for (tool, arguments, says) in [
            ("vimma_elements", r#"{"tab":"12","query":""}"#, query),
            ("vimma_elements", r#"{"tab":"12","query":"a\nb"}"#, query),
            ("vimma_elements", r#"{"tab":"12","query":1}"#, query),
            ("vimma_elements", long.as_str(), query),
            ("vimma_elements", r#"{"tab":"12","kinds":[]}"#, kinds),
            ("vimma_elements", r#"{"tab":"12","kinds":["menu"]}"#, kinds),
            ("vimma_elements", r#"{"tab":"12","kinds":"button"}"#, kinds),
            (
                "vimma_elements",
                r#"{"tab":"12","kinds":["link","link"]}"#,
                kinds,
            ),
            (
                "vimma_elements",
                r#"{"tab":"12","full":"yes"}"#,
                "full must be true or false",
            ),
            ("vimma_open", r#"{"url":"https://a/","query":"oat"}"#, with),
            (
                "vimma_activate",
                r#"{"tab":"12","label":"sd","elements":false,"kinds":["link"]}"#,
                with,
            ),
            (
                "vimma_open",
                r#"{"url":"https://a/","elements":true,"full":true}"#,
                "unknown argument \"full\"",
            ),
        ] {
            let Action::Reply(r) = handle(&mut p, &call_line(6, tool, arguments)) else {
                panic!("{arguments}: reached Vimma");
            };
            let t = tool_error_text(&r);
            assert!(t.contains(says), "{arguments}: {t}");
        }
    }
}
