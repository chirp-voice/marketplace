import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEffortLevel } from '../effort.js'

function makeDirs() {
  const home = mkdtempSync(join(tmpdir(), 'chirp-effort-home-'))
  const project = mkdtempSync(join(tmpdir(), 'chirp-effort-proj-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(project, '.claude'), { recursive: true })
  return { home, project }
}

describe('readEffortLevel', () => {
  it('returns null when no settings files exist', () => {
    const { home, project } = makeDirs()
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBeNull()
  })

  it('reads effortLevel from user ~/.claude/settings.json as fallback', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high' }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBe('high')
  })

  it('project settings.json overrides user settings.json', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low' }))
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'medium' }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBe('medium')
  })

  it('project settings.local.json takes precedence over all others', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low' }))
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'medium' }))
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ effortLevel: 'max' }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBe('max')
  })

  it('skips a file when effortLevel is not set in it', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ someOtherKey: 'value' }))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'normal' }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBe('normal')
  })

  it('returns null when effortLevel is not a string', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 42 }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBeNull()
  })

  it('returns null when effortLevel is an empty string', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: '' }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBeNull()
  })

  it('skips malformed JSON and falls through to next candidate', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(project, '.claude', 'settings.json'), '{not valid json')
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'normal' }))
    expect(readEffortLevel({ HOME: home, CLAUDE_PROJECT_DIR: project }, project)).toBe('normal')
  })

  it('uses cwd as projectDir fallback when CLAUDE_PROJECT_DIR is unset', () => {
    const { home, project } = makeDirs()
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low' }))
    // no CLAUDE_PROJECT_DIR in env → should use cwd arg
    expect(readEffortLevel({ HOME: home }, project)).toBe('low')
  })
})
