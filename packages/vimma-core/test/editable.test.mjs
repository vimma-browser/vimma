import { describe, test, expect } from "vitest";
import {
  isEditable,
  matchSiteRule,
  insertModeAfterFocus,
  INSERT_TRIGGERS,
  TEXT_INPUT_EXCLUDED_TYPES,
  EDITABLE_ROLES,
  KNOWN_EDITORS,
  INSERT_SITE_MODES,
  parseDescriptor,
  DESCRIPTOR_MAX_STRING,
  INSERT_EDIT_COMMANDS,
  INSERT_ENTER,
  insertEditCommand,
  DESCRIPTOR_MAX_CLASSES,
} from "../src/keys/editable.mjs";
import { resolveEscape } from "../src/keys/escape.mjs";

/** @import { Mode } from "../src/keys/modes.mjs" */
/**
 * @import { EditableDescriptor, InsertSiteMode, InsertSiteRule, InsertTrigger }
 *   from "../src/keys/editable.mjs"
 */

/** @param {string | undefined} type */
const input = (type, extra = {}) => ({ tagName: "INPUT", type, ...extra });
const div = (extra = {}) => ({ tagName: "DIV", ...extra });

describe("isEditable: inputs", () => {
  test.each([
    [undefined, "input:text"],
    ["", "input:text"],
    ["text", "input:text"],
    ["SEARCH", "input:search"],
    ["email", "input:email"],
    ["password", "input:password"],
    ["number", "input:number"],
    ["date", "input:date"],
    ["datetime-local", "input:datetime-local"],
    ["tel", "input:tel"],
    ["url", "input:url"],
    ["foo", "input:foo"],
  ])("Given <input type=%s>, then editable with %s", (type, reason) => {
    expect(isEditable(input(type))).toEqual({ editable: true, reason });
  });

  test.each([
    "checkbox",
    "radio",
    "submit",
    "button",
    "file",
    "range",
    "color",
    "hidden",
    "image",
    "reset",
  ])("Given <input type=%s>, then not editable", (type) => {
    expect(isEditable(input(type))).toEqual({ editable: false, reason: `input:${type}` });
  });

  test("lowercase XHTML tag names are recognised", () => {
    expect(isEditable({ tagName: "input", type: "text" }).editable).toBe(true);
  });

  test("the excluded type list is the documented one", () => {
    expect([...TEXT_INPUT_EXCLUDED_TYPES].sort()).toEqual(
      [
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].sort(),
    );
  });
});

describe("isEditable: disabled and read-only", () => {
  test.each([
    [{ disabled: true }, "disabled"],
    [{ readOnly: true }, "readonly"],
    [{ disabled: true, readOnly: true }, "disabled"],
  ])("Given a text input with %o, then not editable (%s)", (extra, reason) => {
    expect(isEditable(input("text", extra))).toEqual({ editable: false, reason });
  });

  test("Given a readOnly textarea, then readonly", () => {
    expect(isEditable({ tagName: "TEXTAREA", readOnly: true })).toEqual({
      editable: false,
      reason: "readonly",
    });
  });

  test.each([
    [input("text", { ariaDisabled: true }), "input:text"],
    [{ tagName: "TEXTAREA", ariaDisabled: true }, "textarea"],
    [div({ isContentEditable: true, ariaDisabled: true }), "contenteditable"],
  ])(
    "Given native editable %o under an aria-disabled ancestor, then still editable",
    (d, reason) => {
      expect(isEditable(d)).toEqual({ editable: true, reason });
    },
  );

  test("Given role textbox with aria-disabled, then aria-disabled", () => {
    expect(isEditable(div({ role: "textbox", ariaDisabled: true }))).toEqual({
      editable: false,
      reason: "aria-disabled",
    });
  });

  test("Given a disabled checkbox, then disabled wins over the type", () => {
    expect(isEditable(input("checkbox", { disabled: true })).reason).toBe("disabled");
  });
});

