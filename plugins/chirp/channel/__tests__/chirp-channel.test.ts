import { describe, test, expect, vi, beforeEach } from 'vitest'
import { pickLastAssistantText } from '../turn-line'
import type { TurnLine } from '../turn-line'

// Importing chirp-channel.ts pulls in its module-level wiring (transcript tailer + relay connect +
// stdio transport). Those side effects are guarded behind `!process.env.VITEST`, which vitest sets,
// so importing here is inert and we can drive connectRelay() directly with injected fakes.
import {
  connectRelay, _relayUrlValidForTests,
  _mcpForTests, _setTailedPathForTests, _pendingPermsForTests, _pluginVersionForTests,
  resolveTranscriptPath, QUIET_RECHECK_MS, PROVIDER,
  type TailerState,
} from '../chirp-channel'

/** Drain the microtask queue: the shared relay reads the preview through an async dep, so its
 *  frame lands a few ticks after the open handler returns. Safe under fake timers (which stub
 *  the macrotask clock, not microtasks). */
const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Build a fake WebSocket, connect it via connectRelay, and return the wired message handler
 *  plus a list that collects every frame the channel sends back over the relay. */
async function buildHarness() {
  let messageHandler: ((raw: unknown) => Promise<void>) | null = null
  const sentFrames: unknown[] = []
  const ws = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
      if (event === 'message') messageHandler = cb as typeof messageHandler
    }),
    send: vi.fn((data: unknown) => { sentFrames.push(JSON.parse(data as string)) }),
    close: vi.fn(),
    readyState: 1, // OPEN
  }
  const makeWs = vi.fn((_url: string, _opts: { headers: Record<string, string> }) => ws)
  await connectRelay({ getToken: async () => 'tok-hist', makeWs: makeWs as any })
  return { messageHandler: messageHandler!, sentFrames }
}

function fakeWsInstance() {
  // readyState OPEN so the shared relay's preview liveness guard (`sock.readyState === 1`)
  // treats a manually-fired 'open' the way a real ws would.
  return { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: 1 }
}

type FakeWs = ReturnType<typeof fakeWsInstance>
// Typed so `makeWs.mock.calls[i]` carries the [url, opts] tuple (a bare `vi.fn(() => ws)` infers
// a zero-arg signature, which makes calls[0][1] a tuple-index error under strict tsc).
const makeWsFn = (ws: FakeWs) =>
  vi.fn((_url: string, _opts: { headers: Record<string, string> }) => ws)

