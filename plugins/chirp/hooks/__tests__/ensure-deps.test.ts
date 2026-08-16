import { describe, test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../ensure-deps.sh', import.meta.url))

/** A fake `npm` on PATH: records that it ran (marker in cwd) and simulates an install. */
function fakeNpmBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'chirp-fakebin-'))
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\ntouch "$(pwd)/.npm-was-called"\nmkdir -p node_modules\nexit 0\n')
  chmodSync(join(bin, 'npm'), 0o755)
  return bin
}

/** A fake `npm` that records it ran and fails the install. */
function failingNpmBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'chirp-fakebin-fail-'))
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\ntouch "$(pwd)/.npm-was-called"\nexit 1\n')
  chmodSync(join(bin, 'npm'), 0o755)
  return bin
}

describe('ensure-deps.sh', () => {
  test('no-op when node_modules already exists (does not invoke npm)', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-deps-have-'))
    const bin = fakeNpmBin()
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    try {
      execFileSync('bash', [script], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      expect(existsSync(join(root, '.npm-was-called'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('installs deps when node_modules is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-deps-missing-'))
    const bin = fakeNpmBin()
    try {
      execFileSync('bash', [script], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      expect(existsSync(join(root, '.npm-was-called'))).toBe(true)
      expect(existsSync(join(root, 'node_modules'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('a failed install emits a JSON systemMessage on stdout (plain stderr is invisible)', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-deps-fail-'))
    const bin = failingNpmBin()
    try {
      const stdout = execFileSync('bash', [script], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      const parsed = JSON.parse(stdout)
      expect(parsed.systemMessage).toMatch(/install failed/)
      expect(parsed.systemMessage).toContain(root) // tells the user where to run npm install
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('the install lock is released on exit', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-deps-lock-'))
    const bin = fakeNpmBin()
    try {
      execFileSync('bash', [script], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      expect(existsSync(join(root, '.chirp-deps.lock'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('lock held: waits for the other install, then proceeds cleanly once deps exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-deps-wait-'))
    const bin = fakeNpmBin()
    mkdirSync(join(root, '.chirp-deps.lock'))
    try {
      // Simulate the concurrent session finishing its install: deps appear, lock clears.
      const stdout = execFileSync(
        'bash',
        ['-c', `(sleep 0.3; mkdir -p "$1/node_modules"; rmdir "$1/.chirp-deps.lock") & exec bash "$0"`, script, root],
        {
          env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}`, CHIRP_DEPS_LOCK_TIMEOUT: '5' },
          encoding: 'utf8',
        },
      )
      expect(stdout).toBe('') // no failure message
      expect(existsSync(join(root, '.npm-was-called'))).toBe(false) // never ran its own install
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('lock held past the timeout with no deps: emits the failure message, never runs npm', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-deps-stale-'))
    const bin = fakeNpmBin()
    mkdirSync(join(root, '.chirp-deps.lock'))
    try {
      const stdout = execFileSync('bash', [script], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}`, CHIRP_DEPS_LOCK_TIMEOUT: '1' },
        encoding: 'utf8',
      })
      expect(JSON.parse(stdout).systemMessage).toMatch(/install failed/)
      expect(existsSync(join(root, '.npm-was-called'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
