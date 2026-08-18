import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Notification } from '@modelcontextprotocol/sdk/types.js'
import type WebSocket from 'ws'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { findTranscriptPath, newestSessionId, parseTaskLine, extractModel, latestModelIn } from './transcript-scan.js'
import { projectTurnLine, readRecentTurnLines, pickLastAssistantText } from './turn-line.js'
import { readEffortLevel } from './effort.js'
import { TaskTracker, type TaskFrame } from './task-tracker.js'
import {
  isPromptFrame, isPermVerdictFrame, buildHello,
  AUTH_REJECTED_HINT, INVALID_URL_HINT, SIGN_IN_HINT,
  type TaskSnapshotFrame,
} from './frames.js'
import { createRelay, resolveRelayUrl, type RelayHandle } from './relay.js'
import { deriveLabel } from './label.js'
import { detectControllable } from './activation.js'

// The send site is buildHello in frames.ts; re-exported here so the test that pins the wire
// value keeps importing it from the channel module.
export { PROVIDER } from './frames.js'

// Prod relay baked as the default so installed users are never prompted for config;
// CHIRP_RELAY_URL (inherited shell env) overrides for the dev stack / a local concierge.
// Resolved at module load so a typo'd CHIRP_RELAY_URL produces a clear message once and does
// not throw synchronously later from inside `new WebSocket(...)`.
const { url: RELAY, error: relayUrlError } = resolveRelayUrl(process.env, undefined, INVALID_URL_HINT)
if (relayUrlError) console.error(`[chirp-channel] ${relayUrlError}`)
export function _relayUrlValidForTests(): boolean { return RELAY !== null }
// Claude Code writes session transcripts under ~/.claude/projects.
const PROJECTS = join(homedir(), '.claude', 'projects')
// Identity, in priority order:
//  - sessionId: explicit override → Claude Code's own session UUID (CLAUDE_CODE_SESSION_ID) →
//    the newest transcript in the project folder → cwd basename as a last resort.
//  - label: CHIRP_SESSION_LABEL override → "<repo basename> · <branch>" (e.g. "chirp · main") →
//    project-dir basename when off-git. See deriveLabel.
// Claude Code 2.1.170 DOES inject CLAUDE_CODE_SESSION_ID into a stdio MCP server's env
// (verified: `env:{...,CLAUDE_PROJECT_DIR:P1(),CLAUDE_CODE_SESSION_ID:k_(),CLAUDECODE:"1"}`
// at the server spawn site), so the newestSessionId() step is a fallback for older builds
// only. Keep it: without an id the transcript tailer cannot find "<sessionId>.jsonl" and the
// phone shows nothing. Note it resolves per project DIRECTORY, so if it ever does fire for
// two concurrent sessions in the same repo they collide on one id and only one stays
// reachable through the relay.
const sessionId =
  process.env.CHIRP_SESSION_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  newestSessionId(PROJECTS, process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) ??
  basename(process.cwd())
const label = deriveLabel(process.env, process.cwd())
// Fixed for the life of the process — it is read off the owning `claude` process's argv, which
// was set at exec. Computed once here rather than per `open` because detection shells out to
// `ps` synchronously and the open handler is the reconnect hot path.
const controllable = detectControllable()
if (!controllable) console.error('[chirp-channel] session not launched with --channels — registering as view-only')
const tasks = new TaskTracker()

// The socket lifecycle (connect / token / hello / capped-backoff reconnect) lives in the shared
// channel/relay.ts — byte-identical with plugins/openclaw's copy — so a concierge deploy or
// network blip never orphans the session. This module wires the Claude Code side in: identity,
// the hello, frame handling, and perm-request redelivery.
let relayHandle: RelayHandle | null = null
let reportedModel: string | null = null

// False when the socket is not open — the frame is dropped, by design: dropped turn-lines are
// recovered by the phone's history-request on reconnect, and perm-requests by onOpen redelivery.
const emit = (obj: Record<string, unknown>): boolean => relayHandle?.emit(obj) ?? false
// TaskFrame and TaskSnapshotFrame are discriminated unions (no string index signature), so
// localize the cast here rather than scattering it at each call site.
const emitFrame = (f: TaskFrame | TaskSnapshotFrame) => emit(f as unknown as Record<string, unknown>)