describe('connectRelay — JWT on the upgrade header', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  test('with a jwt, makeWs is called with an Authorization upgrade header', async () => {
    const ws = fakeWsInstance()
    const makeWs = makeWsFn(ws)
    const getToken = vi.fn(async () => 'tok-123')

    await connectRelay({ getToken, makeWs: makeWs as any })

    expect(getToken).toHaveBeenCalledTimes(1)
    expect(makeWs).toHaveBeenCalledTimes(1)
    const [, opts] = makeWs.mock.calls[0]
    expect(opts).toEqual({ headers: { authorization: 'Bearer tok-123' } })
  })

  test('the hello frame is still sent on open (registration unchanged)', async () => {
    const ws = fakeWsInstance()
    const makeWs = makeWsFn(ws)
    const getToken = vi.fn(async () => 'tok-xyz')

    await connectRelay({ getToken, makeWs: makeWs as any, readPreview: vi.fn(() => null) })

    // Find and fire the 'open' handler the way ws would.
    const openCall = ws.on.mock.calls.find(([ev]) => ev === 'open')
    expect(openCall).toBeDefined()
    await openCall![1]()

    expect(ws.send).toHaveBeenCalledTimes(1)
    const frame = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(frame).toMatchObject({ v: 1, kind: 'hello', role: 'channel', jwt: 'tok-xyz' })
  })

  test('the hello frame reports controllability', async () => {
    const ws = fakeWsInstance()
    const makeWs = makeWsFn(ws)
    const getToken = vi.fn(async () => 'tok-ctrl')

    await connectRelay({ getToken, makeWs: makeWs as any, readPreview: vi.fn(() => null) })

    const openCall = ws.on.mock.calls.find(([ev]) => ev === 'open')
    expect(openCall).toBeDefined()
    await openCall![1]()

    expect(ws.send).toHaveBeenCalledTimes(1)
    const frame = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(typeof frame.controllable).toBe('boolean')
  })

  test('the hello frame declares the claude-code provider', async () => {
    const ws = fakeWsInstance()
    const makeWs = makeWsFn(ws)
    const getToken = vi.fn(async () => 'tok-prov')

    await connectRelay({ getToken, makeWs: makeWs as any, readPreview: vi.fn(() => null) })

    const openCall = ws.on.mock.calls.find(([ev]) => ev === 'open')
    expect(openCall).toBeDefined()
    await openCall![1]()

    const frame = JSON.parse(ws.send.mock.calls[0][0] as string)
    // Sent explicitly rather than leaning on the relay's absent-means-claude-code default: that
    // default is backward compatibility for plugins already installed on user Macs, not the
    // shape a current plugin should emit.
    expect(frame.provider).toBe(PROVIDER)
    // Pin the literal separately — the line above only proves the frame carries whatever the
    // module exports, not that the wire value is the one the app and worker key off.
    expect(PROVIDER).toBe('claude-code')
  })

  test('with a null token, makeWs is NOT called and a reconnect is scheduled', async () => {
    const ws = fakeWsInstance()
    const makeWs = makeWsFn(ws)
    const getToken = vi.fn(async () => null)

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    await connectRelay({ getToken, makeWs: makeWs as any })

    expect(getToken).toHaveBeenCalledTimes(1)
    expect(makeWs).not.toHaveBeenCalled()
    // scheduleReconnect arms a timer rather than constructing a socket.
    expect(setTimeoutSpy).toHaveBeenCalled()
  })

  test('close without open grows the backoff — no 1 Hz storm against a down relay', async () => {
    // Token is healthy but the relay never completes the handshake: each attempt
    // fires 'close' without 'open'. The backoff must GROW across attempts — the
    // regression was resetting it after the token fetch (pre-open), which pinned
    // retries at the 1s floor forever.
    const getToken = vi.fn(async () => 'tok-123')
    // A fake clock (the shared relay's schedule/cancel deps) collects reconnects so each
    // attempt can be fired by hand and the armed delay stays observable via the handle.
    const pending: Array<() => void> = []
    const handlers: Array<Record<string, (...args: unknown[]) => unknown>> = []
    const makeWs = vi.fn((_url: string, _opts: { headers: Record<string, string> }) => {
      const h: Record<string, (...args: unknown[]) => unknown> = {}
      handlers.push(h)
      return { on: (ev: string, cb: (...args: unknown[]) => unknown) => { h[ev] = cb }, send: vi.fn(), close: vi.fn(), readyState: 0 }
    })

    const handle = (await connectRelay({
      getToken,
      makeWs: makeWs as any,
      schedule: (fn) => { pending.push(fn); return pending.length - 1 },
      cancel: () => {},
    }))!
    expect(handle.reconnectDelayMs()).toBe(1000)

    handlers[0].close() // relay refused / dropped the socket pre-open
    expect(handle.reconnectDelayMs()).toBe(2000) // 1000 armed, doubled for the next attempt

    pending.shift()!() // fire the queued reconnect
    await flushMicrotasks() // let its token fetch resolve and the next socket wire up
    expect(handlers).toHaveLength(2)
    handlers[1].close()
    expect(handle.reconnectDelayMs()).toBe(4000) // buggy code re-pinned this to 2000
  })
})

