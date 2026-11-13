// The promo video's shots (tools/promo/record.mjs): what each clip shows and the keys that do
// it. `setup` runs before the recording starts; `run` is what the camera sees. Every step
// waits on Vimma's state through vimma-ctl; the only sleeps are `hold`, the pacing pauses
// that let a viewer follow (a multiple of --pace). `theme` is the shot's `[theme] source`:
// "file" (the default) shows the built-in palette, "omarchy" the recorder's temp theme
// directory, which starts empty, so the built-in palette shows there too until a shot sets one.
import { PROMO_TASK } from "./agent.mjs";
import { HOSTS } from "./promo.mjs";

const ARTICLE = `${HOSTS.handbook}modal-browsing.html`;
const ARTICLE_TITLE = "Leave the mouse in the drawer · Handbook";
const PANES = `${HOSTS.handbook}panes.html`;
const PANES_TITLE = "Panes, the tmux way · Handbook";
const NEWS = `${HOSTS.news}front.html`;
const NEWS_TITLE = "Front page · news.example";
const RUNBOOK = `${HOSTS.wiki}runbook.html`;
const RUNBOOK_TITLE = "On-call runbook · Wiki";
const CHECKLIST = `${HOSTS.wiki}release-checklist.html`;
const CHECKLIST_TITLE = "Release checklist 4.2 · Wiki";
const POSTMORTEM = `${HOSTS.wiki}postmortem.html`;
const POSTMORTEM_TITLE = "Postmortem: cache stampede · Wiki";
const DRILL = `${HOSTS.wiki}rollback-drill.html`;
const DRILL_TITLE = "Rollback drill, Q3 · Wiki";
const INCIDENT = `${HOSTS.tracker}inc-1187.html`;
const INCIDENT_TITLE = "INC-1187 Checkout slow after deploy · Tracker";
const STANDUP = `${HOSTS.notes}standup.html`;
const STANDUP_TITLE = "Standup, Tuesday · Notes";
const START_URL = "chrome://browser/content/vimma/start/start.html";

/** @typedef {import("./record.mjs").Director} Director */
/** @typedef {{ name: string, theme?: "file" | "omarchy", agent?: boolean,
 *   setup: (d: Director) => Promise<void>, run: (d: Director) => Promise<void> }} Shot */

/** @param {any} s */
const selected = (s) => s.tabs.find((/** @type {any} */ t) => t.selected);

/** @param {string} who */
const inbox = (who) => `Inbox (${who}) · mail.example`;

/**
 * The panes in the window's split: 1 without one.
 * @param {any} s
 */
function paneCount(s) {
  /** @param {any} n @returns {number} */
  const leaves = (n) =>
    n.children
      ? n.children.reduce((/** @type {number} */ a, /** @type {unknown} */ c) => a + leaves(c), 0)
      : 1;
  return s.panes?.root ? leaves(s.panes.root) : 1;
}

/**
 * The split's shape (axes, nesting and sizes), to see a layout change.
 * @param {any} s
 */
function shape(s) {
  /** @param {any} n @returns {any} */
  const strip = (n) =>
    n.children ? { axis: n.axis, ratios: n.ratios, children: n.children.map(strip) } : 0;
  return JSON.stringify(s.panes?.root ? strip(s.panes.root) : null);
}

/**
 * tmux's tiled layout at four panes: two splits of two, a 2x2 grid.
 * @param {any} s
 */
function isGrid(s) {
  const root = s.panes?.root;
  return (
    root?.children?.length === 2 &&
    root.children.every((/** @type {any} */ c) => c.children?.length === 2 && c.axis !== root.axis)
  );
}

/**
 * Open `url` in a new tab, wait for `title`, then close every other tab, so the status bar
 * says `tab 1/1`.
 * @param {Director} d
 * @param {string} url
 * @param {string} title
 */
async function only(d, url, title) {
  await d.open(url);
  await d.until((s) => selected(s)?.title === title && s.mode === "normal", `"${title}" loaded`);
  while ((await d.state()).tabs.length > 1) {
    const before = (await d.state()).tabs.length;
    const first = (await d.state()).tabs[0];
    if (first.title === title) throw new Error(`a second "${title}" tab is open`);
    await d.send("ctrl+b 1");
    await d.until((s) => s.tabs[0].selected, "the first tab selected");
    await d.send("ctrl+b shift+x");
    await d.until((s) => s.tabs.length === before - 1, "a tab closed");
  }
  await d.until((s) => selected(s)?.title === title && s.mode === "normal", `back on "${title}"`);
}

