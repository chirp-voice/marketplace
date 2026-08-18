# @chirp/chirp-plugin

The Claude Code **plugin** side of Chirp — a voice-first remote for your Claude
Code sessions. It provides:

- **`chirp-channel`** — an MCP server that connects this session to your Chirp
  relay over an outbound WebSocket, so the Chirp iOS app can see the session as a
  thread and drive it by voice/text (prompts, replies, remote permission
  approval, live status/steps). Declared as a Claude Code **channel** in
  `.claude-plugin/plugin.json`.

Topic staging (research / email digests for briefings) is **not** part of this
plugin — it lives in the hosted Chirp MCP server at `chirp.dev/mcp`, which any
assistant can connect to.

## Layout

```
plugins/claude/
├── .claude-plugin/plugin.json       plugin manifest (channels binding)
├── .claude-plugin/marketplace.json  serves this dir as a one-plugin marketplace
├── .mcp.json                    registers chirp-channel (via ${CLAUDE_PLUGIN_ROOT})
├── commands/chirp-auth.md       /chirp:chirp-auth
├── channel/                     chirp-channel.ts + activation.ts, effort.ts, frames.ts,
│                                label.ts, task-tracker.ts, transcript-scan.ts, turn-line.ts
├── auth/                        chirp-auth.ts + pkce-login.ts (Clerk public PKCE client)
└── hooks/                       hooks.json + SessionStart hooks: ensure-deps.sh,
                                 auth-check.sh, channel-check.sh
```

## Local development

Install deps once, then load the plugin straight from this directory for a
session (no marketplace needed):

```bash
cd plugins/claude && npm install
claude --plugin-dir ./plugins/claude
```

Or register it as a local marketplace for a persistent install (this dir serves
itself as a one-plugin marketplace via `.claude-plugin/marketplace.json`):

```
/plugin marketplace add ./plugins/claude
/plugin install chirp@chirp-plugin
```

(`chirp` is the plugin name from `plugin.json`; `chirp-plugin` is the marketplace
name from `marketplace.json`. Relative `source: "."` resolves to the marketplace
root — works when added by local path or Git; a direct marketplace.json URL would
instead need a `git-subdir` source.)

**Relay selection.** The prod relay (`wss://chirp-concierge.fly.dev/relay`) is **baked into the
channel as the default** — there is deliberately no `userConfig`, so installing from the public
marketplace never prompts for configuration. Point a dev machine at another stack with the
`CHIRP_RELAY_URL` env var (the MCP server inherits the shell environment; `npm run channel`
reads the same var):

```sh
export CHIRP_RELAY_URL=wss://api-dev.chirp.dev/relay   # dev stack
export CHIRP_RELAY_URL=ws://localhost:8080/relay       # local concierge
```

## Distribution — the public marketplace mirror

The public install path is the **`chirp-voice/marketplace`** GitHub repo, a
read-only mirror published by `.github/workflows/plugin-publish.yml` on every
push to `main` touching `plugins/claude/**` or `marketplace/**`. The mirror is
assembled from the repo-root `marketplace/` dir (the public marketplace.json +
README) plus this dir's tracked files at `plugins/chirp/` (minus the
self-serving dev `marketplace.json` below). Users install with:

```
/plugin marketplace add chirp-voice/marketplace
/plugin install chirp
```

Rules of the mirror:

- **Never commit to `chirp-voice/marketplace` directly** — the next sync
  clobbers it. Everything is authored here.
- **Bump `plugin.json` `version` with any plugin content change** — installed
  plugins run from a version-pinned cache, so an unbumped sync never reaches
  users. The workflow fails if content changed without a bump.
- The workflow pushes with the `MARKETPLACE_DEPLOY_KEY` repo secret (a
  write-access deploy key on the mirror repo).

## Status / follow-ups

This is the in-monorepo home for the plugin's source:

- **Runtime deps:** `npx tsx` needs `node_modules`. The `hooks/ensure-deps.sh` SessionStart hook
  `npm install --omit=dev`s into the plugin dir on the first session when `node_modules` is missing
  (idempotent thereafter); `tsx` is a runtime dependency so the channel runs after that install.
  Caveat: on the very first session the `chirp-channel` MCP server may boot before the install finishes —
  if the channel doesn't connect that once, restart Claude Code (one-time).
- **Auth:** interactive sign-in is `/chirp-auth` (the only browser flow); the channel uses a
  silent token getter and tells the user to run `/chirp-auth` if not signed in. Distribution-ready:
  `auth/pkce-login.ts` uses a Clerk **public** PKCE client (no secret) with the prod `base`/`client_id`
  baked as env-overridable defaults (`oauthConfig()`), so friends need **zero env**. Set
  `CLERK_OAUTH_BASE` / `CLERK_OAUTH_CLIENT_ID` to target the dev stack; `CLERK_OAUTH_CLIENT_SECRET`
  is optional (unused by the public client). A stalled sign-in times out after ~3 min instead of hanging.
- **Channel activation:** installed users launch sessions with `claude --channels plugin:chirp@chirp-voice`
  (plugin `chirp` from the `chirp-voice` public marketplace; the `channels` manifest entry in plugin.json declares the channel);
  `--dangerously-load-development-channels plugin:chirp@chirp-plugin` remains the
  live-source dev form.
- **Hooks need a real install, not the channel flag.** The SessionStart hooks
  (`hooks/auth-check.sh` "not signed in" nudge, `hooks/ensure-deps.sh`) only register when the
  plugin is **installed/enabled** (`/plugin install chirp@chirp-plugin` → `enabledPlugins`).
  Loading via `--dangerously-load-development-channels` alone wires up the channel/MCP but **not**
  the hooks. The auth nudge emits JSON `systemMessage` (a SessionStart hook's plain stdout is
  swallowed into model context, not shown to the user) and fires on `startup|resume|clear`.
- **Cache is version-pinned.** Installed plugins load from `~/.claude/plugins/cache/<mkt>/chirp/<version>/`.
  Edits to a checked-out source dir are ignored until `plugin.json` `version` bumps (then reinstall),
  or use `claude --plugin-dir ./plugins/claude` for live source during dev. Break-glass: delete the cache
  dir and reinstall.
