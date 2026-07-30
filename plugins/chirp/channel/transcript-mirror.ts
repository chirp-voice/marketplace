import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

export type MirrorTurn = { role: 'user' | 'assistant'; text: string }

/** A streamed step: a tool action or a line of intermediate narration. */
export type Step = { kind: 'tool' | 'text'; label: string }

export const STEP_TEXT_CAP = 160
const BASH_CAP = 40

/** Compact human label for a tool_use block. Never throws; falls back to the tool name. */
export function formatToolStep(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  switch (name) {
    case 'Read': case 'Edit': case 'Write': {
      const fp = str(i.file_path)
      return fp ? `${name} ${basename(fp)}` : name
    }
    case 'Bash': {
      const c = str(i.command)
      return c ? `Bash: ${c.slice(0, BASH_CAP)}` : 'Bash'
    }
    case 'Grep': { const p = str(i.pattern); return p ? `Grep ${p}` : 'Grep' }
    case 'Glob': { const p = str(i.pattern); return p ? `Glob ${p}` : 'Glob' }
    case 'Task': { const d = str(i.description); return d ? `Task: ${d}` : 'Task' }
    case 'WebFetch': {
      const u = str(i.url)
      if (!u) return 'WebFetch'
      try { return `Fetch ${new URL(u).host}` } catch { return 'WebFetch' }
    }
    default:
      return name
  }
}

/** The assistant stop_reasons that genuinely end a turn (vs tool_use / null / unknown = still working). */
export function isTerminalStop(stopReason: unknown): boolean {
  return stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'max_tokens'
}

// Steps streamed live during a turn: every tool_use block, plus intermediate narration text
// (text on a NON-terminal line). Terminal-stop text is the final answer (extractMirror's job),
// not a step; thinking blocks and tool_result lists are skipped. [] for non-assistant lines.
export function extractSteps(jsonl: string): Step[] {
  let o: any
  try { o = JSON.parse(jsonl) } catch { return [] }
  if (o?.type !== 'assistant') return []
  const content = o?.message?.content
  if (!Array.isArray(content)) return []
  const terminal = isTerminalStop(o?.message?.stop_reason)
  const steps: Step[] = []
  for (const b of content) {
    if (b?.type === 'tool_use' && typeof b?.name === 'string') {
      steps.push({ kind: 'tool', label: formatToolStep(b.name, b.input) })
    } else if (!terminal && b?.type === 'text' && typeof b?.text === 'string') {
      const t = b.text.trim()
      if (t) steps.push({ kind: 'text', label: t.slice(0, STEP_TEXT_CAP) })
    }
  }
  return steps
}

// If `content` is a phone-injected `<channel source="…">…</channel>` envelope (Claude Code's wrapper
// for a prompt Chirp sent), return the inner prompt text; otherwise null. Detection matches the live
// skip (`<channel source=`), so it flags exactly the same lines the mirror drops live — but lets the
// history path recover the actual text the user said.
export function unwrapChannelPrompt(content: string): string | null {
  if (!/^\s*<channel\s+source=/.test(content)) return null
  return content
    .replace(/^\s*<channel\b[^>]*>/, '')
    .replace(/<\/channel>\s*$/, '')
    .trim()
}

// A Claude Code turn worth mirroring to the phone, or null to skip. The mirror is
// the single content path (the reply tool no longer carries content), so every
// assistant text turn is emitted. The one dedup marker is on the user side:
// prompts injected from the phone arrive wrapped `<channel source="…">…</channel>`
// (Claude Code's envelope) and already render on the phone, so the LIVE mirror skips them.
// History backfill passes { includeChannelPrompts: true } to restore them (unwrapped) — after a
// reopen there's no live optimistic echo to double, so the user's own prompts must show.
export function extractMirror(jsonl: string, opts?: { includeChannelPrompts?: boolean }): MirrorTurn | null {
  let o: any
  try { o = JSON.parse(jsonl) } catch { return null }
  const content = o?.message?.content

  if (o?.type === 'user') {
    if (o?.origin?.kind === 'task-notification') return null // surfaced as task-done, not a chat bubble
    if (typeof content !== 'string') return null // tool_result lists etc.
    const inner = unwrapChannelPrompt(content)
    if (inner !== null) {
      // Phone-injected prompt: skip live (avoids doubling the optimistic echo); include in history.
      return opts?.includeChannelPrompts && inner ? { role: 'user', text: inner } : null
    }
    const text = content.trim()
    return text ? { role: 'user', text } : null
  }

  if (o?.type === 'assistant') {
    if (!Array.isArray(content)) return null
    // Only the terminal-stop text is the final answer / a message. Intermediate narration
    // (non-terminal text) is a step now (see extractSteps), not a chat message.
    if (!isTerminalStop(o?.message?.stop_reason)) return null
    const text = content
      .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    return text ? { role: 'assistant', text } : null
  }

  return null
}

