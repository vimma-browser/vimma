/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/guide.md's config.toml reference (issue #1443): the :config template's own annotated
// lines (vimma-core's configTables), grouped by topic, each block followed by links to the
// sections that say more. npm run gen-docs writes it into the guide, from its first heading up
// to "### Search engines"; no marker comments, since vimma.dev's renderer would show them.
import { configTables } from "../../packages/vimma-core/src/index.mjs";

const FIRST = "### Keys and modes";
const NEXT = "### Search engines";

/** A heading, the tables of its block, and where to read more. */
const GROUPS: { heading: string; tables: string[]; more: [string, string][] }[] = [
  {
    heading: FIRST,
    tables: ["keys", "modal", "unbind", "firefox", "sites"],
    more: [
      ["Every key is yours", "#every-key-is-yours"],
      ["Default bindings", "bindings.md"],
      ["Normal and insert mode", "#normal-and-insert-mode"],
      ["Link hints", "#link-hints"],
      ["PDF viewer", "#pdf-viewer"],
      ["Firefox's own shortcuts", "#firefoxs-own-shortcuts"],
      ["Keys a site keeps", "#keys-a-site-keeps"],
    ],
  },
  {
    heading: "### Panes, look and browsing",
    tables: [
      "panes",
      "theme",
      "theme.colors",
      "ui",
      "statusbar",
      "panel",
      "scroll",
      "private",
      "bookmarks",
      "tabs",
      "passwords",
      "updates",
    ],
    more: [
      ["Several splits", "#several-splits"],
      ["Layouts", "#layouts"],
      ["Picking a tab during a split", "#picking-a-tab-during-a-split"],
      ["Colours and themes", "#colours-and-themes"],
      ["Hiding the toolbar", "#hiding-the-toolbar"],
      ["Tab line", "#tab-line"],
      ["Firefox's Bookmarks Toolbar", "#firefoxs-bookmarks-toolbar"],
      ["Side panel", "#side-panel"],
      ["Private workspace", "#private-workspace"],
      ["Bookmarks", "#bookmarks"],
      ["Bookmarks in a file", "#bookmarks-in-a-file"],
      ["Sleeping tabs", "#sleeping-tabs"],
      ["Saved passwords", "#saved-passwords"],
      ["Updates", "#updates"],
    ],
  },
  {
    heading: "### Workspaces and routing",
    tables: ["workspaces", "routes", "routing"],
    more: [
      ["Workspaces", "#workspaces"],
      ["Routing", "#routing-which-workspace-a-link-opens-in"],
    ],
  },
  {
    heading: "### AI agents",
    tables: ["mcp", "agent"],
    more: [
      ["Agent workspace", "#agent-workspace"],
      ["Downloads from the agent workspace", "#downloads-from-the-agent-workspace"],
      ["Vimma's own agent", "#vimmas-own-agent"],
      ["Choosing a model for the agent chat", "#choosing-a-model-for-the-agent-chat"],
      ["Using an agent CLI in the chat window", "#using-an-agent-cli-in-the-chat-window"],
    ],
  },
];

/** `text` in lines of at most 100 columns, as the guide's paragraphs are written. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > 100) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}

/** The reference as Markdown, from its first heading to the line before "### Search engines". */
export function configReferenceMarkdown(): string {
  const tables = new Map(configTables({ brief: true }).map((t) => [t.name, t.lines]));
  const out: string[] = [];
  for (const g of GROUPS) {
    out.push(g.heading, "");
    const block = g.tables.map((name) => {
      const lines = tables.get(name);
      if (!lines) throw new Error(`config reference: no table "${name}" in configTables`);
      return lines.join("\n");
    });
    out.push("```toml", block.join("\n\n"), "```", "");
    out.push(...wrap(`See also: ${g.more.map(([t, href]) => `[${t}](${href})`).join(", ")}.`), "");
  }
  return out.join("\n");
}

/** `guide` with its config.toml reference replaced by the generated one. */
export function spliceConfigReference(guide: string): string {
  const start = guide.indexOf(`\n${FIRST}\n`);
  const end = guide.indexOf(`\n${NEXT}\n`, start);
  if (start < 0 || end < 0) {
    throw new Error(`docs/guide.md: the config.toml reference runs from "${FIRST}" to "${NEXT}"`);
  }
  return `${guide.slice(0, start + 1)}${configReferenceMarkdown()}\n${guide.slice(end + 1)}`;
}