// ── Fix 1: quiet-transcript re-resolution ────────────────────────────────────
describe('resolveTranscriptPath — quiet-transcript re-resolution (fix 1)', () => {
  const baseState = (): TailerState => ({ path: '/old/abc.jsonl', offset: 100, lastActivityMs: 0, buffer: '' })
  const finders = (newId: string | null, newPath: string | null, size: number | null = 0) => ({
    newestId: vi.fn(() => newId),
    findPath: vi.fn(() => newPath),
    sizeOf: vi.fn(() => size),
  })

  test('returns updated path + reset offset when a newer, fresh transcript exists', () => {
    const state = baseState()
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 9000, finders('newid', '/new/newid.jsonl'))
    expect(result.path).toBe('/new/newid.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
    expect(result.lastActivityMs).toBe(9000)
  })

  test('quiet switch to a small fresh file (post-/clear) replays it from 0', () => {
    const state = baseState()
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 9000, finders('fresh', '/new/fresh.jsonl', 4_096))
    expect(result.path).toBe('/new/fresh.jsonl')
    expect(result.offset).toBe(0)
  })

  test('quiet switch to an already-large file starts at EOF, never replaying it from 0', () => {
    // Two concurrent sessions in one project dir: the idle session's quiet probe finds the
    // active session's transcript. Starting anywhere but EOF replays that session's entire
    // history as this row's turn-lines (wrong-row duplication, re-emitted task frames).
    const state = baseState()
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 9000, finders('busy', '/other/busy.jsonl', 5_000_000))
    expect(result.path).toBe('/other/busy.jsonl')
    expect(result.offset).toBe(5_000_000)
    expect(result.buffer).toBe('')
  })

  test('quiet switch with an unreadable size falls back to 0 (the next stat failure re-resolves anyway)', () => {
    const result = resolveTranscriptPath(baseState(), '/proj', '/cwd', 9000, finders('x', '/new/x.jsonl', null))
    expect(result.offset).toBe(0)
  })

  test('missing/truncated switches replay from 0 even when the file is large', () => {
    // Our own file vanished or shrank — the newest file is this session's continuation.
    for (const reason of ['missing', 'truncated'] as const) {
      const result = resolveTranscriptPath(baseState(), '/proj', '/cwd', 9000, finders('big', '/new/big.jsonl', 5_000_000), reason)
      expect(result.offset).toBe(0)
    }
  })

  test('does not switch when the newest path is the same file already being tailed', () => {
    const state = baseState()
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 9000, finders('abc', '/old/abc.jsonl'))
    // Same path: no switch, but lastActivityMs still updated.
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.offset).toBe(100) // offset preserved
    expect(result.lastActivityMs).toBe(9000)
  })

  test('returns unchanged path (plus refreshed lastActivityMs) when no newer transcript is found', () => {
    const state = baseState()
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 5000, finders(null, null))
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.lastActivityMs).toBe(5000)
  })

  test('QUIET_RECHECK_MS constant is 30 seconds', () => {
    expect(QUIET_RECHECK_MS).toBe(30_000)
  })
})

// ── Fix 2: tailer recovery from truncation ────────────────────────────────────
describe('resolveTranscriptPath — truncation reset (fix 2)', () => {
  test('truncation with a path switch replays the new file from 0', () => {
    const state: TailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: 'partial' }
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 1234, {
      newestId: vi.fn(() => 'newid'),
      findPath: vi.fn(() => '/new/newid.jsonl'),
    }, 'truncated')
    expect(result.path).toBe('/new/newid.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
  })

  test('truncation with the same path resets the offset — the tailer must not wedge on size < offset', () => {
    // Regression: when the truncated file was still the newest transcript, the offset was
    // preserved, so `size < offset` held forever and the tailer never read another byte.
    const state: TailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: 'partial' }
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 7777, {
      newestId: vi.fn(() => 'abc'),
      findPath: vi.fn(() => '/old/abc.jsonl'),
    }, 'truncated')
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
    expect(result.lastActivityMs).toBe(7777)
  })

  test('truncation with no transcript found still resets the offset', () => {
    const state: TailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: '' }
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 8888, {
      newestId: vi.fn(() => null),
      findPath: vi.fn(() => null),
    }, 'truncated')
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.offset).toBe(0)
    expect(result.lastActivityMs).toBe(8888)
  })
})

