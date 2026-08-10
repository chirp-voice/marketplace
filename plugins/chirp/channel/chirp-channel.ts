import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Notification } from '@modelcontextprotocol/sdk/types.js'
import WebSocket from 'ws'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { findTranscriptPath, newestSessionId, parseTaskLine, extractModel, latestModelIn } from './transcript-scan.js'
import { projectTurnLine, readRecentTurnLines } from './turn-line.js'
import { readEffortLevel } from './effort.js'
import { TaskTracker, type TaskFrame } from './task-tracker.js'
import type { TaskSnapshotFrame } from './frames.js'
import { deriveLabel } from './label.js'
import { getAccessToken } from '../auth/pkce-login.js'
import { detectControllable } from './activation.js'

// Prod relay baked as the default so installed users are never prompted for config;
// CHIRP_RELAY_URL (inherited shell env) overrides for the dev stack / a local concierge.
const RELAY_RAW = process.env.CHIRP_RELAY_URL ?? 'wss://chirp-concierge.fly.dev/relay'
// Validate at module load so a typo'd CHIRP_RELAY_URL produces a clear
// message and does not throw synchronously later from inside `new WebSocket(...)`.
let RELAY: string
let _relayUrlValid = true
try {
  new URL(RELAY_RAW) // throws on malformed URLs
  RELAY = RELAY_RAW
} catch {
  console.error(`[chirp-channel] invalid relay URL "${RELAY_RAW}" (set via CHIRP_RELAY_URL) — relay disabled; MCP channel still active`)
  RELAY = ''
  _relayUrlValid = false
}
export function _relayUrlValidForTests(): boolean { return _relayUrlValid }
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

// The relay socket is reconnecting: a concierge restart/deploy, network blip, or a
// transient auth failure (expired token before /chirp-auth refreshes it) drops the socket,
// and we reconnect with capped exponential backoff. Without this a single concierge deploy
// orphans the session permanently (the phone stops seeing it until Claude Code restarts).
let relay: WebSocket | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reportedModel: string | null = null

const emit = (obj: Record<string, unknown>) => {
  try {
    if (relay && relay.readyState === WebSocket.OPEN) relay.send(JSON.stringify({ v: 1, sessionId, ...obj }))
  } catch { /* socket mid-reconnect — dropped frames are recovered by the phone's history-request on reconnect */ }
}
// TaskFrame and TaskSnapshotFrame are discriminated unions (no string index signature), so
// localize the cast here rather than scattering it at each call site.
const emitFrame = (f: TaskFrame | TaskSnapshotFrame) => emit(f as unknown as Record<string, unknown>)

function currentModel(): string | null {
  const path = findTranscriptPath(PROJECTS, sessionId)
  if (!path) return null
  try { return latestModelIn(readFileSync(path, 'utf8')) } catch { return null }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectRelay()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

// Test-only seams: the single-flight timer + backoff live in module state, so the
// backoff-growth property (close-without-open must grow the delay) is otherwise
// unobservable from tests. Inert in production — nothing outside tests calls these.
export function _reconnectDelayForTests(): number {
  return reconnectDelay
}
export function _resetReconnectForTests(delayMs = 1000): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectDelay = delayMs
}

// The JWT is fetched BEFORE the upgrade and passed as the `Authorization` request header so the
// concierge can read it off the relay WebSocket's upgrade headers and `fly-replay`-route the
// connection to the right machine (sticky routing). Sending it only in the post-open `hello` frame
// is too late for routing. The `hello` frame still goes out on open to register the channel
// (sessionId/label) — its shape is unchanged. Deps are injectable (with real defaults) purely so
// tests can drive this without a real socket or auth round-trip.
export async function connectRelay(
  deps: {
    getToken?: () => Promise<string | null>
    makeWs?: (url: string, opts: { headers: Record<string, string> }) => WebSocket
  } = {},
) {
  // Skip relay entirely if the URL was invalid at startup (already logged once).
  if (!_relayUrlValid) return

  const getToken = deps.getToken ?? getAccessToken
  const makeWs = deps.makeWs ?? ((url, opts) => new WebSocket(url, opts))

  const jwt = await getToken()
  if (!jwt) {
    // Not signed in / token refresh failed. Don't give up — back off and retry so the
    // session auto-heals once `/chirp-auth` refreshes the credentials.
    console.error('[chirp-channel] not signed in — run /chirp-auth in Claude Code; will retry')
    scheduleReconnect()
    return
  }

  let ws: WebSocket
  try {
    ws = makeWs(RELAY, { headers: { authorization: `Bearer ${jwt}` } })
  } catch (e) {
    // new WebSocket() can throw synchronously on a bad URL; route into the backoff loop.
    console.error('[chirp-channel] relay connect threw', String(e))
    scheduleReconnect()
    return
  }
  relay = ws
  ws.on('open', () => {
    // Reset backoff only on a real connection. Resetting after the token fetch
    // (pre-open) meant a down relay never grew past the 1s floor — every
    // connected Mac hammering a deploying concierge at 1 req/s forever.
    reconnectDelay = 1000
    reportedModel = currentModel()
    const effort = readEffortLevel(process.env, process.cwd()) ?? undefined
    // `controllable` is best-effort: true whenever we cannot prove the channel is inactive
    // (see activation.ts). Resolved once at module load.
    ws.send(JSON.stringify({ v: 1, kind: 'hello', role: 'channel', jwt, sessionId, label, model: reportedModel ?? undefined, effort, controllable }))
  })
  ws.on('message', handleRelayMessage)
  ws.on('error', (e) => console.error('[chirp-channel] relay error', String(e)))
  ws.on('close', () => scheduleReconnect())
}

