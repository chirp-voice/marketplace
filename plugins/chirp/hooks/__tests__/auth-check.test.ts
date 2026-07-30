import { describe, test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../auth-check.sh', import.meta.url))

function run(home: string): string {
  return execFileSync('bash', [script], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
}

/** Write ~/.chirp/credentials.json under `home` with the given raw JSON. */
function writeCreds(home: string, json: string): void {
  mkdirSync(join(home, '.chirp'), { recursive: true })
  writeFileSync(join(home, '.chirp', 'credentials.json'), json)
}

/**
 * A SessionStart hook only surfaces a message to the USER when it emits JSON with a
 * `systemMessage` (plain stdout is swallowed into model context). Parse + assert that shape.
 */
function expectVisibleNudge(out: string): void {
  const parsed = JSON.parse(out)
  expect(parsed.systemMessage).toContain('/chirp-auth')
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart')
}

describe('auth-check.sh', () => {
  test('emits a visible /chirp-auth nudge when there is no credentials file', () => {
    const home = mkdtempSync(join(tmpdir(), 'chirp-noauth-'))
    try {
      expectVisibleNudge(run(home))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('stays silent when a credential with a refresh token exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'chirp-auth-'))
    writeCreds(home, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 9_999_999_999_999 }))
    try {
      expect(run(home).trim()).toBe('')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('emits a visible /chirp-auth nudge when the credential has no usable refresh token', () => {
    const home = mkdtempSync(join(tmpdir(), 'chirp-stale-'))
    writeCreds(home, JSON.stringify({ accessToken: 'a', refreshToken: '', expiresAt: 1 }))
    try {
      expectVisibleNudge(run(home))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('emits a visible /chirp-auth nudge when the credential file is an empty object', () => {
    const home = mkdtempSync(join(tmpdir(), 'chirp-empty-'))
    writeCreds(home, '{}')
    try {
      expectVisibleNudge(run(home))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