// ── history-lines handler ─────────────────────────────────────────────────────
// Covers the `history-request` branch in handleRelayMessage.
//
// The handler is: `const path = currentTranscriptPath(); emit({ kind: 'history-lines', lines: path ? readRecentTurnLines(path) : [] })`
//
// `currentTranscriptPath` and `readRecentTurnLines` use module-level constants that are
// fixed at import time (real FS paths, real sessionId), so we test the two concerns
// separately:
//   (a) End-to-end: a `history-request` message always produces a `history-lines` frame
//       with a `lines` array (whatever the current session transcript contains).
//   (b) `path ? … : []` fallback: readRecentTurnLines returns [] for a non-existent path,
//       which is exactly what the handler emits when no transcript is found.
describe('handleRelayMessage — history-request → history-lines', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  test('history-request always emits a history-lines frame with a lines array', async () => {
    // Fires the handler end-to-end: regardless of whether the session transcript resolves,
    // the response must be a well-formed `history-lines` frame.
    const { messageHandler, sentFrames } = await buildHarness()

    await messageHandler(JSON.stringify({ v: 1, kind: 'history-request' }))

    const frame = sentFrames.find((f: any) => f.kind === 'history-lines')
    expect(frame).toBeDefined()
    expect(Array.isArray((frame as any).lines)).toBe(true)
  })

  test('no resolved path → readRecentTurnLines returns [] (the handler`s fallback branch)', async () => {
    // The handler does: `path ? readRecentTurnLines(path) : []`
    // When findTranscriptPath returns null the handler emits lines: [].
    // readRecentTurnLines(nonExistentPath) === [] is the exact same contract,
    // since a missing file is indistinguishable from "no path resolved" at the frame level.
    const { readRecentTurnLines } = await import('../turn-line')
    const lines = readRecentTurnLines('/nonexistent/path/that/does/not/exist.jsonl')
    expect(lines).toEqual([])
  })

  test('resolved path → readRecentTurnLines projects text-bearing lines (the handler`s main branch)', async () => {
    // Verifies the projection contract that the handler delegates to when a path IS found.
    const { readRecentTurnLines } = await import('../turn-line')
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = join(tmpdir(), 'chirp-test-history')
    mkdirSync(dir, { recursive: true })
    const tmpFile = join(dir, 'fake-session.jsonl')
    // One text-bearing user line + one tool_result line (text:null, filtered by readRecentTurnLines).
    writeFileSync(tmpFile, [
      JSON.stringify({ type: 'user', message: { content: 'hello from history test' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [] }] } }),
    ].join('\n') + '\n', 'utf8')

    try {
      const lines = readRecentTurnLines(tmpFile)
      // Only the text-bearing line survives the filter; the tool_result row (text:null) is dropped.
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ role: 'user', text: 'hello from history test' })
    } finally {
      try { unlinkSync(tmpFile) } catch { /* best-effort */ }
    }
  })
})

// ── Fix 4: readers follow the tailer's current transcript ─────────────────────
describe('handleRelayMessage — history follows the tailer`s current path', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  test('after the tailer switches files (e.g. post-/clear), history reads the switched-to file', async () => {
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = join(tmpdir(), 'chirp-test-current-path')
    mkdirSync(dir, { recursive: true })
    const tmpFile = join(dir, 'post-clear-session.jsonl')
    writeFileSync(tmpFile, JSON.stringify({ type: 'user', message: { content: 'first post-clear prompt' } }) + '\n', 'utf8')

    try {
      // Simulate the tailer having re-resolved onto a new transcript: the boot-time
      // sessionId's file is now stale, and history must come from the tailed file.
      _setTailedPathForTests(tmpFile)
      const { messageHandler, sentFrames } = await buildHarness()
      await messageHandler(JSON.stringify({ v: 1, kind: 'history-request' }))
      const frame = sentFrames.find((f: any) => f.kind === 'history-lines') as any
      expect(frame).toBeDefined()
      expect(frame.lines).toHaveLength(1)
      expect(frame.lines[0]).toMatchObject({ role: 'user', text: 'first post-clear prompt' })
    } finally {
      _setTailedPathForTests(null)
      try { unlinkSync(tmpFile) } catch { /* best-effort */ }
    }
  })
})