describe("isEditable: other elements", () => {
  test.each([
    ["TEXTAREA", "textarea"],
    ["textarea", "textarea"],
    ["SELECT", "select"],
    ["EMBED", "embed"],
    ["object", "embed"],
  ])("Given <%s>, then editable (%s)", (tagName, reason) => {
    expect(isEditable({ tagName })).toEqual({ editable: true, reason });
  });

  test.each([
    [{ isContentEditable: true }, true],
    [{ isContentEditable: false, contentEditable: "true" }, false],
    [{ contentEditable: "true" }, true],
    [{ contentEditable: "" }, true],
    [{ contentEditable: "plaintext-only" }, true],
    [{ contentEditable: "PLAINTEXT-ONLY" }, true],
    [{ contentEditable: "false" }, false],
    [{ contentEditable: "inherit" }, false],
  ])("Given a div with %o, then editable is %s", (extra, editable) => {
    const r = isEditable(div(extra));
    expect(r).toEqual({ editable, reason: editable ? "contenteditable" : "none" });
  });

  test.each([
    ["textbox", "role:textbox"],
    ["searchbox", "role:searchbox"],
    ["combobox", "role:combobox"],
    ["spinbutton", "role:spinbutton"],
    ["application", "role:application"],
    ["TextBox", "role:textbox"],
    ["textbox foo", "role:textbox"],
    ["  searchbox ", "role:searchbox"],
  ])("Given a div with role %j, then editable (%s)", (role, reason) => {
    expect(isEditable(div({ role }))).toEqual({ editable: true, reason });
  });

  test.each(["button", "listbox", "option", "", null])("Given role %j, then none", (role) => {
    expect(isEditable(div({ role }))).toEqual({ editable: false, reason: "none" });
  });

  test("Given role textbox with aria-readonly, then aria-readonly", () => {
    expect(isEditable(div({ role: "textbox", ariaReadOnly: true }))).toEqual({
      editable: false,
      reason: "aria-readonly",
    });
  });

  test("the editable roles are the documented ones", () => {
    expect([...EDITABLE_ROLES]).toEqual([
      "textbox",
      "searchbox",
      "combobox",
      "spinbutton",
      "application",
    ]);
  });

  test("Given a plain div, a link, an svg, then none", () => {
    for (const tagName of ["DIV", "A", "svg", "BODY"]) {
      expect(isEditable({ tagName })).toEqual({ editable: false, reason: "none" });
    }
  });
});

describe("isEditable: known editors", () => {
  test.each([
    ["native-edit-context", "editor:monaco"],
    ["inputarea", "editor:monaco"],
    ["cm-content", "editor:codemirror6"],
    ["ace_text-input", "editor:ace"],
    ["ProseMirror", "editor:prosemirror"],
    ["ql-editor", "editor:quill"],
  ])("Given a focused div with class %s, then %s", (cls, reason) => {
    expect(isEditable(div({ classes: ["x", cls] }))).toEqual({ editable: true, reason });
  });

  test("Given a class that only contains a marker, then none", () => {
    expect(isEditable(div({ classes: ["cm-contentx", "xProseMirror"] })).reason).toBe("none");
  });

  test("Given a button in CodeMirror 6's search panel, then none", () => {
    expect(isEditable({ tagName: "BUTTON", classes: ["cm-button"] }).reason).toBe("none");
  });

  test.each(["BUTTON", "A", "OPTION", "SUMMARY", "LABEL"])(
    "Given a <%s> carrying an editor focus class, then none (native controls are skipped)",
    (tagName) => {
      expect(isEditable({ tagName, classes: ["cm-content"] })).toEqual({
        editable: false,
        reason: "none",
      });
    },
  );

  test("Given a contenteditable=false widget inside ProseMirror, then none", () => {
    expect(
      isEditable({
        tagName: "SPAN",
        isContentEditable: false,
        contentEditable: "false",
        classes: ["mention-widget"],
      }),
    ).toEqual({ editable: false, reason: "none" });
  });

  test("Given an editor focus element marked contenteditable=false, then none", () => {
    expect(
      isEditable(
        div({ classes: ["cm-content"], isContentEditable: false, contentEditable: "false" }),
      ).reason,
    ).toBe("none");
  });

  test("Given a read-only editor (aria-readonly), then aria-readonly", () => {
    expect(isEditable(div({ classes: ["native-edit-context"], ariaReadOnly: true }))).toEqual({
      editable: false,
      reason: "aria-readonly",
    });
  });

  test("Given a read-only textarea inside an editor, then readonly wins", () => {
    expect(isEditable({ tagName: "TEXTAREA", readOnly: true, classes: ["inputarea"] })).toEqual({
      editable: false,
      reason: "readonly",
    });
  });

  test("every known editor has a name and focus classes", () => {
    for (const e of KNOWN_EDITORS) {
      expect(e.name).toMatch(/^[a-z0-9]+$/);
      expect(e.classes.length).toBeGreaterThan(0);
      for (const c of e.classes) expect(c).toMatch(/^[A-Za-z_-]+$/);
    }
  });
});

