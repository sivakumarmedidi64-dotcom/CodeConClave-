/**
 * CodeConClave — PHASE 3 contract tests.
 * Guards the server/client contract for projects, conversations, threads,
 * mentions, workspace state and preferences schemas.
 */
import { describe, expect, it } from 'vitest';
import {
  createProjectSchema,
  updateProjectSchema,
  conversationUpdateSchema,
  messageEditSchema,
  threadCreateSchema,
  mentionCreateSchema,
  workspaceUpdateSchema,
  preferencesUpdateSchema,
} from './contracts.js';
import { ProjectStatus, ProjectMemberRole, WorkspaceStateKey, MAX_PROJECT_TAGS, MAX_TAG_LENGTH } from './constants.js';

describe('phase 3 project contracts', () => {
  it('createProjectSchema accepts name, deadline, tags', () => {
    const input = createProjectSchema.parse({
      name: 'Launcher',
      deadline: '2026-12-31T00:00:00.000Z',
      tags: ['launch', 'v2'],
    });
    expect(input.tags).toEqual(['launch', 'v2']);
  });

  it('createProjectSchema rejects empty name and oversized tag lists', () => {
    expect(() => createProjectSchema.parse({ name: '' })).toThrow();
    expect(() =>
      createProjectSchema.parse({ name: 'X', tags: Array(MAX_PROJECT_TAGS + 1).fill('a') }),
    ).toThrow();
    expect(() => createProjectSchema.parse({ name: 'X', tags: ['a'.repeat(MAX_TAG_LENGTH + 1)] })).toThrow();
  });

  it('updateProjectSchema accepts status transitions, favorite and deadline', () => {
    const input = updateProjectSchema.parse({
      status: 'ON_HOLD',
      favorite: true,
      deadline: '2026-06-01T00:00:00.000Z',
      tags: ['frontend'],
    });
    expect(input.status).toBe('ON_HOLD');
    expect(input.favorite).toBe(true);
    expect(() => updateProjectSchema.parse({ status: 'WIP' })).toThrow();
  });

  it('project statuses and member roles are frozen constants', () => {
    for (const s of ['ACTIVE', 'ARCHIVED', 'COMPLETED', 'ON_HOLD']) {
      expect(ProjectStatus[s as keyof typeof ProjectStatus]).toBe(s);
    }
    for (const r of ['OWNER', 'ADMIN', 'EDITOR', 'MEMBER', 'VIEWER']) {
      expect(ProjectMemberRole[r as keyof typeof ProjectMemberRole]).toBe(r.toLowerCase());
    }
  });
});

describe('phase 3 conversation contracts', () => {
  it('conversationUpdateSchema accepts archive/favorite/tags/title', () => {
    const input = conversationUpdateSchema.parse({ archived: true, favorite: true, tags: ['work'], title: 'Renamed' });
    expect(input).toMatchObject({ archived: true, favorite: true, title: 'Renamed' });
    expect(() => conversationUpdateSchema.parse({ archived: 'yes' })).toThrow();
  });

  it('messageEditSchema trims and bounds content', () => {
    expect(messageEditSchema.parse({ content: '  edited  ' }).content).toBe('edited');
    expect(() => messageEditSchema.parse({ content: '' })).toThrow();
  });

  it('thread and mention schemas require identifiers and titles', () => {
    expect(threadCreateSchema.parse({ parentMessageId: 'm1', title: 'Thread' })).toBeDefined();
    expect(() => threadCreateSchema.parse({ parentMessageId: 'm1', title: '' })).toThrow();
    expect(mentionCreateSchema.parse({ userId: 'u2' })).toBeDefined();
  });
});

describe('phase 3 workspace + preferences contracts', () => {
  it('workspaceUpdateSchema carries the value and optional baseVersion', () => {
    const input = workspaceUpdateSchema.parse({ value: { conversationId: 'c1' }, baseVersion: 2 });
    expect(input.value).toEqual({ conversationId: 'c1' });
    expect(input.baseVersion).toBe(2);
    expect(workspaceUpdateSchema.parse({ value: {} }).baseVersion).toBeUndefined();
    expect(() => workspaceUpdateSchema.parse({ baseVersion: -1 })).toThrow();
  });

  it('preferencesUpdateSchema accepts an arbitrary prefs record', () => {
    const input = preferencesUpdateSchema.parse({ prefs: { theme: 'dark', sound: 'off' } });
    expect(input.prefs).toMatchObject({ theme: 'dark' });
  });

  it('workspace state keys cover continuity + phase 3 additions', () => {
    for (const k of [
      'LAST_ACTIVE_PROJECT',
      'RETURN_TO_WORK',
      'CURRENT_PROJECT',
      'CURRENT_CONVERSATION',
      'CONVERSATION_SCROLL',
      'CURRENT_MODE',
      'CURRENT_MODEL',
      'TERMINAL_TABS',
      'ACTIVE_TASK',
      'LOADED_DNA_VERSION',
      'MEMORY_CONTEXT_REFS',
      'SIDEBAR_STATE',
    ]) {
      expect(WorkspaceStateKey[k as keyof typeof WorkspaceStateKey]).toBe(k.toLowerCase());
    }
  });
});