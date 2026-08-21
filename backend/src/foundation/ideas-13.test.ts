/**
 * CodeConClave — Phase 13 ideas tests: create/edit/status/priority/assignment,
 * voting, comments, archive/trash/restore, tenant isolation, team/project
 * permissions and assignee notifications. DB mocked.
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
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

import * as notifications from '../modules/notifications/service.js';
import {
  createIdea,
  getIdea,
  listIdeas,
  updateIdea,
  voteIdea,
  addIdeaComment,
  listIdeaComments,
  deleteIdeaComment,
  setIdeaArchived,
  trashIdea,
  restoreIdea,
} from '../modules/ideas/service.js';

function ideaRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ide_1',
    owner_id: 'u1',
    team_id: null,
    project_id: null,
    title: 'Ship dark mode',
    description: null,
    tags: [],
    category: null,
    priority: 'MEDIUM',
    status: 'PROPOSED',
    assignee_id: null,
    archived: false,
    deleted_at: null,
    vote_count: 0,
    comment_count: 0,
    ai_generated: false,
    provenance: null,
    references: [],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createIdea', () => {
  it('persists a personal idea with defaults and audits it', async () => {
    db.state.resolve = (text) => (text.includes('INSERT INTO ideas') ? [ideaRow({ id: 'ide_1', title: 'Ship dark mode' })] : null);
    const idea = await createIdea('u1', { title: 'Ship dark mode' });
    expect(idea.id).toBe('ide_1');
    expect(idea.status).toBe('PROPOSED');
    expect(idea.priority).toBe('MEDIUM');
    expect(idea.aiGenerated).toBe(false);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO ideas'));
    expect(insert).toBeTruthy();
    expect(insert!.params[1]).toBe('u1');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO audit_logs') && c.params.includes('idea.created'))).toBe(true);
  });

  it('notifies the assignee when one is given', async () => {
    const notifySpy = vi.spyOn(notifications, 'notify').mockResolvedValue(undefined);
    db.state.resolve = (text) =>
      text.includes('INSERT INTO ideas') ? [ideaRow({ id: 'ide_1', assignee_id: 'u2', title: 'T' })] : null;
    await createIdea('u1', { title: 'T', assigneeId: 'u2' });
    expect(notifySpy).toHaveBeenCalledWith('u2', 'idea.assigned', expect.stringContaining('T'), expect.objectContaining({ resourceType: 'idea' }));
  });

  it('does not notify when the assignee is the creator', async () => {
    const notifySpy = vi.spyOn(notifications, 'notify').mockResolvedValue(undefined);
    db.state.resolve = (text) =>
      text.includes('INSERT INTO ideas') ? [ideaRow({ id: 'ide_1', assignee_id: 'u1' })] : null;
    await createIdea('u1', { title: 'T', assigneeId: 'u1' });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('rejects non-members when scoping to a project', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT\n       EXISTS (SELECT 1 FROM projects')) {
        return [{ is_owner: false, member_role: null }];
      }
      return null;
    };
    await expect(createIdea('u9', { title: 'T', projectId: 'prj_1' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });
});

describe('listIdeas — tenant isolation + filters', () => {
  it('always scopes the query to owner/project-member/team-member', async () => {
    db.state.resolve = (text) => {
      if (text.includes('count(*)::int AS n FROM ideas')) return [{ n: 1 }];
      if (text.includes('SELECT i.* FROM ideas i')) return [ideaRow()];
      return null;
    };
    const result = await listIdeas('u1');
    expect(result.total).toBe(1);
    const listCall = db.state.calls.find((c) => c.text.includes('SELECT i.* FROM ideas i'));
    expect(listCall!.text).toContain('i.owner_id = $1');
    expect(listCall!.text).toContain('project_members');
    expect(listCall!.text).toContain('team_members');
    expect(listCall!.text).toContain('i.deleted_at IS NULL');
  });

  it('applies status/priority/tag/q filters and escapes LIKE wildcards', async () => {
    db.state.resolve = (text) => {
      if (text.includes('count(*)::int AS n FROM ideas')) return [{ n: 0 }];
      if (text.includes('SELECT i.* FROM ideas i')) return [];
      return null;
    };
    await listIdeas('u1', { status: 'ACCEPTED', priority: 'HIGH', tag: 'ux', q: '100%' });
    const listCall = db.state.calls.find((c) => c.text.includes('SELECT i.* FROM ideas i'));
    expect(listCall!.text).toContain("i.status = $2");
    expect(listCall!.text).toContain("i.priority = $3");
    expect(listCall!.text).toContain("$4 = ANY(i.tags)");
    expect(listCall!.params).toContain('%100\\%%');
  });
});

describe('getIdea / updateIdea', () => {
  it('throws not_found for an idea outside the tenant', async () => {
    await expect(getIdea('u1', 'ide_missing')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('updates status and priority and audits the change', async () => {
    const original = ideaRow();
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [original];
      if (text.includes('UPDATE ideas SET')) return [ideaRow({ status: 'ACCEPTED', priority: 'CRITICAL' })];
      return null;
    };
    const updated = await updateIdea('u1', 'ide_1', { status: 'ACCEPTED', priority: 'CRITICAL' });
    expect(updated.status).toBe('ACCEPTED');
    expect(updated.priority).toBe('CRITICAL');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO audit_logs') && c.params.includes('idea.updated'))).toBe(true);
  });
});

describe('voting', () => {
  it('records a vote, recomputes the count and audits', async () => {
    const base = ideaRow({ vote_count: 0 });
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [base];
      if (text.includes('UPDATE ideas SET vote_count')) return [];
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1') ) return [base];
      return null;
    };
    const result = await voteIdea('u1', 'ide_1', true);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO idea_votes') && c.params.includes('u1'))).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE ideas SET vote_count'))).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO audit_logs') && c.params.includes('idea.voted'))).toBe(true);
    expect(result.id).toBe('ide_1');
  });

  it('un-votes by deleting the row', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [ideaRow({ vote_count: 1 })];
      return null;
    };
    await voteIdea('u1', 'ide_1', false);
    expect(db.state.calls.some((c) => c.text.includes('DELETE FROM idea_votes WHERE idea_id = $1 AND user_id = $2'))).toBe(true);
  });
});

describe('comments', () => {
  it('adds a comment, bumps the counter and audits', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [ideaRow()];
      if (text.includes('INSERT INTO idea_comments')) return [{ id: 'icm_1', idea_id: 'ide_1', author_id: 'u1', parent_id: null, content: 'Nice', deleted_at: null, created_at: new Date() }];
      return null;
    };
    const comment = await addIdeaComment('u1', 'ide_1', { content: 'Nice' });
    expect(comment.id).toBe('icm_1');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE ideas SET comment_count = comment_count + 1'))).toBe(true);
    expect(db.state.calls.some((c) => c.params.includes('idea.commented'))).toBe(true);
  });

  it('rejects a parent comment from another idea', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [ideaRow()];
      return null;
    };
    await expect(addIdeaComment('u1', 'ide_1', { content: 'x', parentId: 'icm_other' })).rejects.toMatchObject({
      errorCode: 'not_found',
    });
  });

  it('lists comments for a visible idea', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [ideaRow()];
      if (text.includes('SELECT * FROM idea_comments WHERE idea_id = $1')) return [{ id: 'icm_1', idea_id: 'ide_1', author_id: 'u1', parent_id: null, content: 'Nice', deleted_at: null, created_at: new Date() }];
      return null;
    };
    const comments = await listIdeaComments('u1', 'ide_1');
    expect(comments).toHaveLength(1);
  });

  it('lets only the author or owner delete a comment', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [ideaRow()];
      if (text.includes('SELECT * FROM idea_comments WHERE id = $1 AND idea_id = $2')) return [{ id: 'icm_1', author_id: 'u2', deleted_at: null }];
      return null;
    };
    await expect(deleteIdeaComment('u3', 'ide_1', 'icm_1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });
});

describe('archive / trash / restore', () => {
  it('archives and audits', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [ideaRow()];
      if (text.includes('UPDATE ideas SET archived')) return [ideaRow({ archived: true })];
      return null;
    };
    const idea = await setIdeaArchived('u1', 'ide_1', true);
    expect(idea.archived).toBe(true);
    expect(db.state.calls.some((c) => c.params.includes('idea.archived'))).toBe(true);
  });

  it('trashes then restores with audit on both transitions', async () => {
    let trashed = false;
    db.state.resolve = (text) => {
      if (text.includes('UPDATE ideas SET deleted_at = now()')) {
        trashed = true;
        return [];
      }
      if (text.includes('UPDATE ideas SET deleted_at = NULL')) {
        trashed = false;
        return [];
      }
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) {
        return [ideaRow({ deleted_at: trashed ? new Date('2026-02-01T00:00:00Z') : null })];
      }
      return null;
    };
    await trashIdea('u1', 'ide_1');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE ideas SET deleted_at = now()'))).toBe(true);
    expect(db.state.calls.some((c) => c.params.includes('idea.trashed'))).toBe(true);
    await restoreIdea('u1', 'ide_1');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE ideas SET deleted_at = NULL'))).toBe(true);
    expect(db.state.calls.some((c) => c.params.includes('idea.restored'))).toBe(true);
  });

  it('refuses to trash an already-trashed idea', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT i.* FROM ideas i WHERE i.id = $1') ? [ideaRow({ deleted_at: new Date() })] : null;
    await expect(trashIdea('u1', 'ide_1')).rejects.toMatchObject({ errorCode: 'already_trashed' });
  });
});

describe('project/team scoped access', () => {
  it('allows a project member (non-owner) to read and update an idea', async () => {
    const base = ideaRow({ owner_id: 'u1', project_id: 'prj_1' });
    db.state.resolve = (text) => {
      if (text.includes('SELECT\n       EXISTS (SELECT 1 FROM projects')) return [{ is_owner: false, member_role: 'editor' }];
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [base];
      if (text.includes('UPDATE ideas SET')) return [ideaRow({ owner_id: 'u1', project_id: 'prj_1', status: 'REJECTED' })];
      return null;
    };
    const idea = await updateIdea('u2', 'ide_1', { status: 'REJECTED' });
    expect(idea.status).toBe('REJECTED');
  });

  it('allows an ACTIVE team member to read a team idea', async () => {
    const base = ideaRow({ owner_id: 'u1', team_id: 'tm_1' });
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'")) {
        return [{ role: 'editor' }];
      }
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [base];
      return null;
    };
    const idea = await getIdea('u2', 'ide_1');
    expect(idea.id).toBe('ide_1');
  });

  it('blocks an outsider from a team idea', async () => {
    const base = ideaRow({ owner_id: 'u1', team_id: 'tm_1' });
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'")) return [];
      if (text.includes('SELECT i.* FROM ideas i WHERE i.id = $1')) return [base];
      return null;
    };
    await expect(getIdea('u3', 'ide_1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });
});