import type { TaskLine } from './transcript-scan.js'
import type { RunningTask, CompletedTask, TaskStartFrame, TaskDoneFrame } from './frames.js'

export type { RunningTask, CompletedTask }
// TaskFrame is the outbound subset that TaskTracker.apply() can return (task-start + task-done).
// task-snapshot is emitted directly in chirp-channel.ts on a task-snapshot-request, not via TaskTracker.
export type TaskFrame = TaskStartFrame | TaskDoneFrame

export const RECENT_CAP = 20

/** Correlates bg-launch→bg-result→bg-done into a running map + bounded recentlyCompleted.
 *  `apply` returns the frame to emit (or null). `now` is injectable for tests. */
export class TaskTracker {
  private pending = new Map<string, { command: string; label: string }>() // toolUseId → launch info
  private running = new Map<string, RunningTask>()                          // taskId → task
  private completed: CompletedTask[] = []
  constructor(private now: () => number = () => Date.now()) {}

  apply(line: TaskLine): TaskFrame | null {
    if (line.kind === 'bg-launch') { this.pending.set(line.toolUseId, { command: line.command, label: line.label }); return null }
    if (line.kind === 'bg-result') {
      const p = this.pending.get(line.toolUseId)
      this.pending.delete(line.toolUseId)
      const task: RunningTask = { taskId: line.taskId, label: p?.label ?? line.taskId, command: p?.command ?? '', startedAt: this.now() }
      this.running.set(line.taskId, task)
      return { kind: 'task-start', task }
    }
    // bg-done
    const r = this.running.get(line.taskId)
    this.running.delete(line.taskId)
    const label = r?.label ?? line.summary
    this.completed.push({ taskId: line.taskId, label, status: line.status, exitCode: line.exitCode, summary: line.summary, completedAt: this.now() })
    if (this.completed.length > RECENT_CAP) this.completed = this.completed.slice(-RECENT_CAP)
    return { kind: 'task-done', taskId: line.taskId, status: line.status, exitCode: line.exitCode, summary: line.summary, label }
  }

  snapshot(): { running: RunningTask[]; recentlyCompleted: CompletedTask[] } {
    return { running: [...this.running.values()], recentlyCompleted: [...this.completed] }
  }
}
