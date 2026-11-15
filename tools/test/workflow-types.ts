// The parts of a GitHub Actions workflow that the workflow tests read, as js-yaml parses them
// (workflow-runners.mjs's `jobs` and `parseWorkflow`). Only the keys a test names are typed, with
// the types GitHub gives them; any other key is unknown, so reading it needs a check first.

export interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  environment?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
  [key: string]: unknown;
}