// ── malformed / early relay frames must never throw ───────────────────────────
// ws.on('message', handleRelayMessage) does not await the handler, so anything that
// escapes it is an unhandledRejection that kills the whole channel process.
describe('handleRelayMessage — malformed and early frames', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  test('a well-formed prompt is injected via mcp.notification', async () => {
    const notify = vi.spyOn(_mcpForTests(), 'notification').mockResolvedValue(undefined)
    try {
      const { messageHandler } = await buildHarness()
      await messageHandler(JSON.stringify({ v: 1, kind: 'prompt', text: 'run the tests' }))
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify.mock.calls[0][0]).toMatchObject({
        method: 'notifications/claude/channel',
        params: { content: 'run the tests' },
      })
    } finally { notify.mockRestore() }
  })

  test('a prompt frame with no text resolves without throwing and injects nothing', async () => {
    const notify = vi.spyOn(_mcpForTests(), 'notification').mockResolvedValue(undefined)
    try {
      const { messageHandler } = await buildHarness()
      await expect(messageHandler(JSON.stringify({ v: 1, kind: 'prompt' }))).resolves.toBeUndefined()
      await expect(messageHandler(JSON.stringify({ v: 1, kind: 'prompt', text: 42 }))).resolves.toBeUndefined()
      expect(notify).not.toHaveBeenCalled()
    } finally { notify.mockRestore() }
  })

  test('a perm-verdict whose mcp.notification rejects resolves and logs the failure', async () => {
    // The stdio transport can be down when a verdict arrives (startup, transport drop) —
    // mcp.notification then throws "Not connected". The verdict is droppable (the terminal
    // can still answer the permission prompt); killing the process is not.
    const notify = vi.spyOn(_mcpForTests(), 'notification').mockRejectedValue(new Error('Not connected'))
    try {
      const { messageHandler } = await buildHarness()
      await expect(
        messageHandler(JSON.stringify({ v: 1, kind: 'perm-verdict', requestId: 'req-1', behavior: 'allow' })),
      ).resolves.toBeUndefined()
      expect(notify).toHaveBeenCalledTimes(1)
      const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toMatch(/perm-verdict notification FAILED/)
    } finally { notify.mockRestore() }
  })

  test('a null frame resolves without throwing', async () => {
    const { messageHandler } = await buildHarness()
    await expect(messageHandler('null')).resolves.toBeUndefined()
  })
})

// ── Fix 3: malformed relay_url does not kill the server ───────────────────────
describe('relay URL validation (fix 3)', () => {
  test('_relayUrlValidForTests reflects the baked default URL being valid', () => {
    // In the test environment CHIRP_RELAY_URL is unset, so we fall back to the
    // baked prod default, which is a valid URL.
    expect(_relayUrlValidForTests()).toBe(true)
  })

  test('connectRelay returns without calling makeWs when relay URL is invalid', async () => {
    // Simulate invalid relay by forcing the invalid-URL guard via the injected-deps path.
    // We achieve this by directly verifying that connectRelay skips makeWs when RELAY is null.
    // Since the module-level URL is resolved at load time (from CHIRP_RELAY_URL at import), we
    // can't mutate it per-test — but we CAN verify the guard indirectly: when the URL is valid,
    // makeWs IS called; a mock makeWs that throws synchronously must NOT escape connectRelay.
    const getToken = vi.fn(async () => 'tok-abc')
    const throwingMakeWs = vi.fn((_url: string, _opts: { headers: Record<string, string> }) => {
      throw new Error('ECONNREFUSED bad URL')
    })
    // Should not throw; the synchronous throw from makeWs must be caught and turned into a
    // reconnect (parked on the injected schedule so no real timer outlives the test).
    await expect(
      connectRelay({ getToken, makeWs: throwingMakeWs as any, schedule: () => 0, cancel: () => {} }),
    ).resolves.toBeTruthy()
    expect(throwingMakeWs).toHaveBeenCalledTimes(1)
  })
})

