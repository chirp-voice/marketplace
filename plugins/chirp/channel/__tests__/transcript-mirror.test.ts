import { describe, test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractMirror, findTranscriptPath, readRecentTurns, deriveStatus, newestSessionId, isTerminalStop, formatToolStep, extractSteps, unwrapChannelPrompt, extractModel, latestModelIn } from '../transcript-mirror'

const line = (o: unknown) => JSON.stringify(o)

describe('extractMirror', () => {
  test('locally-typed user prompt → user turn', () => {
    expect(extractMirror(line({ type: 'user', message: { role: 'user', content: 'run the tests' } })))
      .toEqual({ role: 'user', text: 'run the tests' })
  })

  test('channel-injected prompt is INCLUDED (unwrapped) when includeChannelPrompts is set (history)', () => {
    expect(extractMirror(line({ type: 'user', message: { role: 'user', content: '<channel source="chirp-channel">\nHi\n</channel>' } }), { includeChannelPrompts: true }))
      .toEqual({ role: 'user', text: 'Hi' })
  })

  test('channel-injected prompt is skipped (already shown on the phone)', () => {
    expect(extractMirror(line({ type: 'user', message: { role: 'user', content: '<channel source="chirp-channel">\nHi\n</channel>' } })))
      .toBeNull()
  })

  test('user tool_result turn is skipped', () => {
    expect(extractMirror(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [] }] } })))
      .toBeNull()
  })

  test('assistant text turn → claude turn', () => {
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — 3 tests pass.' }] } })))
      .toEqual({ role: 'assistant', text: 'Done — 3 tests pass.' })
  })

  test('assistant text is mirrored even when the turn also calls reply (reply carries no content now)', () => {
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'text', text: 'Sure.' },
      { type: 'tool_use', name: 'mcp__chirp-channel__reply', input: { text: 'Sure.' } },
    ] } }))).toEqual({ role: 'assistant', text: 'Sure.' })
  })

  test('assistant thinking-only / tool-only turn → null (no text to mirror)', () => {
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }))).toBeNull()
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }))).toBeNull()
  })

  test('multiple assistant text blocks are joined', () => {
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'text', text: 'one ' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'two' },
    ] } }))).toEqual({ role: 'assistant', text: 'one two' })
  })

  test('assistant text on a non-terminal line → null (it is a step now)', () => {
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Let me check' },
    ] } }))).toBeNull()
  })
  test('assistant text on a terminal line → assistant turn', () => {
    expect(extractMirror(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'text', text: 'The answer.' },
    ] } }))).toEqual({ role: 'assistant', text: 'The answer.' })
  })

  test('system / non-conversation lines and junk → null', () => {
    expect(extractMirror(line({ type: 'system' }))).toBeNull()
    expect(extractMirror(line({ type: 'file-history-snapshot' }))).toBeNull()
    expect(extractMirror('not json')).toBeNull()
    expect(extractMirror('')).toBeNull()
  })
})

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

describe('unwrapChannelPrompt', () => {
  test('returns inner text for a channel-wrapped prompt', () => {
    expect(unwrapChannelPrompt('<channel source="chirp-channel">\nHi there\n</channel>')).toBe('Hi there')
  })
  test('returns null for a plain (non-channel) prompt', () => {
    expect(unwrapChannelPrompt('run the tests')).toBeNull()
  })
  test('handles multi-line inner content', () => {
    expect(unwrapChannelPrompt('<channel source="chirp-channel"> line one\nline two </channel>')).toBe('line one\nline two')
  })
})

describe('readRecentTurns', () => {
  const write = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'chirp-tx-'))
    const f = join(dir, 't.jsonl')
    writeFileSync(f, `${lines.join('\n')}\n`)
    return f
  }
  const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
  const asst = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

  test('returns the last n conversation turns in order', () => {
    const f = write([user('one'), asst('two'), user('three'), asst('four')])
    expect(readRecentTurns(f, 2)).toEqual([
      { role: 'user', text: 'three' },
      { role: 'assistant', text: 'four' },
    ])
  })
  test('includes channel-wrapped prompts (unwrapped) but skips tool-only and system lines', () => {
    const f = write([
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<channel source="chirp-channel">\nhi\n</channel>' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'system' }),
      user('real prompt'),
    ])
    expect(readRecentTurns(f, 10)).toEqual([
      { role: 'user', text: 'hi' }, // phone prompt now restored in history
      { role: 'user', text: 'real prompt' },
    ])
  })
  test('returns all turns when fewer than n', () => {
    const f = write([user('only')])
    expect(readRecentTurns(f, 40)).toEqual([{ role: 'user', text: 'only' }])
  })
  test('missing file → empty array, no throw', () => {
    expect(readRecentTurns(join(tmpdir(), 'nope-zzz.jsonl'), 40)).toEqual([])
  })
})

describe('isTerminalStop', () => {
  test('terminal stop_reasons → true', () => {
    expect(isTerminalStop('end_turn')).toBe(true)
    expect(isTerminalStop('stop_sequence')).toBe(true)
    expect(isTerminalStop('max_tokens')).toBe(true)
  })
  test('non-terminal / missing → false', () => {
    expect(isTerminalStop('tool_use')).toBe(false)
    expect(isTerminalStop(null)).toBe(false)
    expect(isTerminalStop(undefined)).toBe(false)
  })
})

