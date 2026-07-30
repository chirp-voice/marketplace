#!/usr/bin/env bash
# SessionStart: a freshly-installed plugin has no node_modules, so the chirp-channel
# MCP server (which needs `ws` + the MCP SDK) can't start. Install runtime deps once.
# Idempotent: a no-op once node_modules exists.
DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ -d "$DIR/node_modules" ]; then
  exit 0
fi

echo "Chirp: installing plugin dependencies (first run)…" >&2
if ! ( cd "$DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
  echo "Chirp: dependency install failed — run 'npm install' in $DIR, then restart Claude Code." >&2
fi
exit 0
