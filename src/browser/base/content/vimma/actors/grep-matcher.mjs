/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live grep's matching in one content process (docs/specs/live-grep.md decision 14): one
// ChromeWorker (actors/grep-worker.mjs) shared by every frame of the process that is being
// searched, holding each frame's text by key. Queries run one at a time, each with its own time
// budget; a query that runs past it is stopped by terminating the worker, which cannot be
// interrupted otherwise. A frame's newer query replaces its queued or running one. The worker
// ends when no frame holds text in it.

const { clearTimeout, setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);

const WORKER_URL = "chrome://browser/content/vimma/actors/grep-worker.mjs";
/** A query's time budget (ms); the parent waits 2,000 ms for a frame's answer. */
export const GREP_BUDGET_MS = 1000;

/**
 * @typedef {object} Job
 * @property {string} key  the frame's
 * @property {{ text: string }} model  the frame's text model
 * @property {string} query
 * @property {boolean} all  every match up to the count cap (the jump)
 * @property {boolean} firstPerLine  one match a line (recently closed titles and URLs)
 * @property {(reply: any) => void} resolve  grepText's result, null when replaced, "timeout"
 */

/** @type {ChromeWorker | null} */
let worker = null;
/** @type {Map<string, object>} the model each frame's text in the worker came from */
const texts = new Map();
/** @type {Job[]} */
let queue = [];
/** @type {{ id: number, job: Job, timer: unknown } | null} */
let running = null;
let lastId = 0;
let lastKey = 0;

function kill() {
  worker?.terminate();
  worker = null;
  texts.clear();
}

/** Stops the running query: it answers `reply`, and the next one starts. */
function stopRunning(/** @type {any} */ reply) {
  if (!running) return;
  clearTimeout(running.timer);
  const { job } = running;
  running = null;
  kill();
  job.resolve(reply);
}

function pump() {
  if (running || !queue.length) return;
  const job = /** @type {Job} */ (queue.shift());
  if (!worker) {
    worker = new ChromeWorker(WORKER_URL, { type: "module" });
    worker.onmessage = (/** @type {MessageEvent} */ e) => {
      if (!running || e.data?.id !== running.id) return;
      clearTimeout(running.timer);
      const done = running.job;
      running = null;
      done.resolve(e.data.reply);
      pump();
    };
  }
  if (texts.get(job.key) !== job.model) {
    worker.postMessage({ type: "text", key: job.key, text: job.model.text });
    texts.set(job.key, job.model);
  }
  const id = ++lastId;
  const timer = setTimeout(() => {
    if (running?.id !== id) return;
    stopRunning("timeout");
    pump();
  }, GREP_BUDGET_MS);
  running = { id, job, timer };
  worker.postMessage({
    type: "query",
    id,
    key: job.key,
    query: job.query,
    all: job.all,
    firstPerLine: job.firstPerLine,
  });
}

/** Drops a frame's queued queries (they answer null) and stops its running one. */
function cancel(/** @type {string} */ key) {
  queue = queue.filter((job) => {
    if (job.key !== key) return true;
    job.resolve(null);
    return false;
  });
  if (running?.job.key === key) stopRunning(null);
}

export const GrepMatcher = {
  /** A key for a new frame. */
  newKey() {
    return String(++lastKey);
  },

  /**
   * Runs a frame's query on its text model, replacing that frame's earlier one.
   * @param {string} key
   * @param {{ text: string }} model
   * @param {string} query
   * @param {boolean} all
   * @param {boolean} [firstPerLine]
   * @returns {Promise<any>} grepText's result, null when replaced, or "timeout"
   */
  match(key, model, query, all, firstPerLine = false) {
    cancel(key);
    return new Promise((resolve) => {
      queue.push({ key, model, query, all, firstPerLine, resolve });
      pump();
    });
  },

  /**
   * The frame is done (the picker closed, or its document went away): its queries stop, its
   * text leaves the worker, and the worker ends when no frame holds text in it.
   * @param {string} key
   */
  drop(key) {
    cancel(key);
    if (texts.delete(key)) worker?.postMessage({ type: "forget", key });
    if (!texts.size && !running && !queue.length) kill();
    pump();
  },

  /** Tests: the workers alive (0 or 1) and the frames whose text the worker holds. */
  get workers() {
    return worker ? 1 : 0;
  },
  get frames() {
    return [...texts.keys()];
  },
};
