import { describe, test, expect } from 'vitest'
import { parseAuthCommand, CHANNEL_LAUNCH_HINT } from '../chirp-auth'

describe('parseAuthCommand', () => {
  test('no args -> login', () => { expect(parseAuthCommand([])).toBe('login') })
  test('unknown arg -> login', () => { expect(parseAuthCommand(['foo'])).toBe('login') })
  test('--status -> status', () => { expect(parseAuthCommand(['--status'])).toBe('status') })
  test('--logout -> logout', () => { expect(parseAuthCommand(['--logout'])).toBe('logout') })
  test('--status wins over --logout', () => { expect(parseAuthCommand(['--logout', '--status'])).toBe('status') })
})

describe('CHANNEL_LAUNCH_HINT', () => {
  test('tells you how to launch a session with the channel activated', () => {
    expect(CHANNEL_LAUNCH_HINT).toContain('claude --channels chirp')
  })
})
