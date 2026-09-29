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
  insertMessageExact,
  findMessageByClientId,
  addReaction,
  removeReaction,
  listReactions,
  syncConversation,
  listMessages,
  editMessage,
  updateConversation,
  softDeleteConversation,
  restoreConversation,
  softDeleteMessage,
  setConversationSharing,
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
    client_id: null,
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

  it('team viewers cannot edit, delete, or reshare messages in a conversation they do not own', async () => {
    const teamConv = () => convRow({ owner_id: 'owner-1', team_id: 'team-1' });
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        // getConversation: owner-1's team conversation is visible to u-viewer.
        return [teamConv()];
      }
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'viewer' }];
      if (text.includes('SELECT content FROM messages')) return [{ content: 'hello' }];
      if (text.includes('SELECT * FROM messages')) return [msgRow()];
      return null;
    };
    await expect(editMessage('u-viewer', 'c1', 'm1', 'rewritten')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    await expect(softDeleteMessage('u-viewer', 'c1', 'm1')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    await expect(setConversationSharing('u-viewer', 'c1', {})).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    expect(db.state.calls.some((c) => c.text.includes('UPDATE messages SET content'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE messages SET deleted_at'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE conversations SET sharing'))).toBe(false);
  });

  it('team editors may edit messages in shared conversations', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow({ owner_id: 'owner-1', team_id: 'team-1' })];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      if (text.includes('SELECT content FROM messages')) return [{ content: 'hello' }];
      if (text.includes('SELECT * FROM messages')) return [msgRow({ content: 'hello world', edit_count: 1 })];
      return null;
    };
    const edited = await editMessage('u-editor', 'c1', 'm1', 'hello world');
    expect(edited.content).toBe('hello world');
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

describe('continuity: idempotent message insert (clientId)', () => {
  it('insertMessageExact inserts a NEW row and reports replayed=false when there is no conflict', async () => {
    db.state.rowCount = 1;
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('SELECT * FROM messages WHERE id')) return [msgRow({ id: 'm-new', client_id: 'cl-1' })];
      return null;
    };
    const { row, replayed } = await insertMessageExact('u1', {
      conversationId: 'c1',
      sender: 'USER',
      role: 'user',
      content: 'hello',
      clientId: 'cl-1',
    });
    expect(replayed).toBe(false);
    expect(row.id).toBe('m-new');
  });

  it('insertMessageExact replays the existing row (replayed=true) when clientId already exists', async () => {
    db.state.rowCount = 0;
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('WHERE conversation_id = $1 AND client_id = $2')) {
        return [msgRow({ id: 'm-existing', content: 'hello', client_id: 'cl-1' })];
      }
      return null;
    };
    const { row, replayed } = await insertMessageExact('u1', {
      conversationId: 'c1',
      sender: 'USER',
      role: 'user',
      content: 'hello',
      clientId: 'cl-1',
    });
    expect(replayed).toBe(true);
    expect(row.id).toBe('m-existing');
  });

  it('insertMessageExact throws idempotency_conflict when the row cannot be resolved', async () => {
    db.state.rowCount = 0;
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      return null; // no existing row to resolve to
    };
    await expect(
      insertMessageExact('u1', {
        conversationId: 'c1',
        sender: 'USER',
        role: 'user',
        content: 'hello',
        clientId: 'cl-1',
      }),
    ).rejects.toMatchObject({ errorCode: 'message_idempotency_conflict' });
  });

  it('findMessageByClientId resolves a prior send (ownership-checked) and nulls fresh/blank keys', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('WHERE conversation_id = $1 AND client_id = $2')) {
        return params[1] === 'cl-1' ? [msgRow({ id: 'm-existing', client_id: 'cl-1' })] : [];
      }
      return null;
    };
    const found = await findMessageByClientId('u1', 'c1', 'cl-1');
    expect(found?.id).toBe('m-existing');
    // Ownership is checked first: another user's conversation never resolves.
    await expect(findMessageByClientId('u2', 'c1', 'cl-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    expect(await findMessageByClientId('u1', 'c1', 'cl-fresh')).toBeNull();
    expect(await findMessageByClientId('u1', 'c1', '   ')).toBeNull();
    expect(await findMessageByClientId('u1', 'c1', null)).toBeNull();
    const lookup = db.state.calls.find((c) => c.text.includes('WHERE conversation_id = $1 AND client_id = $2'))!;
    expect(lookup.params).toEqual(['c1', 'cl-1']);
  });

  it('reactions are bound to the authorized conversation (no cross-message injection)', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      // Binding check: message m1 lives in c1; anything else is foreign.
      if (text.includes('FROM messages WHERE id = $1 AND conversation_id = $2')) {
        return params[0] === 'm1' && params[1] === 'c1' ? [{ id: 'm1' }] : [];
      }
      return null;
    };
    await addReaction('u1', 'c1', 'm1', '👍');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO reactions'))!;
    expect(insert.params.slice(1, 4)).toEqual(['m1', 'u1', '👍']);
    // Same caller, own conversation c1, but someone else's message id.
    await expect(addReaction('u1', 'c1', 'm-victim', '👍')).rejects.toMatchObject({ errorCode: 'not_found' });
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO reactions')).length).toBe(1);
    // Remove scopes the delete to the conversation in a single statement.
    await removeReaction('u1', 'c1', 'm1', '👍');
    const del = db.state.calls.find((c) => c.text.includes('DELETE FROM reactions'))!;
    expect(del.text).toContain('conversation_id = $4');
    expect(del.params).toEqual(['m1', 'u1', '👍', 'c1']);
  });

  it('listReactions requires conversation ownership (no cross-tenant read)', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('FROM reactions')) return [{ message_id: 'm1', emoji: '👍', user_id: 'u1' }];
      return null;
    };
    await expect(listReactions('u1', 'c1')).resolves.toHaveLength(1);
    await expect(listReactions('u2', 'c1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('insertMessage without clientId still works (legacy path)', async () => {
    db.state.rowCount = 1;
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('SELECT * FROM messages WHERE id')) return [msgRow({ id: 'm-plain' })];
      return null;
    };
    const msg = await insertMessage('u1', { conversationId: 'c1', sender: 'USER', role: 'user', content: 'hi' });
    expect(msg.id).toBe('m-plain');
  });
});