/**
 * Open `url` in another tab (off camera) and wait for `title`.
 * @param {Director} d
 * @param {string} url
 * @param {string} title
 */
async function also(d, url, title) {
  await d.open(url);
  await d.until((s) => selected(s)?.title === title && s.mode === "normal", `"${title}" loaded`);
}

/**
 * Make a workspace (off camera) and go to it: `ctrl+b shift+n` and its name.
 * @param {Director} d
 * @param {string} name
 */
async function newWorkspace(d, name) {
  await d.send("ctrl+b shift+n");
  await d.until((s) => s.mode === "command", "the new-workspace prompt");
  await d.send(`${[...name].join(" ")} enter`);
  await d.until((s) => s.workspace === name, `the ${name} workspace`);
}

/**
 * Load `url` in the selected tab with `:open` (off camera), so no tab is closed and nothing
 * extra lands under tab search's Recently closed; wait for `title`.
 * @param {Director} d
 * @param {string} url
 * @param {string} title
 */
async function openHere(d, url, title) {
  await d.send("esc");
  await d.send("esc");
  await d.until((s) => s.mode === "normal", "focus in the page");
  await d.send(":");
  await d.until((s) => s.mode === "command", "the command line");
  await d.send(
    `${[..."open "]
      .concat([...url])
      .map((c) => (c === " " ? "space" : c))
      .join(" ")} enter`,
  );
  await d.until((s) => selected(s)?.title === title && s.mode === "normal", `"${title}" loaded`);
}

/**
 * The team's tabs for tab search and live grep (off camera): four in main, the standup notes
 * selected; a postmortem and the news in a second workspace, "reading"; and, with `closed`, the
 * rollback drill opened and closed again, so it is under Recently closed.
 * @param {Director} d
 * @param {{ closed: boolean }} o
 */
async function teamTabs(d, { closed }) {
  await only(d, RUNBOOK, RUNBOOK_TITLE);
  await also(d, CHECKLIST, CHECKLIST_TITLE);
  await also(d, INCIDENT, INCIDENT_TITLE);
  if (closed) {
    await also(d, DRILL, DRILL_TITLE);
    const count = (await d.state()).tabs.length;
    await d.send("ctrl+b shift+x");
    await d.until((s) => s.tabs.length === count - 1, "the drill tab closed");
  }
  await also(d, STANDUP, STANDUP_TITLE);
  await newWorkspace(d, "reading");
  await openHere(d, POSTMORTEM, POSTMORTEM_TITLE);
  await also(d, NEWS, NEWS_TITLE);
  await d.send("ctrl+b (");
  await d.until(
    (s) => s.workspace === "main" && selected(s)?.title === STANDUP_TITLE && s.mode === "normal",
    "back in main, on the standup notes",
  );
}

/**
 * @type {Shot} the hook, link hints over the article and a label typed; then on the followed
 * page j/k/d, / find with its match count, and gF opening a link in a background tab
 */
const keys = {
  name: "keys",
  async setup(d) {
    const article = await d.probeHintLabel(ARTICLE);
    d.labels.target = article.label;
    d.points.target = { x: article.x, y: article.y };
    const panes = await d.probeHintLabel(PANES);
    d.labels.background = panes.label;
    d.points.background = { x: panes.x, y: panes.y };
    await only(d, ARTICLE, ARTICLE_TITLE);
  },
  async run(d) {
    await d.hold(0.6);
    d.mark("hints");
    await d.key("f", 0);
    await d.until((s) => s.mode === "hint", "hint mode");
    await d.hold(2.6);
    const label = d.labels.target ?? "";
    for (const c of label.slice(0, -1)) await d.key(c, 1.0);
    await d.key(label.slice(-1), 0);
    await d.until(
      (s) => selected(s)?.title === PANES_TITLE && s.mode === "normal",
      "the hinted link followed",
    );
    await d.hold(1.8);
    d.mark("scroll");
    await d.key("j", 0.4);
    await d.key("j", 0.4);
    await d.key("d", 0.9);
    await d.key("k", 0.5);
    d.mark("find");
    await d.key("/", 0);
    await d.until((s) => s.mode === "command", "the find bar");
    await d.hold(0.3);
    await d.type("pane", 0.3);
    await d.hold(1.0);
    await d.key("enter", 0);
    await d.until((s) => s.mode === "normal", "find closed");
    await d.key("n", 0.9);
    d.mark("background");
    // back at the top, where the probe worked out gF's label
    await d.key("g g", 0.6);
    await d.key("g F", 0);
    await d.until((s) => s.mode === "hint", "gF's hints");
    await d.hold(1.0);
    const bg = d.labels.background ?? "";
    for (const c of bg) await d.key(c, 0.5);
    await d.until(
      (s) => s.tabs.length === 2 && selected(s)?.title === PANES_TITLE && s.mode === "normal",
      "a second tab, in the background",
    );
    await d.hold(1.4);
  },
};

