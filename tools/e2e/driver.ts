// Drives a running Vimma through `vimma-ctl` (spec m0-e2e-harness), so the e2e suite dogfoods
// the shipped client. Exit codes and messages are vimma-ctl's (spec
// m0-control-protocol-and-vimma-ctl). Only ready() retries, and only while the socket is not up
// yet or busy; commands and assertions run once (plan §5: no retries).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type CtlErrorKind =
  "server" | "usage" | "not-running" | "busy" | "auth" | "protocol" | "spawn" | "aborted";

/**
 * A server still starting up: it listens before its first browser window exists and answers
 * `failed: no browser window` until then. ready() retries only this one.
 */
const STARTING_UP = /^vimma-ctl: failed: no browser window\b/m;

export class CtlError extends Error {
  declare kind: CtlErrorKind;
  declare code: string | null;
  declare exitCode: number | null;
  declare stderr: string;
  constructor(
    message: string,
    {
      kind,
      code,
      exitCode,
      stderr,
    }: { kind: CtlErrorKind; code: string | null; exitCode: number | null; stderr: string },
  ) {
    super(message);
    this.name = "CtlError";
    this.kind = kind;
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Map a vimma-ctl exit code and stderr to an error kind and, when there is one, the protocol
 * error code.
 * @param exitCode null: the process did not run or was killed
 */
export function classify(
  exitCode: number | null,
  stderr: string,
): { kind: CtlErrorKind; code: string | null } {
  const line =
    stderr
      .trim()
      .split("\n")[0]
      ?.replace(/^vimma-ctl: /, "") ?? "";
  switch (exitCode) {
    case 1:
      return { kind: "server", code: /^([a-z-]+): /.exec(line)?.[1] ?? null };
    case 2:
      return { kind: "usage", code: null };
    case 3:
      return /control socket is busy/.test(line)
        ? { kind: "busy", code: "busy" }
        : { kind: "not-running", code: null };
    case 4:
      return { kind: "auth", code: /^authentication failed: ([a-z-]+):/.exec(line)?.[1] ?? null };
    case 5:
      return { kind: "protocol", code: null };
    default:
      return { kind: "spawn", code: null };
  }
}

/**
 * The vimma-ctl binary: `flag` (--vimma-ctl), else VIMMA_CTL, else a cargo build in the repo.
 */
export function findVimmaCtl({
  flag,
  env = {},
  root = REPO_ROOT,
  exists = existsSync,
}: {
  flag?: string;
  env?: Record<string, string | undefined>;
  root?: string;
  exists?: (path: string) => boolean;
} = {}) {
  const explicit = flag ?? env.VIMMA_CTL;
  if (explicit) {
    if (!exists(explicit)) throw new Error(`vimma-ctl not found at ${explicit}`);
    return explicit;
  }
  const tried = ["release", "debug"].map((p) =>
    join(root, "tools/vimma-ctl/target", p, "vimma-ctl"),
  );
  const found = tried.find((p) => exists(p));
  if (found) return found;
  throw new Error(
    `vimma-ctl is not built (tried ${tried.join(", ")}). Build it: ` +
      "(cd tools/vimma-ctl && cargo build --locked), or pass --vimma-ctl / set VIMMA_CTL",
  );
}

export class Ctl {
  declare bin: string;
  declare profile: string;
  declare timeoutSecs: number;
  declare signal: AbortSignal | undefined;
  /**
   * @param options `signal` (the scenario's timeout) kills a running vimma-ctl and stops ready() at once.
   */
  constructor({
    bin,
    profile,
    timeoutSecs = 5,
    signal,
  }: {
    bin: string;
    profile: string;
    timeoutSecs?: number;
    signal?: AbortSignal;
  }) {
    this.bin = bin;
    this.profile = profile;
    this.timeoutSecs = timeoutSecs;
    this.signal = signal;
  }

  /**
   * Run vimma-ctl once.
   * @returns stdout
   */
  run(args: string[]): Promise<string> {
    const argv = ["--profile", this.profile, "--timeout", String(this.timeoutSecs), ...args];
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        argv,
        {
          encoding: "utf8",
          timeout: (this.timeoutSecs + 5) * 1000,
          env: { ...process.env },
          signal: this.signal,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const exitCode = typeof error.code === "number" ? error.code : null;
          const { kind, code } = this.signal?.aborted
            ? { kind: "aborted" as CtlErrorKind, code: null }
            : classify(exitCode, stderr);
          const why = stderr.trim() || error.message;
          reject(
            new CtlError(`vimma-ctl ${args[0]} failed (${kind}): ${why}`, {
              kind,
              code,
              exitCode,
              stderr,
            }),
          );
        },
      );
    });
  }

  /** @returns the `state` result */
  async state(): Promise<Record<string, any>> {
    const out = await this.run(["state", "--json"]);
    let state;
    try {
      state = JSON.parse(out);
    } catch {
      throw new CtlError(`vimma-ctl state --json printed invalid JSON: ${out.slice(0, 200)}`, {
        kind: "protocol",
        code: null,
        exitCode: 0,
        stderr: "",
      });
    }
    return state;
  }

  /** @param keys Herdr chords, space-separated */
  async sendKeys(keys: string) {
    await this.run(["send-keys", keys]);
  }

  /** @returns the new tab's id */
  async open(url: string): Promise<string> {
    return (await this.run(["open", url])).trim();
  }

  /**
   * Connection setup: call `state` until it answers, retrying only while the socket is not up
   * yet (`not-running`), `busy`, or the server is still starting up (`failed: no browser
   * window`), and only until `timeoutMs`. Anything else fails at once.
   */
  async ready({
    timeoutMs = 10_000,
    intervalMs = 100,
  }: { timeoutMs?: number; intervalMs?: number } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.state();
      } catch (e) {
        const retryable =
          e instanceof CtlError &&
          (e.kind === "not-running" ||
            e.kind === "busy" ||
            (e.kind === "server" && STARTING_UP.test(e.stderr)));
        if (!retryable || Date.now() + intervalMs >= deadline) throw e;
      }
      try {
        await sleep(intervalMs, undefined, { signal: this.signal });
      } catch {
        throw new CtlError("vimma-ctl: ready() aborted", {
          kind: "aborted",
          code: null,
          exitCode: null,
          stderr: "",
        });
      }
    }
  }
}
