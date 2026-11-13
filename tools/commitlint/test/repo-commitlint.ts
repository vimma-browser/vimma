/**
 * The repository's commitlint (commitlint.config.mjs and its plugins), run in-process for tests.
 *
 * Spawning `npx commitlint` per message cost each call an npm start-up plus a commitlint
 * start-up and config load (about 0.3 s idle, 0.7 s and more on a loaded machine), which pushed
 * tests that lint several messages past Vitest's 5 s timeout under load. This loads the config
 * once per test file and lints each message with the same `load`, `lint` and `format` modules
 * the installed CLI imports, wired the way `@commitlint/cli` (lib/cli.js) wires them for a
 * message on stdin. One test in body-required.test.mjs still runs the CLI itself.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("../../..", import.meta.url));

// Resolved from the CLI's own location, so these are the very modules `commitlint` runs with,
// at the versions it was installed with, without listing them as dependencies of their own.
const fromCli = createRequire(
  createRequire(import.meta.url).resolve("@commitlint/cli/package.json"),
);

/** The CLI's entry point, for the one test that runs it as a process. */
export const cliPath = fromCli.resolve("@commitlint/cli/cli.js");

/** @param {string} name */
const cliModule = async (name) => (await import(pathToFileURL(fromCli.resolve(name)).href)).default;

/** @type {Promise<(message: string) => Promise<{ status: number, output: string }>> | undefined} */
let linter;

async function makeLinter() {
  const [load, lint, format] = await Promise.all(
    ["@commitlint/load", "@commitlint/lint", "@commitlint/format"].map(cliModule),
  );
  const loaded = await load({}, { cwd: root });
  const parserOpts = loaded.parserPreset?.parserOpts;
  const opts = {
    parserOpts: typeof parserOpts === "object" ? parserOpts : {},
    plugins: loaded.plugins ?? {},
    ignores: loaded.ignores ?? [],
    defaultIgnores: loaded.defaultIgnores !== false,
  };
  return async (/** @type {string} */ message) => {
    const result = await lint(message, loaded.rules, opts);
    const report = {
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      results: [result],
    };
    const output = format(report, { color: false, helpUrl: loaded.helpUrl });
    // The CLI exits 1 on any error and 0 otherwise, warnings included.
    return { status: result.valid ? 0 : 1, output };
  };
}

/**
 * Lints `message` as `npx commitlint` would with the message on stdin.
 * @param {string} message
 * @returns {Promise<{ status: number, output: string }>}
 */
export async function commitlint(message) {
  linter ??= makeLinter();
  return (await linter)(message);
}