/** @type {Shot} ctrl+b enter three times: a dwindle spiral; ctrl+b space through the presets */
const tiling = {
  name: "tiling",
  async setup(d) {
    await only(d, ARTICLE, ARTICLE_TITLE);
  },
  async run(d) {
    await d.hold(0.8);
    d.mark("split");
    for (let n = 2; n <= 4; n++) {
      await d.prefix("enter");
      await d.until(
        (s) => paneCount(s) === n && selected(s)?.url === START_URL,
        `${n} panes, the new one on the start page`,
      );
      await d.hold(0.6);
    }
    d.mark("layouts");
    // even-horizontal, even-vertical, main-vertical, main-horizontal, tiled
    for (let i = 0; i < 5; i++) {
      const before = shape(await d.state());
      await d.prefix("space");
      await d.until((s) => shape(s) !== before, "the next layout preset");
      await d.hold(i === 4 ? 0 : 0.6);
    }
    await d.until(isGrid, "the tiled preset: a 2x2 grid");
    await d.hold(1.4);
  },
};

/** @type {Shot} the side panel: space marks three tabs, Enter shows them together as panes */
const marks = {
  name: "marks",
  async setup(d) {
    // the team's pages that tab search and live grep search later in the video
    await only(d, RUNBOOK, RUNBOOK_TITLE);
    await also(d, CHECKLIST, CHECKLIST_TITLE);
    await also(d, INCIDENT, INCIDENT_TITLE);
    await also(d, STANDUP, STANDUP_TITLE);
    await d.send("ctrl+b 1");
    await d.until((s) => s.tabs[0].selected && s.mode === "normal", "the first tab selected");
  },
  async run(d) {
    await d.hold(0.6);
    await d.prefix("b");
    await d.until((s) => s.mode === "panel", "the side panel");
    await d.hold(0.7);
    d.mark("mark");
    // marks the runbook, skips the checklist, marks the incident and the standup notes; space
    // leaves the highlight on the row it marks, so j moves to the next one
    await d.key("space", 0.5);
    await d.key("j", 0.3);
    await d.key("j", 0.5);
    await d.key("space", 0.5);
    await d.key("j", 0.5);
    await d.key("space", 0.8);
    d.mark("together");
    await d.key("enter", 0);
    await d.until((s) => paneCount(s) === 3 && s.mode === "normal", "three panes");
    await d.hold(2.0);
  },
};

/**
 * @type {Shot} ctrl+^ flips between two workspaces, signed in differently in each; then a beat
 * of the private workspace, and back
 */
const flip = {
  name: "flip",
  async setup(d) {
    await only(d, `${HOSTS.mail}signin.html#personal`, inbox("personal"));
    await d.send("ctrl+b shift+n");
    await d.until((s) => s.mode === "command", "the new-workspace prompt");
    await d.send("w o r k enter");
    await d.until((s) => s.workspace === "work", "the work workspace");
    await only(d, `${HOSTS.mail}signin.html#work`, inbox("work"));
    // back in main, so work is the workspace ctrl+^ goes back to
    await d.send("ctrl+b (");
    await d.until(
      (s) => s.workspace === "main" && selected(s)?.title === inbox("personal"),
      "back in main",
    );
  },
  async run(d) {
    await d.hold(1.0);
    for (const [ws, who] of /** @type {const} */ ([
      ["work", "work"],
      ["main", "personal"],
    ])) {
      await d.key("ctrl+^", 0);
      await d.until(
        (s) => s.workspace === ws && selected(s)?.title === inbox(who),
        `the ${who} inbox`,
      );
      await d.hold(1.6);
    }
    d.mark("private");
    await d.prefix("shift+p");
    await d.until((s) => s.private === true, "the private workspace", 20_000);
    await d.hold(1.6);
    d.mark("back");
    await d.prefix("shift+p");
    await d.until((s) => !s.private && s.workspace === "main", "back in main");
    await d.hold(1.0);
  },
};

/**
 * Rosé Pine's main dark palette (rosepinetheme.com: base, surface, text, rose, iris), as the
 * video's config card types it into `[theme.colors]`.
 */
