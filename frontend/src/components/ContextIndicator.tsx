/**
 * CodeConClave — Context Indicator.
 * A compact pill in the header fed by the server-authoritative
 * GET /api/v1/workspace/context; clicking opens an inspector panel.
 * States: loading / ready / error (with retry). Never fakes data.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { WorkspaceContext } from '../lib/types';

export function ContextIndicator() {
  const [ctx, setCtx] = useState<WorkspaceContext | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<WorkspaceContext>('/api/v1/workspace/context');
      setCtx(res);
      setState('ready');
    } catch {
      setCtx(null);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const memoryCount = ctx?.memoryCount ?? 0;
  const dnaVersion = ctx?.dnaVersion ?? 0;
  const projectName = ctx?.project?.projectName ?? null;

  const label =
    state === 'loading'
      ? 'Context…'
      : state === 'error'
        ? 'Context unavailable'
        : `Mem ${memoryCount} · DNA v${dnaVersion}${projectName ? ` · ${projectName}` : ''}`;

  return (
    <div className="cc-context">
      <button className="cc-context__pill" onClick={() => (state === 'error' ? void load() : setOpen((o) => !o))} aria-label="Context indicator">
        <span className={`cc-context__dot${state === 'ready' && memoryCount > 0 ? ' loaded' : ''}`} aria-hidden="true" />
        {label}
      </button>
      {open && state === 'ready' && ctx && (
        <div className="cc-popover cc-context__panel" role="region" aria-label="Context details">
          <div className="cc-context__row">
            <span>Memory loaded</span>
            <span>{ctx.memoryLoaded ? 'yes' : 'no'}</span>
          </div>
          <div className="cc-context__row">
            <span>Memory items</span>
            <span>{ctx.memoryCount ?? 0}</span>
          </div>
          <div className="cc-context__row">
            <span>Memory source refs</span>
            <span>{ctx.memorySourceRefs ?? 0}</span>
          </div>
          <div className="cc-context__row">
            <span>DNA blocks</span>
            <span>{ctx.dnaCount ?? 0}</span>
          </div>
          <div className="cc-context__row">
            <span>DNA version</span>
            <span>v{ctx.dnaVersion ?? 0}</span>
          </div>
          <div className="cc-context__row">
            <span>Active project</span>
            <span>{ctx.project?.projectName ?? (ctx.project ? ctx.project.projectId : '—')}</span>
          </div>
          <div className="cc-context__row">
            <span>Relevant files</span>
            <span>{ctx.relevantFiles ?? 0}</span>
          </div>
          <p className="cc-popover__hint" style={{ padding: '6px 0 0' }}>
            Server-derived from your workspace state.
          </p>
        </div>
      )}
    </div>
  );
}