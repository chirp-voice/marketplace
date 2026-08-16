// Mechanical scanning of Claude Code transcript files: where they are, what model wrote a line,
// and which lines are background-task lifecycle events. Interpretation of a line's *meaning*
// (what counts as a finished turn, what the answer is, what status that implies) lives in the
// concierge — see concierge/src/relay/transcript.ts. The projection that feeds it is turn-line.ts.
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Resolve the active session's id from its transcript when no id is supplied in the environment.
// Current Claude Code builds (2.1.170+) inject CLAUDE_CODE_SESSION_ID alongside CLAUDE_PROJECT_DIR
// into a channel MCP server's env (see the identity notes in chirp-channel.ts), so this is a
// fallback for older builds that inject only CLAUDE_PROJECT_DIR. For them we recover the id from
// the project's transcript folder:
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
