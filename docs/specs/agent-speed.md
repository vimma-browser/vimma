# Spec: agent-speed

Status: draft (Delivery 1 in #603, 2 in #611, 3 for #598, 6 for #600) · Area: `tools/agent-bench/` (the
scripted floor, the per-step breakdown); `packages/vimma-core/src/` (`agent-loop.mjs`, `agent-providers.mjs`,
`agent-tools-data.mjs`, `agent-act.mjs`); `tools/vimma-ctl` (`src/mcp.rs`: tool descriptions and
`INSTRUCTIONS`); `src/browser/base/content/vimma/` (`ctl/agent-commands.mjs`,
`actors/VimmaChild.sys.mjs` for element lists); `docs/agent-bench.md`, `docs/runbook.md`,
`docs/guide.md`, `docs/security.md` · Upstream patches: none · ADR: none. No new dependency.

Issue: [#596](https://github.com/vimma-browser/vimma/issues/596)

Builds on [builtin-agent](builtin-agent.md) (the model loop, the bench, and its Delivery 7, the
`query` and `kinds` filters of `vimma_elements`), [mcp-forms](mcp-forms.md) (element lists, M31)
and [mcp-checkpoints](mcp-checkpoints.md) (sending a form and paying). Decisions of those specs
are written "builtin-agent B2" and so on; this spec's own are "S1", "S2", and so on. Vimma paths
are under `src/browser/base/content/vimma/` unless they start with `packages/`, `tools/` or
`docs/`. Measurements were made at commit `3bceaafa` on an artifact build of Firefox 159.0.

## Summary

The built-in agent takes too long on a shopping list: the bench's scripted agent, which knows
the answers, needs 51 steps and about 500,000 tokens for ten items, and a local 27B model on the
CPU spends about 90 seconds a step, so it reaches the 30-minute limit after about 20 steps. This
spec measures where the time and the tokens go and plans five changes: fewer steps a list item
(open a site's search results by URL and take the element list in the same call), local models
that run where they are fast (the GPU, a mixture-of-experts model, no thinking on routine
steps), less new text a step (compact element lists), a context that stops growing (older page
content left out of later requests), and fewer model turns (independent steps in one turn).
Together they bring a ten-item list within a few minutes for a capable model, without weakening
the page-text rules, the checkpoints or the confinement.

## Problem

- **Steps.** The scripted floor in [agent-bench.md](../agent-bench.md) takes about 5 steps an
  item: `vimma_open`, one to three `vimma_elements` refused while the tab is still on its first
  blank document, a `vimma_elements` that lists the page, and a `vimma_activate` for each unit
  of the quantity. A model also has to find each product, which the floor skips by opening the
  product's URL directly.
- **Tokens.** Every request sends the whole conversation again. The floor's mean request on the
  ten-item list held 9,700 tokens and its last 15,400; over the run 34 % of the characters sent
  were the tool definitions, 39 % earlier tool results, and only 2 % the result the model had
  not seen yet.
- **Time on a local model.** On the bench machine's CPU a dense 27B model reads new prompt
  text at 12 to 24 tokens a second and writes 2.4 to 4.1 tokens a second. A step
  that brings a product page's element list (about 860 new tokens) takes about 80 seconds, of
  which about 70 are spent reading the list. Ollama ran on the CPU although the machine has a
  GPU (Research).
- **Rates.** A fast agent reaches the per-conversation rate of 10 page loads a minute
  (`OPEN_RATE`, `packages/vimma-core/src/agent.mjs`) at about ten items a minute; the refusal
  costs further steps and says that requests are waiting for the user, which is not the cause.

## Behaviour

1. The bench reports, for each run, the model's time and the tools' time, the mean and largest
   input tokens a model turn, the mean output tokens a turn, and the share of the characters
   sent that were tool definitions, instructions, the model's own calls, earlier results and
   new results (`formatBreakdown`, printed after the results table, and `turns` in `--out`).
2. The scripted floor takes the shortest path the tools allow a model that does not know the
   product's URL: a site search opened by URL with `elements: true`, and the listing's basket
   button. It is measured both at full speed and paced as a model would be, so that the floor
   is not refused for being faster than the rates allow.
3. The agent's instructions tell it to open a site's search results by URL when the site has a
   search (`https://shop.example/search?q=oat+drink`), with `elements: true`, rather than
   typing into the search field and sending the form, which is a form submission and asked
   every time (mcp-forms F15).
4. An element list carries its explanation once, in the tool description, instead of in every
   result; a list of a page on a site the conversation has already listed leaves out the lines
   identical to that earlier list and says how many it left out; `vimma_elements`, and the
   `elements` option of `vimma_open`, `vimma_activate` and `vimma_fill`, take the `query` and
   `kinds` filters of builtin-agent B2.
5. The built-in agent's requests leave out the body of tool results older than the last
   `[agent] keep_results` results (default 6), keeping each result's first line (the page's
   URL and title inside the untrusted-content wording) and a note that the rest was left out.
   Results are left out in blocks of the same size, so that a provider's prompt cache keeps
   the conversation's prefix between blocks.
6. A conversation's model turn may carry several tool calls; the instructions say that steps
   that do not depend on each other (opening each item's search in its own tab) go in one turn.
7. Setup and the guide say how to run a local model on the GPU, and the bench's results state
   where each model ran. A local provider may turn a model's thinking off or down for the
   agent's steps (`think = false` in its `[[agent.providers]]` entry).

## Research

### Where the time and the tokens go

Bench runs with the scripted provider, all ten lists, one run each, with the breakdown of
Behaviour 1 (the token figures are characters divided by four, as the scripted provider
counts them):

| List | Steps | Model turns | Input/turn (mean) | Input/turn (max) | Output/turn | Tools % | Instructions % | Calls % | Old results % | New results % |
| ---- | ----- | ----------- | ----------------- | ---------------- | ----------- | ------- | -------------- | ------- | ------------- | ------------- |
| L01  | 10    | 11          | 4,850             | 6,074            | 40          | 68      | 12             | 3       | 10            | 3             |
| L04  | 27    | 28          | 6,641             | 10,036           | 41          | 49      | 9              | 6       | 26            | 2             |
| L07  | 42    | 43          | 8,453             | 13,770           | 41          | 39      | 7              | 7       | 35            | 2             |
| L10  | 52    | 53          | 9,676             | 15,426           | 41          | 34      | 6              | 8       | 39            | 2             |

- **Per item:** 5.2 steps on L10, of which 2.0 were `vimma_elements` refused because the tab
  was still on its first blank document or navigating. Paced at 1.3 seconds a model turn, the
  refusals disappear and L04 takes 16 steps (three an item, one more click for the second
  pack of butter, three for the checkout) and 110,000 tokens instead of 27 and 187,000.
- **Per request:** the tool definitions are 12,818 characters (about 3,200 tokens) and the
  system text 2,040, sent with every request. A product page's element list is about 2,350
  characters, of which 781 are the explanation that every list repeats and 1,412 the shop's
  search form, header and category links, the same on every page.
- **Growth:** the input grows by about 250 tokens a step on average and by about 600 for each
  element list, so the last request of a ten-item list is four times the first.
- **Tool time:** 1 to 4 seconds a run (over all ten lists, `vimma_open` took 15 ms on
  average, `vimma_elements` 21 ms and `vimma_activate` 325 ms, which waits to report what the
  click changed). The tools are not where the time goes.

### Scripted paths and request changes

Scripted runs of other paths on L04 (four items, one of them twice) and L10 (ten items, one
of them twice), one run each. The request changes were applied to the request body before the
scripted provider counted it, so they show the token effect only, not how a model would read
the shorter context. Model turns were paced so that the runs stayed under the rates, except
where noted.

| Path                                                             | L04 steps | L04 turns | L04 tokens | L10 steps | L10 turns | L10 tokens | L10 last request |
| ---------------------------------------------------------------- | --------- | --------- | ---------- | --------- | --------- | ---------- | ---------------- |
| Today's floor, unpaced (product URL, `vimma_elements`, clicks)   | 27        | 28        | 187,000    | 52        | 53        | 515,000    | 15,400           |
| Today's floor, paced at 1.3 s a turn                             | 16        | 17        | 110,000    | 32 (1)    | 33        | 304,000    | 14,000           |
| Product URL opened with `elements: true`                         | 11        | 12        | 78,000     | 42 (1)    | 43        | 632,000    | 27,700           |
| Search URL with `elements: true`, then the listing's button (S2) | 11        | 12        | 78,000     | 23        | 24        | 232,000    | 15,400           |
| S2 with compact element lists (S3, S4)                           | 11        | 12        | 69,000     | 23        | 24        | 171,000    | 10,600           |
| S2 with results older than the last four left out (S5)           | 11        | 12        | 69,000     | 23        | 24        | 159,000    | 8,800            |
| S2 with S3, S4 and S5                                            | 11        | 12        | 62,000     | 23        | 24        | 141,000    | 8,000            |
| S2 with tool descriptions cut to their first sentence            | 11        | 12        | 61,000     | 23        | 24        | 197,000    | 14,000           |
| S2 with independent steps in one turn (S6)                       | 11        | 5         | 37,000     | 23 (2)    | 5         | 53,000     | 12,500           |

(1) Incomplete: the eleventh page load within a minute was refused as `busy` by the open rate,
and the run spent its remaining steps retrying. (2) Incomplete: after ten loads in one turn,
every click of the next turn was refused as `busy`; which rate refused them was not found.

- The search path is the shortest a model can take that does not know a product's URL, and it
  takes two steps an item plus two for the checkout: 23 steps for ten items, against 52.
- A product page's list repeats 781 characters of explanation, and 85 % of the JSON lines of
  the floor's ten product lists were identical, label included, to a line an earlier list of
  the same shop had given (the header, the category links, the quantity field and the basket
  button). Search listings repeat less, since their rows differ, which is why compact lists
  save 26 % on the search path.
- Cutting the tool descriptions saves 15 %, less than compact lists or pruning, and removes
  the text that tells a model what asks the user and what never runs; it is not proposed.
- Several calls a turn cut the turns from 12 to 5 on L04, and the tokens by half, because each
  turn sends the conversation once.

### Local models on this machine

AMD Ryzen AI 7 PRO 350 (8 cores, 16 threads), 58 GiB RAM, Radeon 860M, Linux 7.2; Ollama
0.40.12 (`/usr/local/bin/ollama`, the upstream build). Each figure is one request to Ollama's
`/api/chat` with the bench's tools and system text, timed from its `prompt_eval_duration` and
`eval_duration`; wall times leave out loading the model. Two unrelated processes held two
hardware threads at 100 % during these runs, and the first row also ran beside a build, so the
figures are slower than an idle machine gives.

| Model                                             | Request                                     | New prompt tokens read | Read speed | Output tokens | Write speed | Wall time |
| ------------------------------------------------- | ------------------------------------------- | ---------------------- | ---------- | ------------- | ----------- | --------- |
| qwen3.8:27b (dense, Q4_K_M), thinking on (medium) | first turn, nothing cached                  | 3,964                  | 20 tok/s   | 126           | 2.4 tok/s   | 250 s     |
| qwen3.8:27b, thinking off                         | first turn, nothing cached                  | 3,966                  | 24 tok/s   | 68            | 3.3 tok/s   | 188 s     |
| qwen3.8:27b, thinking off                         | L03 step 17: a new element list (about 860) | about 860              | 12 tok/s   | 40            | 4.1 tok/s   | 79 s      |
| qwen3.8:27b, thinking on (medium)                 | L03 step 18: a click result (about 200)     | about 200              | 13 tok/s   | 63            | 2.4 tok/s   | 41 s      |
| ornith-1.5:35b (mixture of experts, Q4_K_M), off  | first turn, nothing cached                  | 3,923                  | 66 tok/s   | 78            | 13.8 tok/s  | 66 s      |
| ornith-1.5:35b, thinking off                      | L03 step 17: a new element list (about 860) | about 860              | 35 tok/s   | 40            | 3.6 tok/s   | 36 s      |
| ornith-1.5:35b, thinking on (default)             | L03 step 18: a click result (about 200)     | about 200              | 46 tok/s   | 79            | 10.4 tok/s  | 12 s      |

- Ollama's prompt cache works for this loop: a request that repeats the previous one and adds
  to it is read only from the first changed token, so the cost of a step is the new text and
  the output, not the whole conversation. A change to an earlier message (pruning, a new
  system text) makes the next request read everything after it again.
- Reading new text dominates a step on the CPU: an element list costs 70 seconds on the dense
  27B model and 24 on the mixture-of-experts model, against 10 to 27 seconds of output.
- Thinking added 0 to 60 output tokens a step at the default level, 10 to 25 seconds each on
  the dense model.
- **Why Ollama used no GPU.** The service log at startup reads `dropping integrated GPU; to
enable, set OLLAMA_IGPU_ENABLE=1` for the device `AMD Radeon 860M Graphics (RADV KRACKAN1)`
  found through `library=Vulkan`, followed by an inference device `id=cpu`. Ollama 0.40.12 has
  its Vulkan backend on (`OLLAMA_VULKAN:true` in the same log) and finds the GPU through Mesa's
  RADV driver (`vulkan-radeon` 26.2.5), but leaves out integrated GPUs unless
  `OLLAMA_IGPU_ENABLE=1` is set. The kernel reports 4 GiB of dedicated memory for the GPU
  (`mem_info_vram_total`) and 31.4 GB it may map from system memory (`mem_info_gtt_total`). The
  effect on speed was not measured, since it needs a change to the system service. A GPU reads
  prompt text much faster than the CPU because reading is compute-bound; writing is bound by
  memory bandwidth, which the integrated GPU shares with the CPU, so it gains less.

### Providers

- **Anthropic.** The adapter sends a top-level `cache_control: { type: "ephemeral" }`
  (`agent-providers.mjs`), which caches the request up to its last block and moves the cache
  point forward each turn; a cache read costs a tenth of the input price, and a cached prefix
  is not read again, which shortens the time to the first token on long requests. A change to
  an earlier message invalidates the cache after it, as with Ollama. Anthropic also offers
  server-side clearing of old tool results (`context_management`, beta), which the loop does
  not use because the same rule must apply to OpenAI-compatible servers and the bench must
  measure what the browser runs (builtin-agent B6).
- **OpenAI-compatible servers** cache a prompt prefix automatically where they do so at all
  (Ollama and the llama.cpp server keep the last prompt of a slot); the request has no field
  for it.
- **Hosted model latency was not measured.** No hosted model was run for this spec because a
  run costs money. A hosted model answers a cached request of this size in a few seconds, so
  on the floor's path of about 50 turns the model's time is a few minutes and the number of
  turns, not the tokens, decides the wall time.

## Design

1. **Measure before and after each change** (S1), because each change below trades something
   (cache stability, what the model sees, instruction length) and only the bench shows whether
   it pays. The per-step breakdown (Behaviour 1) is the bench's instrument: it lives in
   `tools/agent-bench/breakdown.mjs`, wraps the provider's `fetch` and reads the request body,
   so the loop itself is unchanged and the figures come from what was actually sent.
   Rejected: counting tokens inside the loop, because the loop would then carry bench-only
   code.
2. **Fewer steps first** (S2), because every step costs a model turn whatever its size: on a
   hosted model the turn's latency, on a local one the new text it reads and the output it
   writes. Opening a site's search results by URL with `elements: true` takes one step where
   typing into the search field, sending the form and listing the results takes three, and it
   is not a form submission, so it is not asked every time (mcp-forms F15) while still subject
   to the grant, the open rate and the notice every load makes. The listing's basket buttons
   then add an item in one more step. The change is instruction text in `INSTRUCTIONS`
   (`mcp.rs`) and the scripted floor, so it serves MCP agents too. Rejected: a "search this
   shop" tool, because builtin-agent B2 keeps the agent to the shared tools.
3. **One explanation per conversation, not per result** (S3), because the 781 characters every
   element list repeats are a third of a product page's list and are the same every time. The
   explanation moves into the `vimma_elements` description, which is sent once and cached.
   The untrusted-content wording at the top of each result (the URL and title line) and the
   delimiters stay in every result, because they are what tells the model, result by result,
   that the text is the page's (M31).
4. **Unchanged lines are left out of a repeated list** (S4), because a site's header, search
   form and navigation are the same on every page: 85 % of the JSON lines of the floor's ten
   product lists repeated a line an earlier list had given, label included.
   A list for a tab whose page has the same origin as a list the conversation already got
   leaves out element lines that are identical to that list's, label included, and ends with
   `(N elements as in your last list of this site)`. Labels stay valid, since a label is still
   given for every element on the page. The check runs in the parent on the checked copies
   (`parseAgentElement`), so it adds no page-controlled path. Rejected: a diff that names
   removed elements, because the model acts only on what is on the page now.
5. **Old page content leaves the context in blocks** (S5), because earlier results are the
   largest and fastest-growing part of each request (39 % on the ten-item list) and a model
   rarely needs a page it has left. Pruning every turn would change the prefix of every
   request and make a provider read the whole conversation again each turn, which on a local
   model costs more than it saves; pruning in blocks of `keep_results` results changes the
   prefix once per block. Each left-out result keeps its first line, so the model still knows
   which page it read, and the note says it can read the page again. Less page text in the
   context also leaves less room for an injected instruction to act later. Rejected: a summary
   written by the model, because it would be page text by another route and cost a request
   (builtin-agent B15 rejects the same for stored conversations).
6. **Steps that do not depend on each other go in one turn** (S6), because the loop already
   runs every call of a turn (`agent-loop.mjs`) and a turn, not a call, is what costs model
   time. Opening each item's search in its own tab in one turn and clicking each basket button
   in the next takes four turns for a whole list. The calls of a turn still run one after
   another through the gate, so every rule and rate applies to each; running them at once
   would save only the tools' time, which is under 2 % of a run.
7. **Rates stay as they are** (S7), because the open rate bounds what a steered model can send
   out in URLs (builtin-agent, "Prompt injection"). At 10 loads a minute a ten-item list needs
   at least a minute of loads, which fits the goal. A refusal that names the rate and when the
   next call is allowed lets a model wait instead of retrying, as
   [agent-bench.md](../agent-bench.md) found; that change is
   [#594](https://github.com/vimma-browser/vimma/pull/594), outside this spec.
8. **Local models: GPU, the right model, thinking off for steps** (S8). The bench machine's
   GPU is unused because Ollama leaves out integrated GPUs by default (Research); the runbook
   and the guide give the setting, and the bench records where each model ran (`ollama ps`).
   A mixture-of-experts model of the same size class reads three times and writes three to
   four times faster than a dense one on the same CPU (Research). A provider setting turns a
   local model's thinking off (Ollama's `think: false`, or the `reasoning_effort` field of an
   OpenAI-compatible request), because on the measured models thinking added up to half of a
   routine step's output time; the default stays the model's own, because whether thinking
   helps a model choose products is for the bench to show.

## Security and privacy

The rules this spec must not weaken are the page-text rules (M31: an element list is one
string inside the untrusted-content delimiters, cut and escaped), the checkpoints (sending a
form and paying ask every time, under any grant), the confinement to the agent workspace and to
a conversation's own tabs, and the per-conversation rates.

- **S2 (search by URL)** is no new reach: any URL could already be opened under a grant, at the
  same rate, with the same notice and log row. It does mean a search no longer passes the form
  question, which is the point; a search URL carries only what the agent puts in it, which is
  the risk every `vimma_open` already has and security.md §12 states.
- **S3 and S4 (compact lists)** change what an element list holds, so they are
  security-sensitive: the delimiters, the URL and title line, M31's limits and escaping, and
  the rule that a sensitive field shows no value must hold for every list, and a list that
  leaves lines out must not become a way for a page to hide an element the model then clicks
  by a stale label (labels stay those of the current page). docs/security.md M31 gains the
  rules, and the change gets a fresh review.
- **S5 (pruning)** removes page text from later requests and never adds any; the first line it
  keeps is Vimma's wording around the page's URL and title, already escaped and cut.
- **S6 (several calls a turn)** changes no gate rule: each call is checked, rated and logged on
  its own, and a checkpoint in the middle of a turn waits for the user as it does now.
- **S8 (GPU, thinking)** changes where a local model runs, not what it receives.

## Tests

### Vitest (`tools/agent-bench`)

- `requestParts splits a openai request into what each part costs`, and the same for
  `anthropic`; `timedFetch times each request and hands on its parts, and the reply unchanged`;
  `formatBreakdown says per run where the time went and what a request held`;
  `runOne records each model turn's time, tokens and request parts, and each call's time`
  (Behaviour 1).
- `the scripted shopper opens each item's search by URL with elements and clicks the listing's
basket button`; `a paced scripted run is not refused by the rates` (Behaviour 2).

### Vitest (`packages/vimma-core`)

- `an element list leaves out lines given earlier for the same site and counts them`;
  `a list after a navigation to another site is given in full`; `a left-out line's label still
activates its element` (Behaviour 4, in `agent-act.test.mjs`).
- `the loop leaves out results older than keep_results in blocks, keeping their first line`;
  `a request's prefix changes only when a block is left out` (Behaviour 5).
- `a local provider with think = false sends the setting its server takes` (Behaviour 7).
- `agent-tools-data matches the MCP fixture` (existing) catches drift of the new descriptions.

### Mochitests

- `browser_vimma_mcp_elements.js`: `test_repeated_list_leaves_out_unchanged_lines`,
  `test_compact_list_keeps_delimiters_and_sensitive_rules` (Behaviour 4, M31).

### The bench

- Each delivery PR runs the scripted floor and at least one local model on L04 and L10 before
  and after, and adds the rows to `docs/agent-bench.md`.

## Docs and changelog

- `docs/agent-bench.md`: the breakdown table for each model, and where each model ran.
- `docs/runbook.md`, "The agent model bench": the breakdown, pacing, and running Ollama on an
  integrated GPU.
- `docs/guide.md`, "Built-in agent": running a local model on the GPU, `think`, and
  `keep_results`.
- `docs/security.md`: M31 for compact lists (S3, S4); §12 for pruning (S5).
- `CHANGELOG.md`: added at merge.

## Delivery

Ordered by expected gain for cost. Each PR runs the bench before and after.

1. `test(agent-bench): per-step time and token breakdown` (S1, Behaviour 1):
   [#603](https://github.com/vimma-browser/vimma/pull/603).
2. `test(agent-bench): a scripted floor that searches by URL, paced as a model` (S2,
   Behaviour 2), with the new floor in `docs/agent-bench.md`:
   [#597](https://github.com/vimma-browser/vimma/issues/597).
3. `feat(mcp): open a shop's search results by URL` (S2, Behaviour 3): `INSTRUCTIONS` and the
   regenerated `agent-tools-data.mjs`. Expected: 52 to about 23 steps for ten items, the
   largest gain for every model, for a few lines of text:
   [#598](https://github.com/vimma-browser/vimma/issues/598).
4. `feat(agent): local models on the GPU and without thinking` (S8, Behaviour 7): the provider
   setting, setup's check, the runbook and the guide. Expected: three to four times faster
   steps from a mixture-of-experts model (measured), more from the GPU (not measured):
   [#602](https://github.com/vimma-browser/vimma/issues/602).
5. `feat(mcp): compact element lists` (S3, S4, Behaviour 4) with builtin-agent Delivery 7's
   `query` and `kinds` filters; security-sensitive. Expected: a quarter fewer tokens, and on
   a local model most of the reading time of a repeated page:
   [#599](https://github.com/vimma-browser/vimma/issues/599).
6. `feat(agent): older page content leaves the agent's context` (S5, Behaviour 5). Expected: a
   third fewer tokens and a context that stops growing:
   [#600](https://github.com/vimma-browser/vimma/issues/600).
7. `feat(agent): independent steps in one model turn` (S6, Behaviour 6): instruction text, a
   bench run of the parallel path, and the cause of its `busy` refusals. Expected: about half
   the turns and tokens: [#601](https://github.com/vimma-browser/vimma/issues/601).

## Open questions

1. **A planner and an executor.** Options: (a) one model does everything, as now; (b) a
   capable model plans the list and a cheaper or local model takes the page steps; (c) the
   planner splits the list over several conversations that run at once under `max_running`.
   (b) saves cost on a hosted provider but adds a second endpoint, which builtin-agent B11
   keeps to one, and a page could steer the executor to report false results to the planner;
   (c) multiplies the rates by up to three and needs a grant that one `Enter` gives to several
   conversations, which B18 does not allow. Recommendation: (a) until S2 to S6 are measured,
   because they remove most of the steps a planner would hand out.
2. **The default of `keep_results`.** Options: 4, 6 or 10. Fewer saves more tokens but a model
   that compares products across pages may need an older list again, which costs a step.
   Recommendation: 6, measured on L06 and L09 (the lists with preferences) before Delivery 5
   merges. Measured so far ([agent-bench.md](../agent-bench.md), "Older results left out"): on
   the scripted floor 4, 6 and 10 save 21, 14 and 2 % of L09's tokens; on a local
   mixture-of-experts model on the CPU, 6 cut L10's tokens by 37 % but each block left out cost
   about 120 s of reading, so the run took as long.
3. **Thinking for local models by default.** Options: the model's default, or off for local
   providers. Recommendation: the model's default until the bench shows that a model with
   thinking off chooses the same products (the "cheapest" and "lactose-free" items).
