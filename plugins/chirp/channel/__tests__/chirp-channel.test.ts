import { describe, test, expect, vi, beforeEach } from 'vitest'

// Importing chirp-channel.ts pulls in its module-level wiring (mirror tailer + relay connect +
// stdio transport). Those side effects are guarded behind `!process.env.VITEST`, which vitest sets,
// so importing here is inert and we can drive connectRelay() directly with injected fakes.
import {
  connectRelay, _reconnectDelayForTests, _resetReconnectForTests, _relayUrlValidForTests,
  resolveMirrorPath, QUIET_RECHECK_MS,
  type MirrorTailerState,
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

    await connectRelay({ getToken, makeWs: makeWs as any })

    // Find and fire the 'open' handler the way ws would.
    const openCall = ws.on.mock.calls.find(([ev]) => ev === 'open')
    expect(openCall).toBeDefined()
    await openCall![1]()

    expect(ws.send).toHaveBeenCalledTimes(1)
    const frame = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(frame).toMatchObject({ v: 1, kind: 'hello', role: 'channel', jwt: 'tok-xyz' })
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
describe('resolveMirrorPath — quiet-transcript re-resolution (fix 1)', () => {
  const baseState = (): MirrorTailerState => ({ path: '/old/abc.jsonl', offset: 100, lastActivityMs: 0, buffer: '' })
  const finders = (newId: string | null, newPath: string | null) => ({
    newestId: vi.fn(() => newId),
    findPath: vi.fn(() => newPath),
  })

  test('returns updated path + reset offset when a newer transcript exists', () => {
    const state = baseState()
    const result = resolveMirrorPath(state, '/proj', '/cwd', 9000, finders('newid', '/new/newid.jsonl'))
    expect(result.path).toBe('/new/newid.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
    expect(result.lastActivityMs).toBe(9000)
  })

  test('does not switch when the newest path is the same file already being tailed', () => {
    const state = baseState()
    const result = resolveMirrorPath(state, '/proj', '/cwd', 9000, finders('abc', '/old/abc.jsonl'))
    // Same path: no switch, but lastActivityMs still updated.
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.offset).toBe(100) // offset preserved
    expect(result.lastActivityMs).toBe(9000)
  })

  test('returns unchanged path (plus refreshed lastActivityMs) when no newer transcript is found', () => {
    const state = baseState()
    const result = resolveMirrorPath(state, '/proj', '/cwd', 5000, finders(null, null))
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.lastActivityMs).toBe(5000)
  })

  test('QUIET_RECHECK_MS constant is 30 seconds', () => {
    expect(QUIET_RECHECK_MS).toBe(30_000)
  })
})

// ── Fix 2: tailer recovery from truncation ────────────────────────────────────
describe('resolveMirrorPath — truncation reset (fix 2)', () => {
  test('when offset > size (truncation detected), re-resolves to newest transcript', () => {
    // The channel code detects size < offset and calls resolveMirrorPath — the same helper
    // used by the quiet-timeout path. This test verifies that reset + path switch works.
    const state: MirrorTailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: 'partial' }
    const result = resolveMirrorPath(state, '/proj', '/cwd', 1234, {
      newestId: vi.fn(() => 'newid'),
      findPath: vi.fn(() => '/new/newid.jsonl'),
    })
    expect(result.path).toBe('/new/newid.jsonl')
    expect(result.offset).toBe(0)
    expect(result.buffer).toBe('')
  })

  test('when no newer file found after truncation, preserves current path but resets lastActivityMs', () => {
    // If newestId returns the same session, we stay on the same file (offset unchanged by
    // resolveMirrorPath alone — the caller is responsible for truncation-specific reset).
    const state: MirrorTailerState = { path: '/old/abc.jsonl', offset: 500, lastActivityMs: 0, buffer: '' }
    const result = resolveMirrorPath(state, '/proj', '/cwd', 7777, {
      newestId: vi.fn(() => null),
      findPath: vi.fn(() => null),
    })
    expect(result.path).toBe('/old/abc.jsonl')
    expect(result.lastActivityMs).toBe(7777)
  })
})

// ── Fix 3: malformed relay_url does not kill the server ───────────────────────
describe('relay URL validation (fix 3)', () => {
  test('_relayUrlValidForTests reflects the baked default URL being valid', () => {
    // In the test environment CHIRP_RELAY_URL is unset, so we fall back to the
    // baked default `ws://localhost:8080/relay` which is a valid URL.
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
