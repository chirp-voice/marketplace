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
})