describe("isEditable: designMode and site overrides", () => {
  test("Given designMode on a body, then design-mode", () => {
    expect(isEditable({ tagName: "BODY", designMode: true })).toEqual({
      editable: true,
      reason: "design-mode",
    });
  });

  test("Given designMode and a disabled input, then designMode wins", () => {
    expect(isEditable(input("text", { disabled: true, designMode: true })).reason).toBe(
      "design-mode",
    );
  });

  test("Given site never and designMode, then site:never", () => {
    expect(isEditable({ tagName: "BODY", designMode: true }, { site: "never" })).toEqual({
      editable: false,
      reason: "site:never",
    });
  });

  test("Given site never and a text input, then not editable", () => {
    expect(isEditable(input("text"), { site: "never" }).editable).toBe(false);
  });

  test("Given site always and a div, then site:always", () => {
    expect(isEditable(div(), { site: "always" })).toEqual({
      editable: true,
      reason: "site:always",
    });
  });

  test("Given site auto, then the heuristic decides", () => {
    expect(isEditable(div(), { site: "auto" })).toEqual(isEditable(div()));
    expect(isEditable(input("text"), { site: "auto" })).toEqual(isEditable(input("text")));
  });

  test("an unknown site mode throws", () => {
    expect(() => isEditable(div(), { site: /** @type {any} */ ("sometimes") })).toThrow(TypeError);
  });

  test("the site modes are auto, never, always", () => {
    expect([...INSERT_SITE_MODES]).toEqual(["auto", "never", "always"]);
  });
});

describe("matchSiteRule", () => {
  /** @type {InsertSiteRule[]} */
  const rules = [
    { match: "example.com", insert: "never" },
    { match: "docs.example.com", insert: "always" },
    { match: "Other.org", insert: "always" },
    { match: "other.org", insert: "never" },
  ];

  test.each([
    ["example.com", 0],
    ["www.example.com", 0],
    ["docs.example.com", 1],
    ["a.docs.example.com", 1],
    ["EXAMPLE.COM", 0],
    ["example.com.", 0],
    ["other.org", 2],
    ["sub.other.org", 2],
  ])("Given host %s, then rule %i", (host, index) => {
    expect(matchSiteRule(host, rules)).toBe(rules[index]);
  });

  test.each(["badexample.com", "example.co", "com", "", "example.com.evil"])(
    "Given host %j, then no rule",
    (host) => {
      expect(matchSiteRule(host, rules)).toBeUndefined();
    },
  );

  test("Given no rules, then undefined", () => {
    expect(matchSiteRule("example.com", [])).toBeUndefined();
  });

  test.each([
    ["10.1.1.1", "1.1"],
    ["10.1.1.1", "1.1.1"],
    ["192.168.0.10", "0.10"],
    ["[::1]", "1"],
    ["[fe80::1]", "80::1"],
    ["example.com:8080", "example.com"],
    ["localhostx", "localhost"],
  ])(
    "Given host %s and rule %s, then no match (IP literals and ports match exactly)",
    (host, match) => {
      expect(matchSiteRule(host, [{ match, insert: "never" }])).toBeUndefined();
    },
  );

  test.each([
    ["localhost", "localhost"],
    ["10.1.1.1", "10.1.1.1"],
    ["[::1]", "[::1]"],
    ["[::1]", "::1"],
    ["[FE80::1]", "fe80::1"],
  ])("Given host %s and rule %s, then the rule matches", (host, match) => {
    /** @type {InsertSiteRule} */
    const rule = { match, insert: "always" };
    expect(matchSiteRule(host, [rule])).toBe(rule);
  });

  test("a rule with a trailing dot or uppercase still matches", () => {
    /** @type {InsertSiteRule} */
    const r = { match: "Example.COM.", insert: "never" };
    expect(matchSiteRule("www.example.com", [r])).toBe(r);
  });
});

