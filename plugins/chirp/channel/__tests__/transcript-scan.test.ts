import { describe, test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTranscriptPath, newestSessionId, parseTaskLine, extractModel, latestModelIn } from '../transcript-scan'

const line = (o: unknown) => JSON.stringify(o)

describe('findTranscriptPath', () => {
  test('locates <sessionId>.jsonl under any project subdir', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-projects-'))
    try {
      const sub = join(root, '-Users-jon-Source-foo')
      mkdirSync(sub)
      const target = join(sub, 'abc-123.jsonl')
      writeFileSync(target, '')
      writeFileSync(join(sub, 'other.jsonl'), '')
      expect(findTranscriptPath(root, 'abc-123')).toBe(target)
      expect(findTranscriptPath(root, 'missing')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing projects dir → null, not a throw', () => {
    expect(findTranscriptPath(join(tmpdir(), 'does-not-exist-zzz'), 'abc')).toBeNull()
  })
})

describe('newestSessionId', () => {
  test('returns the newest transcript id in the encoded project dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-projects-'))
    try {
      const projectPath = '/Users/jon/Source/pulseiq/chirp/host-agent'
      const sub = join(root, '-Users-jon-Source-pulseiq-chirp-host-agent') // CC's `/`→`-` encoding
      mkdirSync(sub)
      const older = join(sub, 'aaaa-old.jsonl')
      const newer = join(sub, 'bbbb-new.jsonl')
      writeFileSync(older, '')
      writeFileSync(newer, '')
      utimesSync(older, new Date(1_000_000), new Date(1_000_000))
      utimesSync(newer, new Date(2_000_000), new Date(2_000_000))
      expect(newestSessionId(root, projectPath)).toBe('bbbb-new')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('encoded project dir absent → null', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-projects-'))
    try {
      expect(newestSessionId(root, '/Users/jon/no/such/project')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('project dir with no .jsonl → null', () => {
    const root = mkdtempSync(join(tmpdir(), 'chirp-projects-'))
    try {
      const sub = join(root, '-tmp-empty')
      mkdirSync(sub)
      writeFileSync(join(sub, 'notes.txt'), 'x')
      expect(newestSessionId(root, '/tmp/empty')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('extractModel', () => {
  test('returns message.model from an assistant line', () => {
    expect(extractModel(line({ type: 'assistant', message: { model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [] } })))
      .toBe('claude-sonnet-4-5')
  })
  test('returns null for a non-assistant line', () => {
    expect(extractModel(line({ type: 'user', message: { model: 'claude-sonnet-4-5', content: 'hi' } }))).toBeNull()
  })
  test('returns null when message.model is missing', () => {
    expect(extractModel(line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }))).toBeNull()
  })
  test('returns null when message.model is an empty string', () => {
    expect(extractModel(line({ type: 'assistant', message: { model: '', content: [] } }))).toBeNull()
  })
  test('returns null when message.model is not a string', () => {
    expect(extractModel(line({ type: 'assistant', message: { model: 42, content: [] } }))).toBeNull()
  })
  test('returns null for non-JSON input', () => {
    expect(extractModel('not json')).toBeNull()
    expect(extractModel('')).toBeNull()
  })
  test('returns null for synthetic assistant lines', () => {
    expect(extractModel(line({ type: 'assistant', message: { model: '<synthetic>', content: [] } }))).toBeNull()
  })
})

describe('latestModelIn', () => {
  test('returns the last assistant model in a multi-line blob', () => {
    const text = [
      line({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [] } }),
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [] } }),
    ].join('\n')
    expect(latestModelIn(text)).toBe('claude-sonnet-4-5')
  })
  test('returns the only model when there is a single assistant line', () => {
    expect(latestModelIn(line({ type: 'assistant', message: { model: 'claude-opus-4-5', content: [] } })))
      .toBe('claude-opus-4-5')
  })
  test('returns null when there are no assistant lines with a model', () => {
    const text = [
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'system' }),
    ].join('\n')
    expect(latestModelIn(text)).toBeNull()
  })
  test('returns null for empty input', () => {
    expect(latestModelIn('')).toBeNull()
  })
})

describe('parseTaskLine', () => {
  const launch = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash',
      input: { command: 'sleep 25 && echo BG_DONE_7F3X', description: 'Sleep 25 seconds then echo marker', run_in_background: true } }] },
  })
  const result = JSON.stringify({
    type: 'user',
    message: { content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'Command running in background with ID: bgcbxg5fj…' }] },
    toolUseResult: { backgroundTaskId: 'bgcbxg5fj' },
  })
  const done = JSON.stringify({
    type: 'user', origin: { kind: 'task-notification' },
    message: { content: '<task-notification>\n<task-id>bgcbxg5fj</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Background command "Sleep 25 seconds then echo marker" completed (exit code 0)</summary>\n</task-notification>' },
  })

  test('bg-launch → toolUseId + command + label', () => {
    expect(parseTaskLine(launch)).toEqual({ kind: 'bg-launch', toolUseId: 'toolu_1',
      command: 'sleep 25 && echo BG_DONE_7F3X', label: 'Sleep 25 seconds then echo marker' })
  })
  test('foreground Bash (no run_in_background) → null', () => {
    const fg = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } })
    expect(parseTaskLine(fg)).toBeNull()
  })
  test('bg-result → toolUseId + taskId', () => {
    expect(parseTaskLine(result)).toEqual({ kind: 'bg-result', toolUseId: 'toolu_1', taskId: 'bgcbxg5fj' })
  })
  test('bg-done → taskId, status, exitCode, summary', () => {
    expect(parseTaskLine(done)).toEqual({ kind: 'bg-done', taskId: 'bgcbxg5fj', toolUseId: 'toolu_1',
      status: 'completed', exitCode: 0, summary: 'Background command "Sleep 25 seconds then echo marker" completed (exit code 0)' })
  })
  test('non-task line → null', () => { expect(parseTaskLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBeNull() })
  test('garbage → null', () => { expect(parseTaskLine('{not json')).toBeNull() })
})