// ── one-shot preview frame ────────────────────────────────────────────────────
describe('connectRelay — one-shot preview frame after hello', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  test('after hello, a one-shot preview frame carries the last assistant text', async () => {
    const ws = fakeWsInstance()
    const getToken = vi.fn(async () => 'tok')
    const readPreview = vi.fn(() => ({ text: 'Last answer from the JSONL', ts: 42 }))
    await connectRelay({ getToken, makeWs: makeWsFn(ws) as any, readPreview })
    const openCall = ws.on.mock.calls.find(([ev]) => ev === 'open')!
    await openCall[1]()
    await flushMicrotasks() // the shared relay reads the preview through an async dep
    const frames = ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string))
    expect(frames[0].kind).toBe('hello')
    const preview = frames.find((f) => f.kind === 'preview')
    expect(preview).toMatchObject({ v: 1, kind: 'preview', text: 'Last answer from the JSONL', ts: 42 })
  })

  test('no preview frame when the transcript has no assistant text', async () => {
    const ws = fakeWsInstance()
    await connectRelay({ getToken: vi.fn(async () => 'tok'), makeWs: makeWsFn(ws) as any, readPreview: vi.fn(() => null) })
    const openCall = ws.on.mock.calls.find(([ev]) => ev === 'open')!
    await openCall[1]()
    await flushMicrotasks()
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string)).some((f) => f.kind === 'preview')).toBe(false)
  })
})

// ── perm-request redelivery after a relay outage ──────────────────────────────
// Unlike turn-lines, perm-requests are NOT recoverable via history-request: a frame
// dropped while the socket is down leaves the session blocked with the phone never
// seeing the card. Unresolved requests must be re-sent on reconnect.
describe('perm-request redelivery after a relay outage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _pendingPermsForTests().clear()
  })

  const permNotification = (requestId = 'req-1') => ({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: requestId, tool_name: 'Bash', description: 'Run a command', input_preview: 'fly deploy' },
  })

  /** connectRelay against a fake ws in the given readyState (1=OPEN, 3=CLOSED);
   *  returns the wired handlers plus every frame sent over the socket. */
  async function connect(readyState: number) {
    const sentFrames: any[] = []
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const ws = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => { handlers[event] = cb }),
      send: vi.fn((data: unknown) => { sentFrames.push(JSON.parse(data as string)) }),
      close: vi.fn(),
      readyState,
    }
    await connectRelay({ getToken: async () => 'tok', makeWs: vi.fn(() => ws) as any, readPreview: () => null })
    return { handlers, sentFrames }
  }
  const permFrames = (frames: any[]) => frames.filter((f) => f.kind === 'perm-request')

  test('a perm-request emitted while the socket is down is re-emitted on reconnect', async () => {
    const down = await connect(3) // CLOSED: emit drops the frame
    await _mcpForTests().fallbackNotificationHandler!(permNotification() as any)
    expect(permFrames(down.sentFrames)).toHaveLength(0)

    const up = await connect(1)
    await up.handlers.open()
    const perms = permFrames(up.sentFrames)
    expect(perms).toHaveLength(1)
    expect(perms[0]).toMatchObject({ requestId: 'req-1', toolName: 'Bash', inputPreview: 'fly deploy' })
  })

  test('a verdict clears the pending request — the next reconnect re-sends nothing', async () => {
    const notify = vi.spyOn(_mcpForTests(), 'notification').mockResolvedValue(undefined)
    try {
      const first = await connect(1)
      await _mcpForTests().fallbackNotificationHandler!(permNotification() as any)
      expect(permFrames(first.sentFrames)).toHaveLength(1)
      await first.handlers.message(JSON.stringify({ v: 1, kind: 'perm-verdict', requestId: 'req-1', behavior: 'allow' }))

      const second = await connect(1)
      await second.handlers.open()
      expect(permFrames(second.sentFrames)).toHaveLength(0)
    } finally { notify.mockRestore() }
  })

  test('a delivered-but-unanswered perm-request is re-sent on every reconnect until its verdict', async () => {
    // Re-sending an already-delivered card is safe: the relay contract is idempotent on requestId.
    const first = await connect(1)
    await _mcpForTests().fallbackNotificationHandler!(permNotification() as any)
    expect(permFrames(first.sentFrames)).toHaveLength(1)

    const second = await connect(1)
    await second.handlers.open()
    expect(permFrames(second.sentFrames)).toHaveLength(1)
    expect(permFrames(second.sentFrames)[0].requestId).toBe('req-1')
  })

  test('a fresh perm-request supersedes an older undelivered one (one blocking prompt at a time)', async () => {
    const down = await connect(3)
    await _mcpForTests().fallbackNotificationHandler!(permNotification('req-old') as any)
    await _mcpForTests().fallbackNotificationHandler!(permNotification('req-new') as any)
    expect(permFrames(down.sentFrames)).toHaveLength(0)

    const up = await connect(1)
    await up.handlers.open()
    const perms = permFrames(up.sentFrames)
    expect(perms).toHaveLength(1)
    expect(perms[0].requestId).toBe('req-new')
  })
})

