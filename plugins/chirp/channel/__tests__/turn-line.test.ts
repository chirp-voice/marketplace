import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectTurnLine, readRecentTurnLines, formatToolStep, unwrapChannelPrompt } from '../turn-line.js'

const assistant = (o: Record<string, unknown>) => JSON.stringify({ type: 'assistant', ...o })
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { content }, ...extra })

describe('projectTurnLine — user lines', () => {
  it('projects a locally-typed prompt', () => {
    expect(projectTurnLine(user('ship it'))).toEqual({
      role: 'user', stopReason: null, isApiError: false, text: 'ship it',
      tools: [], injected: false, taskNotification: false,
    })
  })

  it('nulls text for a tool_result list so it cannot look like a new user turn', () => {
    const line = user([{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }])
    expect(projectTurnLine(line)).toMatchObject({ role: 'user', text: null })
  })

  it('unwraps a phone-injected prompt and flags it', () => {
    const line = user('<channel source="chirp-channel">kick off the refresh</channel>')
    expect(projectTurnLine(line)).toMatchObject({
      role: 'user', text: 'kick off the refresh', injected: true,
    })
  })

  it('flags a task-notification line', () => {
    const line = user('<task-id>t9</task-id>', { origin: { kind: 'task-notification' } })
    expect(projectTurnLine(line)).toMatchObject({ role: 'user', taskNotification: true })
  })
})

describe('projectTurnLine — assistant lines', () => {
  it('projects a terminal text answer', () => {
    const line = assistant({ message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done deal' }] } })
    expect(projectTurnLine(line)).toEqual({
      role: 'assistant', stopReason: 'end_turn', isApiError: false, text: 'done deal',
      tools: [], injected: false, taskNotification: false,
    })
  })

  it('projects tool_use blocks as name + preview, and never their inputs verbatim', () => {
    const line = assistant({
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'reading it' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/Users/j/src/deep/app.ts' } },
        ],
      },
    })
    expect(projectTurnLine(line)).toMatchObject({
      stopReason: 'tool_use', text: 'reading it',
      tools: [{ name: 'Read', preview: 'Read app.ts' }],
    })
  })

  it('skips thinking blocks entirely', () => {
    const line = assistant({
      message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'secret reasoning' }] },
    })
    expect(projectTurnLine(line)).toMatchObject({ text: null, tools: [] })
    expect(JSON.stringify(projectTurnLine(line))).not.toContain('secret')
  })

  it('carries isApiError from the top-level isApiErrorMessage flag', () => {
    const line = assistant({
      isApiErrorMessage: true,
      message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: overloaded' }] },
    })
    expect(projectTurnLine(line)).toMatchObject({
      role: 'assistant', stopReason: 'stop_sequence', isApiError: true, text: 'API Error: overloaded',
    })
  })

  it('reports a null stop_reason as null, not a string', () => {
    const line = assistant({ message: { stop_reason: null, content: [] } })
    expect(projectTurnLine(line)).toMatchObject({ stopReason: null })
  })
})

describe('projectTurnLine — other', () => {
  it('returns null for unparseable input', () => {
    expect(projectTurnLine('not json')).toBeNull()
  })

  it('projects an unknown line type as role "other"', () => {
    expect(projectTurnLine(JSON.stringify({ type: 'system', foo: 1 }))).toMatchObject({ role: 'other', text: null })
  })
})

describe('formatToolStep', () => {
  it('basenames file tools', () => {
    expect(formatToolStep('Edit', { file_path: '/a/b/c.ts' })).toBe('Edit c.ts')
  })
  it('caps bash commands at 40 chars', () => {
    expect(formatToolStep('Bash', { command: 'x'.repeat(80) })).toBe(`Bash: ${'x'.repeat(40)}`)
  })
  it('falls back to the tool name', () => {
    expect(formatToolStep('Mystery', { anything: 1 })).toBe('Mystery')
  })
  it('uses the host for WebFetch and survives a bad URL', () => {
    expect(formatToolStep('WebFetch', { url: 'https://example.com/x' })).toBe('Fetch example.com')
    expect(formatToolStep('WebFetch', { url: 'nope' })).toBe('WebFetch')
  })
  it('basenames Read and Write too, not just Edit', () => {
    expect(formatToolStep('Read', { file_path: '/a/b/c.ts' })).toBe('Read c.ts')
    expect(formatToolStep('Write', { file_path: '/a/b/new.md' })).toBe('Write new.md')
  })
  it('echoes Grep and Glob patterns', () => {
    expect(formatToolStep('Grep', { pattern: 'TODO' })).toBe('Grep TODO')
    expect(formatToolStep('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts')
  })
  it('labels a Task by description, bare when it has none', () => {
    expect(formatToolStep('Task', { description: 'audit deps' })).toBe('Task: audit deps')
    expect(formatToolStep('Task', {})).toBe('Task')
  })
  it('falls back to the bare name when input is missing entirely', () => {
    expect(formatToolStep('Read', undefined)).toBe('Read')
    expect(formatToolStep('Bash', undefined)).toBe('Bash')
    expect(formatToolStep('Grep', null)).toBe('Grep')
  })
})

describe('unwrapChannelPrompt', () => {
  it('returns null for a plain prompt', () => {
    expect(unwrapChannelPrompt('hello')).toBeNull()
  })
  it('strips the envelope', () => {
    expect(unwrapChannelPrompt('<channel source="chirp-channel">hi</channel>')).toBe('hi')
  })
})

describe('readRecentTurnLines', () => {
  it('keeps only text-bearing lines and returns the last n', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chirp-tl-'))
    const path = join(dir, 't.jsonl')
    writeFileSync(path, [
      user('one'),
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'noise' }]),
      assistant({ message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'two' }] } }),
      user('three'),
      '',
    ].join('\n'))
    expect(readRecentTurnLines(path, 2).map((l) => l.text)).toEqual(['two', 'three'])
  })

  it('keeps injected and task-notification lines, with their flags intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chirp-tl-'))
    const path = join(dir, 't.jsonl')
    writeFileSync(path, [
      user('<channel source="chirp-channel">from the phone</channel>'),
      user('<task-id>t9</task-id>', { origin: { kind: 'task-notification' } }),
    ].join('\n'))
    expect(readRecentTurnLines(path, 10)).toMatchObject([
      { text: 'from the phone', injected: true, taskNotification: false },
      { text: '<task-id>t9</task-id>', injected: false, taskNotification: true },
    ])
  })

  it('returns [] when the file is missing', () => {
    expect(readRecentTurnLines('/nope/nothing.jsonl', 10)).toEqual([])
  })
})