// Read the last `n` conversation turns from a session transcript, for history backfill when the app
// opens a session. Unlike the live mirror this INCLUDES phone-injected prompts (unwrapped) so a
// reopened session shows what the user said, not just Claude's replies.
export function readRecentTurns(transcriptPath: string, n: number): MirrorTurn[] {
  let content: string
  try { content = readFileSync(transcriptPath, 'utf8') } catch { return [] }
  const turns: MirrorTurn[] = []
  for (const line of content.split('\n')) {
    const turn = line.trim() && extractMirror(line, { includeChannelPrompts: true })
    if (turn) turns.push(turn)
  }
  return turns.slice(-n)
}

// Resolve the active session's id from its transcript when no id is supplied in the environment.
// Newer Claude Code builds (≥2.1.x) inject CLAUDE_PROJECT_DIR but NOT CLAUDE_CODE_SESSION_ID into a
// channel MCP server's env, so we recover the id from the project's transcript folder:
// ~/.claude/projects/<encoded-project-dir>/<sessionId>.jsonl, where the encoding replaces every
// non-alphanumeric run with `-` (e.g. /Users/jon/foo → -Users-jon-foo). The session that owns this
// channel is the one whose transcript is being written, i.e. the most-recently-modified `.jsonl`.
// Returns null (caller falls back to the cwd basename) if the folder or any transcript is missing.
export function newestSessionId(projectsDir: string, projectPath: string): string | null {
  const dir = join(projectsDir, projectPath.replace(/[^a-zA-Z0-9]/g, '-'))
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return null } // folder absent / unreadable
  let newest: string | null = null
  let newestMtime = -Infinity
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue
    let mtime: number
    try { mtime = statSync(join(dir, e)).mtimeMs } catch { continue }
    if (mtime > newestMtime) { newestMtime = mtime; newest = e }
  }
  return newest ? newest.slice(0, -'.jsonl'.length) : null
}

