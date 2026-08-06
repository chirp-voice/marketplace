---
description: Sign in to Chirp (Clerk). Run once after install. Also supports --status and --logout.
---

# /chirp-auth

Connect this machine to your Chirp account so the channel can reach the
concierge.

Run the auth CLI, passing through any arguments, then report its output to the user:

    npx tsx ${CLAUDE_PLUGIN_ROOT}/auth/chirp-auth.ts $ARGUMENTS

- **No arguments** → opens a browser to sign in; a local callback completes it. No env setup is needed —
  the prod Chirp Clerk client is baked in (override with `CLERK_OAUTH_BASE` / `CLERK_OAUTH_CLIENT_ID` for
  the dev stack). This blocks until the user finishes in the browser, so allow up to a few minutes (use a
  generous Bash timeout); if nothing completes the flow it times out after ~3 minutes with a clear message
  rather than hanging. On success the CLI prints a channel-launch hint — relay it to the user **verbatim**
  so they know to start sessions with `claude --channels plugin:chirp@chirp-voice`
  (without the channel activated, the phone sees the session but voice prompts are silently dropped).
- **`--status`** → shows whether you're signed in, and as whom.
- **`--logout`** → clears the local credential (`~/.chirp/credentials.json`).

**Important:** sign in with the SAME Clerk account you use in the Chirp iOS app — otherwise the phone
won't see this machine's sessions and context (the relay pairs by user).
