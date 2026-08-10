#!/usr/bin/env bash
# SessionStart: warn when this session was launched without the chirp channel.
# Claude Code silently drops relay prompts for such a session (skip kind "session" shows no
# toast), so without this the failure is invisible until a phone command goes nowhere.
# Emits a JSON systemMessage — plain stdout from a SessionStart hook is never shown.
set -uo pipefail

parent_args=""
pid=${CHIRP_HOOK_PID:-$PPID}
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  args=$(ps -ww -o args= -p "$pid" 2>/dev/null) || break
  case "${args%% *}" in
    claude|*/claude) parent_args="$args"; break ;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || break
  [ -z "$pid" ] && break
  [ "$pid" -le 1 ] 2>/dev/null && break
done

# No claude ancestor found, or it names a chirp channel: stay quiet (fail open).
[ -z "$parent_args" ] && exit 0
case "$parent_args" in
  *--channels*chirp*|*--dangerously-load-development-channels*chirp*) exit 0 ;;
esac

printf '{"systemMessage":"Chirp: this session is view-only on your phone — relaunch with `claude --channels plugin:chirp@chirp-voice` to control it by voice."}\n'
exit 0
