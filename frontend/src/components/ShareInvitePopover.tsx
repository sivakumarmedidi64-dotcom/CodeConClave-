/**
 * CodeConClave — Share / Invite popover for a cowork conversation.
 * Rides the CANONICAL share-link rail (conversations.sharing jsonb, no second
 * system): WATCH / COMMENT / CO_CONTROL roles, optional one-time redemption,
 * expiry, revocation, and a full audit trail on the backend. Redemption never
 * bypasses authentication (external identity federation is intentionally off;
 * non-collaborators fail closed with aios_share_access_denied).
 */
import { useEffect, useState } from 'react';
import { createShareLink, listShareLinks, revokeShareLink } from '../lib/api';
import { copyText } from '../lib/clipboard';
import type { ShareLinkView, ShareMode } from '../lib/types';

const EXPIRY_OPTIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

const MODES: { mode: ShareMode; label: string; hint: string }[] = [
  { mode: 'WATCH', label: 'Watch', hint: 'Teammate can view the session' },
  { mode: 'COMMENT', label: 'Comment', hint: 'Teammate can view + comment' },
  { mode: 'CO_CONTROL', label: 'Co-control', hint: 'Teammate can steer the cowork' },
];

export function ShareInvitePopover({
  conversationId,
  onClose,
  toast,
}: {
  conversationId: string;
  onClose: () => void;
  toast: (msg: string, kind?: 'info' | 'error') => void;
}) {
  const [role, setRole] = useState<ShareMode>('WATCH');
  const [oneTime, setOneTime] = useState(false);
  const [expiryMs, setExpiryMs] = useState<number>(EXPIRY_OPTIONS[2]!.ms);
  const [links, setLinks] = useState<ShareLinkView[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const list = await listShareLinks(conversationId);
      setLinks(list.filter((l) => !l.revokedAt));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const makeLink = async () => {
    setBusy(true);
    try {
      const link = await createShareLink(conversationId, role, {
        oneTime,
        expiresInMs: expiryMs,
      });
      setLinks((prev) => [link, ...prev]);
      const copied = await copyText(link.url);
      toast(copied ? 'Link copied' : 'Link created', copied ? 'info' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'could not create link', 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async (l: ShareLinkView) => {
    const ok = await copyText(l.url);
    toast(ok ? 'Copied' : 'Copy failed', ok ? 'info' : 'error');
  };

  const revoke = async (l: ShareLinkView) => {
    try {
      await revokeShareLink(conversationId, l.token);
      setLinks((prev) => prev.filter((x) => x.token !== l.token));
      toast('Link revoked');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'revoke failed', 'error');
    }
  };

  return (
    <div className="cc-popover cc-share-popover" role="dialog" aria-modal="true" aria-label="Share or invite">
      <div className="cc-popover__title">Share / Invite your team</div>
      <p className="cc-hint" style={{ margin: '0 0 8px' }}>
        Teammates must already be signed in and members of this workspace — a link never bypasses authentication.
      </p>
      <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={`cc-btn cc-btn--sm ${role === m.mode ? 'cc-btn--primary' : 'cc-btn--ghost'}`}
            onClick={() => setRole(m.mode)}
            aria-pressed={role === m.mode}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label className="cc-hint" style={{ display: 'block', margin: '6px 0' }}>
        <input type="checkbox" checked={oneTime} onChange={(e) => setOneTime(e.target.checked)} /> One-time use
      </label>
      <label className="cc-hint" style={{ display: 'block', margin: '6px 0' }}>
        Expires in{' '}
        <select className="cc-select" value={expiryMs} onChange={(e) => setExpiryMs(Number(e.target.value))}>
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.label} value={o.ms}>{o.label}</option>
          ))}
        </select>
      </label>
      <button className="cc-btn" disabled={busy} onClick={() => void makeLink()}>
        {busy ? 'Creating…' : 'Create invite link'}
      </button>
      {links.length > 0 && (
        <div style={{ marginTop: 10, maxHeight: 140, overflow: 'auto' }}>
          {links.map((l) => (
            <div key={l.token} className="cc-pill" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.mode}
                {l.oneTime ? ' · one-time' : ''}
              </span>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void copyLink(l)} aria-label="Copy link">
                Copy
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void revoke(l)} aria-label="Revoke link">
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10, textAlign: 'right' }}>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}