export const ROSE_PINE = Object.freeze({
  accent: "#ebbcba",
  background: "#191724",
  dark_background: "#1f1d2e",
  foreground: "#e0def4",
  magenta: "#c4a7e7",
});

/**
 * @type {Shot} the theme from config.toml: over a split of the article and the start page, the
 * built-in aqua palette, then Rosé Pine's colours saved into `[theme.colors]`. The video's config
 * card types the same lines before the save.
 */
const theme = {
  name: "theme",
  async setup(d) {
    await only(d, ARTICLE, ARTICLE_TITLE);
    await d.send("ctrl+b v");
    await d.until(
      (s) => s.panes?.root?.children?.length === 2 && selected(s)?.url === START_URL,
      "a split with the start page on the right",
    );
    // the new pane's address bar has focus: Esc twice puts it back in the page (normal mode)
    await d.send("esc");
    await d.send("esc");
    await d.until((s) => s.mode === "normal", "focus back in the start page");
  },
  async run(d) {
    // the card types `[theme.colors]` and its lines meanwhile
    await d.hold(6.4);
    await d.saveTheme({ colors: ROSE_PINE }, "config:save");
    await d.hold(4.2);
  },
};

/** @type {Shot} tab search: every workspace's tabs and the recently closed; one reopened */
const tabs = {
  name: "tabs",
  async setup(d) {
    await teamTabs(d, { closed: true });
  },
  async run(d) {
    await d.hold(0.8);
    d.mark("search");
    await d.key("b", 0);
    await d.until((s) => s.mode === "help", "tab search");
    await d.hold(1.6);
    d.mark("closed");
    await d.type("drill", 0.3);
    await d.hold(1.0);
    await d.key("enter", 0);
    await d.until(
      (s) => s.mode === "normal" && selected(s)?.title === DRILL_TITLE,
      "the closed drill page reopened",
    );
    await d.hold(1.4);
  },
};

/**
 * @type {Shot} live grep: "rollback" across the tabs, ctrl+s widening the scope to the window,
 * ctrl+p and the preview, Enter to that match
 */
const grep = {
  name: "grep",
  async setup(d) {
    await teamTabs(d, { closed: false });
  },
  async run(d) {
    await d.hold(0.8);
    d.mark("grep");
    await d.key("ctrl+b", 0.5);
    await d.key("f", 0.25);
    await d.key("g", 0);
    await d.until((s) => s.mode === "help", "live grep");
    await d.hold(0.6);
    await d.type("rollback", 0.22);
    await d.hold(1.2);
    // widen the scope from this workspace to the window: every open tab, the reading
    // workspace's too
    d.mark("scope");
    await d.key("ctrl+s", 1.6);
    d.mark("browse");
    await d.key("ctrl+p", 0.8);
    await d.key("ctrl+p", 1.3);
    d.mark("jump");
    await d.key("enter", 0);
    await d.until(
      (s) => s.mode === "normal" && selected(s)?.title === CHECKLIST_TITLE,
      "the selected match, in the release checklist",
    );
    await d.hold(1.6);
  },
};

/**
 * @type {Shot} Vimma's own agent: ctrl+b i, a shopping task sent with Enter (a grant for the
 * task), the agent's steps in the agent workspace while the user's page stays as it was, then
 * the payment checkpoint, answered n
 */
const agent = {
  name: "agent",
  agent: true,
  async setup(d) {
    await only(d, NEWS, NEWS_TITLE);
  },
  async run(d) {
    await d.hold(0.8);
    d.mark("chat");
    await d.prefix("i");
    await d.until((s) => s.mode === "insert", "the chat window's input");
    await d.hold(0.8);
    await d.typeText(PROMO_TASK, 0.18);
    await d.hold(0.6);
    d.mark("send");
    await d.key("enter", 0);
    await d.agentPaying();
    d.mark("checkpoint");
    await d.hold(3.2);
    d.mark("answer");
    await d.key("n", 0);
    await d.agentDone();
    await d.hold(2.6);
  },
};

/** @type {Shot} the ctrl+b ? overlay, filtered */
const help = {
  name: "help",
  async setup(d) {
    await only(d, ARTICLE, ARTICLE_TITLE);
  },
  async run(d) {
    await d.hold(0.6);
    await d.prefix("?");
    await d.until((s) => s.mode === "help", "the bindings overlay");
    await d.hold(0.8);
    await d.key("/", 0.4);
    await d.type("pane", 0.3);
    await d.hold(1.8);
  },
};

/** @type {readonly Shot[]} in storyboard order */
export const SHOTS = Object.freeze([keys, tiling, flip, marks, tabs, grep, agent, theme, help]);
