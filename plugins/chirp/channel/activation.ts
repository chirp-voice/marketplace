import { execFileSync } from 'node:child_process'

// Whether this Claude Code session can actually receive relay prompts is decided inside
// Claude Code by a gate we cannot query: the server is only fed `notifications/claude/channel`
// when the session was launched with `--channels`/`--dangerously-load-development-channels`
// naming this plugin. The gate is silent — no error comes back and no toast is shown — so the
// only signal available to us is the owning `claude` process's argv, which we reach by walking
// our own process ancestry (node ← tsx ← npm exec ← claude).
//
// This is BEST EFFORT and deliberately biased: every inconclusive branch reports `true`
// (controllable). A false negative would mark a working session view-only, which is strictly
// worse than the status quo; a false positive is exactly the status quo.
//
// macOS only. `process.title="claude"` does not clobber argv here because `ps` reads the
// original exec arguments from the kernel — on Linux the same assignment overwrites the argv
// region, so we bail to `true` off darwin rather than read a lie.

export type ProcRow = { pid: number; ppid: number; args: string }

const CHANNEL_FLAGS = new Set(['--channels', '--dangerously-load-development-channels'])
/** Our plugin's name as it appears in a `plugin:<name>@<marketplace>` channel entry. */
const PLUGIN_NAME = 'chirp'

/** Parse `ps -axww -o pid=,ppid=,args=` output. Malformed lines are skipped. */
export function parseProcTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return rows
}

/** True when this argv is the Claude Code CLI itself, not something that merely mentions it.
 *  Matches the executable token only (`claude`, `/usr/local/bin/claude`), never a path argument. */
function isClaudeProcess(args: string): boolean {
  const exe = args.split(' ')[0] ?? ''
  return /(^|\/)claude$/.test(exe)
}

/** Walk the ppid chain from `startPid` and return the first Claude Code ancestor, or null.
 *  Bounded by `maxDepth` and a visited-set so a malformed table cannot spin. */
export function findClaudeAncestor(rows: ProcRow[], startPid: number, maxDepth = 12): ProcRow | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const seen = new Set<number>()
  let pid = startPid
  for (let depth = 0; depth < maxDepth; depth++) {
    if (seen.has(pid)) return null
    seen.add(pid)
    const row = byPid.get(pid)
    if (!row) return null
    if (isClaudeProcess(row.args)) return row
    if (row.ppid <= 1) return null
    pid = row.ppid
  }
  return null
}

/** Minimal shell tokenizer: splits args into tokens, treating single- and double-quoted
 *  strings as single opaque tokens. Sufficient for reading `ps args=` output. */
function shellTokenize(args: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < args.length) {
    // skip whitespace between tokens
    while (i < args.length && /\s/.test(args[i])) i++
    if (i >= args.length) break
    const quote = args[i] === '"' || args[i] === "'" ? args[i] : null
    if (quote) {
      // consume to matching close quote (no escape handling needed for our purpose)
      const end = args.indexOf(quote, i + 1)
      tokens.push(end === -1 ? args.slice(i) : args.slice(i, end + 1))
      i = end === -1 ? args.length : end + 1
    } else {
      // unquoted token — ends at next whitespace
      const start = i
      while (i < args.length && !/\s/.test(args[i])) i++
      tokens.push(args.slice(start, i))
    }
  }
  return tokens
}

/** Extract the channel entries a claude argv activates. Both flags are variadic
 *  (`<servers...>`), so each consumes tokens until the next `-`-prefixed flag.
 *  Quoted tokens (e.g. `"explain --channels to me"`) are treated as single opaque
 *  values and never trigger flag matching. */
export function parseChannelArgs(args: string): string[] {
  const tokens = shellTokenize(args)
  const entries: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!CHANNEL_FLAGS.has(tokens[i])) continue
    for (let j = i + 1; j < tokens.length && !tokens[j].startsWith('-'); j++) entries.push(tokens[j])
  }
  return entries
}

/** Does any entry activate this plugin? Mirrors Claude Code's own matching: our MCP server is
 *  named `plugin:chirp:chirp-channel`, so a `plugin:<name>@<marketplace>` entry matches on
 *  <name> alone (the marketplace mismatch is a separate, non-silent skip we don't model).
 *  A bare non-plugin entry mentioning our channel counts too, biasing toward fail-open. */
export function activatesChirp(entries: string[], pluginName: string = PLUGIN_NAME): boolean {
  return entries.some((e) => {
    const plugin = /^plugin:([^@]+)(@.*)?$/.exec(e)
    if (plugin) return plugin[1] === pluginName
    return e.includes('chirp')
  })
}

/** Best-effort: can this session actually receive relay prompts?
 *  TRUE whenever we cannot prove otherwise — see the fail-open note at the top of this file. */
export function detectControllable(deps: {
  platform?: string
  pid?: number
  readProcTable?: () => string
} = {}): boolean {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return true
  const readProcTable = deps.readProcTable ??
    (() => execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000 }))
  let rows: ProcRow[]
  try {
    rows = parseProcTable(readProcTable())
  } catch {
    return true // ps unavailable or slow — assume controllable
  }
  const claude = findClaudeAncestor(rows, deps.pid ?? process.pid)
  if (!claude) return true // not launched by Claude Code (or ancestry broken)
  // A found claude ancestor with no channel flags at all is the one case we can call
  // definitively: this session cannot receive prompts.
  return activatesChirp(parseChannelArgs(claude.args))
}
