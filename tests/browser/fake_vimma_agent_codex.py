#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# A stand-in for Codex in browser_vimma_agent_cli_codex.js (docs/specs/builtin-agent-cli.md):
# it answers `codex --version` and `codex mcp list --json` as Codex 0.163.0 does, and for
# `codex exec` reads every `-c` value as the TOML Codex reads it, takes the prompt from stdin to
# its end, starts the server the vimma_chat table names (the real vimma-ctl mcp) with only the
# variables its env_vars forwards, and speaks `codex exec --json`. No model runs. The prompt's
# text scripts it, in [[...]] directives:
#   [[tabs]]                       a vimma_tabs call through vimma-ctl mcp
#   [[own TEXT]]  [[patch PATH]]   a command of its own; a file it adds
#   [[foreign]]                    a call to an MCP server that is not Vimma's
#   [[sleep S]]                    wait
#   [[bad-key]]                    the stream of a rejected API key, then exit 1
# FAKE_CODEX_SERVERS: the names `mcp list` gives (comma separated; default "vimma,other").
# Each run appends what it was given to the JSON list FAKE_CLI_REPORT names.
import json
import os
import re
import subprocess
import sys
import time
import tomllib

REPORT = os.environ.get("FAKE_CLI_REPORT")
args = sys.argv[1:]

if args == ["--version"]:
    print("codex-cli 0.163.0")
    sys.exit(0)

if args == ["mcp", "list", "--json"]:
    names = os.environ.get("FAKE_CODEX_SERVERS") or "vimma,other"
    print(json.dumps([{"name": n, "enabled": True, "transport": {"type": "stdio"}}
                      for n in names.split(",") if n], indent=2))
    sys.exit(0)

# A few of Codex 0.163.0's `codex features list`.
KNOWN_FEATURES = {"apps", "plugins", "skill_mcp_dependency_install", "browser_use", "computer_use"}

report = {
    "args": args,
    "cwd": os.getcwd(),
    "env": sorted(os.environ.keys()),
    "config": {},
    "calls": [],
}


def save():
    if not REPORT:
        return
    runs = []
    if os.path.exists(REPORT):
        with open(REPORT) as f:
            runs = json.load(f)
    if runs and runs[-1].get("pid") == os.getpid():
        runs[-1] = report
    else:
        report["pid"] = os.getpid()
        runs.append(report)
    tmp = REPORT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(runs, f)
    os.replace(tmp, REPORT)


def merge(into, value):
    for k, v in value.items():
        if isinstance(v, dict) and isinstance(into.get(k), dict):
            merge(into[k], v)
        else:
            into[k] = v


assert args[0] == "exec" and args[-1] == "-", args
i = 1
while i < len(args) - 1:
    if args[i] == "-c":
        # Codex reads `key=value` as TOML; one that is not fails the run, as it would.
        merge(report["config"], tomllib.loads(args[i + 1]))
        i += 2
    elif args[i] == "--disable":
        # As Codex 0.163.0: `-c features.<name>=false`, and a feature it does not know ends it.
        if args[i + 1] not in KNOWN_FEATURES:
            print(f"Error: Unknown feature flag: {args[i + 1]}", file=sys.stderr)
            sys.exit(2)
        merge(report["config"], {"features": {args[i + 1]: False}})
        i += 2
    elif args[i] in ("-C", "-m"):
        i += 2
    else:
        i += 1
save()

prompt = sys.stdin.read()
report["prompt"] = prompt
report["stdin_closed"] = True
save()



def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


out({"type": "thread.started", "thread_id": "fake-thread"})
out({"type": "turn.started"})

if "[[bad-key]]" in prompt:
    message = "unexpected status 401 Unauthorized: Incorrect API key provided"
    out({"type": "error", "message": message})
    out({"type": "turn.failed", "error": {"message": message}})
    sys.exit(1)

server = report["config"]["mcp_servers"]["vimma_chat"]
env = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
for name in server.get("env_vars", []):
    if name in os.environ:
        env[name] = os.environ[name]
report["server_env_keys"] = sorted(k for k in env if k.startswith("VIMMA_"))
save()
mcp = subprocess.Popen(
    [server["command"], *server["args"]],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    env=env,
    text=True,
)
next_id = [0]


def rpc(method, params=None):
    next_id[0] += 1
    mcp.stdin.write(json.dumps({"jsonrpc": "2.0", "id": next_id[0], "method": method,
                                "params": params or {}}) + "\n")
    mcp.stdin.flush()
    while True:
        line = mcp.stdout.readline()
        if not line:
            return None
        m = json.loads(line)
        if m.get("id") == next_id[0]:
            return m


init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": {"name": "fake-codex", "version": "0"}})
if init is None or "result" not in init:
    sys.stderr.write("Error: required MCP servers failed to initialize: vimma_chat\n")
    sys.exit(1)
mcp.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
mcp.stdin.flush()

n = [0]


def item(kind, **fields):
    n[0] += 1
    it = {"id": f"item_{n[0]}", "type": kind, **fields}
    out({"type": "item.started", "item": {**it, "status": "in_progress"}})
    return it


for d in re.findall(r"\[\[([^\]]*)\]\]", prompt):
    word, _, rest = d.partition(" ")
    if word == "tabs":
        it = item("mcp_tool_call", server="vimma_chat", tool="vimma_tabs", arguments={})
        r = rpc("tools/call", {"name": "vimma_tabs", "arguments": {}})
        result = (r or {}).get("result", {})
        text = " ".join(c.get("text", "") for c in result.get("content", [])
                        if c.get("type") == "text")
        report["calls"].append({"name": "vimma_tabs", "isError": bool(result.get("isError")),
                                "text": text[:500]})
        save()
        out({"type": "item.completed", "item": {**it, "result": result, "status": "completed"}})
    elif word == "own":
        it = item("command_execution", command=f"/usr/bin/bash -lc '{rest}'",
                  aggregated_output="", exit_code=None)
        out({"type": "item.completed",
             "item": {**it, "aggregated_output": "", "exit_code": 0, "status": "completed"}})
    elif word == "patch":
        it = item("file_change", changes=[{"path": rest, "kind": "add"}])
        out({"type": "item.completed", "item": {**it, "status": "completed"}})
    elif word == "foreign":
        it = item("mcp_tool_call", server="other", tool="read", arguments={})
        out({"type": "item.completed", "item": {**it, "status": "completed"}})
    elif word == "sleep":
        time.sleep(float(rest))

n[0] += 1
out({"type": "item.completed",
     "item": {"id": f"item_{n[0]}", "type": "agent_message", "text": "fake codex: done"}})
out({"type": "turn.completed", "usage": {"input_tokens": 1500, "cached_input_tokens": 700,
                                         "output_tokens": 300}})
mcp.stdin.close()
mcp.wait()
report["exited"] = time.time()
save()
