/**
 * Stops `npm run import` and `npm run lane:setup` up front on a Node outside `package.json`'s
 * `engines`, which npm itself only warns about.
 *
 * The range is the 22 and 24 lines: 22.18 and 24.3 are the first to run `.ts` without a flag or
 * a warning (ADR-025), and Node 26 fails surfer's branding patch, whose `async-icns` calls
 * `fs.rmdir(path, { recursive: true })`, an option Node 26 rejects (issue #1538). Node 25 is not
 * an LTS line and is untested, so it is left out too.
 *
 * CLI: node tools/import/check-node.ts [version], the version defaulting to the running Node's.
 */
import { fileURLToPath } from "node:url";

/**
 * @param version a Node version as `process.version` gives it, such as `v22.23.3`
 * @returns why that Node cannot import, or null when it can
 */
export function nodeProblem(version: string): string | null {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if ((major === 22 && minor >= 18) || (major === 24 && minor >= 3)) return null;
  return [
    `Node ${version} is outside package.json's engines (^22.18.0 || ^24.3.0).`,
    "Node 26 fails surfer's branding patch (async-icns calls fs.rmdir with { recursive: true }),",
    "and older Node cannot run the .ts tools. Use the version in .nvmrc (nvm use).",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problem = nodeProblem(process.argv[2] ?? process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
