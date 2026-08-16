import WebSocket from "ws";
import { getAccessToken } from "../auth/pkce-login.ts";

/**
 * The Chirp relay socket — a plugin's `role:'channel'` connection to the concierge.
 *
 * A factory, not module state: the owner controls the lifetime (the OpenClaw gateway starts one
 * socket per account; the Claude Code channel server starts one for its session), and everything
 * package-specific — the hello frame, the frame kinds acted on, the sign-in wording — arrives
 * through `RelayDeps`.
 *
 * BYTE-IDENTICAL by convention: this file exists in `openclaw-plugin/channel/` and
 * `chirp-plugin/channel/`, kept identical the same way `auth/pkce-login.ts` is (pinned by the
 * relay-identity test next to the pkce one). It may import only `ws`, `../auth/pkce-login.ts`
 * (itself byte-identical), and `./frames.ts` — the package's own wire vocabulary.
 *
 * This module knows the WIRE LIFECYCLE and nothing about either package. Frame *meaning* lives
 * in the concierge (`concierge/src/relay/transcript.ts`); frame *construction* lives in
 * `./frames.ts` and its neighbours.
 */

// The package's wire vocabulary: its hello builder, provider tag, inbound-frame classification,
// and the user-facing hint strings injected below. Re-exported because callers treat the relay
// module as the wire surface — and, deliberately, this is the one import that resolves to
// DIFFERENT content in each package.
export * from "./frames.ts";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Prod relay baked in so installed users are never prompted for config.
 *
 * Precedence (highest to lowest):
 *   1. The `configured` argument — the package's own config surface, when it has one
 *      (OpenClaw: `channels.chirp.relayUrl`, the only mechanism that reaches a launchd-managed
 *      gateway with no shell; the Claude Code plugin passes none).
 *   2. `CHIRP_RELAY_URL` env — works in shells and CI, identical in both packages.
 *   3. This default — production; leave it alone in normal use.
 */
export const DEFAULT_RELAY_URL = "wss://chirp-concierge.fly.dev/relay";

/** Resolve and validate the relay URL. A typo must disable the relay with a clear message,
 *  never throw synchronously out of `new WebSocket(...)` and take the host process down.
 *  `invalidHint` is the package's fix-it tail — injected because each package must name the
 *  config surfaces its users actually have. */
export function resolveRelayUrl(
  env: Record<string, string | undefined>,
  configured: string | undefined,
  invalidHint: string,
): {
  url: string | null;
  error: string | null;
} {
  const raw = configured ?? env.CHIRP_RELAY_URL ?? DEFAULT_RELAY_URL;
  try {
    new URL(raw);
    return { url: raw, error: null };
  } catch {
    return {
      url: null,
      error: `invalid relay URL "${raw}" — ${invalidHint}`,
    };
  }
}

