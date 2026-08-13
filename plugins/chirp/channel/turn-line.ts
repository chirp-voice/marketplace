import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// How many text-bearing projected lines the history backfill keeps. A mechanical bound on the
// payload, not a policy: the concierge reduces these to conversation turns (see relay/transcript.ts).
export const HISTORY_LINE_CAP = 120

const BASH_CAP = 40

/**
 * One transcript JSONL line, projected to the fields the concierge needs to interpret it.
 *
 * PRIVACY BOUNDARY — this is the ONLY shape that leaves the Mac. `tool_result` payloads,
 * thinking blocks, tool *inputs*, and raw line JSON stay here. `tools[].preview` is a
 * formatted label (a basename, a 40-char command prefix), never the full input.
 */
export type TurnLine = {
  role: 'user' | 'assistant' | 'other'
  stopReason: string | null
  isApiError: boolean
  /** Concatenated text blocks (assistant) or the prompt string (user). null when there is none —
   *  crucially including a `tool_result` list, which shares role 'user' but is not a prompt. */
  text: string | null
  tools: { name: string; preview: string }[]
  /** The user line was a phone-injected `<channel source="…">` prompt; `text` is the unwrapped inner. */
  injected: boolean
  taskNotification: boolean
}

/** Compact human label for a tool_use block. Never throws; falls back to the tool name.
 *  Stays plugin-side deliberately: formatting server-side would mean shipping raw tool
 *  inputs — i.e. file contents — over the wire. */
export function formatToolStep(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  /** A present, non-empty string field, or null — so every case below can fall back to the bare name. */
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

/** If `content` is a phone-injected `<channel source="…">…</channel>` envelope (Claude Code's
 *  wrapper for a prompt Chirp sent), return the inner prompt text; otherwise null. */
export function unwrapChannelPrompt(content: string): string | null {
  if (!/^\s*<channel\s+source=/.test(content)) return null
  return content
    .replace(/^\s*<channel\b[^>]*>/, '')
    .replace(/<\/channel>\s*$/, '')
    .trim()
}

/** Project one transcript JSONL line, or null if it is not parseable JSON. */
export function projectTurnLine(jsonl: string): TurnLine | null {
  let o: any
  try { o = JSON.parse(jsonl) } catch { return null }

  const base = {
    stopReason: null as string | null,
    isApiError: o?.isApiErrorMessage === true,
    text: null as string | null,
    tools: [] as { name: string; preview: string }[],
    injected: false,
    taskNotification: false,
  }

  if (o?.type === 'user') {
    const content = o?.message?.content
    const taskNotification = o?.origin?.kind === 'task-notification'
    // A non-string content is a tool_result list, not a prompt. Leaving `text` null is what
    // lets the concierge tell the two apart — they share role 'user'.
    if (typeof content !== 'string') return { ...base, role: 'user', taskNotification }
    const inner = unwrapChannelPrompt(content)
    // `inner || null`: an empty `<channel source="…"></channel>` envelope is still an injected
    // line, but it carries no prompt — keep the flag, drop the empty string.
    if (inner !== null) return { ...base, role: 'user', text: inner || null, injected: true, taskNotification }
    return { ...base, role: 'user', text: content.trim() || null, taskNotification }
  }

  if (o?.type === 'assistant') {
    const sr = o?.message?.stop_reason
    const content = o?.message?.content
    const blocks: any[] = Array.isArray(content) ? content : []
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    const tools = blocks
      .filter((b) => b?.type === 'tool_use' && typeof b?.name === 'string')
      .map((b) => ({ name: b.name as string, preview: formatToolStep(b.name, b.input) }))
    return {
      ...base,
      role: 'assistant',
      stopReason: typeof sr === 'string' ? sr : null,
      text: text || null,
      tools,
    }
  }

  return { ...base, role: 'other' }
}

/** Return the last assistant text that is not a task-notification, clipped to 200 codepoints.
 *  Scans in reverse so the newest turn wins. Returns null when no qualifying line is found. */
export function pickLastAssistantText(lines: TurnLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (l.role === 'assistant' && l.text && !l.taskNotification) return [...l.text].slice(0, 200).join('')
  }
  return null
}

/** Project the last `n` text-bearing lines of a transcript, for history backfill when the app
 *  opens a session. Text-bearing is a mechanical filter (drop tool_result / thinking-only lines),
 *  not a policy one — the concierge decides which of these become conversation turns. */
export function readRecentTurnLines(transcriptPath: string, n: number = HISTORY_LINE_CAP): TurnLine[] {
  let content: string
  try { content = readFileSync(transcriptPath, 'utf8') } catch { return [] }
  const out: TurnLine[] = []
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    const line = projectTurnLine(raw)
    // Keep every text-bearing line, whatever its flags — an injected prompt and a
    // task-notification are both real history. Only `text: null` lines (tool_result lists,
    // thinking-only assistant turns) and unparseable JSON are dropped.
    if (!line || line.text === null) continue
    out.push(line)
  }
  return out.slice(-n)
}
