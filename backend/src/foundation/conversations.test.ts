/**
 * CodeConClave — conversations foundation tests (PHASE 3).
 * Covers: create + project association, ownership, message persistence +
 * ordering, edit history, archive/favorite/tags, soft delete, threads,
 * mentions, authorization. DB interaction is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import {
  createConversation,
  getConversation,
  listConversations,
  insertMessage,
  listMessages,
  editMessage,
  updateConversation,
  softDeleteConversation,
  restoreConversation,
  softDeleteMessage,
  createThread,
  listThreads,
  addMention,
  listMentionsForUser,
  toMessageJson,
} from '../modules/conversations/service.js';

function convRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    project_id: 'p1',
    owner_id: 'u1',
    title: 'Chat 1',
    mode: 'CHAT',
    archived: false,
    is_favorite: false,
    tags: [],
    sharing: {},
    search_metadata: { title: 'Chat 1' },
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function msgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    conversation_id: 'c1',
    seq: 1,
    sender: 'USER',
    coworker_type: null,
    role: 'user',
    content: 'hello',
    model_id: null,
    provider_id: null,
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
    status: 'COMPLETED',
    error_code: null,
    edited_at: null,
    edit_count: 0,
    thread_id: null,
    created_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function ownedConversation(owner = 'u1') {
  db.state.resolve = (text, params) => {
    if (text.includes('SELECT * FROM conversations')) {
      return params[1] === owner ? [convRow({ owner_id: owner })] : [];
    }
    if (text.includes('SELECT 1 FROM projects')) return [{ id: 'p1' }];
    if (text.includes('SELECT * FROM messages')) return [msgRow()];
    if (text.includes('SELECT content FROM messages')) return [{ content: 'hello' }];
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conversation lifecycle + ownership', () => {
  it('creates a conversation associated with a project (validated inside tenant tx)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT 1 FROM projects')) return [{ id: 'p1' }];
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      return null;
    };
    const conv = await createConversation('u1', { projectId: 'p1', title: 'Chat 1' });
    expect(conv.owner_id).toBe('u1');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO conversations'))!;
    expect(insert.params[1]).toBe('p1');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'conversation.created' }));
  });

  it('rejects creation against an unknown project', async () => {
    db.state.resolve = (text) => (text.includes('SELECT 1 FROM projects') ? [] : null);
    await expect(createConversation('u1', { projectId: 'nope' })).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('conversations are owner-scoped: a non-owner cannot read', async () => {
    ownedConversation('u1');
    await expect(getConversation('u2', 'c1')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(listConversations('u2')).resolves.toEqual([]);
  });

  it('updateConversation sets archive/favorite/tags and audits', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow({ archived: true, is_favorite: true, tags: ['work'] })] : [];
      }
      return null;
    };
    const updated = await updateConversation('u1', 'c1', { archived: true, favorite: true, tags: ['work'] });
    expect(updated.archived).toBe(true);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE conversations SET'))!;
    expect(upd.text).toContain('archived = $');
    expect(upd.text).toContain('is_favorite = $');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'conversation.archived' }));
  });

  it('soft delete + restore keep conversation ownership intact', async () => {
    ownedConversation();
    await softDeleteConversation('u1', 'c1');
    expect(db.state.calls.some((c) => c.text.includes('deleted_at = now()') && c.params[0] === 'c1')).toBe(true);
    db.state.resolve = (text) => {
      if (text.includes('UPDATE conversations SET deleted_at = NULL')) return [convRow()];
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      return null;
    };
    await restoreConversation('u1', 'c1');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'conversation.restored' }));
  });
});

describe('message persistence + ordering + edit history', () => {
  it('persists a message and bumps the conversation timestamp', async () => {
    ownedConversation();
    const msg = await insertMessage('u1', {
      conversationId: 'c1',
      sender: 'USER',
      role: 'user',
      content: 'hello',
    });
    expect(msg.content).toBe('hello');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO messages'))!;
    expect(insert.params[1]).toBe('c1');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE conversations SET updated_at = now()'))).toBe(true);
  });

  it('lists messages ordered by created_at DESC, seq DESC', async () => {
    ownedConversation();
    await listMessages('u1', 'c1', undefined, 100);
    const call = db.state.calls.find((c) => c.text.includes('ORDER BY created_at DESC, seq DESC'))!;
    expect(call).toBeDefined();
    expect(call.text).toContain('LIMIT $2');
  });

  it('editMessage snapshots the prior content, increments edit_count, and audits', async () => {
    ownedConversation();
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      if (text.includes('SELECT content FROM messages')) return [{ content: 'hello' }];
      if (text.includes('SELECT * FROM messages')) return [msgRow({ content: 'hello world', edit_count: 1 })];
      return null;
    };
    const edited = await editMessage('u1', 'c1', 'm1', 'hello world');
    expect(edited.content).toBe('hello world');
    const snapshot = db.state.calls.find((c) => c.text.includes('INSERT INTO message_edits'))!;
    expect(snapshot.params[2]).toBe('hello');
    const upd = db.state.calls.find((c) => c.text.includes('edit_count = edit_count + 1'))!;
    expect(upd).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'message.edited' }));
  });

  it('editMessage refuses to edit a message in another conversation', async () => {
    ownedConversation();
    db.state.resolve = (text) => (text.includes('SELECT content FROM messages') ? [] : null);
    await expect(editMessage('u1', 'c1', 'm_other', 'x')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('soft deletes a message scoped to its conversation', async () => {
    ownedConversation();
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('UPDATE messages SET deleted_at = now()')) return [{ id: 'm1' }];
      return null;
    };
    await softDeleteMessage('u1', 'c1', 'm1');
    const del = db.state.calls.find((c) => c.text.includes('UPDATE messages SET deleted_at = now()'))!;
    expect(del.params).toEqual(['m1', 'c1']);
  });

  it('toMessageJson exposes edit metadata', () => {
    const json = toMessageJson(msgRow({ edited_at: new Date(), edit_count: 2, thread_id: 't1' }) as never);
    expect(json.editCount).toBe(2);
    expect(json.threadId).toBe('t1');
  });
});

describe('threads + mentions foundation', () => {
  it('creates a thread under a parent message within the conversation', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      if (text.includes('SELECT 1 FROM messages')) return [{ id: 'm1' }];
      if (text.includes('SELECT id, conversation_id, parent_message_id')) return [{ id: 't1', parent_message_id: 'm1', title: 'Thread' }];
      return null;
    };
    const thread = await createThread('u1', 'c1', 'm1', 'Thread');
    expect(thread.id).toBe('t1');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO threads'))!;
    expect(insert.params[4]).toBe('u1'); // created_by
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'thread.created' }));
  });

  it('threads require the parent message to be in the conversation', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      if (text.includes('SELECT 1 FROM messages')) return [];
      return null;
    };
    await expect(createThread('u1', 'c1', 'm_other', 'T')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('lists threads owner-scoped and ordered', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      if (text.includes('FROM threads t')) return [{ id: 't1', title: 'T' }];
      return null;
    };
    const threads = await listThreads('u1', 'c1');
    expect(threads[0]).toMatchObject({ title: 'T' });
  });

  it('adds a mention to a message in the conversation and records it', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      if (text.includes('SELECT 1 FROM messages')) return [{ id: 'm1' }];
      return null;
    };
    await addMention('u1', 'c1', 'm1', 'u2');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO mentions'))!;
    expect(insert.params[2]).toBe('u2');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mention.created' }));
  });

  it('lists mentions only where the target also owns the conversation', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM mentions m') ? [{ id: 'mn1', conversation_title: 'Chat 1' }] : null;
    const mentions = await listMentionsForUser('u2');
    expect(mentions[0]).toMatchObject({ conversation_title: 'Chat 1' });
    const call = db.state.calls.find((c) => c.text.includes('FROM mentions m'))!;
    expect(call.text).toContain('m.user_id = $1');
    expect(call.text).toContain('c.owner_id = $1');
  });
});