describe("insert mode on focus changes (host contract)", () => {
  const body = { tagName: "BODY" };
  const html = { tagName: "HTML" };
  const text = input("text");

  test("the triggers are focusin and recheck", () => {
    expect([...INSERT_TRIGGERS]).toEqual(["focusin", "recheck"]);
  });

  /** @type {Array<[{ site?: InsertSiteMode }, EditableDescriptor]>} */
  const roots = [
    [{ site: "always" }, body],
    [{ site: "always" }, html],
    [{}, { ...body, designMode: true }],
    [{}, { ...html, designMode: true }],
  ];
  test.each(roots)("on a recheck, %o never makes a bare <body>/<html> editable", (opts, d) => {
    expect(isEditable(d, { ...opts, trigger: "recheck" })).toEqual({
      editable: false,
      reason: "document-root",
    });
    expect(isEditable(d, { ...opts, trigger: "focusin" }).editable).toBe(true);
  });

  test("on a recheck, site always still makes a focused div editable", () => {
    expect(isEditable(div(), { site: "always", trigger: "recheck" }).reason).toBe("site:always");
  });

  test("an unknown trigger throws", () => {
    expect(() => isEditable(div(), { trigger: /** @type {any} */ ("blur") })).toThrow(TypeError);
  });

  /** @type {Array<[Mode, InsertTrigger, EditableDescriptor, InsertSiteMode, Mode]>} */
  const focusChanges = [
    ["normal", "focusin", text, "auto", "insert"],
    ["insert", "focusin", div(), "auto", "normal"],
    ["insert", "focusin", text, "auto", "insert"],
    ["normal", "focusin", div(), "auto", "normal"],
    ["normal", "recheck", text, "auto", "normal"],
    ["insert", "recheck", text, "auto", "insert"],
    ["insert", "recheck", body, "auto", "normal"],
    ["hint", "focusin", text, "auto", "hint"],
    ["visual", "recheck", body, "auto", "visual"],
    ["normal", "focusin", body, "always", "insert"],
  ];
  test.each(focusChanges)(
    "Given %s, on %s of %o (site %s), then %s",
    (mode, trigger, descriptor, site, next) => {
      expect(insertModeAfterFocus({ mode, trigger, descriptor, site })).toBe(next);
    },
  );

  /** @type {Array<[string, { site?: InsertSiteMode }, EditableDescriptor]>} */
  const escToBody = [
    ["site always", { site: "always" }, body],
    ["designMode", {}, { ...body, designMode: true }],
  ];
  test.each(escToBody)(
    "Given insert under %s, when Esc blurs to <body>, then normal mode stays",
    (_, opts, d) => {
      // Esc: the host switches to normal and blurs (resolveEscape); focus falls to <body>.
      const esc = resolveEscape({ mode: "insert" });
      expect(esc).toMatchObject({ mode: "normal", blur: true });
      if (esc.kind === "pass") throw new Error("Esc in insert mode passed");
      const afterEsc = esc.mode;
      expect(
        insertModeAfterFocus({ mode: afterEsc, trigger: "recheck", descriptor: d, ...opts }),
      ).toBe("normal");
      // A host that rechecks before switching still leaves insert.
      expect(
        insertModeAfterFocus({ mode: "insert", trigger: "recheck", descriptor: d, ...opts }),
      ).toBe("normal");
    },
  );
});

