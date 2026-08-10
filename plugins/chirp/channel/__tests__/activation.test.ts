import { describe, it, expect } from 'vitest'
import { parseProcTable, findClaudeAncestor, parseChannelArgs, activatesChirp, detectControllable } from '../activation.js'

describe('parseProcTable', () => {
  it('parses pid/ppid/args triples', () => {
    const rows = parseProcTable('  100   1 claude --channels plugin:chirp@chirp-voice\n  200 100 node /x/y.ts\n')
    expect(rows).toEqual([
      { pid: 100, ppid: 1, args: 'claude --channels plugin:chirp@chirp-voice' },
      { pid: 200, ppid: 100, args: 'node /x/y.ts' },
    ])
  })
  it('ignores malformed lines', () => {
    expect(parseProcTable('garbage\n\n  5 6 ok\n')).toEqual([{ pid: 5, ppid: 6, args: 'ok' }])
  })
})

describe('findClaudeAncestor', () => {
  const rows = [
    { pid: 400, ppid: 300, args: '/opt/node --require /x/preflight.cjs /p/chirp-channel.ts' },
    { pid: 300, ppid: 200, args: 'node /x/.bin/tsx /p/chirp-channel.ts' },
    { pid: 200, ppid: 100, args: 'npm exec tsx /p/chirp-channel.ts' },
    { pid: 100, ppid: 1, args: 'claude --channels plugin:chirp@chirp-voice' },
  ]
  it('walks up to the claude process', () => {
    expect(findClaudeAncestor(rows, 400)?.pid).toBe(100)
  })
  it('returns null when there is no claude ancestor', () => {
    expect(findClaudeAncestor(rows.slice(0, 3), 400)).toBeNull()
  })
  it('does not match a path that merely contains claude', () => {
    const r = [{ pid: 9, ppid: 1, args: 'node /Users/j/.claude/plugins/thing.js' }]
    expect(findClaudeAncestor(r, 9)).toBeNull()
  })
  it('terminates on a ppid cycle', () => {
    const r = [{ pid: 1, ppid: 2, args: 'a' }, { pid: 2, ppid: 1, args: 'b' }]
    expect(findClaudeAncestor(r, 1)).toBeNull()
  })
})

describe('parseChannelArgs', () => {
  it('returns [] for a bare claude', () => {
    expect(parseChannelArgs('claude')).toEqual([])
  })
  it('reads the variadic --channels list', () => {
    expect(parseChannelArgs('claude --channels plugin:chirp@chirp-voice plugin:x@y'))
      .toEqual(['plugin:chirp@chirp-voice', 'plugin:x@y'])
  })
  it('stops the variadic list at the next flag', () => {
    expect(parseChannelArgs('claude --channels plugin:chirp@chirp-voice --verbose'))
      .toEqual(['plugin:chirp@chirp-voice'])
  })
  it('reads the development-channels flag too', () => {
    expect(parseChannelArgs('claude --dangerously-load-development-channels plugin:chirp@chirp-plugin'))
      .toEqual(['plugin:chirp@chirp-plugin'])
  })
  it('ignores --channels appearing inside a later argument value', () => {
    expect(parseChannelArgs('claude -p "explain --channels to me"')).toEqual([])
  })
})

describe('activatesChirp', () => {
  it('matches the plugin form regardless of marketplace', () => {
    expect(activatesChirp(['plugin:chirp@chirp-voice'])).toBe(true)
    expect(activatesChirp(['plugin:chirp@chirp-plugin'])).toBe(true)
  })
  it('rejects a different plugin', () => {
    expect(activatesChirp(['plugin:telegram@claude-plugins-official'])).toBe(false)
  })
  it('accepts a bare server-name entry mentioning the channel (fail open)', () => {
    expect(activatesChirp(['chirp-channel'])).toBe(true)
  })
  it('is false for an empty list', () => {
    expect(activatesChirp([])).toBe(false)
  })
})

describe('detectControllable (fail open)', () => {
  const table = [
    '  400 300 /opt/node --require /x/preflight.cjs /p/chirp-channel.ts',
    '  300 200 node /x/.bin/tsx /p/chirp-channel.ts',
    '  200 100 npm exec tsx /p/chirp-channel.ts',
  ]
  const withClaude = (claudeArgs: string) => [...table, `  100 1 ${claudeArgs}`].join('\n')

  it('is true off darwin even when the parent has no --channels', () => {
    expect(detectControllable({ platform: 'linux', pid: 400, readProcTable: () => withClaude('claude') })).toBe(true)
  })
  it('is true when ps throws', () => {
    expect(detectControllable({ platform: 'darwin', pid: 400, readProcTable: () => { throw new Error('nope') } })).toBe(true)
  })
  it('is true when no claude ancestor is found', () => {
    expect(detectControllable({ platform: 'darwin', pid: 400, readProcTable: () => table.join('\n') })).toBe(true)
  })
  it('is FALSE for a bare claude parent — the bug this fixes', () => {
    expect(detectControllable({ platform: 'darwin', pid: 400, readProcTable: () => withClaude('claude') })).toBe(false)
  })
  it('is true when the parent activates the chirp channel', () => {
    expect(detectControllable({ platform: 'darwin', pid: 400, readProcTable: () => withClaude('claude --channels plugin:chirp@chirp-voice') })).toBe(true)
  })
  it('is true for the development-channels dev form', () => {
    expect(detectControllable({ platform: 'darwin', pid: 400, readProcTable: () => withClaude('claude --dangerously-load-development-channels plugin:chirp@chirp-plugin') })).toBe(true)
  })
  it('is false when only a different plugin is activated', () => {
    expect(detectControllable({ platform: 'darwin', pid: 400, readProcTable: () => withClaude('claude --channels plugin:telegram@claude-plugins-official') })).toBe(false)
  })
})
