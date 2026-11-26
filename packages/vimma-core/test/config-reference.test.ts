// defaults.toml as the annotated config.toml reference (issue #1443): every key the parser takes
// appears as `key = default` (or a commented example when it has no default) with a short note,
// so the :config template, docs/guide.md and vimma.dev read like the file itself.
import { describe, expect, test } from "vitest";
import { configTables, formatConfigTemplate, formatDefaultsToml } from "../src/config/defaults.mjs";
import {
  AGENT_DEFAULTS,
  CONTAINER_COLORS,
  CONTAINER_ICONS,
  MCP_BOUNDS,
  parseConfig,
} from "../src/config/config.mjs";

/** `table.key` for every key line, commented or not, outside the keymap's own tables. */
function settingNames(toml: string): string[] {
  const names: string[] = [];
  let table = "";
  for (const line of toml.split("\n")) {
    const header = /^(?:# )?\[\[?([^\]]+)\]\]?(?:\s|$)/.exec(line);
    const h = header?.[1];
    if (h) {
      if (h.startsWith("sites.")) table = "sites.<host>";
      else if (h.startsWith("workspaces.")) table = "workspaces.<name>";
      else table = h;
      continue;
    }
    if (table === "keys" || table.startsWith("modal.") || table === "search.aliases") continue;
    const key = /^(?:# )?([a-z_]+) = /.exec(line);
    if (key?.[1]) names.push(`${table}.${key[1]}`);
  }
  return names;
}

/** The settings part of the file: everything after the keymap's tables. */
const settings = () => {
  const toml = formatDefaultsToml();
  return toml.slice(toml.indexOf("\n[unbind]"));
};

describe("defaults.toml as the config.toml reference (#1443)", () => {
  test("names every key config.toml takes, with its default or an example", () => {
    const toml = formatDefaultsToml();
    const keys = toml.slice(toml.indexOf("[keys]"), toml.indexOf("\n[modal]"));
    expect(keys).toMatch(/^prefix = "ctrl\+b"/m);
    expect(new Set(settingNames(toml))).toEqual(
      new Set([
        "modal.leader",
        "modal.timeout_ms",
        "modal.hint_chars",
        "modal.insert_editing",
        "unbind.normal",
        "firefox.disable",
        "firefox.enable",
        "workspaces.<name>.color",
        "workspaces.<name>.icon",
        "workspaces.<name>.home",
        // autofill is accepted and does nothing yet: no line invites setting it (#1474).
        "theme.source",
        "theme.name",
        "theme.appearance",
        "theme.font",
        "theme.colors.accent",
        "panes.max",
        "panes.max_splits",
        "panes.layout",
        "panes.main_size",
        "panes.new_tab",
        "bookmarks.root",
        "bookmarks.bookmarklets",
        "bookmarks.write_back",
        "panel.numbers",
        "scroll.step",
        "private.placement",
        "ui.toolbar",
        "ui.bookmarks_toolbar",
        "ui.pdf_outline",
        "ui.tabline",
        "ui.tabline_width",
        "statusbar.tab",
        "tabs.sleep_after",
        "tabs.sleep_on_low_memory",
        "updates.check",
        "mcp.enabled",
        "mcp.workspace",
        "mcp.ask_timeout",
        "mcp.grant_minutes",
        "mcp.grant_max_minutes",
        "mcp.max_read_chars",
        "mcp.notify",
        "mcp.download_dir",
        "mcp.download_max_mb",
        "mcp.clamav_max_age_days",
        "mcp.open_per_minute",
        "mcp.load_per_minute",
        "agent.default",
        "agent.local_only",
        "agent.max_running",
        "agent.max_steps",
        "agent.max_tokens",
        "agent.max_cost",
        "agent.keep_days",
        "agent.keep_results",
        "agent.providers.name",
        "agent.providers.kind",
        "agent.providers.endpoint",
        "agent.providers.model",
        "agent.providers.vision",
        "agent.providers.price_in",
        "agent.providers.price_out",
        "agent.providers.cli",
        "agent.providers.max_minutes",
        "sites.<host>.insert",
        "sites.<host>.sleep",
        "sites.<host>.unbind",
        "routes.domain",
        "routes.url",
        "routes.app",
        "routes.workspace",
        "routing.default_workspace",
        "search.default",
      ]),
    );
  });

  test("every setting carries a note on its own line, after its value", () => {
    const bare = settings()
      .split("\n")
      .filter((l) => /^(?:# )?[a-z_]+ = /.test(l) && !/ {2,}# \S/.test(l));
    expect(bare).toEqual([]);
  });

  test("each setting's note is one line, never carried on to the next", () => {
    expect(
      formatDefaultsToml()
        .split("\n")
        .filter((l) => /^ +#/.test(l)),
    ).toEqual([]);
  });

  test("the template's lines fit 100 columns", () => {
    const long = formatConfigTemplate()
      .split("\n")
      .filter((l) => l.length > 100);
    expect(long).toEqual([]);
  });

  test("[mcp] says each key's range on its own line", () => {
    const mcp = settings().slice(settings().indexOf("[mcp]"));
    const line = (key: string) => mcp.split("\n").find((l) => l.startsWith(`${key} = `)) ?? "";
    const { askTimeout, grantMaxMinutes, maxReadChars, downloadMaxMb, clamavMaxAgeDays } =
      MCP_BOUNDS;
    expect(line("ask_timeout")).toContain(`(${askTimeout.min}–${askTimeout.max})`);
    expect(line("grant_max_minutes")).toContain(`(${grantMaxMinutes.min}–${grantMaxMinutes.max})`);
    expect(line("max_read_chars")).toContain(`(${maxReadChars.min}–${maxReadChars.max})`);
    expect(line("download_max_mb")).toContain(`(${downloadMaxMb.min}–${downloadMaxMb.max})`);
    expect(line("clamav_max_age_days")).toContain(
      `(${clamavMaxAgeDays.min}–${clamavMaxAgeDays.max})`,
    );
    const { openPerMinute, loadPerMinute } = MCP_BOUNDS;
    expect(line("open_per_minute")).toContain(`(${openPerMinute.min}–${openPerMinute.max})`);
    expect(line("load_per_minute")).toContain(`(${loadPerMinute.min}–${loadPerMinute.max})`);
  });

  test("[agent]'s example lines are its defaults", () => {
    const agent = settings().slice(settings().indexOf("# [agent]"));
    expect(agent).toMatch(new RegExp(`^# max_running = ${AGENT_DEFAULTS.maxRunning} `, "m"));
    expect(agent).toMatch(new RegExp(`^# max_steps = ${AGENT_DEFAULTS.maxSteps} `, "m"));
    expect(agent).toMatch(new RegExp(`^# max_tokens = ${AGENT_DEFAULTS.maxTokens} `, "m"));
    expect(agent).toMatch(new RegExp(`^# max_cost = ${AGENT_DEFAULTS.maxCost} `, "m"));
  });

  test("a workspace's notes list every container colour and icon", () => {
    const ws = settings().slice(settings().indexOf("# Workspaces"), settings().indexOf("[theme]"));
    for (const c of CONTAINER_COLORS) expect(ws).toContain(c);
    for (const i of CONTAINER_ICONS) expect(ws).toContain(i);
  });

  test("its example lines, uncommented, are a config.toml Vimma accepts", () => {
    const text = configTables()
      .filter((t) => t.name !== "keys" && t.name !== "modal")
      .flatMap((t) => t.lines)
      .map((l) => (/^# (?:\[|[a-z_0-9]+ = )/.test(l) ? l.slice(2) : l))
      .join("\n");
    const r = parseConfig(text);
    expect(r.errors).toEqual([]);
    expect(r.config?.panes.maxSplits).toBe(9);
    expect(r.config?.agent.providers.map((p) => p.name)).toEqual(["local", "claude"]);
  });
});
