/**
 * Task-frame fixture contract tests (T4-6).
 *
 * Verifies that:
 *  1. Every sample in fixtures/task-frames.json satisfies the runtime shape
 *     validators in channel/frames.ts (TS types alone can't check JSON at
 *     runtime — validators are the source of truth here).
 *  2. The fixture contains exactly the expected set of frame kinds.
 *  3. TASK_FRAME_KINDS in channel/frames.ts matches the fixture kind set.
 *  4. Unhandled relay frames are logged (the else-branch in handleRelayMessage).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isTaskStartFrame,
  isTaskDoneFrame,
  isTaskSnapshotFrame,
  isTaskSnapshotRequestFrame,
  isAnyTaskFrame,
  TASK_FRAME_KINDS,
} from '../frames'

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures')

interface TaskFrameFixture {
  [key: string]: unknown
  $comment?: string
}

function loadFixture(): TaskFrameFixture {
  const p = path.join(FIXTURES_DIR, 'task-frames.json')
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TaskFrameFixture
}

const fixture = loadFixture()

// Extract non-comment entries (the real frame samples keyed by kind name).
const frameSamples = Object.fromEntries(
  Object.entries(fixture).filter(([k]) => !k.startsWith('$')),
) as Record<string, unknown>

// ---------------------------------------------------------------------------
// T4-6a: fixture kinds vs TASK_FRAME_KINDS constant
// ---------------------------------------------------------------------------

describe('TASK_FRAME_KINDS constant vs fixture (T4-6a)', () => {
  it('fixture has a sample for every kind in TASK_FRAME_KINDS', () => {
    for (const kind of TASK_FRAME_KINDS) {
      expect(frameSamples).toHaveProperty(kind)
    }
  })

  it('every fixture sample kind is in TASK_FRAME_KINDS', () => {
    for (const key of Object.keys(frameSamples)) {
      expect(TASK_FRAME_KINDS as readonly string[]).toContain(key)
    }
  })

  it('fixture has exactly 4 kinds', () => {
    expect(Object.keys(frameSamples)).toHaveLength(4)
    expect(TASK_FRAME_KINDS).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// T4-6b: each fixture sample satisfies its runtime validator
// ---------------------------------------------------------------------------

describe('fixture samples satisfy runtime shape validators (T4-6b)', () => {
  it('task-start sample passes isTaskStartFrame', () => {
    expect(isTaskStartFrame(frameSamples['task-start'])).toBe(true)
  })

  it('task-done sample passes isTaskDoneFrame', () => {
    expect(isTaskDoneFrame(frameSamples['task-done'])).toBe(true)
  })

  it('task-snapshot sample passes isTaskSnapshotFrame', () => {
    expect(isTaskSnapshotFrame(frameSamples['task-snapshot'])).toBe(true)
  })

  it('task-snapshot-request sample passes isTaskSnapshotRequestFrame', () => {
    expect(isTaskSnapshotRequestFrame(frameSamples['task-snapshot-request'])).toBe(true)
  })

  it('all fixture samples pass isAnyTaskFrame', () => {
    for (const [kind, sample] of Object.entries(frameSamples)) {
      expect(isAnyTaskFrame(sample), `kind=${kind} failed isAnyTaskFrame`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// T4-6c: validators reject malformed inputs
// ---------------------------------------------------------------------------

describe('shape validators reject malformed inputs (T4-6c)', () => {
  it('isTaskStartFrame rejects missing task.taskId', () => {
    expect(isTaskStartFrame({ kind: 'task-start', task: { label: 'x', command: 'y' } })).toBe(false)
  })

  it('isTaskDoneFrame rejects non-null non-number exitCode', () => {
    expect(isTaskDoneFrame({ kind: 'task-done', taskId: 'a', label: 'b', status: 'completed', exitCode: 'nope', summary: 's' })).toBe(false)
  })

  it('isTaskSnapshotFrame rejects non-array running', () => {
    expect(isTaskSnapshotFrame({ kind: 'task-snapshot', running: null, recentlyCompleted: [] })).toBe(false)
  })

  it('isTaskSnapshotRequestFrame rejects missing sessionId', () => {
    expect(isTaskSnapshotRequestFrame({ kind: 'task-snapshot-request' })).toBe(false)
  })

  it('isAnyTaskFrame rejects unknown kind', () => {
    expect(isAnyTaskFrame({ kind: 'totally-unknown' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T4-6d: unhandled-frame else-branch in chirp-channel.ts logs the kind
// ---------------------------------------------------------------------------

describe('unhandled relay frame logging (T4-6d)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('handleRelayMessage logs unhandled frame kind without throwing', async () => {
    // Import after mocking to pick up the spy.
    const { connectRelay } = await import('../chirp-channel')

    // Build a fake WebSocket that delivers one unhandled-kind message.
    let messageHandler: ((raw: unknown) => Promise<void>) | null = null
    const ws = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
        if (event === 'message') messageHandler = cb as typeof messageHandler
      }),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1, // OPEN
    }
    const makeWs = vi.fn((_url: string, _opts: { headers: Record<string, string> }) => ws)

    await connectRelay({ getToken: async () => 'tok-abc', makeWs: makeWs as any })

    expect(messageHandler).not.toBeNull()

    const errorCalls: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errorCalls.push(args) })

    // Send a frame with an unrecognised kind.
    await messageHandler!(JSON.stringify({ v: 1, kind: 'some-future-frame', data: 42 }))

    const logged = errorCalls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('unhandled') && args[0].includes('some-future-frame'),
    )
    expect(logged).toBe(true)
  })
})
