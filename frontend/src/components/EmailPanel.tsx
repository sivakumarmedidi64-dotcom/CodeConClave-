/**
 * CodeConClave — Email: one-box Gmail connect, inbox, reading, replies.
 *
 * Type your address, click Connect, approve once at Google (Google's rule —
 * CodeConclave never sees your password), then read mail and write replies
 * without leaving CodeConClave. Replies are SEND-permission actions: the
 * server proposes an approval and nothing sends until you approve it in the
 * Approval Center. Every state here comes from a real API — no demo mail.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface PluginConnection {
  id: string;
  plugin_type: string;
  state: string;
  name?: string;
}

interface MailRow {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
}

interface OpenMail extends MailRow {
  body: string;
  truncated: boolean;
  threadId: string;
  messageId: string;
}

function msg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
}

function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  const addr = (m?.[1] ?? from).trim();
  return addr || from.trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailPanel() {
  const [conn, setConn] = useState<PluginConnection | null>(null);
  const [connState, setConnState] = useState<'loading' | 'ready'>('loading');
  const [email, setEmail] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [rows, setRows] = useState<MailRow[]>([]);
  const [inboxState, setInboxState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenMail | null>(null);
  const [opening, setOpening] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ kind: 'approval'; approvalId: string } | { kind: 'sent'; id: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const loadConnection = useCallback(async () => {
    setConnState('loading');
    try {
      const res = await api<{ connections: PluginConnection[] }>('/api/v1/plugins/connections');
      const google = res.connections?.find((c) => c.plugin_type === 'google' && c.state === 'CONNECTED') ?? null;
      setConn(google);
    } catch {
      setConn(null);
    } finally {
      setConnState('ready');
    }
  }, []);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  const loadInbox = useCallback(async () => {
    if (!conn) return;
    setInboxState('loading');
    setInboxError(null);
    try {
      const listed = await api<{ messages?: { id: string }[] }>('/api/v1/plugins/actions', {
        method: 'POST',
        body: { connectionId: conn.id, action: 'gmail.messages.list', input: { query: 'is:unread', maxResults: 10 } },
      });
      const ids = (listed.messages ?? []).slice(0, 10);
      const out: MailRow[] = [];
      for (const m of ids) {
        const one = (await api<unknown>('/api/v1/plugins/actions', {
          method: 'POST',
          body: { connectionId: conn.id, action: 'gmail.messages.get', input: { id: m.id, format: 'metadata' } },
        })) as { payload?: { headers?: { name: string; value: string }[] }; snippet?: string };
        out.push({
          id: m.id,
          subject: header(one.payload?.headers, 'subject') || '(no subject)',
          from: header(one.payload?.headers, 'from'),
          snippet: typeof one.snippet === 'string' ? one.snippet : '',
          date: header(one.payload?.headers, 'date'),
        });
      }
      setRows(out);
      setInboxState('ready');
    } catch (e) {
      setInboxError(msg(e, 'Could not load the inbox'));
      setInboxState('error');
    }
  }, [conn]);

  useEffect(() => {
    if (conn) void loadInbox();
  }, [conn, loadInbox]);

  const connect = async () => {
    const address = email.trim();
    if (!EMAIL_RE.test(address) || connecting) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const created = await api<{ connection: PluginConnection }>('/api/v1/plugins/connections', {
        method: 'POST',
        body: { pluginType: 'google', name: address },
      });
      const { authUrl } = await api<{ authUrl: string }>(
        `/api/v1/plugins/oauth/${created.connection.id}/authorize?hint=${encodeURIComponent(address)}`,
      );
      window.location.href = authUrl;
    } catch (e) {
      setConnectError(msg(e, 'Could not start connecting'));
    } finally {
      setConnecting(false);
    }
  };

  const openMail = async (row: MailRow) => {
    if (!conn || opening) return;
    setOpening(true);
    setSendResult(null);
    setSendError(null);
    try {
      const full = (await api<unknown>('/api/v1/plugins/actions', {
        method: 'POST',
        body: { connectionId: conn.id, action: 'gmail.messages.get', input: { id: row.id, format: 'full' } },
      })) as {
        payload?: { headers?: { name: string; value: string }[] };
        snippet?: string;
        threadId?: string;
        bodyText?: string;
        bodyTruncated?: boolean;
      };
      setOpen({
        ...row,
        subject: header(full.payload?.headers, 'subject') || row.subject,
        from: header(full.payload?.headers, 'from') || row.from,
        date: header(full.payload?.headers, 'date') || row.date,
        body: typeof full.bodyText === 'string' ? full.bodyText : typeof full.snippet === 'string' ? full.snippet : '',
        truncated: full.bodyTruncated === true,
        threadId: typeof full.threadId === 'string' ? full.threadId : '',
        messageId: header(full.payload?.headers, 'message-id'),
      });
      setReply('');
    } catch (e) {
      setInboxError(msg(e, 'Could not open this mail'));
    } finally {
      setOpening(false);
    }
  };

  const sendReply = async () => {
    if (!conn || !open || !reply.trim() || sending) return;
    setSending(true);
    setSendError(null);
    setSendResult(null);
    try {
      const to = addressOf(open.from);
      const subject = `Re: ${open.subject}`.slice(0, 200);
      const res = await api<{ requiresApproval?: boolean; approval?: { id: string }; executed?: boolean; result?: { id?: string } }>(
        '/api/v1/plugins/actions',
        {
          method: 'POST',
          body: {
            connectionId: conn.id,
            action: 'gmail.send',
            input: {
              to: [to],
              subject,
              body: reply.trim(),
              ...(open.threadId ? { threadId: open.threadId } : {}),
              ...(open.messageId ? { inReplyTo: open.messageId } : {}),
            },
          },
        },
      );
      if (res.requiresApproval && res.approval?.id) {
        setSendResult({ kind: 'approval', approvalId: res.approval.id });
      } else if (res.executed) {
        setSendResult({ kind: 'sent', id: typeof res.result?.id === 'string' ? res.result.id : '' });
        setReply('');
      } else {
        setSendError('The server gave no usable send result');
      }
    } catch (e) {
      setSendError(msg(e, 'Could not send this reply'));
    } finally {
      setSending(false);
    }
  };

  if (connState === 'loading') return <p className="cc-hint">Checking mail connection…</p>;

  if (!conn) {
    return (
      <div data-testid="email-connect" className="cc-card cc-email-connect">
        <p className="cc-card__eyebrow">Mail</p>
        <h3>Connect your mail</h3>
        <p className="cc-hint">Type your address, click Connect, approve once at Google. CodeConClave never sees your password.</p>
        <div className="cc-row">
          <input
            data-testid="email-connect-input"
            className="cc-input"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void connect();
            }}
          />
          <button
            data-testid="email-connect-submit"
            type="button"
            className="cc-btn cc-btn--primary"
            disabled={!EMAIL_RE.test(email.trim()) || connecting}
            onClick={() => void connect()}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {connectError && <p data-testid="email-connect-error" className="cc-error">{connectError}</p>}
      </div>
    );
  }

  return (
    <div data-testid="email-inbox" className="cc-card cc-email">
      <p className="cc-card__eyebrow">Mail · connected{conn.name ? ` as ${conn.name}` : ''}</p>
      <div className="cc-row cc-row--spread">
        <h3>Inbox</h3>
        <button type="button" className="cc-btn cc-btn--sm cc-btn--ghost" onClick={() => void loadInbox()} disabled={inboxState === 'loading'}>
          {inboxState === 'loading' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {inboxState === 'error' && <p data-testid="email-inbox-error" className="cc-error">{inboxError}</p>}
      {inboxState === 'ready' && rows.length === 0 && <p className="cc-empty">No unread mail. Enjoy the quiet.</p>}
      {rows.length > 0 && (
        <ul className="cc-mail-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                data-testid={`email-open-${r.id}`}
                className="cc-mail-row"
                onClick={() => void openMail(r)}
                disabled={opening}
              >
                <span className="cc-mail-from">{r.from || '(unknown sender)'}</span>
                <span className="cc-mail-subject">{r.subject}</span>
                <span className="cc-mail-snippet">{r.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div data-testid="email-reader" className="cc-mail-reader">
          <p className="cc-mail-meta">{open.from} · {open.date}</p>
          <h4>{open.subject}</h4>
          <p className="cc-mail-body">{open.body || '(no readable text in this mail)'}</p>
          {open.truncated && <p className="cc-hint">Long mail — showing the first part.</p>}
          <label className="cc-field">
            Write a reply
            <textarea
              data-testid="email-reply-body"
              className="cc-input"
              rows={4}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={`Reply to ${addressOf(open.from)}…`}
            />
          </label>
          <div className="cc-row">
            <button
              data-testid="email-reply-send"
              type="button"
              className="cc-btn cc-btn--primary"
              disabled={!reply.trim() || sending}
              onClick={() => void sendReply()}
            >
              {sending ? 'Sending…' : 'Send reply'}
            </button>
          </div>
          <p className="cc-hint">Replies need your approval first — nothing sends silently.</p>
          {sendError && <p data-testid="email-reply-error" className="cc-error">{sendError}</p>}
          {sendResult?.kind === 'approval' && (
            <p data-testid="email-approval-notice" className="cc-notice">
              Reply waiting on your approval — <Link to="/approvals">review it in the Approval Center</Link>.
            </p>
          )}
          {sendResult?.kind === 'sent' && (
            <p data-testid="email-sent" className="cc-notice">Reply sent{sendResult.id ? ` (${sendResult.id})` : ''}.</p>
          )}
        </div>
      )}
    </div>
  );
}
