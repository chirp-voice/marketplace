import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Notification } from '@modelcontextprotocol/sdk/types.js'
import WebSocket from 'ws'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { extractMirror, extractSteps, findTranscriptPath, readRecentTurns, deriveStatus, newestSessionId, parseTaskLine, extractModel, latestModelIn } from './transcript-mirror.js'
import { readEffortLevel } from './effort.js'
import { TaskTracker, type TaskFrame } from './task-tracker.js'
import type { TaskSnapshotFrame } from './frames.js'
import { deriveLabel } from './label.js'
import { getAccessToken } from '../auth/pkce-login.js'

const RELAY_RAW = process.env.CHIRP_RELAY_URL ?? 'ws://localhost:8080/relay'
// Validate at module load so a typo'd relay_url userConfig / CHIRP_RELAY_URL produces a clear
// message and does not throw synchronously later from inside `new WebSocket(...)`.
let RELAY: string
let _relayUrlValid = true
try {
  new URL(RELAY_RAW) // throws on malformed URLs
  RELAY = RELAY_RAW
} catch {
  console.error(`[chirp-channel] invalid relay_url "${RELAY_RAW}" (set via CHIRP_RELAY_URL / relay_url userConfig) — relay disabled; MCP channel still active`)
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
// Newer Claude Code builds (≥2.1.x) inject CLAUDE_PROJECT_DIR but NOT CLAUDE_CODE_SESSION_ID into a
// channel server's env. Without the id the mirror tailer can't find this session's transcript (it
// looks up "<sessionId>.jsonl") so it emits no mirror/status frames and the phone shows nothing —
// hence the newestSessionId() recovery from CLAUDE_PROJECT_DIR before the bare-cwd fallback.
const sessionId =
  process.env.CHIRP_SESSION_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  newestSessionId(PROJECTS, process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) ??
  basename(process.cwd())
const label = deriveLabel(process.env, process.cwd())
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
    ws.send(JSON.stringify({ v: 1, kind: 'hello', role: 'channel', jwt, sessionId, label, model: reportedModel ?? undefined, effort }))
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
    // No-op ack. Content reaches the phone solely through the transcript mirror
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
    emit({ kind: 'status', status: 'needs-input' })
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
    const turns = path ? readRecentTurns(path, 40) : []
    console.error(`[chirp-channel] history-request → ${turns.length} turns`)
    emit({ kind: 'history', turns })
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

// Mutable state for the mirror tailer, held in an object so tests can inject and inspect it.
// Exported for testing only; production code only calls startMirror().
export type MirrorTailerState = { path: string | null; offset: number; lastActivityMs: number; buffer: string }

/** Pure re-resolution step: given current state + injected finders, return updated state.
 *  Called when the tailer detects: stat failure, truncation, or quiet-timeout.
 *  Exported as a test seam — production code uses this internally via startMirror(). */
export function resolveMirrorPath(
  current: MirrorTailerState,
  projectsDir: string,
  projectDir: string,
  nowMs: number,
  finders: {
    newestId: (projDir: string, cwdDir: string) => string | null
    findPath: (projDir: string, id: string) => string | null
  },
): MirrorTailerState {
  const newId = finders.newestId(projectsDir, projectDir)
  const newPath = newId ? finders.findPath(projectsDir, newId) : null
  if (newPath && newPath !== current.path) {
    console.error(`[chirp-channel] transcript switched → ${newPath}`)
    return { path: newPath, offset: 0, lastActivityMs: nowMs, buffer: '' }
  }
  return { ...current, lastActivityMs: nowMs }
}

// Mirror locally-driven turns to the phone: tail this session's transcript and
// emit every user prompt / assistant reply that did NOT originate from the phone
// (extractMirror skips the channel-wrapped prompts and the reply tool calls).
// Reuses the open relay socket — no extra connection, no Claude cooperation.
function startMirror() {
  let path: string | null = null
  let offset = 0
  let buffer = ''
  let lastActivityMs = Date.now()

  const resetToNewest = () => {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
    const next = resolveMirrorPath(
      { path, offset, lastActivityMs, buffer },
      PROJECTS,
      projectDir,
      Date.now(),
      { newestId: newestSessionId, findPath: findTranscriptPath },
    )
    path = next.path
    offset = next.offset
    lastActivityMs = next.lastActivityMs
    buffer = next.buffer
  }

  setInterval(() => {
    if (!path) {
      path = findTranscriptPath(PROJECTS, sessionId)
      if (!path) return
      try { offset = statSync(path).size } catch { offset = 0 } // tail from end: live turns only
      lastActivityMs = Date.now()
      console.error(`[chirp-channel] mirroring ${path}`)
    }
    let size: number
    try { size = statSync(path).size } catch {
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
    const fd = openSync(path, 'r')
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
      const turn = extractMirror(line)
      if (turn) emit({ kind: 'mirror', role: turn.role, text: turn.text })
      // Live play-by-play: tool calls + intermediate narration as ephemeral steps (never
      // affects status; the voice summary still fires only on the terminal-stop `done`).
      for (const step of extractSteps(line)) emit({ kind: 'step', step })
      // Status is derived per line from stop_reason (decoupled from the mirror): `done` fires only on
      // a genuine turn-end, so intermediate narration stays `running` and the phone speaks the answer.
      const status = deriveStatus(line)
      if (status) emit({ kind: 'status', status })
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
// Top-level side effects (the mirror tailer, the relay connection, and the stdio transport) only
// run when this module is executed as the channel server — not when a test imports it for the
// exported helpers. vitest sets process.env.VITEST; it is unset in the real `tsx channel/...` run.
if (!process.env.VITEST) {
  startMirror()
  await connectRelay()
  await mcp.connect(new StdioServerTransport())
}
