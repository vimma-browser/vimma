#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# A stand-in for Gemini CLI in browser_vimma_agent_cli_gemini.js (docs/specs/builtin-agent-cli.md):
# it answers `gemini --version` as Gemini CLI 0.66.0 does, and otherwise runs headless as it
# does: the task from stdin to its end, the working directory's `.gemini/settings.json` read only
# when GEMINI_CLI_TRUST_WORKSPACE=true, the servers it names started only when
# `--allowed-mcp-server-names` names them (the real vimma-ctl mcp, with the entry's `env`), and
# `-o stream-json` on stdout. Like Gemini CLI, it records the run in its own folder
# ($GEMINI_CLI_HOME, else $HOME, then .gemini): the working directory in projects.json, a
# project folder in tmp/ and history/ with a .project_root marker, and the conversation in
# tmp/<project>/chats/session-*.jsonl. No model runs. The prompt's text scripts it, in [[...]]
# directives:
#   [[tabs]]        a vimma_tabs call through vimma-ctl mcp
#   [[own TEXT]]    a shell command of its own, which headless Gemini CLI does not offer
#   [[sleep S]]     wait
#   [[bad-key]]     an error report in TMPDIR, the stream of a rejected API key, then exit 145
# Each run appends what it was given to the JSON list FAKE_CLI_REPORT names.
import json
import os
import re
import subprocess
import sys
import time
import uuid

REPORT = os.environ.get("FAKE_CLI_REPORT")
args = sys.argv[1:]

if args == ["--version"]:
    print("0.66.0")
    sys.exit(0)

report = {
    "args": args,
    "cwd": os.getcwd(),
    "env": sorted(os.environ.keys()),
    "trust": os.environ.get("GEMINI_CLI_TRUST_WORKSPACE"),
    "tmpdir": os.environ.get("TMPDIR"),
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


allowed = []
i = 0
while i < len(args):
    if args[i] == "--allowed-mcp-server-names":
        allowed += args[i + 1].split(",")
        i += 2
    elif args[i] in ("-o", "-m", "-e"):
        i += 2
    else:
        i += 1

settings = {}
path = os.path.join(os.getcwd(), ".gemini", "settings.json")
if report["trust"] == "true" and os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
report["settings"] = settings
save()

prompt = sys.stdin.read()
report["prompt"] = prompt
report["stdin_closed"] = True
save()

# Its records of the run, as Gemini CLI 0.66.0 keeps them.
home = os.environ.get("GEMINI_CLI_HOME") or os.environ["HOME"]
root = os.path.join(home, ".gemini")
os.makedirs(root, exist_ok=True)
registry = os.path.join(root, "projects.json")
data = {"projects": {}}
if os.path.exists(registry):
    with open(registry) as f:
        data = json.load(f)
base = re.sub(r"[^a-z0-9-]", "-", os.path.basename(os.getcwd()).lower()) or "project"
slug, n = base, 0
while slug in data["projects"].values():
    n += 1
    slug = f"{base}-{n}"
data["projects"][os.getcwd()] = slug
with open(registry, "w") as f:
    json.dump(data, f, indent=2)
for kind in ("tmp", "history"):
    os.makedirs(os.path.join(root, kind, slug), exist_ok=True)
    with open(os.path.join(root, kind, slug, ".project_root"), "w") as f:
        f.write(os.getcwd())
chats = os.path.join(root, "tmp", slug, "chats")
os.makedirs(chats, exist_ok=True)
session = str(uuid.uuid4())
log = os.path.join(chats, f"session-{time.strftime('%Y-%m-%dT%H-%M')}-{session[:8]}.jsonl")
with open(log, "w") as f:
    f.write(json.dumps({"sessionId": session, "type": "user", "content": prompt}) + "\n")
report["session_file"] = log
save()


def out(obj):
    sys.stdout.write(json.dumps({**obj, "timestamp": "2026-11-04T18:59:09.206Z"}) + "\n")
    sys.stdout.flush()


out({"type": "init", "session_id": session, "model": "auto"})
out({"type": "message", "role": "user", "content": prompt})

if "[[bad-key]]" in prompt:
    with open(os.path.join(os.environ.get("TMPDIR", "/tmp"),
                           "gemini-client-error-fake.json"), "w") as f:
        json.dump({"error": "401", "context": prompt}, f)
    message = "[API Error: API key not valid. Please pass a valid API key.]"
    out({"type": "result", "status": "error", "error": {"type": "unknown", "message": message},
         "stats": {"input_tokens": 0, "output_tokens": 0}})
    sys.exit(145)

server = settings.get("mcpServers", {}).get("vimma_chat")
mcp = None
if server and "vimma_chat" in allowed:
    env = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
    env.update(server.get("env", {}))
    report["server_env_keys"] = sorted(k for k in env if k.startswith("VIMMA_"))
    report["server_trusted"] = server.get("trust") is True
    save()
    mcp = subprocess.Popen(
        [server["command"], *server.get("args", [])],
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


if mcp:
    rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "fake-gemini", "version": "0"}})
    mcp.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    mcp.stdin.flush()

calls = [0]
for d in re.findall(r"\[\[([^\]]*)\]\]", prompt):
    word, _, rest = d.partition(" ")
    calls[0] += 1
    if word == "tabs":
        tid = f"mcp_vimma_chat_vimma_tabs__{calls[0]}"
        out({"type": "tool_use", "tool_name": "mcp_vimma_chat_vimma_tabs", "tool_id": tid,
             "parameters": {}})
        if not mcp:
            out({"type": "tool_result", "tool_id": tid, "status": "error",
                 "error": {"type": "tool_not_registered", "message": "not found"}})
            continue
        r = rpc("tools/call", {"name": "vimma_tabs", "arguments": {}})
        result = (r or {}).get("result", {})
        text = " ".join(c.get("text", "") for c in result.get("content", [])
                        if c.get("type") == "text")
        report["calls"].append({"name": "vimma_tabs", "isError": bool(result.get("isError")),
                                "text": text[:500]})
        save()
        out({"type": "tool_result", "tool_id": tid, "status": "success", "output": text})
    elif word == "own":
        tid = f"run_shell_command__{calls[0]}"
        out({"type": "tool_use", "tool_name": "run_shell_command", "tool_id": tid,
             "parameters": {"command": rest, "description": "list"}})
        out({"type": "tool_result", "tool_id": tid, "status": "error",
             "error": {"type": "tool_not_registered", "message": "not found"}})
    elif word == "sleep":
        time.sleep(float(rest))

out({"type": "message", "role": "assistant", "content": "fake gemini: ", "delta": True})
out({"type": "message", "role": "assistant", "content": "done", "delta": True})
out({"type": "result", "status": "success",
     "stats": {"total_tokens": 1800, "input_tokens": 1500, "output_tokens": 300, "cached": 700}})
if mcp:
    mcp.stdin.close()
    mcp.wait()
report["exited"] = time.time()
save()
