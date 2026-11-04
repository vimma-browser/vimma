#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Creates the upstream autopilot's GitHub App from a manifest (docs/runbook.md, "Upstream App";
 * docs/security.md, G14) and stores its client ID and private key where upstream.yml reads them.
 *
 *   node tools/upstream/create-app.mjs [--org vimma-browser] [--repo vimma]
 *     [--name vimma-upstream-autopilot] [--env upstream-autopilot]
 *
 * Open the printed local address and confirm on GitHub. The private key goes from GitHub's answer
 * to `gh secret set` through a pipe and is never written to disk or printed. Installing the App on
 * the repository is the one step left by hand: GitHub has no API for it with a user's token.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * @param {string} redirectUrl where GitHub sends the browser back with the one-time code
 * @param {string} [name]
 */
export function manifest(redirectUrl, name = "vimma-upstream-autopilot") {
  return {
    name,
    url: "https://github.com/vimma-browser/vimma",
    description: "Opens Vimma's Firefox upstream bump pull requests so that their CI runs.",
    public: false,
    hook_attributes: { active: false },
    redirect_url: redirectUrl,
    default_permissions: { contents: "write", pull_requests: "write", issues: "write" },
    default_events: [],
  };
}

/** @param {string} s */
function attr(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The page that posts the manifest to GitHub, as the manifest flow requires a form post.
 * @param {object} m the manifest
 * @param {string} state
 * @param {string} org
 */
export function formPage(m, state, org) {
  const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<meta charset="utf-8">
<title>Create the upstream App</title>
<form action="${attr(action)}" method="post">
  <input type="hidden" name="manifest" value="${attr(JSON.stringify(m))}">
  <button type="submit">Create the App on GitHub</button>
</form>
`;
}

/**
 * Deployment policies besides the branch main: any of them would let another ref read the key.
 * @param {{ name: string, type: string }[]} list
 */
export function otherPolicies(list) {
  return list
    .filter((p) => !(p.name === "main" && p.type === "branch"))
    .map((p) => `${p.type} ${p.name}`);
}

/**
 * @param {string[]} args
 * @param {string} [input]
 */
function gh(args, input) {
  return execFileSync("gh", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

/**
 * The environment the key lives in: deployable only from main, as site-dispatch is.
 * @param {string} nwo owner/repo
 * @param {string} env
 */
function ensureEnvironment(nwo, env) {
  gh([
    "api",
    "-X",
    "PUT",
    `repos/${nwo}/environments/${env}`,
    "-F",
    "deployment_branch_policy[protected_branches]=false",
    "-F",
    "deployment_branch_policy[custom_branch_policies]=true",
  ]);
  const policies = JSON.parse(
    gh(["api", `repos/${nwo}/environments/${env}/deployment-branch-policies`]),
  );
  /** @type {{ name: string, type: string }[]} */
  const list = policies.branch_policies ?? [];
  if (!list.some((p) => p.name === "main" && p.type === "branch")) {
    gh([
      "api",
      "-X",
      "POST",
      `repos/${nwo}/environments/${env}/deployment-branch-policies`,
      "-f",
      "name=main",
      "-f",
      "type=branch",
    ]);
  }
  const others = otherPolicies(list);
  if (others.length) {
    throw new Error(`${env} also deploys from ${others.join(", ")}: remove them, then rerun`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      org: { type: "string", default: "vimma-browser" },
      repo: { type: "string", default: "vimma" },
      name: { type: "string", default: "vimma-upstream-autopilot" },
      env: { type: "string", default: "upstream-autopilot" },
    },
  });
  const org = /** @type {string} */ (values.org);
  const nwo = `${org}/${values.repo}`;
  const env = /** @type {string} */ (values.env);
  const state = randomBytes(16).toString("hex");
  // Before the App exists, so a refused environment leaves nothing to clean up.
  ensureEnvironment(nwo, env);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    if (url.pathname === "/") {
      const m = manifest(`http://127.0.0.1:${port}/callback`, values.name);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(formPage(m, state, org));
      return;
    }
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.get("state") !== state || !/^[\w-]+$/.test(code)) {
      res.writeHead(400).end("state or code does not match");
      return;
    }
    try {
      // The code is single-use and expires in an hour; the answer holds the private key.
      const app = JSON.parse(gh(["api", "-X", "POST", `app-manifests/${code}/conversions`]));
      if (app.owner?.login !== org) throw new Error(`the App belongs to ${app.owner?.login}`);
      gh(["secret", "set", "UPSTREAM_APP_KEY", "-R", nwo, "--env", env], app.pem);
      gh(["variable", "set", "UPSTREAM_APP_ID", "-R", nwo, "-b", app.client_id]);
      const install = `https://github.com/apps/${app.slug}/installations/new`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><p>Created ${attr(app.slug)}. ` +
          `<a href="${attr(install)}">Install it on ${attr(nwo)} only</a>.</p>`,
      );
      console.log(`Created ${app.html_url} (client ID ${app.client_id}).`);
      console.log(`UPSTREAM_APP_ID set; UPSTREAM_APP_KEY set in the ${env} environment.`);
      console.log(`Last step: install it on ${nwo} only: ${install}`);
    } catch (e) {
      res.writeHead(500).end("failed; see the terminal");
      console.error(e);
      process.exitCode = 1;
    }
    server.close();
  });
  server.listen(0, "127.0.0.1", () => {
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    console.log(`Open http://127.0.0.1:${port}/ and confirm on GitHub.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
