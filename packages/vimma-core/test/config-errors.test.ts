// What config.toml's errors say and where they point, for mistakes a user makes while editing
// the file Vimma creates (#1270, #1273, #1283, #1284): each names the line the user wrote and
// says what to write instead.
import { describe, expect, test } from "vitest";
import { addAgentProviderText, formatConfigError, parseConfig } from "../src/config/config.mjs";
import { formatConfigTemplate } from "../src/config/defaults.mjs";
import { parseToml } from "../src/config/toml.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";
const template = formatConfigTemplate();
const lineCount = template.split("\n").length - (template.endsWith("\n") ? 1 : 0);

/** Each error as formatConfigError writes it. */
function errors(text: string) {
  return parseConfig(text).errors.map((e) => formatConfigError(e, "config.toml"));
}

describe("dotted keys pasted outside their table (#1270)", () => {
  const pasted = ['keys.prefix = "ctrl+a"', 'modal.leader = ","'];

  test("at the end of the template, they name the table they belong in", () => {
    const text = `${template}${pasted.join("\n")}\n`;
    expect(errors(text)).toEqual([
      `config.toml:${lineCount + 1}: mcp.keys: unknown key "keys": a keys.… line belongs under [keys], without "keys."`,
      `config.toml:${lineCount + 2}: mcp.modal: unknown key "modal": a modal.… line belongs under [modal], without "modal."`,
    ]);
  });

  test("a top-level table name is not offered as a near miss of a key", () => {
    const [e] = parseConfig(cfg("[ui]", 'keys.prefix = "ctrl+a"')).errors;
    expect(e).not.toHaveProperty("suggestion");
  });

  test("at the top of the template, the redefinition says a table cannot be both", () => {
    const lines = template.split("\n");
    lines.splice(1, 0, ...pasted);
    const r = parseToml(lines.join("\n"));
    expect(r).toEqual({
      ok: false,
      error: {
        line: lines.indexOf("[keys]") + 1,
        column: 2,
        message:
          "trying to redefine an already defined table or value " +
          "([keys] is already made by a keys.… line above: a table is either dotted keys or a " +
          '[keys] header, not both; write those lines under [keys], without "keys.")',
      },
    });
  });

  test("a near miss or a plain value is an ordinary unknown key", () => {
    expect(errors(cfg("[mcp]", 'workspaces = "agent"'))).toEqual([
      'config.toml:3: mcp.workspaces: unknown key "workspaces" (did you mean "workspace"?)',
    ]);
    expect(errors(cfg("[ui]", 'search = "x"'))).toEqual([
      'config.toml:3: ui.search: unknown key "search"',
    ]);
  });

  test("the guide's example pasted with its headers names the header already there", () => {
    const text = `${template}[keys]\nprefix = "ctrl+a"\n`;
    const r = parseToml(text);
    expect(!r.ok && r.error).toEqual({
      line: lineCount + 1,
      column: 2,
      message:
        "trying to redefine an already defined table or value " +
        `([keys] is already at line ${template.split("\n").indexOf("[keys]") + 1}: put these lines under it)`,
    });
  });

  test("a redefinition made otherwise has no such hint", () => {
    // An inline table is not looked for; nor is a header the scan does not read as one.
    const r = parseToml("keys = { a = 1 }\n[keys]\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toBe("trying to redefine an already defined table or value");
  });
});

describe("a bad prefix names keys.prefix and its line (#1273)", () => {
  test("a prefix that a built-in [modal.pdf] key uses", () => {
    expect(errors(cfg("[keys]", 'prefix = "a"'))).toEqual([
      'config.toml:3: keys.prefix: "a" is a [modal.pdf] key by default (pdf_fit_page), and the ' +
        "prefix must work in every mode: pick a chord such as ctrl+a",
    ]);
  });

  test("a prefix the user's own [modal.pdf] binds still names that binding", () => {
    expect(
      errors(cfg("[keys]", 'prefix = "ctrl+a"', "[modal.pdf]", '"<C-a>x" = "pdf.fit_page"')),
    ).toEqual(['config.toml:5: modal.pdf."<C-a>x": [modal.pdf] cannot bind the prefix']);
  });

  test("a prefix of two chords says the prefix is one", () => {
    expect(errors(cfg("[keys]", 'prefix = "ctrl+b ctrl+b"'))).toEqual([
      'config.toml:3: keys.prefix: the prefix is one chord, such as "ctrl+b", got "ctrl+b ctrl+b"',
    ]);
  });

  test("a leader of two keys says the leader is one", () => {
    expect(errors(cfg("[modal]", 'leader = ", ,"'))).toEqual([
      'config.toml:3: modal.leader: the leader is one key, such as "space", got ", ,"',
    ]);
  });
});

describe("an unclosed bracket at the end of the file (#1273)", () => {
  test("is reported at its own line, not one past the end", () => {
    expect(parseToml("a = 1\noops = [\n")).toEqual({
      ok: false,
      error: { line: 2, column: 8, message: 'unclosed "[": the file ends before it is closed' },
    });
    expect(parseToml("a = 1\nx = { b = 1,\n\n")).toEqual({
      ok: false,
      error: { line: 2, column: 5, message: 'unclosed "{": the file ends before it is closed' },
    });
  });

  test("at the end of the template", () => {
    const [e] = errors(`${template}oops = [\n`);
    expect(e).toBe(
      `config.toml:${lineCount + 1}:8: unclosed "[": the file ends before it is closed`,
    );
  });

  test("an error at the end of a file without a bracket stays on its last line", () => {
    const r = parseToml("a = 1\nb =\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.line).toBe(2);
  });
});

describe("a search alias template with a control character (#1283)", () => {
  test.each([
    ['"""https://a.example/?q=\n%s"""', "a line break"],
    ['"https://a.example/?q=%s\\r"', "a line break"],
    ['"https://a.example/?q=\\t%s"', "a tab"],
  ])("%s is refused, naming the alias", (value) => {
    expect(errors(cfg("[search.aliases]", `g = ${value}`))).toEqual([
      "config.toml:3: search.aliases.g: a template is one line without control characters (a line break, a tab)",
    ]);
  });
});

describe("adding an agent provider says what is wrong with it (#1284)", () => {
  const cli = { name: "c", kind: "cli", cli: "claude-code", endpoint: "", model: "" };
  const opts = { makeDefault: false };

  test("an unknown CLI", () => {
    expect(addAgentProviderText(cfg(), { ...cli, cli: "nope" }, opts)).toEqual({
      error: 'unknown agent CLI "nope"',
    });
  });

  test("a CLI given an endpoint", () => {
    expect(addAgentProviderText(cfg(), { ...cli, endpoint: "http://localhost:1" }, opts)).toEqual({
      error: "a CLI provider has no endpoint: the CLI decides where it sends requests",
    });
  });

  test("a provider with no model", () => {
    const noModel = { ...cli, model: undefined } as unknown as typeof cli;
    expect(addAgentProviderText(cfg(), noModel, opts)).toEqual({
      error: 'the provider has no model (an agent CLI takes "" for its own default)',
    });
  });

  test("a provider that does not read back as given still meets the guard", () => {
    // No endpoint key at all: past the early checks, and read back as "", not undefined.
    const noEndpoint = { name: "c", kind: "cli", cli: "claude-code", model: "m" };
    expect(addAgentProviderText(cfg(), noEndpoint as typeof cli, opts)).toEqual({
      error: "the edit would change other keys of config.toml; nothing written",
    });
  });

  test("these are checked before the file is, so a broken file does not hide them", () => {
    expect(addAgentProviderText("[", { ...cli, cli: "nope" }, opts)).toEqual({
      error: 'unknown agent CLI "nope"',
    });
  });
});
