# Chirp — Claude Code marketplace

[Chirp](https://chirp.dev) is a voice-first iOS app for operating your Claude
Code sessions hands-free. The `chirp` plugin in this marketplace connects a
Claude Code session to the Chirp relay, so the app sees the session as a thread
and can drive it by voice — prompts, replies, permission approvals, live status.

## Install

In Claude Code:

```
/plugin marketplace add chirp-voice/marketplace
/plugin install chirp
```

Sign in with the same account you use in the Chirp iOS app:

```
/chirp-auth
```

Then start sessions with the channel activated:

```
claude --channels chirp
```

Without `--channels chirp` the app can see the session, but voice prompts are
silently dropped.

## About this repo

This is a read-only distribution mirror, published automatically from the Chirp
monorepo — commits, issues, and pull requests here aren't monitored. For help,
visit [chirp.dev](https://chirp.dev).