export type RelayDeps = {
  url: string;
  /** The id this socket claims in its hello (`openclaw:<accountId>`, or Claude Code's own session
   *  UUID). The relay never mints one — the namespace belongs to the package — and it is stamped
   *  onto every emitted frame. */
  sessionId: string;
  /** The package's hello frame, rebuilt on every (re)connect.
   *
   *  Injected for two reasons. The wire shape is each package's contract with the concierge
   *  (`concierge/src/relay/frames.ts` parses it), so it must stay byte-for-byte what that package
   *  always sent — this file cannot own both shapes. And it is a BUILDER, not a value: by the time
   *  a reconnect fires, a turn may have reported the model that actually ran, which supersedes
   *  what the config said at start. A static frame captured at `createRelay` time would silently
   *  revert the phone's row on the first reconnect — a regression with no event to trace it to. */
  buildHello: (jwt: string) => Record<string, unknown>;
  /** Named in the connected log line (e.g. "chirp-openclaw 0.4.3"). The version is what makes a
   *  stale install identifiable from the logs alone. */
  clientTag: string;
  /** How the user signs in on THIS surface (e.g. "run `openclaw chirp login`"). The packages have
   *  different auth entry points, and pointing at the wrong one strands the user. */
  signInHint: string;
  /** Appended to the HTTP 401/403 upgrade-rejection log: how to refresh credentials and where the
   *  relay URL is configured, in the package's own vocabulary. */
  authRejectedHint: string;
  getToken?: () => Promise<string | null>;
  makeWs?: (url: string, opts: { headers: Record<string, string> }) => WebSocket;
  /** One parsed relay frame, unclassified: which kinds a package acts on is package policy
   *  (OpenClaw ignores `task-snapshot-request`; Claude Code answers it), so classification lives
   *  behind this seam. The return value is passed through so a test driving the socket's message
   *  handler can await a frame's full effect — but nothing in production handles a rejection, so
   *  implementations must never reject. */
  onFrame?: (frame: unknown) => void | Promise<void>;
  /** Called after the hello on every established connection, so the owner can re-send what only
   *  it knows must survive a reconnect (pending approval cards). Default no-op. */
  onOpen?: () => void;
  /** The agent's last answer, for the home row. **No default by design**: this module knows the
   *  WIRE and nothing about either package, so the transcript- or SDK-touching reader is injected
   *  by each package's wiring. */
  readPreview?: () => Promise<{ text: string; ts: number } | null>;
  log?: (msg: string) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export type RelayHandle = {
  start: () => Promise<void>;
  /** Returns false when the socket is not open — the frame is dropped, by design. */
  emit: (frame: Record<string, unknown>) => boolean;
  stop: () => void;
  isOpen: () => boolean;
  /** Test seam: the backoff is otherwise unobservable. Inert in production. */
  reconnectDelayMs: () => number;
};

export function createRelay(deps: RelayDeps): RelayHandle {
  const getToken = deps.getToken ?? getAccessToken;
  const makeWs =
    deps.makeWs ?? ((url: string, opts: { headers: Record<string, string> }) => new WebSocket(url, opts));
  const log = deps.log ?? ((m: string) => console.error(`[chirp] ${m}`));
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let ws: WebSocket | null = null;
  let delay = INITIAL_RECONNECT_DELAY_MS;
  let timer: unknown = null;
  let stopped = false;

  const scheduleReconnect = () => {
    if (stopped || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void connect();
    }, delay);
    delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const jwt = await getToken();
    // stop() can land during the token await (a file read plus a possible network refresh). A
    // socket opened past that point has no owner left to close it — and it would claim the
    // sessionId against a restarted owner's replacement socket.
    if (stopped) return;
    if (!jwt) {
      // Don't give up — back off and retry so the bridge self-heals once the user signs in,
      // with no process restart.
      log(`not signed in — ${deps.signInHint}; will retry`);
      scheduleReconnect();
      return;
    }

    let sock: WebSocket;
    try {
      // The JWT goes on the upgrade header, not the hello frame: the concierge reads it off the
      // upgrade to fly-replay-route the socket to the right machine. A hello-frame JWT is too late.
      sock = makeWs(deps.url, { headers: { authorization: `Bearer ${jwt}` } });
    } catch (e) {
      log(`relay connect threw ${String(e)}`);
      scheduleReconnect();
      return;
    }

    ws = sock;
    sock.on("open", () => {
      // stop() between makeWs and this event already called close(), but a real ws can deliver
      // `open` first — a stopped socket must never send the hello and claim the sessionId.
      if (stopped) {
        try {
          sock.close();
        } catch {
          /* already closing */
        }
        return;
      }
      // Reset backoff only on a real connection. Resetting after the token fetch (pre-open)
      // means a down relay never grows past the 1s floor — every connected Mac hammering a
      // deploying concierge at 1 req/s forever.
      delay = INITIAL_RECONNECT_DELAY_MS;
      sock.send(JSON.stringify(deps.buildHello(jwt)));
      // The version in the tag is what makes a stale install identifiable from the logs alone.
      log(`relay connected as ${deps.sessionId} (${deps.clientTag})`);
      // Behind the hello, so anything onOpen emits lands on a claimed session.
      deps.onOpen?.();

      // The home row's last-answer line, right behind the hello. The read is async, so it needs
      // a liveness guard: a reconnect while it is in flight must not push THIS socket's
      // preview down the socket that replaced it. `ws !== sock` is the load-bearing half —
      // `close` nulls `ws` and a reconnect assigns a new socket — and sending on `sock` rather
      // than `emit` is what makes the check meaningful.
      //
      // Re-sending on every reconnect is safe by construction — the concierge accepts a preview
      // only while it has no last reply, and ignores it afterwards.
      void Promise.resolve()
        .then(() => deps.readPreview?.() ?? null)
        .then((p) => {
          if (!p || ws !== sock || sock.readyState !== 1 /* OPEN */) return;
          sock.send(
            JSON.stringify({
              v: 1,
              sessionId: deps.sessionId,
              kind: "preview",
              text: p.text,
              ts: p.ts,
            }),
          );
        })
        // A failed read is polish that did not happen, not a broken bridge — so it must not
        // reject the connect. Logged rather than swallowed: once the owner wires the dep, a
        // throw here means the home row is silently blank, and every other failure in this file
        // leaves a line in the log.
        .catch((err: unknown) => log(`preview read failed: ${String(err)}`));
    });
    sock.on("message", (raw: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      // Returned rather than voided so a test driving this handler can await the frame's full
      // effect. ws itself ignores the return value, so a rejecting onFrame is an
      // unhandledRejection either way — the deps contract forbids rejecting.
      return deps.onFrame?.(parsed);
    });
    sock.on("error", (e: unknown) => log(`relay error ${String(e)}`));
    sock.on(
      "unexpected-response",
      (req: { destroy: (err?: Error) => void }, res: { statusCode?: number }) => {
        const status = res?.statusCode;
        if (status === 401 || status === 403) {
          // A dev Clerk token against the prod relay (or vice-versa) returns HTTP 401/403 on the
          // WebSocket upgrade. Log the URL so the env mismatch is obvious at a glance. Never log
          // the token or any part of it.
          log(`relay auth rejected (HTTP ${status}) at ${deps.url} — ${deps.authRejectedHint}`);
        } else {
          log(`relay upgrade rejected (HTTP ${status ?? "unknown"})`);
        }
        // Registering this listener SUPPRESSES ws's built-in abortHandshake (ws only tears the
        // rejected upgrade down itself when nobody is listening), so we must abort the request
        // ourselves. Otherwise, against a server that keeps error-response connections alive,
        // every retry would leak another half-open CONNECTING socket.
        try {
          req.destroy();
        } catch {
          /* already torn down */
        }
        // Keep retrying on backoff — the bridge must self-heal once the user fixes the config or
        // signs in again — but surface the reason until then.
        scheduleReconnect();
      },
    );
    sock.on("close", () => {
      // Identity-guarded like the preview send: a stale socket's late close must not null the
      // LIVE replacement's `ws` reference (stranding emit/isOpen) or schedule a third socket.
      if (ws !== sock) return;
      ws = null;
      scheduleReconnect();
    });
  };

  return {
    start: connect,
    emit(frame) {
      if (ws?.readyState !== 1 /* OPEN */) return false;
      try {
        ws.send(JSON.stringify({ v: 1, sessionId: deps.sessionId, ...frame }));
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      ws = null;
    },
    isOpen: () => ws !== null && ws.readyState === 1,
    reconnectDelayMs: () => delay,
  };
}