// Claude Code writes each session to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
// The cwd encoding is lossy, so locate by the globally-unique sessionId instead of
// recomputing the directory name.
export function findTranscriptPath(projectsDir: string, sessionId: string): string | null {
  let entries: string[]
  try { entries = readdirSync(projectsDir) } catch { return null }
  for (const sub of entries) {
    const candidate = join(projectsDir, sub, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export type TaskLine =
  | { kind: 'bg-launch'; toolUseId: string; command: string; label: string }
  | { kind: 'bg-result'; toolUseId: string; taskId: string }
  | { kind: 'bg-done'; taskId: string; toolUseId: string | null; status: string; exitCode: number | null; summary: string }

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : null
}

/** Classify one transcript JSONL line as a background-task lifecycle event, or null. Never throws. */
export function parseTaskLine(jsonl: string): TaskLine | null {
  let o: any
  try { o = JSON.parse(jsonl) } catch { return null }

  // Completion: a task-notification user line (origin.kind is the reliable marker).
  if (o?.type === 'user' && o?.origin?.kind === 'task-notification' && typeof o?.message?.content === 'string') {
    const xml = o.message.content
    const taskId = tag(xml, 'task-id')
    if (!taskId) return null
    const summary = tag(xml, 'summary') ?? ''
    const exitMatch = summary.match(/exit code (\d+)/)
    return {
      kind: 'bg-done', taskId, toolUseId: tag(xml, 'tool-use-id'),
      status: tag(xml, 'status') ?? 'completed',
      exitCode: exitMatch ? Number(exitMatch[1]) : null,
      summary,
    }
  }

  // Launch: an assistant tool_use Bash with run_in_background:true.
  if (o?.type === 'assistant' && Array.isArray(o?.message?.content)) {
    for (const b of o.message.content) {
      if (b?.type === 'tool_use' && b?.name === 'Bash' && b?.input?.run_in_background === true && typeof b?.id === 'string') {
        return { kind: 'bg-launch', toolUseId: b.id,
          command: typeof b.input.command === 'string' ? b.input.command : '',
          label: typeof b.input.description === 'string' && b.input.description ? b.input.description : (b.input.command ?? '') }
      }
    }
    return null
  }

  // Launch result: a tool_result user line carrying the backgroundTaskId.
  if (o?.type === 'user' && typeof o?.toolUseResult?.backgroundTaskId === 'string') {
    const content = o?.message?.content
    const toolUseId = Array.isArray(content) ? (content.find((c: any) => c?.type === 'tool_result')?.tool_use_id ?? null) : null
    if (typeof toolUseId === 'string') return { kind: 'bg-result', toolUseId, taskId: o.toolUseResult.backgroundTaskId }
  }
  return null
}

/** The model id of an assistant transcript line (`message.model`), or null for non-assistant
 *  lines / missing model / unparseable input. */
export function extractModel(jsonl: string): string | null {
  let o: unknown
  try { o = JSON.parse(jsonl) } catch { return null }
  const r = o as { type?: unknown; message?: { model?: unknown } }
  if (r?.type !== 'assistant') return null
  const m = r.message?.model
  // Synthetic assistant lines (injected system turns) carry model "<synthetic>" — not a real model.
  return typeof m === 'string' && m && !m.startsWith('<') ? m : null
}

/** The most recent assistant model across a multi-line transcript blob, or null if none. */
export function latestModelIn(fileText: string): string | null {
  let latest: string | null = null
  for (const line of fileText.split('\n')) {
    const m = extractModel(line)
    if (m) latest = m
  }
  return latest
}

// The session status to emit for a transcript line, or null for no change. `done` fires ONLY on the
// line that carries the user-visible answer text — a terminal stop_reason AND a text block — NOT on
// every assistant message. Two reasons the text-block gate matters:
//  - Claude Code emits many assistant messages per turn (narration between tool calls, then the
//    final answer); a per-message `done` made the phone speak the narration and miss the answer.
//  - Claude Code flushes ONE assistant message to the transcript one content block at a time, and a
//    thinking block lands FIRST already carrying the turn's terminal stop_reason — seconds before
//    the text answer's own line. Reporting `done` on that thinking-only flush resolved the phone's
//    reply before the answer line existed, so it showed nothing. Requiring a text block (same gate
//    extractMirror uses) ties `done` to the line that actually holds the answer.
export function deriveStatus(jsonl: string): 'running' | 'done' | null {
  let o: any
  try { o = JSON.parse(jsonl) } catch { return null }

  if (o?.type === 'user') {
    if (o?.origin?.kind === 'task-notification') return null // not a user prompt; no status change
    if (typeof o?.message?.content !== 'string') return null // tool_result lists etc. — no status change
    if (/^\s*<channel\s+source=/.test(o.message.content)) return null // injected from the phone
    return 'running' // a locally-typed prompt means Claude is now working
  }

  if (o?.type === 'assistant') {
    const sr = o?.message?.stop_reason
    const isTerminal = isTerminalStop(sr)
    const content = o?.message?.content
    const hasText = Array.isArray(content) && content.some((b) => b?.type === 'text' && typeof b?.text === 'string')
    // tool_use / null / unknown stop_reason → still working. A terminal stop_reason on a thinking-
    // only flush (no text yet) is also still working; only the text-bearing line ends the turn.
    return isTerminal && hasText ? 'done' : 'running'
  }

  return null
}