const mcp = new Server(
  { name: 'chirp-channel', version: '0.0.1' },
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
    emit({
      kind: 'perm-request',
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    })
  }
}

async function handleRelayMessage(raw: WebSocket.RawData) {
  let m: any; try { m = JSON.parse(String(raw)) } catch { return }
  console.error(`[chirp-channel] relay→ kind=${m.kind} session=${m.sessionId ?? '∅'}`)
  if (m.kind === 'prompt') {
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
  } else if (m.kind === 'perm-verdict') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: m.requestId, behavior: m.behavior },
    } as any)
  } else if (m.kind === 'history-request') {
    const path = findTranscriptPath(PROJECTS, sessionId)
    const lines = path ? readRecentTurnLines(path) : []
    console.error(`[chirp-channel] history-request → ${lines.length} lines`)
    // Projected lines, not turns: the concierge reduces these to the `history` frame the app
    // knows (relay/transcript.ts::historyTurns), so the turn policy lives in one place.
    emit({ kind: 'history-lines', lines })
  } else if (m.kind === 'task-snapshot-request') {
    const snap = tasks.snapshot()
    console.error(`[chirp-channel] task-snapshot-request → ${snap.running.length} running, ${snap.recentlyCompleted.length} recent`)
    const frame: TaskSnapshotFrame = { kind: 'task-snapshot', running: snap.running, recentlyCompleted: snap.recentlyCompleted }
    emitFrame(frame)
  } else {
    console.error(`[chirp-channel] unhandled relay frame kind=${m.kind ?? '(none)'}`)
  }
}

// How long the tail must be idle (no new bytes) before we re-probe for a newer transcript
// (e.g. after /clear or session resume writes a new JSONL file).
export const QUIET_RECHECK_MS = 30_000

// Mutable state for the transcript tailer, held in an object so tests can inject and inspect it.
// Exported for testing only; production code only calls startTailer().
export type TailerState = { path: string | null; offset: number; lastActivityMs: number; buffer: string }

/** Pure re-resolution step: given current state + injected finders, return updated state.
 *  Called when the tailer detects: stat failure, truncation, or quiet-timeout.
 *  Exported as a test seam — production code uses this internally via startTailer(). */
export function resolveTranscriptPath(
  current: TailerState,
  projectsDir: string,
  projectDir: string,
  nowMs: number,
  finders: {
    newestId: (projDir: string, cwdDir: string) => string | null
    findPath: (projDir: string, id: string) => string | null
  },
): TailerState {
  const newId = finders.newestId(projectsDir, projectDir)
  const newPath = newId ? finders.findPath(projectsDir, newId) : null
  if (newPath && newPath !== current.path) {
    console.error(`[chirp-channel] transcript switched → ${newPath}`)
    return { path: newPath, offset: 0, lastActivityMs: nowMs, buffer: '' }
  }
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

  const resetToNewest = () => {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    const next = resolveTranscriptPath(
      { path: transcriptPath, offset, lastActivityMs, buffer },
      PROJECTS,
      projectDir,
      Date.now(),
      { newestId: newestSessionId, findPath: findTranscriptPath },
    )
    transcriptPath = next.path
    offset = next.offset
    lastActivityMs = next.lastActivityMs
    buffer = next.buffer
  }

  setInterval(() => {
    if (!transcriptPath) {
      transcriptPath = findTranscriptPath(PROJECTS, sessionId)
      if (!transcriptPath) return
      try { offset = statSync(transcriptPath).size } catch { offset = 0 } // tail from end: live turns only
      lastActivityMs = Date.now()
      console.error(`[chirp-channel] tailing ${transcriptPath}`)
    }
    let size: number
    try { size = statSync(transcriptPath).size } catch {
      // File deleted or inaccessible — re-resolve to the newest transcript.
      resetToNewest()
      return
    }
    // Fix 1: quiet-timeout re-resolution — if no new bytes for QUIET_RECHECK_MS, probe for a
    // newer transcript (covers /clear and session resume writing a new JSONL file).
    if (size <= offset) {
      if (size < offset) {
        // Fix 2: truncation reset — file was truncated (e.g. log rotation); treat like deletion.
        resetToNewest()
        return
      }
      // No new bytes yet; check quiet timeout.
      if (Date.now() - lastActivityMs > QUIET_RECHECK_MS) resetToNewest()
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
  await connectRelay()
  await mcp.connect(new StdioServerTransport())
}
