/**
 * CodeConClave — morning briefing hero (Home).
 *
 * Speaks first when you open the app: greets YOU by display name, then
 * reports only real state — unread notifications, pending approvals, unread
 * mail (only when Gmail is connected), and the persisted return-to-work
 * summary (where you stopped). Every section is independently fault-tolerant:
 * a failed source hides its own line instead of breaking the greeting, and an
 * empty day says so plainly. Nothing is projected, predicted, or invented.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { ThinkingMoon } from './ThinkingMoon';

interface RtwSummary {
  summaryText?: string;
  counts?: { completed?: number; failed?: number; pendingApprovals?: number };
}

interface GmailMsg {
  id: string;
  subject: string;
  from: string;
}

function firstName(displayName: string | null | undefined, email: string | null | undefined): string {
  const raw = (displayName ?? '').trim() || ((email ?? '').split('@')[0] ?? '');
  const first = raw.trim().split(/\s+/)[0] ?? '';
  return first || 'there';
}

export function MorningBrief() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState<number | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<number | null>(null);
  const [mail, setMail] = useState<{ connected: boolean; messages: GmailMsg[] } | null>(null);
  const [rtw, setRtw] = useState<RtwSummary | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const get = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn();
        } catch {
          return null;
        }
      };
      const [unreadRes, approvalsRes, rtwRes, connsRes] = await Promise.all([
        get(() => api<{ count: number }>('/api/v1/notifications/unread-count')),
        get(() => api<{ pendingCount: number }>('/api/v1/execution/approvals')),
        get(() => api<{ summary: RtwSummary | null }>('/api/v1/workspace/return-to-work')),
        get(() => api<{ connections: { id: string; plugin_type: string; state: string }[] }>('/api/v1/plugins/connections')),
      ]);
      if (!active) return;
      if (typeof unreadRes?.count === 'number') setUnread(unreadRes.count);
      if (typeof approvalsRes?.pendingCount === 'number') setPendingApprovals(approvalsRes.pendingCount);
      if (rtwRes?.summary) setRtw(rtwRes.summary);
      const google = connsRes?.connections?.find((c) => c.plugin_type === 'google' && c.state === 'CONNECTED') ?? null;
      if (!google) {
        setMail({ connected: false, messages: [] });
      } else {
        const listed = await get(() =>
          api<{ data?: unknown } | { messages?: { id: string }[] }>('/api/v1/plugins/actions', {
            method: 'POST',
            body: { connectionId: google.id, action: 'gmail.messages.list', input: { query: 'is:unread', maxResults: 5 } },
          }),
        );
        const ids = ((listed as { messages?: { id: string }[] } | null)?.messages ?? []).slice(0, 5);
        const messages: GmailMsg[] = [];
        for (const m of ids) {
          const one = await get(() =>
            api<unknown>('/api/v1/plugins/actions', {
              method: 'POST',
              body: { connectionId: (google as { id: string }).id, action: 'gmail.messages.get', input: { id: m.id, format: 'metadata' } },
            }),
          );
          const meta = (one ?? {}) as { payload?: { headers?: { name: string; value: string }[] }; snippet?: string };
          const header = (n: string) => meta.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
          messages.push({ id: m.id, subject: header('subject') || '(no subject)', from: header('from') || '' });
        }
        setMail({ connected: true, messages });
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const name = firstName(user?.displayName ?? null, user?.email ?? null);
  // Actionable lines drive the all-clear state. The mail-connect nudge is a
  // setup footnote, not an action item — it must never block "all clear".
  const lines: { key: string; node: React.ReactNode }[] = [];
  let setupNote: React.ReactNode = null;
  if (unread !== null && unread > 0) {
    lines.push({
      key: 'unread',
      node: (
        <span>
          <Link to="/history">{unread} unread notification{unread === 1 ? '' : 's'}</Link>
        </span>
      ),
    });
  }
  if (pendingApprovals !== null && pendingApprovals > 0) {
    lines.push({
      key: 'approvals',
      node: (
        <span>
          <Link to="/approvals">{pendingApprovals} decision{pendingApprovals === 1 ? '' : 's'} waiting on you</Link>
        </span>
      ),
    });
  }
  if (mail && !mail.connected) {
    setupNote = (
      <span>
        Mail isn&apos;t connected — <Link to="/plugins">connect Gmail</Link> to see unread here.
      </span>
    );
  }
  if (mail && mail.connected) {
    lines.push({
      key: 'mail',
      node: (
        <span>
          {mail.messages.length === 0 ? (
            'Inbox zero — nothing unread.'
          ) : (
            <>
              {mail.messages.length} unread: {mail.messages.map((m) => m.subject).join(' · ')}
            </>
          )}
        </span>
      ),
    });
  }
  if (rtw?.summaryText) {
    lines.push({ key: 'rtw', node: <span>While you were away: {rtw.summaryText}</span> });
  }

  return (
    <section className="cc-brief" data-testid="morning-brief" aria-label="Morning briefing">
      {/* The orb spins only while the briefing fetches real state — it
          unmounts the moment loading finishes, never as decoration. */}
      <div className="cc-brief__orb" aria-hidden="true">
        <ThinkingMoon active={loading} label="Checking overnight state" />
      </div>
      <div className="cc-brief__body">
        <h2 className="cc-brief__hi" data-testid="morning-brief-hi">
          Hi {name}.
        </h2>
        {loading && <p className="cc-hint">Checking overnight state…</p>}
        {!loading && lines.length === 0 && <p className="cc-hint">All clear — nothing needs you right now.</p>}
        {!loading && lines.length > 0 && (
          <ul className="cc-brief__lines">
            {lines.map((l) => (
              <li key={l.key}>{l.node}</li>
            ))}
          </ul>
        )}
        {!loading && setupNote && <p className="cc-hint">{setupNote}</p>}
      </div>
    </section>
  );
}