// Unresolved perm-requests, requestId → frame. Unlike turn-lines, perm-requests are NOT
// recoverable via history-request — one dropped while the socket is down leaves the session
// blocked with the phone never seeing the card — so every unresolved request is re-sent on
// reconnect. Bounded: an entry clears on its verdict, and a fresh request supersedes any
// older one (Claude Code raises one blocking permission prompt at a time).
const pendingPermRequests = new Map<string, Record<string, unknown>>()
export function _pendingPermsForTests(): Map<string, Record<string, unknown>> {
  return pendingPermRequests
}

// The tailer's current file. After /clear or a resume the boot-time sessionId's transcript
// stops growing and the tailer re-resolves onto a new file — every reader (history-request,
// the preview, the model probe) must follow it here rather than re-deriving the stale
// boot-time path from sessionId.
let tailedTranscriptPath: string | null = null

function currentTranscriptPath(): string | null {
  return tailedTranscriptPath ?? findTranscriptPath(PROJECTS, sessionId)
}
export function _setTailedPathForTests(p: string | null): void {
  tailedTranscriptPath = p
}

/** Read the last assistant response from the session transcript, capped at 200 codepoints.
 *  Used as the default `readPreview` dep in connectRelay to seed the home-row preview for
 *  sessions whose activity predates the relay's in-memory state. Returns null on any failure. */
function readLastAssistantPreview(): { text: string; ts: number } | null {
  try {
    const path = currentTranscriptPath()
    if (!path) return null
    const lines = readRecentTurnLines(path, 50)
    const text = pickLastAssistantText(lines)
    if (!text) return null
    return { text, ts: Date.now() }
  } catch { return null }
}

function currentModel(): string | null {
  const path = currentTranscriptPath()
  if (!path) return null
  try { return latestModelIn(readFileSync(path, 'utf8')) } catch { return null }
}

// The MCP server is module state, so the notification path handleRelayMessage takes is
// otherwise unobservable (and un-mockable) from tests.
export function _mcpForTests(): Server {
  return mcp
}

// The relay fetches the JWT BEFORE the upgrade and passes it as the `Authorization` request
// header so the concierge can read it off the upgrade and `fly-replay`-route the connection to
// the right machine (sticky routing) — a hello-frame JWT is too late. The `hello` still goes out
// on open to register the channel (sessionId/label); its wire shape is unchanged (see
// frames.ts::buildHello). Deps are injectable (with real defaults) purely so tests can drive
// this without a real socket, auth round-trip, or wall clock.
export async function connectRelay(
  deps: {
    getToken?: () => Promise<string | null>
    makeWs?: (url: string, opts: { headers: Record<string, string> }) => WebSocket
    readPreview?: () => { text: string; ts: number } | null
    schedule?: (fn: () => void, ms: number) => unknown
    cancel?: (handle: unknown) => void
  } = {},
): Promise<RelayHandle | null> {
  // Skip relay entirely if the URL was invalid at startup (already logged once).
  if (!RELAY) return null

  // Production calls this once at startup; tests call it repeatedly. Stop any previous handle so
  // a superseded socket (and its reconnect loop) cannot outlive the wiring that replaced it.
  relayHandle?.stop()

  const handle = createRelay({
    url: RELAY,
    sessionId,
    // Rebuilt per (re)connect: the model probe re-reads the transcript, so a reconnect reports
    // what the session is running NOW — and updating reportedModel here keeps the tailer's
    // session-meta dedupe in step with what the hello last claimed.
    buildHello: (jwt) => {
      reportedModel = currentModel()
      const effort = readEffortLevel(process.env, process.cwd()) ?? undefined
      return buildHello(jwt, sessionId, label, { model: reportedModel ?? undefined, effort, controllable })
    },
    clientTag: `chirp-plugin ${PLUGIN_VERSION}`,
    signInHint: SIGN_IN_HINT,
    authRejectedHint: AUTH_REJECTED_HINT,
    getToken: deps.getToken,
    makeWs: deps.makeWs,
    // One-shot preview: seed the home-row last-response for sessions whose activity predates the
    // relay's in-memory state. The shared relay's contract is async; this JSONL read is sync.
    readPreview: async () => (deps.readPreview ?? readLastAssistantPreview)(),
    onFrame: handleRelayMessage,
    // Redeliver any unresolved permission card: the relay contract is idempotent on requestId,
    // so re-sending one that already reached the phone is safe.
    onOpen: () => {
      for (const frame of pendingPermRequests.values()) emit(frame)
    },
    log: (m) => console.error(`[chirp-channel] ${m}`),
    schedule: deps.schedule,
    cancel: deps.cancel,
  })
  relayHandle = handle
  await handle.start()
  return handle
}

