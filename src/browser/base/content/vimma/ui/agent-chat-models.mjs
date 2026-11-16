/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's model setup (docs/specs/builtin-agent.md Behaviour 2-3, 7, B12;
// builtin-agent-cli.md Behaviour 1-2, 7): the models view, a pick and its waits, a new agent
// CLI's or another model's name on the prompt line, setup's hosted providers (endpoint, model,
// then the key through the window's own `askKey`), and a provider kept in config.toml. It reads
// and writes the agent only through the services the host hands the window (`chat.services`),
// never agent/, config/ or host/ (ADR-026), and asks for a key only through the window, never
// agent-chat-key.mjs. The state stays on the AgentChatWindow (ui/agent-chat.mjs) passed in,
// which is never imported here, so the two do not form a cycle.

import { needsKey, providerWhere, whereDataGoes } from "../core/agent-chat.mjs";
import {
  CLIS,
  DEFAULT_MAX_MINUTES,
  cliModelText,
  modelProblem,
  modelPrompt,
} from "../core/agent-cli.mjs";
import { checkEndpoint, isLocalEndpoint } from "../core/agent-providers.mjs";
import {
  pickerEntries,
  placementText,
  sameProvider,
  unavailableText,
} from "../core/agent-setup.mjs";

/** @import { AgentChatServices, AgentChatWindow, Row } from "./agent-chat.mjs" */
/** @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig */

/** Anthropic's API, which setup's "add: Anthropic" uses (Behaviour 3). */
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

/**
 * A name for a provider set up in the window: `base`, or with a number when config.toml has a
 * provider of that name already, so its key (stored by name) and the file agree.
 * @param {AgentChatServices} services @param {string} base
 */
