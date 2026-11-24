// config.toml's writers and messages (#1474): a valid file written with dotted keys or an inline
// table is edited where that is safe and otherwise refused with the exact line to add by hand,
// every writer keeps a CRLF file's line endings, a key defined twice names its first line, and
// the template points to the vimma.dev reference and has no line for a key that does nothing.
import { describe, test, expect } from "vitest";
import {
  addAgentProviderText,
  appendRouteText,
  parseConfig,
  setConfigKeysText,
} from "../src/config/config.mjs";
import { formatConfigTemplate } from "../src/config/defaults.mjs";
import { editSiteUnbindText } from "../src/config/site-edit.mjs";
import { appendRouteFileText } from "../src/config/routes-file.mjs";
import { parseToml, setTomlKeys as setTomlKeysText } from "../src/config/toml.mjs";

const step = (value: number) => [{ table: "scroll", key: "step", value }];

describe("a table written with dotted keys or inline", () => {
  test("a dotted key line before the first header is edited in place", () => {
    const text = '# mine\nscroll.step = 5 # quick\n\n[ui]\ntoolbar = "shown"\n';
    expect(setConfigKeysText(text, step(9))).toEqual({
      text: '# mine\nscroll.step = 9 # quick\n\n[ui]\ntoolbar = "shown"\n',
    });
  });

  test("a new key of a dotted table goes on a dotted line after its last one", () => {
    const ok = setConfigKeysText('ui.toolbar = "shown"\n[keys]\n', [
      { table: "ui", key: "tabline", value: "auto" },
    ]);
    expect(ok).toEqual({ text: 'ui.toolbar = "shown"\nui.tabline = "auto"\n[keys]\n' });
  });

  test("an inline table is refused with the line to change by hand", () => {
    const r = setConfigKeysText("scroll = { step = 5 }\n", step(9));
    expect(r).toEqual({
      error:
        "config.toml:1: scroll is an inline table ({ … }); set step = 9 in it by hand, or write it as a [scroll] table",
    });
  });
});

describe("dotted tables: positions from the parser, not the line text", () => {
  const def = [{ table: "agent", key: "default", value: "b" }];

  test("an array whose rows start with [ before the dotted lines", () => {
    const ok = setTomlKeysText('l = [\n  [1],\n]\nui.toolbar = "shown"\n', [
      { table: "ui", key: "tabline", value: "auto" },
    ]);
    expect(ok).toEqual({
      ok: true,
      text: 'l = [\n  [1],\n]\nui.toolbar = "shown"\nui.tabline = "auto"\n',
    });
    expect(setTomlKeysText("l = [\n  [1],\n]\nagent.default = 1\n", def)).toEqual({
      ok: true,
      text: 'l = [\n  [1],\n]\nagent.default = "b"\n',
    });
  });

  test("a dotted-looking line inside a multi-line string is not the table's", () => {
    const text = 'ui.toolbar = "shown"\nnote = """\nui.x = 2\n"""\n';
    expect(setTomlKeysText(text, [{ table: "ui", key: "tabline", value: "auto" }])).toEqual({
      ok: true,
      text: 'ui.toolbar = "shown"\nui.tabline = "auto"\nnote = """\nui.x = 2\n"""\n',
    });
  });

  test("only an inline table is called one", () => {
    const r = setTomlKeysText('"agent".x = 1\n', def);
    expect(r).toEqual({
      ok: false,
      error: { line: 1, column: 1, message: "agent is not a plain [agent] table" },
    });
  });

  test("a CRLF file whose last dotted line has no newline stays CRLF", () => {
    const r = setTomlKeysText('z = 1\r\nui.toolbar = "shown"', [
      { table: "ui", key: "tabline", value: "auto" },
    ]);
    expect(r).toEqual({ ok: true, text: 'z = 1\r\nui.toolbar = "shown"\r\nui.tabline = "auto"' });
  });
});

describe("the lines a provider adds, for a file that cannot be written", () => {
  const p = (name: string, endpoint: string) => ({
    name,
    kind: "openai",
    endpoint,
    model: "m",
    vision: false,
  });

  test("a second provider lists its whole block and the default", () => {
    const one = addAgentProviderText(null, p("a", "http://127.0.0.1:1/v1"), { makeDefault: true });
    if ("error" in one) throw new Error(one.error);
    const two = addAgentProviderText(one.text, p("b", "http://127.0.0.1:2/v1"), {
      makeDefault: true,
    });
    expect("added" in two && two.added).toEqual([
      '[agent] default = "b"',
      "[[agent.providers]]",
      'name = "b"',
      'kind = "openai"',
      'endpoint = "http://127.0.0.1:2/v1"',
      'model = "m"',
      "vision = false",
    ]);
  });
});

describe("CRLF files keep CRLF", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const lone = (s: string) => /(^|[^\r])\n/.test(s);

  test("addAgentProviderText", () => {
    const r = addAgentProviderText(
      crlf('[ui]\ntoolbar = "shown"\n'),
      { name: "local", kind: "openai", endpoint: "http://127.0.0.1:8080/v1", model: "m" },
      { makeDefault: true },
    );
    if ("error" in r) throw new Error(r.error);
    expect(lone(r.text), JSON.stringify(r.text)).toBe(false);
    expect(parseConfig(r.text).config?.agent.default).toBe("local");
  });

  test("setConfigKeysText, editSiteUnbindText, appendRouteText and appendRouteFileText", () => {
    const base = crlf('[ui]\ntoolbar = "shown"\n');
    const set = setConfigKeysText(base, step(3));
    expect("text" in set && set.text !== null && !lone(set.text)).toBe(true);
    const site = editSiteUnbindText(base, "example.com", { add: ["j"] });
    expect("text" in site && site.text !== null && !lone(site.text)).toBe(true);
    const route = appendRouteText(base, { domain: "example.com", workspace: "work" });
    expect("append" in route && !lone(route.append)).toBe(true);
    const file = appendRouteFileText(crlf('[[routes]]\ndomain = "a.com"\nworkspace = "w"\n'), {
      domain: "example.com",
      workspace: "work",
    });
    expect("append" in file && !lone(file.append)).toBe(true);
  });
});

describe("messages", () => {
  test("a key defined twice names the line that defined it first", () => {
    const r = parseToml('[keys]\nnew_tab = "prefix+t"\n\nnew_tab = "prefix+y"\n');
    expect(!r.ok && r.error.message).toBe(
      "trying to redefine an already defined table or value (new_tab is already set at line 2)",
    );
  });

  test("the template points to the vimma.dev reference and has no reserved key", () => {
    const t = formatConfigTemplate();
    expect(t).toContain("# Reference: https://vimma.dev/docs/config/");
    expect(t).not.toMatch(/autofill/);
    expect(parseConfig(t).errors).toEqual([]);
  });
});
