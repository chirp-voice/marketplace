#!/usr/bin/env bash
# SessionStart: warn (visibly) when Chirp can't authenticate from this machine.
#
# A SessionStart hook must emit JSON for the user to SEE the message — plain stdout is
# only added to the model's context, not shown on screen. `systemMessage` is the
# user-visible field; `additionalContext` lets Claude proactively offer to help.
#
# Two "not signed in" states are detectable offline (no node, no network):
#   1. no credential file                 -> never signed in
#   2. credential without a refresh token -> session expired / effectively signed out
# (A server-side-revoked token can't be seen offline; the channel surfaces that at connect.)
CRED="$HOME/.chirp/credentials.json"

if [ ! -f "$CRED" ]; then
  printf '%s\n' '{"systemMessage":"Chirp: not signed in — run /chirp-auth to connect.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The user is not signed in to Chirp (no credential file on this machine). If Chirp is relevant, suggest they run /chirp-auth."}}'
elif ! grep -qE '"refreshToken"[[:space:]]*:[[:space:]]*"[^"]' "$CRED"; then
  printf '%s\n' '{"systemMessage":"Chirp: sign-in expired — run /chirp-auth to reconnect.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Chirp sign-in is expired (credential has no usable refresh token). If Chirp is relevant, suggest they run /chirp-auth."}}'
fi
exit 0