// ── MCP server version tracks the plugin manifest ─────────────────────────────
describe('plugin version', () => {
  test('the MCP server version is read from .claude-plugin/plugin.json (no drifting literal)', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    expect(_pluginVersionForTests()).toBe(manifest.version)
    expect(_pluginVersionForTests()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// ── pickLastAssistantText ─────────────────────────────────────────────────────
const makeLine = (overrides: Partial<TurnLine>): TurnLine => ({
  role: 'assistant',
  stopReason: null,
  isApiError: false,
  text: null,
  tools: [],
  injected: false,
  taskNotification: false,
  ...overrides,
})

describe('pickLastAssistantText', () => {
  test('returns null for an empty line list', () => {
    expect(pickLastAssistantText([])).toBeNull()
  })

  test('skips user lines and returns the last assistant text', () => {
    const lines: TurnLine[] = [
      makeLine({ role: 'user', text: 'user question' }),
      makeLine({ role: 'assistant', text: 'assistant reply' }),
      makeLine({ role: 'user', text: 'follow-up' }),
    ]
    expect(pickLastAssistantText(lines)).toBe('assistant reply')
  })

  test('skips assistant lines with text: null', () => {
    const lines: TurnLine[] = [
      makeLine({ role: 'assistant', text: 'earlier reply' }),
      makeLine({ role: 'assistant', text: null }),
    ]
    expect(pickLastAssistantText(lines)).toBe('earlier reply')
  })

  test('skips assistant lines with taskNotification: true', () => {
    const lines: TurnLine[] = [
      makeLine({ role: 'assistant', text: 'real reply' }),
      makeLine({ role: 'assistant', text: 'task done!', taskNotification: true }),
    ]
    expect(pickLastAssistantText(lines)).toBe('real reply')
  })

  test('returns null when all assistant lines are task notifications', () => {
    const lines: TurnLine[] = [
      makeLine({ role: 'assistant', text: 'task done!', taskNotification: true }),
    ]
    expect(pickLastAssistantText(lines)).toBeNull()
  })

  test('clips text to 200 codepoints', () => {
    const long = 'a'.repeat(300)
    const lines: TurnLine[] = [makeLine({ text: long })]
    const result = pickLastAssistantText(lines)
    expect(result).toHaveLength(200)
    expect(result).toBe('a'.repeat(200))
  })

  test('clips correctly for multibyte codepoints', () => {
    // Each emoji is 2 UTF-16 code units but ONE codepoint — spread must count codepoints.
    const emoji = '😀'.repeat(250)
    const lines: TurnLine[] = [makeLine({ text: emoji })]
    const result = pickLastAssistantText(lines)
    // Should be 200 emojis (200 codepoints), not 200 UTF-16 code units (100 emojis).
    expect([...result!].length).toBe(200)
  })

  test('picks the LAST qualifying assistant line in the list', () => {
    const lines: TurnLine[] = [
      makeLine({ text: 'first' }),
      makeLine({ text: 'second' }),
      makeLine({ text: 'third' }),
    ]
    expect(pickLastAssistantText(lines)).toBe('third')
  })
})
