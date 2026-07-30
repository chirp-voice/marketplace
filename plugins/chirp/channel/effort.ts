import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Read the effective Claude Code `effortLevel`, merged across scopes (first found wins):
 *  project `.claude/settings.local.json` → project `.claude/settings.json` → user `~/.claude/settings.json`.
 *  Best-effort: returns null on unset / unreadable / malformed. */
export function readEffortLevel(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? cwd
  const home = env.HOME ?? homedir()
  const candidates = [
    join(projectDir, '.claude', 'settings.local.json'),
    join(projectDir, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ]
  for (const path of candidates) {
    try {
      const level = (JSON.parse(readFileSync(path, 'utf8')) as { effortLevel?: unknown }).effortLevel
      if (typeof level === 'string' && level) return level
    } catch { /* missing / malformed — try the next scope */ }
  }
  return null
}
