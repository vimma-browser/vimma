/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { formPage, manifest, otherPolicies } from "../create-app.mjs";

// docs/security.md, G14: the upstream App can write contents, pull requests and issues, nothing
// else; it has no webhook and is private to the organisation.
describe("the upstream App's manifest", () => {
  it("asks for contents, pull requests and issues, and nothing else", () => {
    const m = manifest("http://127.0.0.1:4000/callback");
    expect(m.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
    });
    expect(m.default_events).toEqual([]);
    // GitHub refuses a manifest whose hook_attributes has no url, even with the webhook off.
    expect(m.hook_attributes).toEqual({
      url: "https://github.com/vimma-browser/vimma",
      active: false,
    });
    expect(m.public).toBe(false);
    expect(m.redirect_url).toBe("http://127.0.0.1:4000/callback");
  });

  it("posts the manifest to the organisation's new-App page with the state", () => {
    const page = formPage(manifest("http://127.0.0.1:4000/callback"), "s1", "vimma-browser");
    expect(page).toContain(
      'action="https://github.com/organizations/vimma-browser/settings/apps/new?state=s1"',
    );
    expect(page).toContain('method="post"');
  });

  it("escapes the manifest inside the form's attribute", () => {
    const m = { ...manifest("http://127.0.0.1:4000/callback"), name: `a"<b>&'` };
    const page = formPage(m, "s1", "vimma-browser");
    expect(page).not.toContain(`a"<b>`);
    const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? "";
    const decoded = value
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    expect(JSON.parse(decoded).name).toBe(`a"<b>&'`);
  });
});

describe("the upstream-autopilot environment", () => {
  it("names every deployment policy other than the branch main", () => {
    expect(otherPolicies([{ name: "main", type: "branch" }])).toEqual([]);
    expect(
      otherPolicies([
        { name: "main", type: "branch" },
        { name: "*", type: "branch" },
        { name: "main", type: "tag" },
      ]),
    ).toEqual(["branch *", "tag main"]);
  });
});
