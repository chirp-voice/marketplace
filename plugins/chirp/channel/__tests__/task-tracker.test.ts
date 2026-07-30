import { describe, test, expect } from 'vitest'
import { TaskTracker } from '../task-tracker'

const launch = { kind: 'bg-launch', toolUseId: 't1', command: 'npm test', label: 'Run tests' } as const
const result = { kind: 'bg-result', toolUseId: 't1', taskId: 'bg1' } as const
const done = { kind: 'bg-done', taskId: 'bg1', toolUseId: 't1', status: 'completed', exitCode: 0, summary: 'Run tests completed (exit code 0)' } as const

describe('TaskTracker', () => {
  test('launch alone emits nothing (no taskId yet)', () => {
    const t = new TaskTracker(); expect(t.apply(launch)).toBeNull()
  })
  test('launch then result → task-start with joined fields', () => {
    const t = new TaskTracker(() => 0); t.apply(launch)
    expect(t.apply(result)).toEqual({ kind: 'task-start', task: { taskId: 'bg1', label: 'Run tests', command: 'npm test', startedAt: 0 } })
    expect(t.snapshot().running).toEqual([{ taskId: 'bg1', label: 'Run tests', command: 'npm test', startedAt: 0 }])
  })
  test('done → task-done, moves running→recentlyCompleted', () => {
    const t = new TaskTracker(() => 0); t.apply(launch); t.apply(result)
    expect(t.apply(done)).toEqual({ kind: 'task-done', taskId: 'bg1', status: 'completed', exitCode: 0, summary: 'Run tests completed (exit code 0)', label: 'Run tests' })
    expect(t.snapshot().running).toEqual([])
    expect(t.snapshot().recentlyCompleted.map(c => c.taskId)).toEqual(['bg1'])
  })
  test('done for unknown task still emits (label from summary fallback)', () => {
    const t = new TaskTracker()
    const d = t.apply({ ...done, taskId: 'ghost' })
    expect(d).toMatchObject({ kind: 'task-done', taskId: 'ghost', label: 'Run tests completed (exit code 0)' })
  })
  test('recentlyCompleted is bounded to RECENT_CAP', () => {
    const t = new TaskTracker()
    for (let i = 0; i < 30; i++) t.apply({ kind: 'bg-done', taskId: `b${i}`, toolUseId: null, status: 'completed', exitCode: 0, summary: `task ${i} (exit code 0)` })
    expect(t.snapshot().recentlyCompleted.length).toBe(20)
    expect(t.snapshot().recentlyCompleted[19].taskId).toBe('b29') // newest kept
  })
})
