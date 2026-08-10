import { describe, test, expect, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../channel-check.sh', import.meta.url))

/**
 * Spawn a long-running `tail -f /dev/null` process with a controlled argv0.
 * macOS `ps -o args=` reads the original exec arguments from the kernel, so the
 * full argv0 string (even multi-word) appears verbatim — this is the same behaviour
 * the shell pid-walk relies on. Returns the child's PID; caller must kill() it.
 */
function spawnFakeClaude(argv0: string): { pid: number; child: ChildProcess } {
  const child = spawn('/usr/bin/tail', ['-f', '/dev/null'], {
    argv0,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  if (!child.pid) throw new Error('Failed to spawn fake claude process')
  return { pid: child.pid, child }
}

/** Run channel-check.sh with CHIRP_HOOK_PID set to the given pid. */
function run(pid: number): string {
  return execFileSync('bash', [script], {
    env: { ...process.env, CHIRP_HOOK_PID: String(pid) },
    encoding: 'utf8',
  })
}

describe('channel-check.sh', () => {
  const children: ChildProcess[] = []

  afterEach(() => {
    for (const child of children) {
      try {
        if (child.pid) process.kill(child.pid)
      } catch {
        // already exited
      }
    }
    children.length = 0
  })

  test('(a) emits JSON systemMessage when the ancestor is bare `claude`', () => {
    const { pid, child } = spawnFakeClaude('claude')
    children.push(child)
    const out = run(pid)
    const parsed = JSON.parse(out.trim())
    expect(parsed.systemMessage).toContain('view-only')
    expect(parsed.systemMessage).toContain('--channels plugin:chirp@chirp-voice')
  })

  test('(b) stays silent when the ancestor is `claude --channels plugin:chirp@chirp-voice`', () => {
    const { pid, child } = spawnFakeClaude('claude --channels plugin:chirp@chirp-voice')
    children.push(child)
    expect(run(pid).trim()).toBe('')
  })

  test('(c) stays silent when there is no claude ancestor (fail-open)', () => {
    // PID 1 (launchd/init) is always present and is never named `claude`; the
    // walk terminates at ppid ≤ 1 and sets parent_args="", so the script exits 0 silently.
    expect(run(1).trim()).toBe('')
  })

  test('(d) stays silent for `--dangerously-load-development-channels plugin:chirp@chirp-plugin`', () => {
    const { pid, child } = spawnFakeClaude('claude --dangerously-load-development-channels plugin:chirp@chirp-plugin')
    children.push(child)
    expect(run(pid).trim()).toBe('')
  })

  test('(e) nudges when a channel is activated but it is not chirp', () => {
    const { pid, child } = spawnFakeClaude('claude --channels plugin:telegram@claude-plugins-official')
    children.push(child)
    const out = run(pid).trim()
    // No chirp in the channel list -> should nudge (this session is view-only from Chirp's perspective)
    expect(JSON.parse(out).systemMessage).toContain('view-only')
  })

  test('(f) emits JSON that is well-formed (parseable) when nudging', () => {
    const { pid, child } = spawnFakeClaude('claude')
    children.push(child)
    const out = run(pid)
    expect(() => JSON.parse(out.trim())).not.toThrow()
  })
})
