/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The MCP side of `vimma-ctl mcp` (docs/specs/vimma-mcp.md, decisions 1 and 5): JSON-RPC lines
//! in, JSON-RPC lines out, with no I/O here. `mcp_serve` does the reading, writing and the
//! control-socket connection.
//!
//! Dual-era (MCP revision 2026-07-28, basic/versioning, "Backward Compatibility"): `initialize`
//! selects the legacy revisions 2025-11-25 and 2025-06-18 for the process, and a request that
//! carries `_meta["io.modelcontextprotocol/protocolVersion"]` is served statelessly as
//! 2026-07-28. Only tools are offered: no resources, prompts, sampling or elicitation, which
//! would put the confirmation in the agent's own UI.

use crate::json::Value;
use std::collections::BTreeMap;

mod args;
mod command;
mod instructions;
mod render;
mod server;
#[cfg(test)]
mod test_support;
mod tool_list;
mod types;

pub use args::{MAX_FILL_FIELDS, MAX_FILL_VALUE};
pub use instructions::INSTRUCTIONS;
pub use render::{failure_text, tool_result, with_note};
pub use server::{Protocol, clean_label, parse_error, too_long};
pub use tool_list::tools;
pub use types::{
    Action, Call, ClientLabel, Era, Failure, FillField, FillSubmit, FillValue, Format, ListFilters,
    ToolCall,
};

/// The modern revision (per-request `_meta`, `server/discover`).
pub const MODERN: &str = "2026-07-28";
/// The legacy revisions `initialize` may select; the first is chosen for any other request.
pub const LEGACY: [&str; 2] = ["2025-11-25", "2025-06-18"];
/// What `server/discover` and an unsupported version's error list.
pub const SUPPORTED: [&str; 3] = [MODERN, LEGACY[0], LEGACY[1]];

/// JSON-RPC 2.0 and MCP error codes.
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
/// MCP 2026-07-28's `UnsupportedProtocolVersion`.
pub const UNSUPPORTED_VERSION: i64 = -32022;

/// Longest input line read from the MCP client, in bytes, without the newline. Every tool's
/// arguments fit in far less (the longest is a URL of at most 65,536 characters).
pub const MAX_INPUT_LINE: usize = 1024 * 1024;
/// Longest URL `vimma_open` passes on, in UTF-16 code units as the browser counts them.
pub const MAX_URL: usize = 65_536;
/// Most text one read may ask for (vimma-core's `MAX_READ_CHARS`).
pub const MAX_READ_CHARS: u64 = 500_000;
/// Longest client name or version passed on as a label (vimma-core's `agent-hello` check).
pub const MAX_LABEL: usize = 64;
/// `vimma_keys`'s limits (docs/specs/mcp-drive.md D15, vimma-core's `AGENT_KEY_LIMITS`): the
/// keys in characters, a count, a find query in characters.
pub const MAX_KEYS: usize = 512;
pub const MAX_COUNT: u32 = 99;
pub const MAX_QUERY: usize = 256;

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT: &str = "io.modelcontextprotocol/clientInfo";
const META_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER: &str = "io.modelcontextprotocol/serverInfo";

fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

fn object<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect::<BTreeMap<_, _>>(),
    )
}
