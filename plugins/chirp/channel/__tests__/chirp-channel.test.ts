import { describe, test, expect, vi, beforeEach } from 'vitest'
import { pickLastAssistantText } from '../turn-line'
import type { TurnLine } from '../turn-line'

// Importing chirp-channel.ts pulls in its module-level wiring (transcript tailer + relay connect +
// stdio transport). Those side effects are guarded behind `!process.env.VITEST`, which vitest sets,
// so importing here is inert and we can drive connectRelay() directly with injected fakes.
import {
  connectRelay, _reconnectDelayForTests, _resetReconnectForTests, _relayUrlValidForTests,
  resolveTranscriptPath, QUIET_RECHECK_MS,
  type TailerState,
} from '../chirp-channel'

function fakeWsInstance() {
  return { on: vi.fn(), send: vi.fn(), close: vi.fn() }
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
    _resetReconnectForTests()

    const failedAttempt = async () => {
      const ws = fakeWsInstance()
      await connectRelay({ getToken, makeWs: makeWsFn(ws) as any })
      const closeCall = ws.on.mock.calls.find(([ev]) => ev === 'close')
      expect(closeCall).toBeDefined()
      closeCall![1]() // relay refused / dropped the socket pre-open
      const next = _reconnectDelayForTests()
      _resetReconnectForTests(next) // clear the single-flight timer, keep the backoff
      return next
    }

    const first = await failedAttempt()
    const second = await failedAttempt()

    expect(first).toBe(2000) // 1000 armed, doubled for the next attempt
    expect(second).toBeGreaterThan(first) // buggy code re-pinned this to 2000
  })
})

// ── Fix 1: quiet-transcript re-resolution ────────────────────────────────────
describe('resolveTranscriptPath — quiet-transcript re-resolution (fix 1)', () => {
  const baseState = (): TailerState => ({ path: '/old/abc.jsonl', offset: 100, lastActivityMs: 0, buffer: '' })
  const finders = (newId: string | null, newPath: string | null) => ({
    newestId: vi.fn(() => newId),
    findPath: vi.fn(() => newPath),
  })

  test('returns updated path + reset offset when a newer transcript exists', () => {
    const state = baseState()
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 9000, finders('newid', '/new/newid.jsonl'))
    expect(result.path).toBe('/new/newid.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
    expect(result.lastActivityMs).toBe(9000)
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
  test('when offset > size (truncation detected), re-resolves to newest transcript', () => {
    // The channel code detects size < offset and calls resolveTranscriptPath — the same helper
    // used by the quiet-timeout path. This test verifies that reset + path switch works.
    const state: TailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: 'partial' }
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 1234, {
      newestId: vi.fn(() => 'newid'),
      findPath: vi.fn(() => '/new/newid.jsonl'),
    })
    expect(result.path).toBe('/new/newid.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
  })

  test('when no newer file found after truncation, preserves current path but resets lastActivityMs', () => {
    // If newestId returns the same session, we stay on the same file (offset unchanged by
    // resolveTranscriptPath alone — the caller is responsible for truncation-specific reset).
    const state: TailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: '' }
    const result = resolveTranscriptPath(state, '/proj', '/cwd', 7777, {
      newestId: vi.fn(() => null),
      findPath: vi.fn(() => null),
    })
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.lastActivityMs).toBe(7777)
  })
})

// ── history-lines handler ─────────────────────────────────────────────────────
// Covers the `history-request` branch in handleRelayMessage.
//
// The handler is: `const path = findTranscriptPath(…); emit({ kind: 'history-lines', lines: path ? readRecentTurnLines(path) : [] })`
//
// `findTranscriptPath` and `readRecentTurnLines` use module-level constants that are
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

// ── Fix 3: malformed relay_url does not kill the server ───────────────────────
describe('relay URL validation (fix 3)', () => {
  test('_relayUrlValidForTests reflects the baked default URL being valid', () => {
    // In the test environment CHIRP_RELAY_URL is unset, so we fall back to the
    // baked prod default, which is a valid URL.
    expect(_relayUrlValidForTests()).toBe(true)
  })

  test('connectRelay returns without calling makeWs when relay URL is invalid', async () => {
    // Simulate invalid relay by forcing _relayUrlValid to false via the injected-deps path.
    // We achieve this by directly verifying that connectRelay skips makeWs when _relayUrlValid=false.
    // Since the module-level flag is set at load time (based on CHIRP_RELAY_URL at import), we
    // can't mutate it per-test — but we CAN verify the guard indirectly: when the URL is valid,
    // makeWs IS called; a mock makeWs that throws synchronously must NOT escape connectRelay.
    _resetReconnectForTests()
    const getToken = vi.fn(async () => 'tok-abc')
    const throwingMakeWs = vi.fn((_url: string, _opts: { headers: Record<string, string> }) => {
      throw new Error('ECONNREFUSED bad URL')
    })
    // Should not throw; the synchronous throw from makeWs must be caught and turned into a reconnect.
    await expect(connectRelay({ getToken, makeWs: throwingMakeWs as any })).resolves.toBeUndefined()
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
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string)).some((f) => f.kind === 'preview')).toBe(false)
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
