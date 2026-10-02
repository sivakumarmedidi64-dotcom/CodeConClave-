/**
 * CodeConClave Desktop — local task monitor (background task monitoring).
 * Tracks LOCAL work (terminal sessions, git runs, attach operations) for the
 * desktop "Tasks" surface. Cloud task state (agents, background execution)
 * remains with the backend/the reused web UI — this monitor is explicitly
 * local-only and never invents cloud state.
 */
import type { TaskSummary } from '../types.js';
import { WorkspaceManager } from './workspace.js';

export interface MonitorEvents {
  onTasksChanged?: (tasks: TaskSummary[]) => void;
}

export class LocalTaskMonitor {
  private readonly tasks: TaskSummary[] = [];

  constructor(
    private readonly ws: WorkspaceManager,
    private readonly events: MonitorEvents = {},
  ) {}

  begin(kind: TaskSummary['kind'], label: string): TaskSummary {
    const task: TaskSummary = {
      id: `task-${Math.random().toString(36).slice(2, 10)}`,
      kind,
      label,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.emit();
    return task;
  }

  finish(id: string, status: 'SUCCEEDED' | 'FAILED' | 'RUNNING'): void {
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.status = status;
      this.emit();
    }
  }

  list(): TaskSummary[] {
    this.ws.requireActive('task.monitor');
    return [...this.tasks].map((t) => ({ ...t }));
  }

  private emit(): void {
    this.events.onTasksChanged?.(this.list());
  }
}