describe("parseDescriptor: untrusted reports from a content process", () => {
  const long = "x".repeat(DESCRIPTOR_MAX_STRING + 1);

  test("the limits are 256 characters and 64 classes", () => {
    expect([DESCRIPTOR_MAX_STRING, DESCRIPTOR_MAX_CLASSES]).toEqual([256, 64]);
  });

  test("a well-formed descriptor comes back as a fresh copy with only known fields", () => {
    const known = {
      tagName: "div",
      type: "text",
      readOnly: false,
      disabled: false,
      isContentEditable: true,
      contentEditable: "true",
      role: null,
      ariaReadOnly: false,
      ariaDisabled: false,
      designMode: false,
      classes: Array(DESCRIPTOR_MAX_CLASSES).fill("x".repeat(DESCRIPTOR_MAX_STRING)),
    };
    const parsed = parseDescriptor({ ...known, extra: "dropped" });
    expect(parsed).toEqual(known);
    expect(parsed?.classes).not.toBe(known.classes);
  });

  test("only tagName is required", () => {
    expect(parseDescriptor({ tagName: "input" })).toEqual({ tagName: "input" });
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "input"],
    ["an array", ["input"]],
    ["no tagName", {}],
    ["tagName not a string", { tagName: 5 }],
    ["tagName empty", { tagName: "" }],
    ["tagName too long", { tagName: long }],
    ["type not a string", { tagName: "input", type: 3 }],
    ["type too long", { tagName: "input", type: long }],
    ["readOnly not a boolean", { tagName: "input", readOnly: "no" }],
    ["disabled not a boolean", { tagName: "input", disabled: 0 }],
    ["isContentEditable not a boolean", { tagName: "div", isContentEditable: "yes" }],
    ["contentEditable not a string", { tagName: "div", contentEditable: true }],
    ["role not a string or null", { tagName: "div", role: ["textbox"] }],
    ["role too long", { tagName: "div", role: long }],
    ["ariaReadOnly not a boolean", { tagName: "div", ariaReadOnly: "true" }],
    ["ariaDisabled not a boolean", { tagName: "div", ariaDisabled: 1 }],
    ["designMode not a boolean", { tagName: "div", designMode: 1 }],
    ["classes not an array", { tagName: "div", classes: "ProseMirror" }],
    ["a class not a string", { tagName: "div", classes: ["ProseMirror", 1] }],
    ["a class too long", { tagName: "div", classes: ["ProseMirror", long] }],
    [
      "too many classes",
      { tagName: "div", classes: Array(DESCRIPTOR_MAX_CLASSES + 1).fill("ProseMirror") },
    ],
  ])("%s → null", (_name, value) => {
    expect(parseDescriptor(value)).toBeNull();
  });

  test("a throwing getter → null, not an exception", () => {
    const hostile = {
      get tagName() {
        throw new Error("boom");
      },
    };
    expect(parseDescriptor(hostile)).toBeNull();
  });
});

// docs/specs/key-handling-batch.md § 2
describe("insertEditCommand", () => {
  test.each([
    ["ctrl+w", "cmd_deleteWordBackward"],
    ["ctrl+u", "cmd_deleteToBeginningOfLine"],
    ["ctrl+h", "cmd_deleteCharBackward"],
  ])("%s runs %s", (chord, command) => {
    expect(insertEditCommand(chord)).toBe(command);
    expect(INSERT_EDIT_COMMANDS).toContain(command);
  });

  test.each(["ctrl+j", "ctrl+m"])("%s is Enter, as in Vim (i_CTRL-J, i_CTRL-M)", (chord) => {
    expect(insertEditCommand(chord)).toBe(INSERT_ENTER);
    expect(insertEditCommand(chord, { mac: true })).toBe(INSERT_ENTER);
  });

  test("Enter is no editor command: the content actor never takes it", () => {
    expect(INSERT_ENTER.startsWith("cmd_")).toBe(false);
    expect(INSERT_EDIT_COMMANDS).not.toContain(INSERT_ENTER);
    expect(INSERT_EDIT_COMMANDS).toHaveLength(3);
  });

  test.each([
    "ctrl+shift+w",
    "ctrl+alt+u",
    "alt+h",
    "w",
    "ctrl+meta+h",
    "ctrl+d",
    "ctrl+shift+j",
    "ctrl+alt+m",
    "j",
    "m",
  ])("%s is no edit key", (chord) => {
    expect(insertEditCommand(chord)).toBeNull();
  });

  test("on macOS ctrl+h is left to Cocoa's own binding; ctrl+w and ctrl+u stay", () => {
    expect(insertEditCommand("ctrl+h", { mac: true })).toBeNull();
    expect(insertEditCommand("ctrl+w", { mac: true })).toBe("cmd_deleteWordBackward");
    expect(insertEditCommand("ctrl+u", { mac: true })).toBe("cmd_deleteToBeginningOfLine");
  });
});
