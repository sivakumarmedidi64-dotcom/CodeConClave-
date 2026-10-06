/**
 * CodeConClave — Workbench data panels.
 * Every panel renders REAL server payloads (task timeline, coworker runs,
 * artifacts, memory, handoffs, activity, audit) with honest loading / empty /
 * unavailable states. Nothing here is fabricated.
 */
import type { Memory, TaskStep, TaskToolCall, TaskAttempt, TaskTimeline } from '../../lib/types';
import {
  statusMeta,
  artifactValue,
  normalizeCoworkerRuns,
  type ActivityEvent,
  type AuditEvent,
  type CoworkerHandoff,
  type WorkbenchCoworkerRun,
} from '../../lib/workbench';

function Pill({ label, color, testid }: { label: string; color: string; testid?: string }) {
  return (
    <span className="cc-pill" style={{ background: color, color: '#fff', fontWeight: 700 }} data-testid={testid}>
      {label}
    </span>
  );
}

function Skeleton({ label }: { label: string }) {
  return <p className="cc-hint" data-testid="panel-loading">{label}</p>;
}

/* ---------------------------------------------------------------- task */

export function TaskPanel({
  timeline,
  loading,
  error,
}: {
  timeline: TaskTimeline | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading && !timeline) return <Skeleton label="Loading task…" />;
  if (error && !timeline) return <p className="cc-hint cc-hint--error">{error}</p>;
  if (!timeline?.task) return <p className="cc-hint">No task selected.</p>;

  const task = timeline.task;
  const meta = statusMeta(task.status);
  const steps = timeline.steps ?? [];
  const attempts = timeline.attempts ?? [];
  const toolCalls = timeline.toolCalls ?? [];

  return (
    <div className="wb-pane" data-testid="task-panel">
      <div className="wb-pane__head">
        <span className="wb-pane__title">{task.title}</span>
        <Pill label={meta.label} color={meta.color} testid="task-status" />
      </div>

      {task.description && <p className="cc-hint" style={{ margin: '4px 0 8px' }}>{task.description}</p>}
      <dl className="wb-kv">
        <dt>Mode</dt>
        <dd>{task.executionMode}</dd>
        <dt>Risk</dt>
        <dd>{task.riskLevel}</dd>
        <dt>Pipeline</dt>
        <dd>{task.coworkerPipeline.length ? task.coworkerPipeline.join(' → ') : '—'}</dd>
      </dl>

      {attempts.length > 0 && (
        <section className="wb-section">
          <h4>Attempts</h4>
          {attempts.map((a: TaskAttempt) => (
            <div className="wb-row" key={a.id} data-testid="attempt-row">
              <span className="cc-mono" style={{ fontSize: 11 }}>#{a.attempt_number}</span>
              <span className="cc-hint" style={{ fontSize: 11 }}>{a.result ?? a.error_code ?? 'in progress'}</span>
            </div>
          ))}
        </section>
      )}

      <section className="wb-section">
        <h4>Steps ({steps.length})</h4>
        {steps.length === 0 && <p className="cc-hint" style={{ fontSize: 11 }}>No steps recorded yet.</p>}
        {steps.map((s: TaskStep) => {
          const sMeta = statusMeta(s.status);
          return (
            <div className="wb-row wb-row--stack" key={s.id} data-testid="step-row">
              <div className="wb-row">
                <span className="cc-mono" style={{ fontSize: 11 }}>{s.kind}</span>
                <Pill label={sMeta.label} color={sMeta.color} />
              </div>
              <span className="wb-row__text">{s.title}</span>
              {s.error_code && <span className="cc-hint cc-hint--error" style={{ fontSize: 11 }}>{s.error_code}</span>}
            </div>
          );
        })}
      </section>

      {toolCalls.length > 0 && (
        <section className="wb-section">
          <h4>Tool calls ({toolCalls.length})</h4>
          {toolCalls.map((t: TaskToolCall) => (
            <div className="wb-row" key={t.id} data-testid="toolcall-row">
              <span className="cc-mono" style={{ fontSize: 11 }}>{t.tool}</span>
              <span className="cc-hint" style={{ fontSize: 11 }}>{t.decision}</span>
            </div>
          ))}
        </section>
      )}

      {!!timeline.failureInfo && (
        <p className="cc-hint cc-hint--error" data-testid="task-failure">Failure: {JSON.stringify(timeline.failureInfo)}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- agents */

function runOutput(r: WorkbenchCoworkerRun): string {
  return r.output && r.output.length > 300 ? `${r.output.slice(0, 300)}…` : r.output ?? '';
}

const RUN_META: Record<string, string> = {
  QUEUED: '#64748b',
  RUNNING: '#8A3FFC',
  VERIFYING: '#8A3FFC',
  COMPLETED: '#1e7d46',
  FAILED: '#dc2626',
  TIMED_OUT: '#dc2626',
  CANCELLED: '#8a8a8a',
  BLOCKED: '#dc2626',
};

const VERIFY_META: Record<string, { label: string; color: string }> = {
  PASS: { label: 'Verified', color: '#1e7d46' },
  FAIL: { label: 'Failed', color: '#dc2626' },
  SKIPPED: { label: 'Skipped', color: '#8a8a8a' },
};

export function AgentPanel({
  coworkerRuns,
  handoffs,
}: {
  coworkerRuns: WorkbenchCoworkerRun[];
  handoffs: CoworkerHandoff[];
}) {
  if (!coworkerRuns.length && !handoffs.length) {
    return <p className="cc-hint">No agent runs for this task yet.</p>;
  }
  return (
    <div className="wb-pane" data-testid="agent-panel">
      <section className="wb-section">
        <h4>Participating agents ({coworkerRuns.length})</h4>
        {coworkerRuns.map((r) => (
          <div className="wb-row wb-row--stack" key={r.id} data-testid="coworker-run">
            <div className="wb-row">
              <span className="wb-row__text">{r.coworkerType}</span>
              <Pill label={r.state} color={RUN_META[r.state] ?? '#334155'} />
              {r.verification ? <Pill label={VERIFY_META[r.verification]?.label ?? r.verification} color={VERIFY_META[r.verification]?.color ?? '#334155'} /> : null}
            </div>
            {r.error && <span className="cc-hint cc-hint--error" style={{ fontSize: 11 }}>{r.error}</span>}
            {runOutput(r) && <pre className="cc-mono wb-snippet">{runOutput(r)}</pre>}
          </div>
        ))}
      </section>
      {handoffs.length > 0 && (
        <section className="wb-section" data-testid="handoff-list">
          <h4>Handoffs ({handoffs.length})</h4>
          {handoffs.map((h) => (
            <div className="wb-row wb-row--stack" key={h.id}>
              <span className="wb-row__text">{h.handoff_summary || h.handoff_title || '(handoff)'}</span>
              <span className="cc-hint" style={{ fontSize: 11 }}>{h.created_at ?? ''}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- verification */

export function VerificationPanel({
  coworkerRuns,
  failureInfo,
}: {
  coworkerRuns: WorkbenchCoworkerRun[];
  failureInfo: unknown | null;
}) {
  if (!coworkerRuns.length) {
    return <p className="cc-hint">No verification results yet.</p>;
  }
  const counts = coworkerRuns.reduce(
    (acc, r) => {
      const v = r.verification;
      if (v === 'PASS') acc.pass += 1;
      else if (v === 'FAIL') acc.fail += 1;
      else if (v === 'SKIPPED') acc.skip += 1;
      else acc.none += 1;
      return acc;
    },
    { pass: 0, fail: 0, skip: 0, none: 0 },
  );
  return (
    <div className="wb-pane" data-testid="verification-panel">
      <div className="wb-kv">
        <dt>Pass</dt>
        <dd className="wb-ok">{counts.pass}</dd>
        <dt>Fail</dt>
        <dd className="wb-bad">{counts.fail}</dd>
        <dt>Skipped</dt>
        <dd>{counts.skip}</dd>
        <dt>Unverified</dt>
        <dd>{counts.none}</dd>
      </div>
      <p className="cc-hint" style={{ fontSize: 11 }}>
        PASS reflects a real verification result recorded by the task engine — never a client-side guess.
      </p>
      {!!failureInfo && <p className="cc-hint cc-hint--error" style={{ fontSize: 12 }}>Failure context: {JSON.stringify(failureInfo)}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- artifacts */

export function ArtifactPanel({
  artifacts,
  loading,
}: {
  artifacts: Record<string, unknown>[];
  loading: boolean;
}) {
  if (loading && !artifacts.length) return <Skeleton label="Loading artifacts…" />;
  if (!artifacts.length) return <p className="cc-hint">No artifacts for this task.</p>;

  const sha = (a: Record<string, unknown>): string => {
    const v = artifactValue<string | undefined>(a, ['sha256', 'sha_256'], undefined);
    return v ? `${v.slice(0, 8)}…` : '—';
  };
  const size = (a: Record<string, unknown>): number =>
    artifactValue<number>(a, ['size_bytes', 'sizeBytes'], 0);
  const verification = (a: Record<string, unknown>): string | null =>
    artifactValue<string | null>(a, ['verification', 'verification_result'], null);

  return (
    <div className="wb-pane" data-testid="artifact-panel">
      <table className="wb-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Source</th>
            <th>Kind</th>
            <th>Check</th>
            <th>SHA-256</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((a) => {
            const id = artifactValue<string>(a, ['id'], '');
            const name = artifactValue<string>(a, ['name'], 'artifact');
            const source = artifactValue<string>(a, ['run', 'coworker_type', 'coworkerType', 'source'], '—');
            const kind = artifactValue<string>(a, ['kind'], '—');
            const v = verification(a);
            return (
              <tr key={id} data-testid="artifact-row">
                <td>
                  <a href={`/api/v1/artifacts/${encodeURIComponent(id)}/download`} className="cc-link" download>
                    {name}
                  </a>
                </td>
                <td className="cc-hint">{source}</td>
                <td className="cc-hint">{kind}</td>
                <td>
                  <Pill label={v ?? 'None'} color={v ? (VERIFY_META[v]?.color ?? '#64748b') : '#64748b'} />
                </td>
                <td className="cc-mono" style={{ fontSize: 10 }}>{sha(a)}</td>
                <td className="cc-hint">{size(a)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- memory */

const MEMORY_TYPE_LABEL: Record<string, string> = {
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
  PROCEDURAL: 'procedural',
  PROJECT: 'project',
  TEAM: 'team',
};

export function MemoryPanel({
  memories,
  handoffs,
  loading,
}: {
  memories: Memory[];
  handoffs: CoworkerHandoff[];
  loading: boolean;
}) {
  if (loading && !memories.length) return <Skeleton label="Loading memory…" />;
  return (
    <div className="wb-pane" data-testid="memory-panel">
      <section className="wb-section">
        <h4>Memory ({memories.length})</h4>
        {!memories.length && <p className="cc-hint">No project memory yet.</p>}
        {memories.map((m) => (
          <div className="wb-row wb-row--stack" key={m.id} data-testid="memory-row">
            <div className="wb-row">
              <span className={`wb-badge wb-badge--${m.confidence}`}>{MEMORY_TYPE_LABEL[m.type] ?? m.type}</span>
              <span className="cc-hint" style={{ fontSize: 11 }}>{m.confidence}{m.flagged ? ' · flagged' : ''}</span>
            </div>
            <span className="wb-row__text">{m.content}</span>
          </div>
        ))}
      </section>
      {handoffs.length > 0 && (
        <section className="wb-section">
          <h4>Project handoffs ({handoffs.length})</h4>
          {handoffs.map((h) => (
            <div className="wb-row wb-row--stack" key={h.id}>
              <span className="wb-row__text">{h.handoff_title ?? h.handoff_summary ?? '(handoff)'}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- activity */

function timeOf(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { hour12: false });
  } catch {
    return '';
  }
}

export function ActivityPanel({ events, loading }: { events: ActivityEvent[]; loading: boolean }) {
  if (loading && !events.length) return <Skeleton label="Loading activity…" />;
  if (!events.length) return <p className="cc-hint">No project activity yet.</p>;
  return (
    <div className="wb-pane" data-testid="activity-panel">
      {events.map((e) => (
        <div className="wb-row wb-row--stack" key={e.id} data-testid="activity-row">
          <div className="wb-row">
            <span className="cc-mono" style={{ fontSize: 10 }}>{e.action}</span>
            <span className="cc-hint" style={{ fontSize: 10 }}>{timeOf(e.createdAt)}</span>
          </div>
          {e.summary && <span className="wb-row__text">{e.summary}</span>}
          {(e.resourceType || e.resourceId) && (
            <span className="cc-hint" style={{ fontSize: 10 }}>{e.resourceType} {e.resourceId}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- audit */

export function AuditPanel({ events, loading }: { events: AuditEvent[]; loading: boolean }) {
  if (loading && !events.length) return <Skeleton label="Loading audit…" />;
  if (!events.length) return <p className="cc-hint">No audit entries.</p>;
  return (
    <div className="wb-pane" data-testid="audit-panel">
      {events.map((e) => (
        <div className="wb-row wb-row--stack" key={e.id} data-testid="audit-row">
          <div className="wb-row">
            <span className="cc-mono" style={{ fontSize: 10 }}>{e.action ?? '—'}</span>
            <span className="cc-hint" style={{ fontSize: 10 }}>{timeOf(e.created_at)}</span>
          </div>
          {(e.resource_type || e.resource_id) && (
            <span className="cc-hint" style={{ fontSize: 10 }}>{e.resource_type} {e.resource_id}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function selectedCoworkerRuns(timeline: TaskTimeline | null): WorkbenchCoworkerRun[] {
  return normalizeCoworkerRuns(timeline?.coworkerRuns ?? []);
}