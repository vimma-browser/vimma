// What release.yml's macos-notarise job, the only one holding the Apple secrets, may run (spec
// macos-build, decision 23; docs/security.md, B14): an exact list of steps and actions, and in its
// shell blocks only allowlisted commands. Returns the problems found, empty when the job is as it
// must be; release-workflow.test.mjs checks the job and mutations of it.

/** The steps, in order: an action (`uses:`) or a step name. */
const STEPS = [
  "uses actions/checkout",
  "uses actions/download-artifact macos-volume",
  "uses actions/download-artifact macos-app-manifest",
  "rcodesign (pinned)",
  "The unsigned app",
  "Signing credentials",
  "Sign with the Developer ID, notarise and staple",
  "Delete the signing credentials",
  "The signed app",
  "uses actions/upload-artifact",
];

/** Commands a shell block may start: builtins, coreutils, tar and the repository's own scripts. */
const COMMANDS = new Set([
  "[",
  "for",
  "if",
  "else",
  "fi",
  "done",
  "echo",
  "printenv",
  "exit",
  "umask",
  "mkdir",
  "printf",
  "base64",
  "rm",
  "tar",
  "cmp",
  "tools/package/fetch-rcodesign.sh",
  "tools/package/macos-app-manifest.sh",
  "tools/package/macos-sign-app.sh",
]);

/**
 * The first word of each command in a shell block: `$(...)` contents become commands of their
 * own, then the text is split on newlines, `;`, `&&`, `||`, `|`, `then`, `do` and grouping
 * parentheses. A word that is only an assignment (`dir=...`) runs nothing.
 * @param {string} script
 * @returns {string[]}
 */
export function commandsOf(script) {
  let text = script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/\\\n/g, " ");
  /** @type {string[]} */
  const pieces = [];
  for (;;) {
    const m = /\$\(([^()]*)\)/.exec(text);
    if (!m) break;
    pieces.push(m[1] ?? "");
    text = text.slice(0, m.index) + "SUBST" + text.slice(m.index + m[0].length);
  }
  pieces.push(text);
  return pieces
    .flatMap((p) => p.split(/\n|;|&&|\|\||\||\bthen\b|\bdo\b/))
    .map((s) =>
      s
        .trim()
        .replace(/^[({]\s*/, "")
        .replace(/^[)}]\s*/, ""),
    )
    .map((s) => {
      // leading assignments (`dir=...`, `LD_PRELOAD=x cmd`) run nothing; the word after them does
      const words = s.split(/\s+/);
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
      return words[0] ?? "";
    })
    .filter((w) => w !== "");
}

/**
 * @param {string} block the job's YAML block, as release-workflow.test.mjs's jobs() gives it
 * @returns {string[]}
 */
export function notariseJobProblems(block) {
  /** @type {string[]} */
  const problems = [];
  const steps = block.slice(block.indexOf("\n    steps:\n") + 12).split(/\n(?= {6}- )/);
  const seen = steps.map((step) => {
    const uses = /^ {6}- uses: ([^@\s]+)@(\S+)/m.exec(step);
    if (uses) {
      if (!/^[0-9a-f]{40}$/.test(uses[2] ?? "")) {
        problems.push(`${uses[1]}@${uses[2]} is not pinned to a commit`);
      }
      const name = /^ {10}name: (\S+)$/m.exec(step)?.[1];
      if (uses[1] === "actions/download-artifact" && name !== undefined) {
        if (!["macos-volume", "macos-app-manifest"].includes(name)) {
          problems.push(`downloads ${name}`);
        }
        return `uses ${uses[1]} ${name}`;
      }
      return `uses ${uses[1]}`;
    }
    return /^ {6}- name: (.*)$/m.exec(step)?.[1] ?? step.trim();
  });
  STEPS.forEach((want, i) => {
    if (seen[i] !== want) problems.push(`step ${i + 1} is ${seen[i] ?? "missing"}, want ${want}`);
  });
  if (seen.length !== STEPS.length) {
    problems.push(`${seen.length} steps, want ${STEPS.length}: ${seen.join(" / ")}`);
  }
  for (const m of block.matchAll(/^ {8}run:(.*)$/gm)) {
    if ((m[1] ?? "").trim() !== "|") problems.push(`run:${m[1]} is not a | block`);
  }
  for (const m of block.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\s*\n)+)/gm)) {
    const script = (m[1] ?? "").replace(/^ {10}/gm, "");
    for (const command of commandsOf(script)) {
      if (!COMMANDS.has(command)) problems.push(`runs ${command}`);
    }
  }
  return problems;
}
