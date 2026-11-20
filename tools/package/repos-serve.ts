#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A local stand-in for the update host in repos-smoke.sh: serves a directory over HTTP on
 * 127.0.0.1 and answers the rules of its _redirects file the way Cloudflare's Workers static
 * assets do for the subset repos.ts writes (docs/specs/package-repositories.md, Research and
 * decision 11): a rule applies before an asset is looked up, `:name` matches one path segment,
 * and the status is the rule's own. Each request is logged as `METHOD path status [location]`,
 * so the smoke test can show that every package came through a redirect.
 *
 *   repos-serve.ts --dir DIR --port PORT [--log FILE]
 *
 * Test tooling only; nothing in a release runs it.
 */

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Rule {
  from: string[];
  to: string;
  status: number;
}

/** The rules of a _redirects file: `from to status`, one per line, # for comments. */
export function parseRedirects(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [from, to, code, ...extra] = line.split(/\s+/);
    if (from === undefined || to === undefined || extra.length || !from.startsWith("/")) {
      throw new Error(`repos-serve: bad rule: ${line}`);
    }
    const status = code === undefined ? 302 : Number(code);
    if (![301, 302, 303, 307, 308].includes(status)) {
      throw new Error(`repos-serve: bad status in rule: ${line}`);
    }
    rules.push({ from: from.split("/"), to, status });
  }
  return rules;
}

/** The first rule that matches `path`, with its placeholders filled in. */
export function matchRedirect(
  rules: Rule[],
  path: string,
): { location: string; status: number } | undefined {
  const segments = path.split("/");
  for (const rule of rules) {
    if (rule.from.length !== segments.length) continue;
    const values: Record<string, string> = {};
    const ok = rule.from.every((part, i) => {
      const segment = segments[i] ?? "";
      if (part.startsWith(":")) {
        values[part.slice(1)] = segment;
        return segment !== "";
      }
      return part === segment;
    });
    if (!ok) continue;
    const location = rule.to.replace(
      /:([A-Za-z_][A-Za-z0-9_]*)/g,
      (m, name: string) => values[name] ?? m,
    );
    return { location, status: rule.status };
  }
  return undefined;
}

/** Serves `dir` on 127.0.0.1:`port` (0 for any free port); resolves once it listens. */
export function serve(dir: string, port: number, log: (line: string) => void): Promise<Server> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // the rules are read on each request, so the smoke test can switch a tree between steps
    let rules: Rule[] = [];
    try {
      rules = parseRedirects(readFileSync(join(root, "_redirects"), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const hit = matchRedirect(rules, path);
    if (hit) {
      log(`${req.method} ${path} ${hit.status} ${hit.location}`);
      res.writeHead(hit.status, { location: hit.location }).end();
      return;
    }
    let body: Buffer | undefined;
    try {
      const file = resolve(root, `.${decodeURIComponent(path)}`);
      const inside = !path.split("/").includes("..") && file.startsWith(root + sep);
      if (inside && statSync(file).isFile()) body = readFileSync(file);
    } catch {
      body = undefined;
    }
    log(`${req.method} ${path} ${body ? 200 : 404}`);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, port: { type: "string" }, log: { type: "string" } },
  });
  if (!values.dir || !values.port) {
    process.stderr.write("usage: repos-serve.ts --dir DIR --port PORT [--log FILE]\n");
    process.exit(1);
  }
  const logFile = values.log;
  serve(values.dir, Number(values.port), (line) => {
    if (logFile) appendFileSync(logFile, `${line}\n`);
    else process.stdout.write(`${line}\n`);
  }).then(() => process.stdout.write(`repos-serve: listening on ${values.port}\n`));
}
