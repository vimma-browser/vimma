// Edges of the config.toml edit behind `:siteunbind --save` and `:sitebind --delete` that the
// weekly mutation run (#1119) found unpinned: which line is the table's header, how the list is
// read (quotes, escapes, line breaks), what goes when a key or the last key is removed, how a key
// is added to each layout, and the result's fields and messages. docs/specs/site-unbind-command.md
// decision 10, docs/security/08-config-toml.md F1; the main suite is site-keys.test.ts.
import { describe, expect, test } from "vitest";
import { editSiteUnbindText } from "../src/config/site-edit.mjs";

type Change = { add?: string[]; remove?: string[] };
const edit = (text: string | null, change: Change, table = "a.b") =>
  editSiteUnbindText(text, table, change);
/** The file after the edit; fails on a refusal. */
const after = (text: string | null, change: Change, table = "a.b") => {
  const r = edit(text, change, table);
  if ("error" in r) throw new Error(r.error);
  return r.text;
};
const LEFT_ALONE = {
  error:
    'config.toml writes [sites."a.b"] in a form this edit leaves alone; edit it there (:config)',
};
/** A multi-line string under an unknown top-level key: a warning, so the file loads. */
const notes = (line: string) => `my_own_notes = """\n${line}\n"""\n`;

describe("the table's own header", () => {
  test("an indented header is the table's", () => {
    expect(after('\t[sites."a.b"]\n', { add: ["x"] })).toBe('\t[sites."a.b"]\nunbind = ["x"]\n');
  });

  test("another site's header is not, so the table is added after it", () => {
    expect(after('[sites."c.d"]\nsleep = false\n', { add: ["j"] })).toBe(
      '[sites."c.d"]\nsleep = false\n\n[sites."a.b"]\nunbind = ["j"]\n',
    );
  });

  test("a line in a multi-line string that is no header alone is not one", () => {
    for (const line of ['sites."a.b" = {}', "[oops", 'sites."a.b" = { unbind = ["t"] }']) {
      const table = '[sites."a.b"]\ninsert = "never"\n';
      expect(after(`${notes(line)}${table}`, { add: ["x"] })).toBe(
        `${notes(line)}${table}unbind = ["x"]\n`,
      );
    }
  });

  test("a header line in a multi-line string leaves the table to the user", () => {
    // The line scan cannot tell it from the table's own header.
    const fake = notes('[sites."a.b"]');
    expect(edit(fake, { add: ["x"] })).toEqual(LEFT_ALONE);
    expect(edit(`${fake}[sites."a.b"]\ninsert = "never"\n`, { add: ["x"] })).toEqual(LEFT_ALONE);
    // Taken for the header, it would put unbind under [sites]: the comparison refuses that.
    expect(edit(`${fake}[sites]\n"a.b".insert = "never"\n`, { add: ["x"] })).toEqual(LEFT_ALONE);
  });

  test("a decoy header below the key, in a string the line scan takes for the header, leaves the table to the user", () => {
    const decoy = '[my_own_notes]\nx = """\n[sites."a.b"]\n"""\n';
    // The key in a multi-line inline table above the decoy.
    expect(edit(`[sites]\n"a.b" = {\n  unbind = [\n  ] }\n${decoy}`, { add: ["g"] })).toEqual(
      LEFT_ALONE,
    );
    // The key on the line just above the decoy, in an inline table over several lines.
    expect(
      edit('[sites]\n"a.b" = {\nunbind = [], x = """\n[sites."a.b"]\n"""\n}\n', { add: ["g"] }),
    ).toEqual(LEFT_ALONE);
    // A byte order mark hides the real header from the scan, so only the decoy is found.
    expect(edit(`\uFEFF[sites."a.b"]\nunbind = []\n${decoy}`, { add: ["g"] })).toEqual(LEFT_ALONE);
  });

  test("a table name that is not a string matches no header", () => {
    // The caller always passes a string; a number must not reach [sites.1] by coercion.
    const r = editSiteUnbindText("[sites.1]\n", 1 as unknown as string, {
      add: ["g"],
    });
    expect(r).toEqual({
      error:
        "config.toml writes [sites.1] in a form this edit leaves alone; edit it there (:config)",
    });
  });

  test("an unbind key written with an escape is left to the user", () => {
    expect(edit('[sites."a.b"]\n"\\u0075nbind" = ["t"]\n', { add: ["x"] })).toEqual(LEFT_ALONE);
  });
});

