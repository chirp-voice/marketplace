import { describe, test, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// CRED_DIR/CRED_FILE are derived from homedir() at module load, so point HOME at a temp
// dir BEFORE importing — these tests must never touch the developer's real ~/.chirp.
const fakeHome = mkdtempSync(join(tmpdir(), 'chirp-pkce-home-'))
const realHome = process.env.HOME
process.env.HOME = fakeHome
const { save, loadCreds, getAccessToken } = await import('../pkce-login')
if (realHome === undefined) delete process.env.HOME
else process.env.HOME = realHome // the module captured its paths at import; restore for other suites

const CRED_DIR = join(fakeHome, '.chirp')
const CRED_FILE = join(CRED_DIR, 'credentials.json')

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('save', () => {
  test('round-trips creds, keeps 0600, and leaves no temp-file debris', () => {
    const c = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 }
    save(c)
    expect(loadCreds()).toEqual(c)
    expect(statSync(CRED_FILE).mode & 0o777).toBe(0o600)
    // The write-then-rename must not strand partially written temp files next to the creds.
    expect(readdirSync(CRED_DIR)).toEqual(['credentials.json'])
  })
})

describe('getAccessToken — concurrent refresh race', () => {
  test('a failed refresh re-reads creds another process wrote meanwhile', async () => {
    save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() - 1000 })
    const fresh = { accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 }
    const fetchMock = vi.fn(async () => {
      // The other process wins the race and writes fresh creds before our exchange
      // resolves; refresh tokens rotate, so our own exchange comes back an error.
      writeFileSync(CRED_FILE, JSON.stringify(fresh))
      return { json: async () => ({ error: 'invalid_grant' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(getAccessToken()).resolves.toBe('fresh')
      // The failure path must not clobber the newer file.
      expect(loadCreds()).toEqual(fresh)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('still returns null (after logging) when no other process refreshed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() - 1000 })
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ error: 'invalid_grant' }) }) as unknown as Response))
    try {
      await expect(getAccessToken()).resolves.toBeNull()
      expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/token refresh failed/)
    } finally {
      vi.unstubAllGlobals()
      err.mockRestore()
    }
  })
})

describe('exchange timeout', () => {
  test('the token exchange carries an abort signal so a hung endpoint cannot wedge startup', async () => {
    save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: 0 })
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return { json: async () => ({ access_token: 'n', refresh_token: 'r2', expires_in: 3600 }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(getAccessToken()).resolves.toBe('n')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
