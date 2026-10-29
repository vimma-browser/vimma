#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# A stand-in for Claude Code in browser_vimma_agent_cli_run.js (docs/specs/builtin-agent-cli.md):
# it takes the arguments Vimma gives `claude`, starts the MCP server its --mcp-config names
# (the real vimma-ctl mcp, with the ticket in its environment) and speaks Claude Code's
# stream-json. No model runs. The task's text scripts it, in [[...]] directives:
#   [[tabs]] [[open URL]] [[show]]            a vimma tool call through vimma-ctl mcp (show: the
#                                             tab the last result named)
#   [[own NAME TEXT]]                         a tool_use of its own (NAME "Bash": TEXT a command)
#   [[sleep S]]  [[ignore-term]]  [[loop]]    wait; ignore SIGTERM; call vimma_tabs until killed
#   [[fail CODE TEXT]]                        TEXT on stderr, exit CODE before any result
#   [[vimma-failed]] [[no-usage]]             init says vimma did not start; result has no usage
#   [[orphan]]                                leave a child holding stdout open after exiting
# Everything it was given goes to the JSON file FAKE_CLI_REPORT names, rewritten as it runs.
import json
import os
import re
import signal
import subprocess
import sys
import time

REPORT = os.environ.get("FAKE_CLI_REPORT")
TOOLS = os.environ.get("FAKE_CLI_TOOLS", "Bash,Read,Write,WebFetch,Edit,Glob,Grep")
report = {
    "args": sys.argv[1:],
    "cwd": os.getcwd(),
    "env": sorted(os.environ.keys()),
    "lines": [],
    "calls": [],
    "mcp_config_mode": None,
    "dir_mode": None,
}


def save():
    if REPORT:
        tmp = REPORT + ".tmp"
        with open(tmp, "w") as f:
            json.dump(report, f)
        os.replace(tmp, REPORT)


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.303 (Claude Code)")
    sys.exit(0)
config_path = args[args.index("--mcp-config") + 1]
report["mcp_config_mode"] = oct(os.stat(config_path).st_mode & 0o777)
report["dir_mode"] = oct(os.stat(os.path.dirname(config_path)).st_mode & 0o777)
config = json.load(open(config_path))
report["mcp_servers"] = sorted(config["mcpServers"].keys())
server = config["mcpServers"]["vimma"]
report["server_command"] = server["command"]
report["server_args"] = server["args"]
report["server_env_keys"] = sorted(server.get("env", {}).keys())
save()

first = sys.stdin.readline()
report["lines"].append(json.loads(first))
save()
task = report["lines"][0]["message"]["content"]
directives = re.findall(r"\[\[([^\]]*)\]\]", task)

for d in directives:
    if d.startswith("fail "):
        _, code, text = d.split(" ", 2)
        sys.stderr.write("some warning\n" + text + "\n")
        sys.stderr.flush()
        sys.exit(int(code))

env = dict(os.environ)
env.update(server.get("env", {}))
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
                          "clientInfo": {"name": "fake-cli", "version": "0"}})
mcp.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
mcp.stdin.flush()
connected = init is not None and "result" in init and "[[vimma-failed]]" not in task
out({
    "type": "system",
    "subtype": "init",
    "tools": [t for t in TOOLS.split(",") if t] + ["mcp__vimma__vimma_tabs"],
    "mcp_servers": [{"name": "vimma", "status": "connected" if connected else "failed"}],
    "model": "fake-model-1",
    "permissionMode": "dontAsk",
    "claude_code_version": "2.1.303",
})


last_tab = [None]


def call(name, arguments):
    out({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": f"t{next_id[0]}", "name": f"mcp__vimma__{name}",
         "input": arguments}]}})
    r = rpc("tools/call", {"name": name, "arguments": arguments})
    result = (r or {}).get("result", {})
    text = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    tab = re.search(r"\btab (\d+)\b", text)
    if tab:
        last_tab[0] = tab.group(1)
    report["calls"].append({"name": name, "isError": bool(result.get("isError")),
                            "text": text[:500], "at": time.time()})
    save()
    out({"type": "user", "message": {"content": [{"type": "tool_result", "content": text}]}})


n = 0
for d in directives:
    word, _, rest = d.partition(" ")
    if word == "tabs":
        call("vimma_tabs", {})
    elif word == "open":
        call("vimma_open", {"url": rest})
    elif word == "show":
        call("vimma_show", {"tab": last_tab[0] or "0"})
    elif word == "own":
        name, _, text = rest.partition(" ")
        n += 1
        field = {"Bash": "command", "Read": "file_path", "WebFetch": "url"}.get(name, "input")
        out({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": f"own{n}", "name": name, "input": {field: text}}]}})
    elif word == "sleep":
        time.sleep(float(rest))
    elif word == "ignore-term":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        report["ignoring_term"] = True
        save()
    elif word == "loop":
        while True:
            call("vimma_tabs", {})
            time.sleep(0.2)

out({"type": "assistant", "message": {"content": [{"type": "text", "text": "fake reply: done"}]}})
result = {"type": "result", "subtype": "success", "is_error": False, "result": "fake reply: done",
          "num_turns": 2, "total_cost_usd": 0.41, "queued_turn_count": 0}
if "[[no-usage]]" not in task:
    result["usage"] = {"input_tokens": 1500, "output_tokens": 300}
out(result)

if "[[orphan]]" in task:
    # A child that keeps the CLI's stdout and stderr open after the CLI exits.
    subprocess.Popen(["sleep", "20"])

# Lines written after the first (added instructions) are kept until stdin closes.
for line in sys.stdin:
    report["lines"].append(json.loads(line))
    save()
report["stdin_closed"] = time.time()
save()
mcp.stdin.close()
mcp.wait()
report["exited"] = time.time()
save()
