import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every SQL statement the service runs (tenant and system scopes).
const sql: { text: string; params: unknown[] }[] = [];
let selectIds: string[] = [];
const client = {
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    if (/SELECT id FROM conversations\s+WHERE incognito/.test(text)) return { rows: selectIds.map((id) => ({ id })) };
    return { rows: [] };
  }),
};
vi.mock('../../shared/db.js', () => ({
  withTenant: vi.fn(async (_uid: string | null, fn: (q: typeof client) => unknown) => fn(client)),
  withSystem: vi.fn(async (fn: (q: typeof client) => unknown) => fn(client)),
}));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { listConversations, purgeIdleIncognito, searchConversations } from './service.js';

beforeEach(() => {
  sql.length = 0;
  selectIds = [];
});

describe('incognito conversations', () => {
  it('are never listed or searchable', async () => {
    await listConversations('usr_1');
    await searchConversations('usr_1', 'secret');
    expect(sql[0]!.text).toMatch(/NOT incognito/);
    expect(sql[1]!.text).toMatch(/NOT c\.incognito/);
  });

  it('idle ones are purged completely, usage unlinked but kept', async () => {
    selectIds = ['conv_a', 'conv_b'];
    const out = await purgeIdleIncognito(24);
    expect(out).toEqual({ incognitoPurged: 2 });
    const texts = sql.map((s) => s.text.replace(/\s+/g, ' '));
    expect(sql[0]!.params).toEqual([24, 200]);
    // Usage rows survive for metering, but lose their link to the chat.
    expect(texts[1]).toMatch(/UPDATE model_usage_logs SET conversation_id = NULL/);
    // Children before parents; the final delete is restricted to incognito rows.
    const order = ['UPDATE tasks', 'DELETE FROM mentions', 'DELETE FROM reactions', 'DELETE FROM threads', 'DELETE FROM messages', 'DELETE FROM conversations'];
    const idx = order.map((o) => texts.findIndex((t) => t.includes(o)));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(texts[texts.length - 1]).toMatch(/DELETE FROM conversations WHERE id = ANY\(\$1\) AND incognito/);
  });

  it('does nothing when no incognito chat is idle', async () => {
    expect(await purgeIdleIncognito(24)).toEqual({ incognitoPurged: 0 });
    expect(sql).toHaveLength(1);
  });
});
