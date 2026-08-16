import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { pkcePair, parseTokenResponse, needsRefresh, identityFromToken, oauthConfig, loginInteractive } from '../pkce-login'

// The dev shell exports CLERK_OAUTH_* (the developer's ~/.zshrc). Run the whole file in a
// known env — deleted by default, restored after — so config-dependent assertions are
// deterministic regardless of the ambient shell.
const OAUTH_ENV_KEYS = ['CLERK_OAUTH_BASE', 'CLERK_OAUTH_CLIENT_ID', 'CLERK_OAUTH_CLIENT_SECRET'] as const
let savedOAuthEnv: Record<string, string | undefined>
beforeEach(() => {
  savedOAuthEnv = Object.fromEntries(OAUTH_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of OAUTH_ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of OAUTH_ENV_KEYS) {
    if (savedOAuthEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedOAuthEnv[k]
  }
})

describe('pkcePair', () => {
  test('challenge is base64url(sha256(verifier))', () => {
    const { verifier, challenge } = pkcePair()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
  })
})

describe('parseTokenResponse', () => {
  test('extracts access + refresh + computes absolute expiry', () => {
    const r = parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 100 }, 1_000_000)
    expect(r).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 1_100_000 })
  })
  test('keeps the prior refresh token if the response omits one', () => {
    const r = parseTokenResponse({ access_token: 'a2', expires_in: 50 }, 2_000_000, 'oldR')
    expect(r.refreshToken).toBe('oldR')
  })
  // Fix 4: NaN guard — missing/invalid expires_in falls back to 5-min TTL
  test('missing expires_in uses the 5-min default TTL instead of producing NaN', () => {
    const nowMs = 1_000_000
    const r = parseTokenResponse({ access_token: 'a', refresh_token: 'r' }, nowMs)
    expect(Number.isFinite(r.expiresAt)).toBe(true)
    // 5 min TTL: expiresAt should be nowMs + 300_000
    expect(r.expiresAt).toBe(nowMs + 5 * 60 * 1000)
  })
  test('non-numeric expires_in also uses the 5-min default TTL', () => {
    const nowMs = 2_000_000
    const r = parseTokenResponse({ access_token: 'a', expires_in: 'bogus' }, nowMs)
    expect(Number.isFinite(r.expiresAt)).toBe(true)
    expect(r.expiresAt).toBe(nowMs + 5 * 60 * 1000)
  })
})

describe('needsRefresh', () => {
  test('true when within the 60s skew window of expiry', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: 1_030_000 }, 1_000_000)).toBe(true)
  })
  test('false when comfortably valid', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: 10_000_000 }, 1_000_000)).toBe(false)
  })
  test('true when there is no token at all', () => {
    expect(needsRefresh(null, 1_000_000)).toBe(true)
  })
  // Fix 4: NaN expiresAt guard
  test('true when expiresAt is NaN (persisted before the isFinite guard)', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NaN }, 1_000_000)).toBe(true)
  })
})

describe('identityFromToken', () => {
  const tok = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
  test('returns email + sub when present', () => {
    expect(identityFromToken(tok({ email: 'a@b.com', sub: 'user_1' }))).toEqual({ email: 'a@b.com', sub: 'user_1' })
  })
  test('returns sub only when email absent', () => {
    expect(identityFromToken(tok({ sub: 'user_1' }))).toEqual({ sub: 'user_1' })
  })
  test('garbage string -> {}', () => {
    expect(identityFromToken('not-a-jwt')).toEqual({})
  })
  test('ignores non-string email/sub fields', () => {
    expect(identityFromToken(tok({ email: null, sub: 123 }))).toEqual({})
  })
})

describe('oauthConfig', () => {
  test('falls back to the baked prod public client when env is unset', () => {
    const c = oauthConfig()
    expect(c.base).toBe('https://clerk.chirp.dev')
    expect(c.clientId).toBe('c482BsIXruDDieiw')
    expect(c.clientSecret).toBeUndefined()
  })

  test('env values override the baked defaults', () => {
    process.env.CLERK_OAUTH_BASE = 'https://ample-malamute-27.clerk.accounts.dev'
    process.env.CLERK_OAUTH_CLIENT_ID = 'bZpgv6l1lY3iWAEO'
    process.env.CLERK_OAUTH_CLIENT_SECRET = 'shhh'
    const c = oauthConfig()
    expect(c.base).toBe('https://ample-malamute-27.clerk.accounts.dev')
    expect(c.clientId).toBe('bZpgv6l1lY3iWAEO')
    expect(c.clientSecret).toBe('shhh')
  })

  test('throws a clear error when the base is not an http(s) URL', () => {
    process.env.CLERK_OAUTH_BASE = 'clerk.chirp.dev' // missing scheme
    expect(() => oauthConfig()).toThrow(/http\(s\) URL/)
  })
})

describe('loginInteractive', () => {
  test('rejects with a timeout instead of hanging when the callback never arrives', async () => {
    // port 0 = ephemeral (no clash with a real 53682 flow); no-op open = no browser.
    // The guidance must stay surface-neutral: this file is shared byte-identical by the
    // Claude Code plugin, the OpenClaw plugin, and the host CLI.
    await expect(
      loginInteractive({ port: 0, timeoutMs: 20, open: () => {} }),
    ).rejects.toThrow(/timed out.*in Claude Code: \/chirp-auth/)
  })
})
