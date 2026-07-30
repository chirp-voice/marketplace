import { describe, test, expect } from 'vitest'
import { formatLabel } from '../label'

describe('formatLabel', () => {
  test('CHIRP_SESSION_LABEL override wins (even when repo/branch are present)', () => {
    expect(formatLabel({ override: 'my session', repoRoot: '/Users/x/chirp', branch: 'main', cwd: '/tmp' })).toBe(
      'my session',
    )
  })

  test('repo root + branch → "<basename> · <branch>"', () => {
    expect(formatLabel({ repoRoot: '/Users/x/chirp', branch: 'main', cwd: '/tmp' })).toBe('chirp · main')
    expect(formatLabel({ repoRoot: '/Users/x/chirp', branch: 'feat/voice-interrupt', cwd: '/tmp' })).toBe(
      'chirp · feat/voice-interrupt',
    )
  })

  test('detached HEAD (branch "HEAD") → repo basename alone', () => {
    expect(formatLabel({ repoRoot: '/Users/x/chirp', branch: 'HEAD', cwd: '/tmp' })).toBe('chirp')
  })

  test('repo root with null / empty branch → repo basename alone', () => {
    expect(formatLabel({ repoRoot: '/Users/x/chirp', branch: null, cwd: '/tmp' })).toBe('chirp')
    expect(formatLabel({ repoRoot: '/Users/x/chirp', branch: '', cwd: '/tmp' })).toBe('chirp')
  })

  test('no repo root, projectDir set → basename(projectDir)', () => {
    expect(formatLabel({ repoRoot: null, projectDir: '/Users/x/some-proj', cwd: '/tmp' })).toBe('some-proj')
  })

  test('no repo root, no projectDir → basename(cwd)', () => {
    expect(formatLabel({ repoRoot: null, cwd: '/Users/x/host-agent' })).toBe('host-agent')
  })
})
