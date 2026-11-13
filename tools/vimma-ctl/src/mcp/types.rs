/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The checked forms of what the client sends and of what is done with it: the revision, the
//! client's label, a tool call and its arguments, and the outcome of a line.

use super::text;
use crate::json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

/// Which revision a request is served under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Era {
    /// 2025-11-25 or 2025-06-18, after `initialize`.
    Legacy,
    /// 2026-07-28: `resultType` and `_meta` serverInfo in every result.
    Modern,
}

/// The MCP client's self-reported name, a label for the question in Vimma and never proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientLabel {
    pub name: String,
    pub version: Option<String>,
}

/// `vimma_read_page`'s `format`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Text,
}

/// A tool call, checked: one agent command (decision 5's table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolCall {
    Tabs,
    Read {
        tab: String,
        format: Option<Format>,
        max_chars: Option<u64>,
    },
    /// With `elements`, waits for the page and returns its element list (issue #584).
    Open {
        url: String,
        tab: Option<String>,
        elements: bool,
        filters: ListFilters,
    },
    Close {
        tab: String,
    },
    /// mcp-drive D8: Vimma's own page keys in an agent tab.
    Keys {
        tab: String,
        keys: String,
    },
    /// mcp-drive D2: the agent workspace brought to the front with this tab selected.
    Show {
        tab: String,
    },
    /// mcp-forms F2: the tab's buttons, fields and links with hint labels; only those the
    /// filters keep (builtin-agent B2), and every line, also those as in the conversation's last
    /// list of the site, when `full` (agent-speed S4).
    Elements {
        tab: String,
        filters: ListFilters,
        full: bool,
    },
    /// mcp-forms F8: a click on one element of the tab, by its label from `Elements`.
    Activate {
        tab: String,
        label: String,
        elements: bool,
        filters: ListFilters,
    },
    /// mcp-forms F12: fields of the tab set by their labels from `Elements`, then perhaps the
    /// form submitted (F15).
    Fill {
        tab: String,
        fields: Vec<FillField>,
        submit: Option<FillSubmit>,
        elements: bool,
        filters: ListFilters,
    },
    /// mcp-forms F18: an image of the tab's viewport, with the labels of the last `Elements`
    /// drawn on it when `labels` (F20); full size when `full` (issue #584).
    Screenshot {
        tab: String,
        labels: bool,
        full: bool,
    },
    /// mcp-forms F22: the tab's script errors and failed requests, only those after `since`
    /// (ms since the epoch) when given.
    Console {
        tab: String,
        since: Option<u64>,
    },
}

/// An element list's filters (builtin-agent B2, agent-speed Behaviour 4): words its lines must
/// hold, and the kinds they must be; vimma-core's `checkListFilters`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListFilters {
    pub query: Option<String>,
    pub kinds: Option<Vec<String>>,
}

impl ListFilters {
    pub(super) fn any(&self) -> bool {
        self.query.is_some() || self.kinds.is_some()
    }

    pub(super) fn insert_into(&self, args: &mut BTreeMap<String, Value>) {
        if let Some(query) = &self.query {
            args.insert("query".into(), text(query));
        }
        if let Some(kinds) = &self.kinds {
            args.insert(
                "kinds".into(),
                Value::Array(kinds.iter().map(|k| text(k)).collect()),
            );
        }
    }
}

/// One field of a `vimma_fill`: its label and what to set it to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillField {
    pub label: String,
    pub value: FillValue,
}

/// A text for a text field, a text area or a select; true or false for a checkbox or radio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FillValue {
    Text(String),
    Flag(bool),
}

/// How a `vimma_fill` submits its form afterwards (mcp-forms F15).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FillSubmit {
    /// `true`: the form's default submission, as Enter in a field sends it.
    Form,
    /// A submit button's label, from `Elements`.
    Button(String),
}

/// A `tools/call` to forward to Vimma.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    /// The MCP request id, echoed in the response.
    pub id: Value,
    pub era: Era,
    pub tool: ToolCall,
}

/// What a line from the MCP client asks of the server.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Nothing to do: a notification, or a response the client sent.
    None,
    /// Write this response.
    Reply(Value),
    /// Ask Vimma, then answer with [`tool_result`](super::tool_result).
    Call(Call),
    /// `notifications/cancelled` for this request id.
    Cancel(Value),
}

/// Why a tool call has no result from Vimma. Each becomes a tool error the model can act on
/// (decision 5): the call was well formed, so it is not a JSON-RPC error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// Vimma said no: `user`, `timeout`, `busy`, `muted`, `changed` or `cancelled`. `waited` is
    /// how long the call waited, which names the timeout.
    Denied { reason: String, waited: Duration },
    /// Vimma said `busy` with `retryAfter`: one of this connection's per-minute rates is used up.
    /// `message` names the limit; `retry_after` is when the next call is allowed.
    RateLimited {
        message: String,
        retry_after: Duration,
    },
    /// Vimma answered with another error code.
    Refused { code: String, message: String },
    /// No discovery file, a stale one, or nothing listening.
    NotRunning(String),
    /// Run by Vimma with a ticket, and nothing listens for it: the task ended or was stopped.
    TaskEnded(String),
    /// Vimma runs, but its agent role is off.
    McpOff,
    /// Vimma speaks only this older protocol.
    TooOld(u64),
    /// Vimma's control socket has no room for another connection.
    Busy,
    /// More calls are waiting here than Vimma would take.
    TooMany,
    /// The connection closed before the answer came.
    Dropped,
    /// No answer at all within this long.
    NoAnswer(Duration),
    /// Vimma broke the protocol.
    Protocol(String),
}
