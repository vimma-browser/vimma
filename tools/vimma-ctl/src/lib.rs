/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Client for Vimma's control socket, protocols 1 and 2
//! (docs/specs/m0-control-protocol-and-vimma-ctl.md), and `vimma-ctl mcp`, the MCP server over
//! stdio for local AI agents (docs/specs/vimma-mcp.md).

pub mod cli;
pub mod client;
pub mod discovery;
pub mod hmac;
pub mod json;
pub mod mcp;
pub mod mcp_serve;
pub mod protocol;
pub mod version;
