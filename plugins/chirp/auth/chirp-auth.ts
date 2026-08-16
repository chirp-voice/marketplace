import { pathToFileURL } from "node:url";
import { loginInteractive, loadCreds, clearCreds, save, identityFromToken } from "./pkce-login.js";

export type AuthCommand = "login" | "status" | "logout";

/**
 * Printed after a successful sign-in: how to launch a Claude Code session with the
 * chirp channel activated (without this flag the channel registers but prompt
 * injection is silently dropped).
 */
export const CHANNEL_LAUNCH_HINT =
  "To let Chirp drive a Claude Code session, launch it with the channel activated:\n" +
  "  claude --channels plugin:chirp@chirp-voice";

/** Route argv to a command. --status takes precedence over --logout; default is login. */
export function parseAuthCommand(argv: string[]): AuthCommand {
  if (argv.includes("--status")) return "status";
  if (argv.includes("--logout")) return "logout";
  return "login";
}

function idLabel(token: string): string {
  const { email, sub } = identityFromToken(token);
  return email ?? sub ?? "your account";
}

async function main(): Promise<void> {
  const cmd = parseAuthCommand(process.argv.slice(2));
  if (cmd === "logout") {
    clearCreds();
    console.log("Signed out.");
    return;
  }
  if (cmd === "status") {
    const c = loadCreds();
    if (c?.accessToken) {
      console.log(`Signed in as ${idLabel(c.accessToken)} (expires ${new Date(c.expiresAt).toISOString()}).`);
    } else {
      console.log("Not signed in — run /chirp-auth.");
    }
    return;
  }
  const c = await loginInteractive();
  save(c);
  console.log(`Signed in as ${idLabel(c.accessToken)}.`);
  console.log(`\n${CHANNEL_LAUNCH_HINT}`);
}

// Run only when invoked directly (not when imported by the test). pathToFileURL percent-encodes
// spaces etc. the way import.meta.url does — a hand-built `file://${argv[1]}` string does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