describe('continuity: syncConversation (push + pull + tombstones)', () => {
  it('applies new pending messages and reports duplicates for idempotent retries', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      if (text.includes('ON CONFLICT (conversation_id, client_id)')) {
        // Simulate the partial unique index: a retried clientId conflicts.
        db.state.rowCount = params[15] === 'cl-push' ? 1 : 0;
        return [];
      }
      if (text.includes('SELECT * FROM messages WHERE id')) {
        return [msgRow({ id: String(params[0]), client_id: 'cl-push' })];
      }
      if (text.includes('WHERE conversation_id = $1 AND client_id = $2')) {
        return [msgRow({ id: 'm-existing', client_id: 'cl-dup' })];
      }
      if (text.includes('seq > $2')) {
        return [msgRow({ id: 'm1', seq: 5 }), msgRow({ id: 'm-del', seq: 6, deleted_at: new Date() })];
      }
      return null;
    };
    const result = await syncConversation('u1', 'c1', {
      afterSeq: 4,
      pending: [
        { clientId: 'cl-push', content: '  new message  ' },
        { clientId: 'cl-dup', content: 'already there' },
      ],
    });
    expect(result.applied).toEqual(['cl-push']);
    expect(result.duplicates).toEqual(['cl-dup']);
    expect(result.messages.map((m) => m.id)).toEqual(['m1']);
    expect(result.deletedIds).toEqual(['m-del']);
    expect(result.lastSeq).toBe(6);
  });

  it('rejects an empty pending message', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) {
        return params[1] === 'u1' ? [convRow()] : [];
      }
      return null;
    };
    await expect(
      syncConversation('u1', 'c1', { pending: [{ clientId: 'cl-x', content: '   ' }] }),
    ).rejects.toMatchObject({ errorCode: 'sync_content_empty' });
  });

  it('does not leak another user’s conversation', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM conversations') ? [] : null);
    await expect(syncConversation('u1', 'c1', { afterSeq: 0 })).rejects.toMatchObject({ errorCode: 'not_found' });
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