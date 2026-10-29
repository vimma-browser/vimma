/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Regenerates packages/vimma-core/src/agent-tools-data.mjs from vimma-ctl's MCP tool fixture
// and its INSTRUCTIONS (docs/specs/builtin-agent.md B6), so the built-in agent offers exactly
// the tools and system text MCP agents get. vimma-core cannot read files at run time (it runs
// in Firefox's parent process and in Node), hence a generated module; agent-tools.test.mjs
// fails when it drifts from either source.
//
//   npm run gen-agent-tools

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const FIXTURE = "tools/vimma-ctl/tests/fixtures/mcp/tools-list.json";
const MCP_RS = "tools/vimma-ctl/src/mcp.rs";
const OUT = "packages/vimma-core/src/agent-tools-data.mjs";

/** @type {Record<string, string>} */
const ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", 0: "\0" };

/**
 * The value of `const NAME: &str = "...";` in Rust source: a `\` at a line's end joins the next
 * line without its leading whitespace, as Rust does, and the simple escapes are read.
 * @param {string} src @param {string} name
 */
export function rustStringConst(src, name) {
  const m = new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(src);
  if (!m) throw new Error(`no string constant ${name}`);
  return m[1].replace(/\\(\n\s*|[ntr\\"'0])/g, (_, e) => (e[0] === "\n" ? "" : ESCAPES[e]));
}

function generate() {
  const tools = JSON.parse(readFileSync(new URL(FIXTURE, root), "utf8")).tools;
  const instructions = rustStringConst(readFileSync(new URL(MCP_RS, root), "utf8"), "INSTRUCTIONS");
  const body = [
    "/* This Source Code Form is subject to the terms of the Mozilla Public",
    " * License, v. 2.0. If a copy of the MPL was not distributed with this",
    " * file, You can obtain one at http://mozilla.org/MPL/2.0/. */",
    "",
    `// Generated from ${FIXTURE}`,
    `// and INSTRUCTIONS in ${MCP_RS} by \`npm run gen-agent-tools\`; do not edit.`,
    "",
    "/** @type {string} */",
    `export const AGENT_INSTRUCTIONS = ${JSON.stringify(instructions)};`,
    "",
    "/** @type {ReadonlyArray<{ name: string, title: string, description: string, inputSchema: any, annotations: any }>} */",
    `export const AGENT_TOOL_LIST = ${JSON.stringify(tools)};`,
    "",
  ].join("\n");
  const out = fileURLToPath(new URL(OUT, root));
  writeFileSync(out, body);
  execFileSync("npx", ["prettier", "--log-level", "warn", "--write", out], { stdio: "inherit" });
  console.log(`gen-agent-tools: ${tools.length} tools -> ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) generate();
