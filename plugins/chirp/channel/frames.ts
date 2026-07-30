/**
 * Typed definitions for all task-alert relay frames that flow between the
 * plugin (emit sites) and the worker (consume sites) via the concierge relay.
 *
 * CONTRACT: shapes here must match the fixture at
 * <repo-root>/fixtures/task-frames.json (enforced by the vitest suite in
 * channel/__tests__/task-frames.test.ts). The relay is intentionally a
 * pass-through — it does NOT parse these frames at runtime.
 *
 * Outbound (plugin → relay → worker via SSE):
 *   TaskStartFrame      "task-start"            task-tracker.ts TaskTracker.apply (bg-result)
 *   TaskDoneFrame       "task-done"             task-tracker.ts TaskTracker.apply (bg-done)
 *   TaskSnapshotFrame   "task-snapshot"         chirp-channel.ts handleRelayMessage (task-snapshot-request)
 *
 * Inbound (concierge internal/route.ts → relay → plugin):
 *   TaskSnapshotRequestFrame  "task-snapshot-request"  concierge internal/route.ts POST …/task-snapshot-request
 */

// Matches RunningTask in task-tracker.ts — kept in sync by the fixture contract.
export type RunningTask = {
  taskId: string
  label: string
  command: string
  startedAt?: number
}

// Matches CompletedTask in task-tracker.ts — kept in sync by the fixture contract.
export type CompletedTask = {
  taskId: string
  label: string
  status: string
  exitCode: number | null
  summary: string
  completedAt?: number
}

export type TaskStartFrame = {
  kind: 'task-start'
  task: RunningTask
}

export type TaskDoneFrame = {
  kind: 'task-done'
  taskId: string
  label: string
  status: string
  exitCode: number | null
  summary: string
}

export type TaskSnapshotFrame = {
  kind: 'task-snapshot'
  running: RunningTask[]
  recentlyCompleted: CompletedTask[]
}

export type TaskSnapshotRequestFrame = {
  kind: 'task-snapshot-request'
  sessionId: string
}

/** All task frames the plugin can emit outbound. */
export type OutboundTaskFrame = TaskStartFrame | TaskDoneFrame | TaskSnapshotFrame

/** All task frames the plugin can receive inbound. */
export type InboundTaskFrame = TaskSnapshotRequestFrame

/** Union of all task frame kinds in the contract. */
export type AnyTaskFrame = OutboundTaskFrame | InboundTaskFrame

/** The set of all task frame kind strings — used in fixture tests. */
export const TASK_FRAME_KINDS = [
  'task-start',
  'task-done',
  'task-snapshot',
  'task-snapshot-request',
] as const

export type TaskFrameKind = (typeof TASK_FRAME_KINDS)[number]

// ---------------------------------------------------------------------------
// Runtime shape validators (used by fixture tests — TS types can't check JSON)
// ---------------------------------------------------------------------------

function isString(x: unknown): x is string { return typeof x === 'string' }
function isNumber(x: unknown): x is number { return typeof x === 'number' }
function isNullableNumber(x: unknown): x is number | null { return x === null || isNumber(x) }
function isObject(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x) }
function isArray(x: unknown): x is unknown[] { return Array.isArray(x) }

function isRunningTask(x: unknown): x is RunningTask {
  if (!isObject(x)) return false
  return isString(x['taskId']) && isString(x['label']) && isString(x['command'])
}

function isCompletedTask(x: unknown): x is CompletedTask {
  if (!isObject(x)) return false
  return (
    isString(x['taskId']) &&
    isString(x['label']) &&
    isString(x['status']) &&
    isNullableNumber(x['exitCode']) &&
    isString(x['summary'])
  )
}

export function isTaskStartFrame(x: unknown): x is TaskStartFrame {
  return isObject(x) && x['kind'] === 'task-start' && isRunningTask(x['task'])
}

export function isTaskDoneFrame(x: unknown): x is TaskDoneFrame {
  if (!isObject(x) || x['kind'] !== 'task-done') return false
  return (
    isString(x['taskId']) &&
    isString(x['label']) &&
    isString(x['status']) &&
    isNullableNumber(x['exitCode']) &&
    isString(x['summary'])
  )
}

export function isTaskSnapshotFrame(x: unknown): x is TaskSnapshotFrame {
  if (!isObject(x) || x['kind'] !== 'task-snapshot') return false
  return isArray(x['running']) && x['running'].every(isRunningTask) &&
    isArray(x['recentlyCompleted']) && x['recentlyCompleted'].every(isCompletedTask)
}

export function isTaskSnapshotRequestFrame(x: unknown): x is TaskSnapshotRequestFrame {
  return isObject(x) && x['kind'] === 'task-snapshot-request' && isString(x['sessionId'])
}

export function isAnyTaskFrame(x: unknown): x is AnyTaskFrame {
  return isTaskStartFrame(x) || isTaskDoneFrame(x) || isTaskSnapshotFrame(x) || isTaskSnapshotRequestFrame(x)
}