describe('formatToolStep', () => {
  test('Read/Edit/Write → name + file basename', () => {
    expect(formatToolStep('Read', { file_path: '/a/b/transcript-mirror.ts' })).toBe('Read transcript-mirror.ts')
    expect(formatToolStep('Edit', { file_path: '/x/RelayProvider.tsx' })).toBe('Edit RelayProvider.tsx')
    expect(formatToolStep('Write', { file_path: 'steps.ts' })).toBe('Write steps.ts')
  })
  test('Bash → command capped to 40 chars', () => {
    expect(formatToolStep('Bash', { command: 'npm test' })).toBe('Bash: npm test')
    expect(formatToolStep('Bash', { command: 'x'.repeat(60) })).toBe(`Bash: ${'x'.repeat(40)}`)
  })
  test('Grep / Glob → pattern', () => {
    expect(formatToolStep('Grep', { pattern: 'foo' })).toBe('Grep foo')
    expect(formatToolStep('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts')
  })
  test('Task → description, WebFetch → host', () => {
    expect(formatToolStep('Task', { description: 'find bugs' })).toBe('Task: find bugs')
    expect(formatToolStep('WebFetch', { url: 'https://example.com/p?q=1' })).toBe('Fetch example.com')
  })
  test('unknown tool / missing input → tool name, never throws', () => {
    expect(formatToolStep('SomeTool', {})).toBe('SomeTool')
    expect(formatToolStep('Read', undefined)).toBe('Read')
    expect(formatToolStep('WebFetch', { url: 'not a url' })).toBe('WebFetch')
  })
})

describe('extractSteps', () => {
  test('tool_use blocks → tool steps (multiple per line, in order)', () => {
    expect(extractSteps(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/a/foo.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ] } }))).toEqual([
      { kind: 'tool', label: 'Read foo.ts' },
      { kind: 'tool', label: 'Bash: npm test' },
    ])
  })
  test('non-terminal text block → narration step (capped)', () => {
    expect(extractSteps(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'text', text: '  Let me check where things stand  ' },
    ] } }))).toEqual([{ kind: 'text', label: 'Let me check where things stand' }])
    const long = 'y'.repeat(200)
    const out = extractSteps(line({ type: 'assistant', message: { role: 'assistant', stop_reason: null, content: [
      { type: 'text', text: long },
    ] } }))
    expect(out).toEqual([{ kind: 'text', label: 'y'.repeat(160) }])
  })
  test('terminal text block → NO step (it is the final answer / mirror)', () => {
    expect(extractSteps(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'text', text: 'The answer.' },
    ] } }))).toEqual([])
  })
  test('thinking blocks, user lines, tool_result → no steps', () => {
    expect(extractSteps(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'hmm' },
    ] } }))).toEqual([])
    expect(extractSteps(line({ type: 'user', message: { role: 'user', content: 'hi' } }))).toEqual([])
    expect(extractSteps(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [] }] } }))).toEqual([])
  })
  test('mixed: tool_use + narration on the same non-terminal line', () => {
    expect(extractSteps(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
    ] } }))).toEqual([
      { kind: 'text', label: 'Checking' },
      { kind: 'tool', label: 'Grep foo' },
    ])
  })
  test('unparseable line → []', () => {
    expect(extractSteps('not json{')).toEqual([])
  })
})

import { parseTaskLine } from '../transcript-mirror'

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

describe('deriveStatus', () => {
  const taskNote = JSON.stringify({
    type: 'user', origin: { kind: 'task-notification' },
    message: { content: '<task-notification><task-id>bg1</task-id><status>completed</status><summary>x completed (exit code 0)</summary></task-notification>' },
  })
  test('extractMirror skips task-notification user lines (no leak)', () => {
    expect(extractMirror(taskNote)).toBeNull()
    expect(extractMirror(taskNote, { includeChannelPrompts: true })).toBeNull()
  })
  test('deriveStatus ignores task-notification user lines', () => {
    expect(deriveStatus(taskNote)).toBeNull()
  })

  test('locally-typed user prompt → running', () => {
    expect(deriveStatus(line({ type: 'user', message: { role: 'user', content: 'run the tests' } }))).toBe('running')
  })

  test('phone-injected <channel source> prompt → null', () => {
    expect(
      deriveStatus(line({ type: 'user', message: { role: 'user', content: '<channel source="chirp-channel">\nhi\n</channel>' } })),
    ).toBeNull()
  })

  test('user tool_result (array content) → null', () => {
    expect(
      deriveStatus(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [] }] } })),
    ).toBeNull()
  })

  test('assistant stop_reason tool_use → running (intermediate narration)', () => {
    expect(
      deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check…' }] } })),
    ).toBe('running')
  })

  test('assistant stop_reason end_turn → done', () => {
    expect(
      deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The answer.' }] } })),
    ).toBe('done')
  })

  test('assistant stop_reason stop_sequence / max_tokens (with text) → done', () => {
    expect(deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'a' }] } }))).toBe('done')
    expect(deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'a' }] } }))).toBe('done')
  })

  // Regression: Claude Code flushes one assistant message to the transcript one content block at a
  // time, and the thinking block lands FIRST already carrying the turn's terminal stop_reason —
  // seconds before the text answer's own line. A thinking-only (no text) flush must NOT report
  // `done`, or the phone resolves the reply before the answer line exists and shows nothing.
  test('assistant terminal stop_reason but thinking-only (no text) → running', () => {
    expect(
      deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }] } })),
    ).toBe('running')
  })

  test('assistant terminal stop_reason but empty content → running', () => {
    expect(deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }))).toBe('running')
  })

  test('assistant missing / null stop_reason → running (conservative)', () => {
    expect(deriveStatus(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }))).toBe('running')
    expect(deriveStatus(line({ type: 'assistant', message: { role: 'assistant', stop_reason: null, content: [] } }))).toBe('running')
  })

  test('non user/assistant line → null', () => {
    expect(deriveStatus(line({ type: 'system', message: {} }))).toBeNull()
  })

  test('unparseable line → null', () => {
    expect(deriveStatus('not json{')).toBeNull()
  })
})
