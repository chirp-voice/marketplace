#!/usr/bin/env bash
# SessionStart: a freshly-installed plugin has no node_modules, so the chirp-channel
# MCP server (which needs `ws` + the MCP SDK) can't start. Install runtime deps once.
# Idempotent: a no-op once node_modules exists.
#
# A SessionStart hook's plain stdout/stderr is never shown to the user (see auth-check.sh),
# so an install failure must be surfaced as a JSON systemMessage on stdout — otherwise the
# plugin is silently dead.
DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCK="$DIR/.chirp-deps.lock"

fail_visibly() {
  printf '%s\n' "{\"systemMessage\":\"Chirp: dependency install failed — run 'npm install' in $DIR, then restart Claude Code.\"}"
}

if [ -d "$DIR/node_modules" ]; then
  exit 0
fi

# mkdir is atomic: of N sessions starting on a fresh install, exactly one wins the lock and
# runs npm; the rest wait below rather than racing overlapping installs into the same dir.
if mkdir "$LOCK" 2>/dev/null; then
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  echo "Chirp: installing plugin dependencies (first run)…" >&2
  if ! ( cd "$DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
    fail_visibly
  fi
else
  # Another session's install is in flight — poll for its lock to clear, bounded.
  waited=0
  limit="${CHIRP_DEPS_LOCK_TIMEOUT:-120}" # seconds; env override keeps tests fast
  while [ -d "$LOCK" ] && [ "$waited" -lt "$limit" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if [ ! -d "$DIR/node_modules" ]; then
    fail_visibly
  fi
fi
exit 0
