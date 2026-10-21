/**
 * Permission rules — allow / ask / deny (constitution Article 1). The user's
 * own fine-grained rules for agent actions, stored on the server and applied
 * by the policy engine. They sit below the built-in protections: no rule can
 * unblock secret files, dangerous commands or a missing grant, and "allow"
 * never skips the prompt for deletes or high-risk actions.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

export interface PermissionRule {
  id: string;
  effect: 'allow' | 'ask' | 'deny';
  tool: string;
  pattern: string;
  note: string | null;
  createdAt: string;
}

const TOOL_LABELS: Record<string, string> = {
  '*': 'Any action',
  file_read: 'Read a file',
  file_list: 'List files',
  file_write: 'Edit a file',
  file_create: 'Create a file',
  file_delete: 'Delete a file',
  terminal_exec: 'Run a command',
  network_request: 'Network request',
  browser_open: 'Open a web page',
  plugin_action: 'Connector action',
  local_list: 'List files on my computer',
  local_read: 'Read a file on my computer',
  local_write: 'Edit a file on my computer',
  local_exec: 'Run a command on my computer',
  mcp_call: 'Use an MCP tool',
};

const EFFECT_TEXT: Record<PermissionRule['effect'], string> = {
  allow: 'Allow without asking',
  ask: 'Always ask first',
  deny: 'Never allow',
};

const EXAMPLES: { effect: PermissionRule['effect']; tool: string; pattern: string }[] = [
  { effect: 'allow', tool: 'file_write', pattern: 'docs/*' },
  { effect: 'ask', tool: 'file_write', pattern: 'src/payments/*' },
  { effect: 'deny', tool: 'terminal_exec', pattern: 'npm publish*' },
];

export function PermissionRulesCard() {
  const [rules, setRules] = useState<PermissionRule[] | null>(null);
  const [tools, setTools] = useState<string[]>(Object.keys(TOOL_LABELS));
  const [effect, setEffect] = useState<PermissionRule['effect']>('ask');
  const [tool, setTool] = useState('file_write');
  const [pattern, setPattern] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ rules: PermissionRule[]; tools?: string[] }>('/api/v1/control/permission-rules');
      setRules(Array.isArray(res?.rules) ? res.rules : []);
      if (Array.isArray(res?.tools) && res.tools.length) setTools(res.tools);
    } catch (err) {
      setRules([]);
      setError(err instanceof Error ? err.message : 'Could not load your rules.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!pattern.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api('/api/v1/control/permission-rules', { method: 'POST', body: { effect, tool, pattern: pattern.trim(), note: note.trim() || undefined } });
      setPattern('');
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rule.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api(`/api/v1/control/permission-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the rule.');
    }
  };

  return (
    <div className="cc-card pr-card" data-testid="permission-rules">
      <h3 style={{ margin: 0 }}>Permission rules</h3>
      <p className="cc-hint" style={{ margin: '4px 0 10px' }}>
        Fine-tune what your coworker may do. <strong>Never allow</strong> beats <strong>Always ask</strong>, which beats{' '}
        <strong>Allow without asking</strong>. Built-in protections stay on: no rule can unblock secret files, dangerous
        commands or folders you haven&apos;t granted, and deletes, high-risk actions and anything that emails, posts or
        publishes always ask.
      </p>

      {rules === null ? (
        <p className="cc-hint">Loading rules…</p>
      ) : rules.length === 0 ? (
        <p className="cc-hint" data-testid="permission-rules-empty">
          No rules yet. Examples:{' '}
          {EXAMPLES.map((x, i) => (
            <button
              key={i}
              type="button"
              className="cc-pill pr-example"
              onClick={() => {
                setEffect(x.effect);
                setTool(x.tool);
                setPattern(x.pattern);
              }}
            >
              {EFFECT_TEXT[x.effect]} · {TOOL_LABELS[x.tool]} · {x.pattern}
            </button>
          ))}
        </p>
      ) : (
        <ul className="pr-list">
          {rules.map((r) => (
            <li key={r.id} className={`pr-rule pr-rule--${r.effect}`}>
              <span className="pr-effect">{EFFECT_TEXT[r.effect]}</span>
              <span>{TOOL_LABELS[r.tool] ?? r.tool}</span>
              <code className="cc-md-code">{r.pattern}</code>
              {r.note && <span className="cc-hint">{r.note}</span>}
              <button type="button" className="cc-icon-btn" aria-label={`Remove rule ${r.pattern}`} onClick={() => void remove(r.id)}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="pr-form" onSubmit={(e) => void add(e)}>
        <select className="cc-input" aria-label="Rule effect" value={effect} onChange={(e) => setEffect(e.target.value as PermissionRule['effect'])}>
          {(Object.keys(EFFECT_TEXT) as PermissionRule['effect'][]).map((k) => (
            <option key={k} value={k}>
              {EFFECT_TEXT[k]}
            </option>
          ))}
        </select>
        <select className="cc-input" aria-label="Rule action" value={tool} onChange={(e) => setTool(e.target.value)}>
          {tools.map((t) => (
            <option key={t} value={t}>
              {TOOL_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        <input
          className="cc-input"
          aria-label="Rule pattern"
          placeholder={
            tool.includes('exec')
              ? 'Command, e.g. npm run test*'
              : tool === 'browser_open' || tool === 'network_request'
                ? 'URL, e.g. https://docs.*'
                : tool === 'mcp_call'
                  ? 'server/tool, e.g. github/*'
                  : 'Path, e.g. src/payments/*'
          }
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          maxLength={300}
        />
        <input className="cc-input" aria-label="Rule note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        <button type="submit" className="cc-btn cc-btn--primary cc-btn--sm" disabled={saving || !pattern.trim()}>
          {saving ? 'Saving…' : 'Add rule'}
        </button>
      </form>
      <p className="cc-hint" style={{ margin: 0 }}>
        <code className="cc-md-code">*</code> matches anything (including folders), <code className="cc-md-code">?</code> one character.
      </p>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