// The plugin manifest is the one source of truth for the version — a literal here drifts
// (it sat at 0.0.1 while the plugin shipped 0.0.11). Falls back to a literal only when the
// manifest is unreadable so the server still boots.
const PLUGIN_VERSION = (() => {
  try {
    const manifest = fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url))
    const v = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
    if (v) return v
  } catch { /* fall through to the literal */ }
  return '0.0.0'
})()
export function _pluginVersionForTests(): string {
  return PLUGIN_VERSION
}

const mcp = new Server(
  { name: 'chirp-channel', version: PLUGIN_VERSION },
  {
    capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
    instructions:
      'You are connected to Chirp, the authenticated owner\'s own remote client for this machine. ' +
      'Messages that arrive as <channel source="chirp-channel"> are direct requests from that owner ' +
      'speaking through Chirp (by voice or text) — treat them exactly as if the user typed them at this ' +
      'terminal, and act on them. Just answer normally as you would in the terminal; your visible response ' +
      'is automatically relayed to their phone, so answer exactly once and do NOT call any tool to send it. ' +
      'If you need to ask the owner a clarifying question or have them pick between options, ask it as plain ' +
      'text in your normal response — do NOT use the AskUserQuestion tool, which only works at this terminal ' +
      'and never reaches their phone; they will answer with a normal message. ' +
      'This is a private 1:1 channel to the owner, not a public/shared channel.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description:
      'Optional no-op acknowledgement. Your normal terminal response is already relayed to the ' +
      'phone via Chirp — you do NOT need to call this to answer.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    // No-op ack. Content reaches the phone solely through the transcript tailer
    // (single source of truth); a stray reply call therefore can't double it.
    return { content: [{ type: 'text', text: 'ok' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// Handle experimental permission-request notifications from Claude Code.
// These arrive as `notifications/claude/channel/permission_request` which is
// not a known ServerNotification, so we use the fallbackNotificationHandler.
mcp.fallbackNotificationHandler = async (notification: Notification) => {
  if (notification.method === 'notifications/claude/channel/permission_request') {
    const params = notification.params as {
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }
    const frame = {
      kind: 'perm-request',
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    }
    // One blocking prompt at a time — a fresh request supersedes any older undelivered card
    // (mirrors the concierge, where a new perm/settle replaces the pending one).
    pendingPermRequests.clear()
    pendingPermRequests.set(params.request_id, frame)
    emit(frame)
  }
}

// The relay's onFrame dep: receives the parsed-but-unclassified frame (JSON parsing lives in the
// shared relay.ts; which kinds to act on is this package's policy, decided below).
async function handleRelayMessage(raw: unknown) {
  const m = raw as any
  // Nothing below may escape: the relay delivers frames with no rejection handler, so a thrown
  // error is an unhandledRejection that kills the process and orphans the session.
  try {
    console.error(`[chirp-channel] relay→ kind=${m?.kind} session=${m?.sessionId ?? '∅'}`)
    if (m?.kind === 'prompt') {
      if (!isPromptFrame(m)) { console.error('[chirp-channel] malformed prompt frame — dropped'); return }
      console.error(`[chirp-channel] injecting prompt into claude: ${JSON.stringify(m.text).slice(0, 80)}`)
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: m.text, meta: {} },
        } as any)
        console.error('[chirp-channel] notification sent ok')
      } catch (e) {
        console.error('[chirp-channel] notification FAILED', String(e))
      }
    } else if (m?.kind === 'perm-verdict') {
      if (!isPermVerdictFrame(m)) { console.error('[chirp-channel] malformed perm-verdict frame — dropped'); return }
      // Resolved: never redeliver this card, even if the notification below fails
      // (the terminal can still answer the prompt; a stale card cannot).
      pendingPermRequests.delete(m.requestId)
      try {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: m.requestId, behavior: m.behavior },
        } as any)
      } catch (e) {
        // "Not connected" is reachable when the stdio transport is down; the verdict is
        // droppable (the terminal can still answer the permission prompt) — the process is not.
        console.error('[chirp-channel] perm-verdict notification FAILED', String(e))
      }
    } else if (m?.kind === 'history-request') {
      const path = currentTranscriptPath()
      const lines = path ? readRecentTurnLines(path) : []
      console.error(`[chirp-channel] history-request → ${lines.length} lines`)
      // Projected lines, not turns: the concierge reduces these to the `history` frame the app
      // knows (relay/transcript.ts::historyTurns), so the turn policy lives in one place.
      emit({ kind: 'history-lines', lines })
    } else if (m?.kind === 'task-snapshot-request') {
      const snap = tasks.snapshot()
      console.error(`[chirp-channel] task-snapshot-request → ${snap.running.length} running, ${snap.recentlyCompleted.length} recent`)
      const frame: TaskSnapshotFrame = { kind: 'task-snapshot', running: snap.running, recentlyCompleted: snap.recentlyCompleted }
      emitFrame(frame)
    } else {
      console.error(`[chirp-channel] unhandled relay frame kind=${m?.kind ?? '(none)'}`)
    }
  } catch (e) {
    console.error('[chirp-channel] relay frame handling failed', String(e))
  }
}

