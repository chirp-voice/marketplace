import { execSync } from 'node:child_process'
import { basename } from 'node:path'

// The session label shown in the phone's sessions list. Default = "<repo basename> · <branch>"
// (e.g. "chirp · main") so parallel sessions on the same repo (different branches/worktrees) are
// distinguishable. CHIRP_SESSION_LABEL overrides; off-git it falls back to the project-dir basename.

/** Pure: precedence + formatting. `repoRoot`/`branch` are the git results (null if unavailable). */
export function formatLabel(o: {
  override?: string
  repoRoot?: string | null
  branch?: string | null
  projectDir?: string
  cwd: string
}): string {
  if (o.override) return o.override
  if (o.repoRoot) {
    const repo = basename(o.repoRoot)
    const branch = o.branch && o.branch !== 'HEAD' ? o.branch : null // detached HEAD → repo alone
    return branch ? `${repo} · ${branch}` : repo
  }
  return basename(o.projectDir ?? o.cwd)
}

function gitOut(dir: string, args: string[]): string | null {
  try {
    const out = execSync(`git ${args.join(' ')}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return out || null
  } catch {
    return null // not a git repo / git absent → caller falls back to the basename
  }
}

/** Gather git info from the project dir, then format. */
export function deriveLabel(env: NodeJS.ProcessEnv, cwd: string): string {
  const override = env.CHIRP_SESSION_LABEL
  if (override) return override
  const projectDir = env.CLAUDE_PROJECT_DIR ?? cwd
  return formatLabel({
    repoRoot: gitOut(projectDir, ['rev-parse', '--show-toplevel']),
    branch: gitOut(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    projectDir: env.CLAUDE_PROJECT_DIR,
    cwd,
  })
}