describe("the list as written", () => {
  test("triple-quoted keys, also one that ends in more quotes than three", () => {
    expect(after('[sites."a.b"]\nunbind = ["""g""", "t"]\n', { remove: ["g"] })).toBe(
      '[sites."a.b"]\nunbind = ["t"]\n',
    );
    // """"""" is the key ", and ''''''' the key '.
    expect(after('[sites."a.b"]\nunbind = [""""""", "t"]\n', { remove: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = ["""""""]\n',
    );
    expect(after("[sites.\"a.b\"]\nunbind = [''''''', \"t\"]\n", { remove: ["t"] })).toBe(
      "[sites.\"a.b\"]\nunbind = [''''''']\n",
    );
    expect(after('[sites."a.b"]\nunbind = ["""\nt""", "g"]\n', { remove: ["g"] })).toBe(
      '[sites."a.b"]\nunbind = ["""\nt"""]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["t", """""""]\n', { add: ["g"] })).toBe(
      '[sites."a.b"]\nunbind = ["t", """"""", "g"]\n',
    );
  });

  test("a key with an escape is read whole", () => {
    expect(after('[sites."a.b"]\nunbind = ["\\u0074", "g"]\n', { remove: ["g"] })).toBe(
      '[sites."a.b"]\nunbind = ["\\u0074"]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["\\"", "g"]\n', { remove: ["g"] })).toBe(
      '[sites."a.b"]\nunbind = ["\\""]\n',
    );
    // A literal string has no escapes: '\\' is the key \ and ends there.
    expect(after('[sites."a.b"]\nunbind = [\'\\\', "t"]\n', { remove: ["t"] })).toBe(
      "[sites.\"a.b\"]\nunbind = ['\\']\n",
    );
    // An escaped spelling of a key already listed is that key.
    expect(edit('[sites."a.b"]\nunbind = ["\\u0074"]\n', { add: ["t"] })).toMatchObject({
      added: [],
      already: ["t"],
    });
  });

  test("an empty list over CRLF lines gets the keys after its [", () => {
    expect(after('[sites."a.b"]\r\nunbind = [\r\n\t]\r\n', { add: ["x", "t"] })).toBe(
      '[sites."a.b"]\r\nunbind = ["x", "t"\r\n\t]\r\n',
    );
  });

  test("unbind written with tabs, quotes or no spaces around =", () => {
    expect(after('[sites."a.b"]\n\tunbind\t=  []\n', { add: ["t"] })).toBe(
      '[sites."a.b"]\n\tunbind\t=  ["t"]\n',
    );
    expect(after('[sites."a.b"]\n\'unbind\'=\t[ "j"]\n', { add: ["t"] })).toBe(
      '[sites."a.b"]\n\'unbind\'=\t[ "j", "t"]\n',
    );
  });
});

describe("removing", () => {
  test("a key on its own line takes its line, CRLF kept", () => {
    expect(
      after('[sites."a.b"]\r\nunbind = [\r\n  "x",\r\n  "t",\r\n  "j"\r\n]\r\n', {
        remove: ["x"],
      }),
    ).toBe('[sites."a.b"]\r\nunbind = [\r\n  "t",\r\n  "j"\r\n]\r\n');
    expect(after('[sites."a.b"]\nunbind = [\n  "x",\n  "t"\n]', { remove: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = [\n  "x"\n]',
    );
  });

  test("a key on the line of the closing bracket leaves the bracket there", () => {
    expect(after('[sites."a.b"]\nunbind = [\n  "x",\n  "t",]', { remove: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = [\n  "x",\n  ]',
    );
  });

  test("a key takes the comma and the blanks after it", () => {
    expect(after('[sites."a.b"]\nunbind = ["x", \t "t" ] # c\n', { remove: ["x"] })).toBe(
      '[sites."a.b"]\nunbind = ["t" ] # c\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["x",\t"t"]\n', { remove: ["x"] })).toBe(
      '[sites."a.b"]\nunbind = ["t"]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["x", "t"]', { remove: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = ["x"]',
    );
  });

  test("the last key takes the whole line, also at the end of a file without a line break", () => {
    const head = '# a\n[sites."a.b"]\ninsert = "never"\n';
    expect(after(`${head}unbind = ["x"]`, { remove: ["x"] })).toBe(head);
    expect(after(`${head}unbind = ["x"]\n\n[keys]\n`, { remove: ["x"] })).toBe(`${head}\n[keys]\n`);
    expect(after(`${head}unbind = ["x",] # x key\n`, { remove: ["x"] })).toBe(head);
  });

  test("a table emptied of its one key goes, with the blank lines in it", () => {
    for (const rest of ["", "\n", "  \n", "\n\n"]) {
      expect(after(`[sites."a.b"]\nunbind = ["x"]\n${rest}`, { remove: ["x"] })).toBe("");
    }
    expect(
      after('[sites."a.b"]\nunbind = ["x"]\n\n[sites."c.d"]\ninsert = "never"\n', {
        remove: ["x"],
      }),
    ).toBe('[sites."c.d"]\ninsert = "never"\n');
    expect(after('[sites."a.b"]\nunbind = ["x"]\n\n  [keys]\n', { remove: ["x"] })).toBe(
      "  [keys]\n",
    );
  });

  test("an emptied table stays when a comment or another key is in it", () => {
    expect(after('[sites."a.b"]\nunbind = ["x"]\n\n# mine\n[keys]\n', { remove: ["x"] })).toBe(
      '[sites."a.b"]\n\n# mine\n[keys]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["x"]\n# keys [ ]\n', { remove: ["x"] })).toBe(
      '[sites."a.b"]\n# keys [ ]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["t"]\ninsert = "always"', { remove: ["t"] })).toBe(
      '[sites."a.b"]\ninsert = "always"',
    );
  });

  test("the sites table stays while another site is in it", () => {
    expect(
      after('[sites."c.d"]\ninsert = "auto"\n\n[sites."a.b"]\nunbind = ["j"]\n', {
        remove: ["j"],
      }),
    ).toBe('[sites."c.d"]\ninsert = "auto"\n\n');
    // An empty [sites] of the file's own stays too.
    expect(after('[sites]\n\n[sites."a.b"]\nunbind = ["x"]\n', { remove: ["x"] })).toBe(
      "[sites]\n\n",
    );
  });

  test("removing the only key while adding another is left to the user, not thrown", () => {
    // :siteunbind adds and :sitebind removes, never both: the line edit does not combine them.
    for (const key of ['"g"', '"""g"""']) {
      expect(edit(`[sites."a.b"]\nunbind = [${key}]\n`, { add: ["j"], remove: ["g"] })).toEqual(
        LEFT_ALONE,
      );
    }
  });
});

describe("adding", () => {
  test("a new table is set off from the file by one blank line", () => {
    const table = '[sites."a.b"]\nunbind = ["t"]\n';
    for (const [text, glue] of [
      ["", ""],
      ["# a", "\n\n"],
      ["# a\n", "\n"],
      ["# a\n\n", ""],
      ["\n# a", "\n\n"],
    ] as const) {
      expect(after(text, { add: ["t"] })).toBe(`${text}${glue}${table}`);
    }
    const crlf = '[sites."a.b"]\r\nunbind = ["t"]\r\n';
    for (const [text, glue] of [
      ["# a\r\n# b", "\r\n\r\n"],
      ["# a\r\n", "\r\n"],
      ["# a\r\n\r\n", ""],
      ["\r\n\r\n# a", "\r\n\r\n"],
    ] as const) {
      expect(after(text, { add: ["t"] })).toBe(`${text}${glue}${crlf}`);
    }
  });

  test("a table without unbind or insert gets the line after its header", () => {
    expect(after('[sites."a.b"]\n', { add: ["t", "x"] })).toBe(
      '[sites."a.b"]\nunbind = ["t", "x"]\n',
    );
    expect(after('[sites."a.b"]\r\nsleep = true\r\n', { add: ["t"] })).toBe(
      '[sites."a.b"]\r\nunbind = ["t"]\r\nsleep = true\r\n',
    );
  });

  test("an empty list gets the keys inside its brackets", () => {
    expect(after('[sites."a.b"]\nunbind = []\n', { add: ["ctrl+k", "t"] })).toBe(
      '[sites."a.b"]\nunbind = ["ctrl+k", "t"]\n',
    );
  });

  test("a one-line list gets the keys after its last, a trailing comma kept", () => {
    expect(after('[sites."a.b"]\nunbind = ["g"]\n', { add: ["t", "x"] })).toBe(
      '[sites."a.b"]\nunbind = ["g", "t", "x"]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["g",]\n', { add: ["t", "x"] })).toBe(
      '[sites."a.b"]\nunbind = ["g", "t", "x",]\n',
    );
    expect(after('[sites."a.b"]\nunbind = ["g" ,]\n', { add: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = ["g" , "t",]\n',
    );
  });

  test("a list over several lines gets one key a line, before the closing bracket", () => {
    expect(after('[sites."a.b"]\nunbind = ["x",\n"g"]\n', { add: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = ["x",\n"g",\n"t"]\n',
    );
    expect(after('[sites."a.b"]\nunbind = [\n\t"g"\n ]', { add: ["t", "x"] })).toBe(
      '[sites."a.b"]\nunbind = [\n\t"g",\n\t"t",\n\t"x"\n ]',
    );
    expect(
      after('[sites."a.b"]\r\nunbind=[\r\n    \'t\',\r\n    "g"\r\n    ]\r\n', { add: ["x"] }),
    ).toBe('[sites."a.b"]\r\nunbind=[\r\n    \'t\',\r\n    "g",\r\n    "x"\r\n    ]\r\n');
    // The comma on a line of its own: the key goes on the line after it.
    expect(after('[sites."a.b"]\nunbind = [\n  "g"\n,\n]\n', { add: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = [\n  "g"\n,\n  "t",\n]\n',
    );
    // The ] on the last key's line, at the end of the file: the key goes before it.
    expect(after('[sites."a.b"]\nunbind = [\n  "g",\n  "x"] # c', { add: ["t"] })).toBe(
      '[sites."a.b"]\nunbind = [\n  "g",\n  "x",\n  "t"] # c',
    );
  });
});

describe("the result", () => {
  test("a missing file with nothing to add stays missing, every list empty", () => {
    expect(edit(null, { remove: ["t"] })).toEqual({
      text: null,
      added: [],
      already: [],
      removed: [],
    });
  });

  test("a key given twice counts once", () => {
    expect(edit("", { add: ["x", "x", "j"] })).toEqual({
      text: '[sites."a.b"]\nunbind = ["x", "j"]\n',
      added: ["x", "j"],
      already: [],
      removed: [],
    });
    const text = '[sites."a.b"]\nunbind = ["x", "t"]\n';
    expect(edit(text, { add: ["t", "t"] })).toEqual({
      text,
      added: [],
      already: ["t"],
      removed: [],
    });
    expect(edit('[sites."a.b"]\nunbind = ["j"]\n', { remove: ["j", "j"] })).toEqual({
      text: "",
      added: [],
      already: [],
      removed: ["j"],
    });
  });

  test("a file that is not TOML names the line and the error, with no path", () => {
    expect(edit("this is = = not toml", { add: ["t"] })).toEqual({
      error: "config.toml has errors; fix them first (:config): line 1: illegal character in key",
    });
  });

  test("macOS's keys decide whether the file has errors", () => {
    // meta+9 is select_last_tab on macOS only.
    const text = '[keys]\nnew_tab = "meta+9"\n';
    expect(after(text, { add: ["t"] })).toBe(`${text}\n[sites."a.b"]\nunbind = ["t"]\n`);
    expect(editSiteUnbindText(text, "a.b", { add: ["t"] }, { mac: true })).toEqual({
      error:
        "config.toml has errors; fix them first (:config): line 2: keys.new_tab: " +
        '"meta+9" is already bound to select_last_tab in normal mode',
    });
  });

  test("a key the file would not load with is refused, with the reason", () => {
    expect(edit("", { add: ["g", "gg"] })).toEqual({
      error:
        'config.toml would not load with the change: sites."a.b".unbind[1]: must be one key: ' +
        'on a site, "g" gives the page g and every sequence it starts',
    });
  });
});