// How long the tail must be idle (no new bytes) before we re-probe for a newer transcript
// (e.g. after /clear or session resume writes a new JSONL file).
export const QUIET_RECHECK_MS = 30_000

// Mutable state for the transcript tailer, held in an object so tests can inject and inspect it.
// Exported for testing only; production code only calls startTailer().
export type TailerState = { path: string | null; offset: number; lastActivityMs: number; buffer: string }

/** Why the tailer is re-resolving: its file stat-failed ('missing'), shrank ('truncated'),
 *  or simply stopped growing for QUIET_RECHECK_MS ('quiet'). */
export type ResolveReason = 'missing' | 'truncated' | 'quiet'

// A switched-to file at or under this size is "fresh": a just-created post-/clear transcript
// observed within one quiet window (preamble + the first turn or two). Anything larger has
// history that predates the switch and must not be replayed as live turn-lines.
export const FRESH_SWITCH_MAX_BYTES = 64 * 1024

/** Pure re-resolution step: given current state + injected finders, return updated state.
 *  Exported as a test seam — production code uses this internally via startTailer(). */
export function resolveTranscriptPath(
  current: TailerState,
  projectsDir: string,
  projectDir: string,
  nowMs: number,
  finders: {
    newestId: (projDir: string, cwdDir: string) => string | null
    findPath: (projDir: string, id: string) => string | null
    sizeOf?: (path: string) => number | null
  },
  reason: ResolveReason = 'quiet',
): TailerState {
  const sizeOf = finders.sizeOf ?? ((p: string) => { try { return statSync(p).size } catch { return null } })
  const newId = finders.newestId(projectsDir, projectDir)
  const newPath = newId ? finders.findPath(projectsDir, newId) : null
  if (newPath && newPath !== current.path) {
    // Where to start reading a file we switch to. 'missing'/'truncated' mean OUR file went
    // away or shrank — the newest file is this session's continuation, so replay it from 0.
    // 'quiet' means our file is intact and merely idle: the newest file may belong to a
    // concurrent session in the same project dir, and replaying it from byte 0 would emit
    // that session's entire history as this row's turn-lines. Rule: on the quiet path,
    // replay from 0 only when the file is verifiably fresh (small at switch time); a file
    // already large at switch time starts at EOF. Turns an EOF start skips are recoverable
    // on demand — history-request reads the tailer's current path.
    let offset = 0
    if (reason === 'quiet') {
      const size = sizeOf(newPath)
      if (size !== null && size > FRESH_SWITCH_MAX_BYTES) offset = size
    }
    console.error(`[chirp-channel] transcript switched → ${newPath} (offset ${offset})`)
    return { path: newPath, offset, lastActivityMs: nowMs, buffer: '' }
  }
  // A truncated file must restart from 0 even when it is still the newest transcript,
  // or the tailer wedges on `size < offset` forever and never reads another byte.
  if (reason === 'truncated') return { ...current, offset: 0, buffer: '', lastActivityMs: nowMs }
  return { ...current, lastActivityMs: nowMs }
}

