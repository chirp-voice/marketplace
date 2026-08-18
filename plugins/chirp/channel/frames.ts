/**
 * This package's wire vocabulary: the `hello` it sends, the relay strings that name Claude Code
 * surfaces, and typed definitions for all task-alert relay frames that flow between the
 * plugin (emit sites) and the worker (consume sites) via the concierge relay.
 *
 * The hello builder and hint strings live here (not in `channel/relay.ts`) because relay.ts is
 * byte-identical across packages — see its header — so anything naming THIS package's wire shape,
 * auth entry point, or config surface must be injected from this module.
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

// ---------------------------------------------------------------------------
// The channel hello + relay strings, injected into channel/relay.ts createRelay
// ---------------------------------------------------------------------------

/** The kind of system behind this row. A free-form presentation tag on the `hello` frame — see
 *  `concierge/src/relay/frames.ts`. Never a routing key. Named rather than inlined so the send
 *  and the test that pins it agree by construction — the same shape
 *  `plugins/openclaw/channel/frames.ts` uses. */
export const PROVIDER = 'claude-code'

/** The channel `hello` — the frame that claims this session's row on the phone.
 *
 *  The shape is this package's contract with the concierge (`concierge/src/relay/frames.ts`
 *  parses it) and must stay byte-for-byte what the channel has always sent. `model`/`effort` may
 *  be undefined; `JSON.stringify` drops those keys, so the wire never carries them.
 *
 *  `controllable` is best-effort, resolved once at module load: true whenever the caller cannot
 *  prove the channel is inactive (see activation.ts). `provider` tells Chirp what kind of system
 *  is behind this row so the phone never renders another provider's advice under this agent —
 *  presentation only, the relay does not route on it. */
export function buildHello(
  jwt: string,
  sessionId: string,
  label: string,
  opts: { model?: string; effort?: string; controllable: boolean },
): Record<string, unknown> {
  return {
    v: 1,
    kind: 'hello',
    role: 'channel',
    jwt,
    sessionId,
    label,
    model: opts.model,
    effort: opts.effort,
    controllable: opts.controllable,
    provider: PROVIDER,
  }
}

/** How the user signs in on this surface — `createRelay` speaks it when no token is available. */
export const SIGN_IN_HINT = 'run /chirp-auth in Claude Code'

/** Appended to the relay's HTTP 401/403 upgrade-rejection log. */
export const AUTH_REJECTED_HINT =
  'run /chirp-auth in Claude Code to refresh your credentials, ' +
  'or check that CHIRP_RELAY_URL matches the environment you signed in to'

/** The fix-it tail of `resolveRelayUrl`'s malformed-URL error — CHIRP_RELAY_URL is the only
 *  config surface a Claude Code install has. */
export const INVALID_URL_HINT =
  'set it via the CHIRP_RELAY_URL env var; relay disabled and the MCP channel stays active'

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

// ---------------------------------------------------------------------------
// Inbound control frames (concierge → plugin), validated at the relay boundary.
// Not part of the task-frame fixture contract above. These are checked at
// runtime because a malformed frame must be dropped, never thrown: ws
// 'message' handlers are not awaited, so an escaping rejection is an
// unhandledRejection that kills the channel process.
// ---------------------------------------------------------------------------

export type PromptFrame = { kind: 'prompt'; text: string }
export type PermVerdictFrame = { kind: 'perm-verdict'; requestId: string; behavior: string }

export function isPromptFrame(x: unknown): x is PromptFrame {
  return isObject(x) && x['kind'] === 'prompt' && isString(x['text'])
}

export function isPermVerdictFrame(x: unknown): x is PermVerdictFrame {
  return isObject(x) && x['kind'] === 'perm-verdict' && isString(x['requestId']) && isString(x['behavior'])
}