function freeName(services, base) {
  const taken = new Set((services.agentConfig()?.providers ?? []).map((p) => p.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * The model picked this session (Behaviour 7), else the provider `[agent] default` names, else
 * the first configured, else none (setup).
 * @param {AgentChatServices} services
 */
export function defaultProvider(services) {
  const config = services.agentConfig();
  const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []);
  return (
    services.chat.chosen ??
    providers.find((p) => p.name === config?.default) ??
    providers[0] ??
    null
  );
}

/**
 * The models view (Behaviour 7): the conversation's model when nothing else lists it, the
 * configured providers, setup's hosted providers, then what the local servers list now; the
 * conversation's model is selected, and one that is not there is shown as such.
 * @param {AgentChatWindow} chat
 */
export function loadModels(chat) {
  const shownAt = ++chat.listed;
  chat.modelsAt = shownAt;
  const shown = () => chat.opened && chat.view === "models" && chat.listed === shownAt;
  const config = chat.services.agentConfig();
  // An agent CLI only while that feature is on (builtin-agent-cli, Delivery).
  const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []).filter(
    (p) => p.kind !== "cli" || chat.services.cli.enabled,
  );
  const current =
    chat.conversation === null ? null : chat.services.chat.get(chat.conversation).provider;
  /** @type {Map<string, string>} key hints, which arrive one by one */
  const hints = new Map();
  let first = true;
  /** @param {any} found @param {any} states */
  const draw = (found, states) => {
    const selected = chat.rows[chat.row]?.label;
    const entries = pickerEntries({ providers, found, states, current });
    /** @type {Row[]} */
    const rows = entries.map((e) => {
      const p = e.provider;
      if (p && e.otherModel) {
        // builtin-agent-cli Behaviour 17: a model of the CLI's that the list does not name.
        const unavailable = unavailableText(p, e.state);
        return {
          label: `${p.name} · other model…`,
          detail: unavailable ? "not available" : "type its name",
          otherModel: p,
          ...(unavailable ? { unavailable } : {}),
        };
      }
      const what = p
        ? {
            // A CLI's own default, short: the row's detail needs its room.
            label: `${p.name} · ${p.kind === "cli" ? p.model || "its default model" : p.model}`,
            provider: p,
            endpoint: p.endpoint,
          }
        : {
            label: `${e.local?.server} · ${e.local?.model}`,
            local: e.local,
            endpoint: e.local?.endpoint ?? "",
          };
      const unavailable = p ? unavailableText(p, e.state) : null;
      // Short, so the label keeps its room; Enter on the row says why in full.
      const where =
        (p && hints.get(what.label)) ?? (p ? providerWhere(p) : whereDataGoes(what.endpoint));
      // An agent CLI's rows say only which model config.toml names, so that their labels
      // keep their room; the header says where its data goes.
      const listed = p?.kind === "cli" ? (e.cliModel ? "agent CLI" : "config.toml") : where;
      const detail = unavailable ? "not available" : listed;
      return {
        label: what.label,
        detail: e.current ? `in use · ${detail}` : detail,
        ...(what.provider ? { provider: what.provider } : {}),
        ...(what.local ? { local: what.local } : {}),
        ...(unavailable ? { unavailable } : {}),
        current: e.current,
      };
    });
    // Setup's hosted providers (Behaviour 3): before the local servers' models.
    const at = rows.findIndex((r) => r.local);
    rows.splice(
      at < 0 ? rows.length : at,
      0,
      { label: "add: Anthropic (Messages API)", detail: "api key", add: "anthropic" },
      { label: "add: OpenAI-compatible endpoint", detail: "https:// and api key", add: "openai" },
      ...(chat.services.cli.enabled
        ? [
            {
              label: `add: agent CLI (${Object.values(CLIS)
                .map((c) => c.title)
                .join(", ")})`,
              detail: "its own login",
              add: /** @type {const} */ ("cli"),
            },
          ]
        : []),
    );
    chat.rows = rows;
    const keep = first ? -1 : rows.findIndex((r) => r.label === selected);
    chat.row =
      keep >= 0
        ? keep
        : Math.max(
            0,
            rows.findIndex((r) => r.current),
          );
    first = false;
    chat.render();
  };
  draw(null, null);
  for (const p of providers) {
    if (!needsKey(p)) continue;
    chat.services.keys.hint(p.name, p.endpoint).then(
      (/** @type {string | null} */ hint) => {
        if (!shown()) return;
        hints.set(`${p.name} · ${p.model}`, hint ?? "no key · Enter adds one");
        const row = chat.rows.find((r) => r.provider === p);
        if (row && !row.unavailable) {
          row.detail = `${row.current ? "in use · " : ""}${hints.get(row.label)}`;
        }
        chat.render();
      },
      () => {},
    );
  }
  // Asked only now, while the picker is open, and only on this machine (Behaviour 2, 7, B12):
  // the usual ports, and the configured providers' own endpoints.
  const asked = [...providers, ...(current ? [current] : [])];
  const locals = asked.filter((p) => p.kind === "openai" && isLocalEndpoint(p.endpoint));
  // An agent CLI's program: its path pref set and its file still passing C4's checks.
  const clis = asked.filter((p) => p.kind === "cli" && chat.services.cli.enabled);
  Promise.all([
    chat.services.chat.probe({
      extra: locals.map((p) => ({ server: p.name, endpoint: p.endpoint })),
    }),
    chat.services.chat.modelStates([...locals, ...clis]),
  ]).then(
    ([found, states]) => {
      if (shown()) draw(found, states);
    },
    (/** @type {any} */ e) => console.error("vimma agent: probe failed", e),
  );
}

/**
 * `Enter` (or `D`, `makeDefault`) on a row: a conversation opens, or the model is used by the
 * open conversation and this session's new ones (Behaviour 7).
 * @param {AgentChatWindow} chat
 * @param {{ makeDefault?: boolean }} [opts]
 */
export async function pick(chat, { makeDefault = false } = {}) {
  const row = chat.rows[chat.row];
  if (!row) return;
  if (chat.view === "list" && row.id !== undefined) {
    chat.open({ conversation: row.id });
    return;
  }
  if (row.add === "cli") {
    chat.findClis();
    return;
  }
  if (row.add) {
    chat.addProvider(row.add);
    return;
  }
  if (row.otherModel && !row.unavailable) {
    chat.askOtherModel(row.otherModel, { makeDefault });
    return;
  }
  if (row.unavailable) {
    chat.host.say(`agent: ${row.unavailable}; pick another model`, true);
    return;
  }
  let provider = row.provider;
  if (row.cliPick) {
    // builtin-agent-cli Behaviour 2, C4: the path picked here is a pref, and the provider
    // names only which CLI it is and its model.
    const info = CLIS[row.cliPick.cli];
    if (!info) return;
    const listed = (chat.services.agentConfig()?.providers ?? []).find(
      (/** @type {AgentProviderConfig} */ p) => p.kind === "cli" && p.cli === info.id,
    );
    // A CLI config.toml lists keeps its model; only a new one asks for it.
    if (!listed) {
      chat.askCliModel(info.id, row.cliPick.path, { makeDefault });
      return;
    }
    chat.services.cli.use(info.id, row.cliPick.path);
    provider = listed;
  }
  // A key hint can wait on the keyring, and a local model's preparation for up to a minute.
  // A pick that finds, after such a wait, a later pick of a model made or the list it was made
  // in left (another list, the key field, the transcript, the window closed) is not used: it
  // changes neither the view nor the model, since the user has moved on and may be typing a
  // key in the field the pick would replace; the later pick wins and says its own (#1005).
  const pickAt = ++chat.picks;
  const shownAt = chat.listed;
  const promptedAt = chat.prompted;
  const stale = () => {
    if (chat.picks !== pickAt) return true;
    // Focus gone from the window (a page, the address bar, the prompt line) counts as left;
    // the window losing OS focus to a keyring prompt does not, as activeElement stays.
    if (chat.listed === shownAt && chat.prompted === promptedAt && chat.focused) return false;
    const why =
      shownAt === chat.reloadedAt
        ? "the model list was reloaded after a key was deleted; pick it again"
        : "the picker was left before it was ready";
    chat.host.say(`agent: ${row.label} not used: ${why}`);
    return true;
  };
  if (provider && needsKey(provider)) {
    const hint = await chat.services.keys.hint(provider.name, provider.endpoint);
    if (stale()) return;
    if (hint === null) {
      chat.askKey(provider);
      return;
    }
  }
  if (row.local) {
    chat.host.say(`agent: preparing ${row.local.model}…`);
    try {
      // Not cancelled when the pick goes stale: it ends on its own and only makes the copy of
      // the model the pick asked for (Behaviour 2); the model is then neither used nor loaded.
      const model = await chat.services.chat.prepareLocal(row.local.endpoint, row.local.model);
      if (stale()) return;
      provider = {
        name: row.local.server,
        kind: "openai",
        endpoint: row.local.endpoint,
        model: model.model,
        vision: false,
      };
    } catch (e) {
      // A later pick says its own; this one's failure is still the answer to its Enter.
      if (chat.picks === pickAt) {
        chat.host.say(`agent: ${/** @type {any} */ (e)?.message ?? e}`, true);
      }
      return;
    }
  }
  if (!provider) return;
  chat.usePicked(provider, { makeDefault });
  if (row.local) {
    const { endpoint, model } = provider;
    // After the pick, since loading a large model takes a minute.
    chat.services.chat
      .placeLocal(endpoint, model)
      .then((/** @type {import("../core/agent-setup.mjs").Placement | null} */ placement) => {
        if (placement) chat.host.say(`agent: ${placementText(model, placement)}`);
      });
  }
}

/**
 * A new agent CLI's model, on the prompt line (builtin-agent-cli Behaviour 2): the CLI's
 * suggested model, editable, and empty for the CLI's own default. A model the command line
 * would refuse is refused here and asked again; nothing is stored before a model is taken.
 * @param {AgentChatWindow} chat
 * @param {string} cli  a key of CLIS
 * @param {string} path  the program setup found
 * @param {{ makeDefault: boolean }} opts
 * @param {string} [value]  what was typed before, to correct
 */
export function askCliModel(chat, cli, path, opts, value) {
  const info = CLIS[cli];
  if (!info) return;
  chat.prompted++;
  const ask = modelPrompt(cli);
  chat.host.prompt({
    label: ask.label,
    value: value ?? ask.value,
    placeholder: ask.placeholder,
    submit: (text) => {
      const model = text.trim();
      const problem = modelProblem(model);
      if (problem) {
        chat.host.say(`agent: ${problem}`, true);
        chat.askCliModel(cli, path, opts, text);
        return;
      }
      chat.services.cli.use(cli, path);
      chat.usePicked(
        {
          name: freeName(chat.services, info.bin),
          kind: "cli",
          cli,
          endpoint: "",
          model,
          vision: false,
          maxMinutes: DEFAULT_MAX_MINUTES,
        },
        { ...opts, addedCli: true },
      );
    },
  });
}

/**
 * A model of a configured agent CLI that its list does not name (builtin-agent-cli
 * Behaviour 7), on the prompt line under setup's rule; then used as a picked row is.
 * @param {AgentChatWindow} chat
 * @param {AgentProviderConfig} base  the CLI's provider in config.toml
 * @param {{ makeDefault: boolean }} opts
 * @param {string} [value]  what was typed before, to correct
 */
export function askOtherModel(chat, base, opts, value) {
  chat.prompted++;
  const ask = modelPrompt(base.cli ?? "");
  chat.host.prompt({
    label: ask.label,
    value: value ?? "",
    placeholder: ask.placeholder,
    submit: (text) => {
      const model = text.trim();
      const problem = modelProblem(model);
      if (problem) {
        chat.host.say(`agent: ${problem}`, true);
        chat.askOtherModel(base, opts, text);
        return;
      }
      chat.usePicked({ ...base, model }, opts);
    },
  });
}

/**
 * The picked provider goes to the open conversation, and to config.toml as `pick` says.
 * @param {AgentChatWindow} chat
 * @param {AgentProviderConfig} picked
 * @param {{ makeDefault: boolean, addedCli?: boolean }} opts  `addedCli`: an agent CLI setup
 *   found that config.toml does not list yet
 */
export function usePicked(chat, picked, { makeDefault, addedCli = false }) {
  if (!chat.useProvider(picked)) return;
  chat.insert();
  const what = picked.kind === "cli" ? cliModelText(picked.cli ?? "", picked.model) : picked.model;
  // config.toml changes only for setup (no provider yet) or when asked with D (B12); an
  // agent CLI setup found is listed there, as a hosted provider added here is, so that it is
  // in the picker after a restart.
  const setup = !(chat.services.agentConfig()?.providers ?? []).length;
  if (!makeDefault && !setup) {
    if (addedCli) {
      chat.remember(picked).then((note) => {
        chat.host.say(`agent: ${picked.name} · ${what}${note}`, note.startsWith(";"));
      });
      return;
    }
    chat.host.say(
      `agent: ${picked.name} · ${what} until a restart; D in the picker makes it the default`,
    );
    return;
  }
  chat.remember(picked, { makeDefault: true }).then((note) => {
    if (note) chat.host.say(`agent: ${picked.name} · ${what}${note}`, note.startsWith(";"));
  });
}

/**
 * Setup's agent CLIs (builtin-agent-cli Behaviour 1): a search of PATH and each one's
 * `--version`, only while setup is open on this row, each listed with its path to pick.
 * @param {AgentChatWindow} chat
 */
export function findClis(chat) {
  const shownAt = ++chat.listed;
  chat.rows = [];
  chat.row = 0;
  chat.render();
  chat.services.cli.find().then(
    (
      /** @type {{ cli: string, path: string, label: string, shim: string | null,
       *   problem: string | null }[]} */ found,
    ) => {
      if (!chat.opened || chat.view !== "models" || chat.listed !== shownAt) return;
      if (!found.length) {
        chat.host.say(`agent: ${chat.services.cli.noneFound()}`, true);
        chat.loadModels();
        return;
      }
      chat.rows = found.map((f) => ({
        label: f.label,
        // The label's path is cut in a narrow window, so the shim is named here too.
        detail: f.problem
          ? "not available"
          : `agent CLI${f.shim ? ` (${f.shim} shim)` : ""} · Enter uses it`,
        ...(f.problem
          ? { unavailable: `${f.path} is refused: ${f.problem}` }
          : { cliPick: { cli: f.cli, path: f.path } }),
      }));
      chat.render();
      // A row cuts a long path; the notice line shows the first one whole before it is used.
      const first = found[0];
      if (first) chat.host.say(`agent: found ${first.label}`, !!first.problem);
    },
    (/** @type {any} */ e) => console.error("vimma agent: looking for agent CLIs failed", e),
  );
}

/**
 * A provider goes to config.toml (B12): a hosted provider added in the window, so that its
 * key has a provider after a restart, and, with `makeDefault` (setup, or `D` in the picker),
 * as `[agent] default`, which new conversations use. Its key stays in login storage.
 * @param {AgentChatWindow} chat
 * @param {AgentProviderConfig} provider
 * @param {{ makeDefault?: boolean }} [opts]  without it, a listed provider writes nothing
 * @returns {Promise<string>} what the notice adds: "" when nothing was written
 */
export async function remember(chat, provider, { makeDefault = false } = {}) {
  const config = chat.services.agentConfig();
  const providers = /** @type {AgentProviderConfig[]} */ (config?.providers ?? []);
  const listed = providers.find(
    (p) =>
      p.kind === provider.kind &&
      p.endpoint === provider.endpoint &&
      p.model === provider.model &&
      p.cli === provider.cli,
  );
  const asDefault = makeDefault || providers.length === 0;
  if (listed && (!asDefault || config?.default === listed.name)) {
    return asDefault ? " · already [agent] default" : "";
  }
  const r = await chat.services.addAgentProvider(provider, { makeDefault: asDefault });
  if ("error" in r) return `; not saved to config.toml (${r.error})`;
  return asDefault ? " · saved to config.toml as [agent] default" : " · saved to config.toml";
}

/**
 * The open conversation's model, and this session's new conversations' (Behaviour 7).
 * @param {AgentChatWindow} chat
 * @param {AgentProviderConfig} provider
 * @returns {boolean} whether it is in use (a running task keeps its model)
 */
export function useProvider(chat, provider) {
  if (chat.conversation === null) {
    chat.conversation = chat.services.chat.create({ provider }).id;
    chat.services.chat.choose(provider);
    return true;
  }
  if (!sameProvider(chat.services.chat.get(chat.conversation).provider, provider)) {
    const refused = chat.services.chat.setProvider(chat.conversation, provider);
    if (refused) {
      chat.host.say(`agent: ${refused}`, true);
      return false;
    }
  }
  chat.services.chat.choose(provider);
  return true;
}

/**
 * Setup's hosted provider (Behaviour 3): Anthropic's API, or an OpenAI-compatible endpoint,
 * which must be https:// off this machine; then its model on the prompt line, then its key in
 * the window's masked field. The provider lasts the session; config.toml keeps one for good.
 * @param {AgentChatWindow} chat
 * @param {"anthropic" | "openai"} kind
 */
export function addProvider(chat, kind) {
  const localOnly = !!chat.services.agentConfig()?.localOnly;
  /** @param {string} endpoint */
  const askModel = (endpoint) => {
    // The prompt line takes focus: no pick still waiting is used under it (#1005).
    chat.prompted++;
    return chat.host.prompt({
      label: "agent model: ",
      value: kind === "anthropic" ? ANTHROPIC_MODEL : "",
      submit: (model) => {
        const name = freeName(
          chat.services,
          kind === "anthropic" ? "anthropic" : new URL(endpoint).hostname,
        );
        if (!model.trim()) return chat.host.say("agent: a model name is needed", true);
        return chat.askKey({
          name,
          kind,
          endpoint,
          model: model.trim(),
          vision: kind === "anthropic",
        });
      },
    });
  };
  if (kind === "anthropic") {
    const refused = checkEndpoint(ANTHROPIC_ENDPOINT, { localOnly });
    if (refused) return chat.host.say(`agent: ${refused}`, true);
    return askModel(ANTHROPIC_ENDPOINT);
  }
  chat.prompted++;
  return chat.host.prompt({
    label: "agent endpoint (https://…/v1): ",
    submit: (text) => {
      const endpoint = text.trim().replace(/\/+$/, "");
      const refused = checkEndpoint(endpoint, { localOnly });
      if (refused) return chat.host.say(`agent: ${refused}`, true);
      return askModel(endpoint);
    },
  });
}