// Tail this session's transcript and emit one `turn-line` projection per line. The plugin is a
// sensor: the concierge relay interprets these into the mirror/step/status frames the phone reads.
// Reuses the open relay socket — no extra connection, no Claude cooperation.
function startTailer() {
  let transcriptPath: string | null = null
  let offset = 0
  let buffer = ''
  let lastActivityMs = Date.now()

  const resetToNewest = (reason: ResolveReason) => {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    const next = resolveTranscriptPath(
      { path: transcriptPath, offset, lastActivityMs, buffer },
      PROJECTS,
      projectDir,
      Date.now(),
      { newestId: newestSessionId, findPath: findTranscriptPath },
      reason,
    )
    transcriptPath = next.path
    tailedTranscriptPath = next.path
    offset = next.offset
    lastActivityMs = next.lastActivityMs
    buffer = next.buffer
  }

  setInterval(() => {
    if (!transcriptPath) {
      transcriptPath = findTranscriptPath(PROJECTS, sessionId)
      if (!transcriptPath) return
      tailedTranscriptPath = transcriptPath
      try { offset = statSync(transcriptPath).size } catch { offset = 0 } // tail from end: live turns only
      lastActivityMs = Date.now()
      console.error(`[chirp-channel] tailing ${transcriptPath}`)
    }
    let size: number
    try { size = statSync(transcriptPath).size } catch {
      // File deleted or inaccessible — re-resolve to the newest transcript.
      resetToNewest('missing')
      return
    }
    // Quiet-timeout re-resolution — if no new bytes for QUIET_RECHECK_MS, probe for a
    // newer transcript (covers /clear and session resume writing a new JSONL file).
    if (size <= offset) {
      if (size < offset) {
        // File was truncated (e.g. log rotation); restart it (or its replacement) from 0.
        resetToNewest('truncated')
        return
      }
      // No new bytes yet; check quiet timeout.
      if (Date.now() - lastActivityMs > QUIET_RECHECK_MS) resetToNewest('quiet')
      return
    }
    lastActivityMs = Date.now()
    const fd = openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      offset = size
      buffer += buf.toString('utf8')
    } finally { closeSync(fd) }
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Every parseable transcript line is forwarded verbatim-as-projected — including
      // role:'other' (system lines, summaries) — because deciding which lines are meaningful
      // is the concierge's job, not the sensor's. See relay/transcript.ts::projectTurnLine.
      const projected = projectTurnLine(line)
      if (projected) emit({ kind: 'turn-line', line: projected })
      const taskLine = parseTaskLine(line)
      if (taskLine) {
        const frame = tasks.apply(taskLine)
        if (frame) emitFrame(frame)
      }
      const model = extractModel(line)
      if (model && model !== reportedModel) {
        reportedModel = model
        emit({ kind: 'session-meta', model, effort: readEffortLevel(process.env, process.cwd()) ?? undefined })
      }
    }
  }, 400)
}
// Top-level side effects (the transcript tailer, the relay connection, and the stdio transport) only
// run when this module is executed as the channel server — not when a test imports it for the
// exported helpers. vitest sets process.env.VITEST; it is unset in the real `tsx channel/...` run.
if (!process.env.VITEST) {
  startTailer()
  // The MCP handshake goes first: Claude Code is waiting on stdio, and a slow token exchange
  // inside connectRelay would make the server look dead. connectRelay never rejects (every
  // failure path routes into its own backoff loop), so awaiting it after is safe.
  await mcp.connect(new StdioServerTransport())
  await connectRelay()
}
