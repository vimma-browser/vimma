#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Watches memory beside a full build (issue #1033): nightly.yml and release.yml start it in the
# background in their Build step and kill it on exit, as do macos.yml and release.yml's
# macos-build (#1572). Hosted runners were lost 61 to 74 min into the build; its memory peak is
# the Rust stage (docs/runbook/ci-full-builds.md, "Full builds").
#
#   tools/ci/memory-watch.sh &      from the repository root, in a GitHub Actions step
#
# Once, at the start: asks the kernel's OOM killer to spare the runner agent, so a build that
# runs out of memory loses a compiler, with a log, rather than the runner and every log with it.
# It walks up from itself (step shell, Runner.Worker, Runner.Listener) and takes only a process
# whose executable is named Runner.Worker or Runner.Listener, never one whose arguments merely say
# so; each gets oom_score_adj -999 (`sudo -n choom`, util-linux). As it stops (SIGTERM from the
# step's trap, which waits for it) it gives each its old value back: the steps the worker starts
# after the build inherit its value, and must stay killable.
#
# Each minute: `free -m` and `df -h /` to the step log, and a `::warning::` annotation when less
# than 1 GB of memory is available, more than half the swap is used, or the OOM killer killed
# something since the last look (/proc/vmstat's oom_kill). At most one warning every 5 minutes
# (an OOM kill warns at once) and 10 in all, so a long squeeze does not bury the log.
#
# Reads no input but /proc and the kernel log; makes no network call. Every failure (no sudo, no
# choom, no runner process) is ignored: the watch must never fail or slow the build. For tests:
# MEMORY_WATCH_PROC (a fake /proc), MEMORY_WATCH_INTERVAL (seconds), MEMORY_WATCH_GAP (rounds
# between warnings), MEMORY_WATCH_MAX (warnings) and MEMORY_WATCH_TICKS (rounds, then exit; 0
# runs until killed) and MEMORY_WATCH_SELF (the pid to walk up from).

# `set -u` with bash 3.2 (macOS, where the unit tests also run) fails on an empty array
# expanded as "${a[@]}": expansions here use ${a[@]+"${a[@]}"}.
set -u

proc=${MEMORY_WATCH_PROC:-/proc}
interval=${MEMORY_WATCH_INTERVAL:-60}
gap=${MEMORY_WATCH_GAP:-5}
max=${MEMORY_WATCH_MAX:-10}
ticks=${MEMORY_WATCH_TICKS:-0}

self=${MEMORY_WATCH_SELF:-$$}

# "pid:old oom_score_adj" of each runner process this script changed.
shielded=()

restore() {
  local entry
  for entry in ${shielded[@]+"${shielded[@]}"}; do
    sudo -n choom -n "${entry#*:}" -p "${entry%%:*}" > /dev/null 2>&1 ||
      echo "memory-watch: runner agent ${entry%%:*}: could not restore oom_score_adj ${entry#*:}"
  done
  shielded=()
}

# The step kills this script on exit: take the sleep down too, so no child keeps the step's
# output open, and give the runner agent its old oom_score_adj back.
sleeper=
stop() {
  [ -n "$sleeper" ] && kill "$sleeper" 2> /dev/null
  restore
  exit 0
}
trap stop TERM HUP

# A /proc/meminfo field in kB (0 when missing).
meminfo_kb() {
  awk -v key="$1:" '$1 == key { print $2; found = 1; exit } END { if (!found) print 0 }' \
    "$proc/meminfo" 2>/dev/null || echo 0
}

# The kernel's count of OOM kills since boot (0 when missing).
oom_kills() {
  awk '$1 == "oom_kill" { print $2; found = 1; exit } END { if (!found) print 0 }' \
    "$proc/vmstat" 2>/dev/null || echo 0
}

# Up the parent chain from this script, at most 32 steps.
pid=$self
found=0
for _ in {1..32}; do
  pid=$(awk '$1 == "PPid:" { print $2; exit }' "$proc/$pid/status" 2> /dev/null)
  case $pid in '' | 0 | *[!0-9]*) break ;; esac
  exe=$(readlink "$proc/$pid/exe" 2> /dev/null) || continue
  name=${exe##*/}
  case $name in Runner.Worker | Runner.Listener) ;; *) continue ;; esac
  found=1
  old=$(cat "$proc/$pid/oom_score_adj" 2> /dev/null)
  [[ $old =~ ^-?[0-9]+$ ]] || old=
  # Recorded before the change: a TERM during choom then still restores it (restoring a value
  # that did not change is harmless); a failed change drops the record again.
  [ -n "$old" ] && shielded+=("$pid:$old")
  if [ -n "$old" ] && sudo -n choom -n -999 -p "$pid" > /dev/null 2>&1; then
    echo "memory-watch: runner agent $pid ($name): oom_score_adj -999, was $old"
  else
    [ -n "$old" ] && unset "shielded[$((${#shielded[@]} - 1))]"
    echo "memory-watch: runner agent $pid ($name): could not set oom_score_adj"
  fi
done
[ "$found" -eq 1 ] || echo "memory-watch: no runner agent among this step's ancestors"

base=$(oom_kills)
tick=0
warned=0
last=$((-gap))
while :; do
  tick=$((tick + 1))
  echo "memory-watch: minute $tick ($(date -u +%H:%M:%S) UTC)"
  free -m 2>&1
  df -h / 2>&1

  reasons=()
  available=$(($(meminfo_kb MemAvailable) / 1024))
  [ "$available" -lt 1024 ] && reasons+=("$available MB available")
  swap_total=$(meminfo_kb SwapTotal)
  swap_used=$((swap_total - $(meminfo_kb SwapFree)))
  if [ "$swap_total" -gt 0 ] && [ $((swap_used * 2)) -gt "$swap_total" ]; then
    reasons+=("swap $((swap_used * 100 / swap_total))% used ($((swap_used / 1024)) of $((swap_total / 1024)) MB)")
  fi

  oom=
  now=$(oom_kills)
  if [ "$now" -gt "$base" ]; then
    kills=$((now - base))
    base=$now
    # The kernel's last word on it; only characters that cannot end or escape the annotation.
    killed=$(sudo -n dmesg 2> /dev/null | grep -E 'Killed process|oom-kill' | tail -n 1 |
      tr -cd '[:alnum:] ._()=:/[]-' | cut -c 1-200)
    oom="OOM killer killed $kills process$([ "$kills" -gt 1 ] && echo es)${killed:+: $killed}"
  fi

  if [ "$warned" -lt "$max" ] &&
    { [ -n "$oom" ] || { [ ${#reasons[@]} -gt 0 ] && [ $((tick - last)) -ge "$gap" ]; }; }; then
    message=$oom
    for reason in ${reasons[@]+"${reasons[@]}"}; do message=${message:+$message; }$reason; done
    echo "::warning title=Build memory::Minute $tick: $message"
    warned=$((warned + 1))
    last=$tick
    [ "$warned" -eq "$max" ] && echo "memory-watch: $max warnings, no more in this step"
  fi

  [ "$ticks" -gt 0 ] && [ "$tick" -ge "$ticks" ] && stop
  sleep "$interval" &
  sleeper=$!
  wait "$sleeper"
  sleeper=
done
