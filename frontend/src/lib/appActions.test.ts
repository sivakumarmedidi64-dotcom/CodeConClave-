import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAppAction, runAppAction } from './appActions';
import { _resetPrefsCache } from './prefs';
import { jsonResponse, stubFetch } from '../testutils';

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetPrefsCache();
});

describe('parseAppAction', () => {
  it('recognises project creation in plain words', () => {
    expect(parseAppAction('create a project called Coffee Shop')).toEqual({ kind: 'create_project', name: 'Coffee Shop' });
    expect(parseAppAction('Make a new project "Landing v2"')).toEqual({ kind: 'create_project', name: 'Landing v2' });
    expect(parseAppAction('new project todo-app')).toEqual({ kind: 'create_project', name: 'todo-app' });
  });

  it('maps permission and effort commands', () => {
    expect(parseAppAction('set permission mode to auto')).toEqual({ kind: 'permission_mode', mode: 'full_access' });
    expect(parseAppAction('switch mode to manual')).toEqual({ kind: 'permission_mode', mode: 'ask' });
    expect(parseAppAction('set permissions to auto-accept edits')).toEqual({ kind: 'permission_mode', mode: 'accept_edits' });
    expect(parseAppAction('set effort to high')).toEqual({ kind: 'effort', effort: 'high' });
  });

  it('opens app surfaces', () => {
    expect(parseAppAction('open usage')).toMatchObject({ kind: 'open', path: '/settings?tab=usage' });
    expect(parseAppAction('take me to code review')).toMatchObject({ kind: 'open', path: '/code-review' });
  });

  it('leaves ordinary requests to the AI', () => {
    expect(parseAppAction('how do I create a project in Django?')).toBeNull();
    expect(parseAppAction('write a function that sets effort to high')).toBeNull();
    expect(parseAppAction('build a landing page')).toBeNull();
  });
});

describe('runAppAction', () => {
  it('really creates the project through the API', async () => {
    const fetchFn = stubFetch(async () => jsonResponse({ data: { project: { id: 'prj_1', name: 'Coffee Shop' } } }, 201));
    const res = await runAppAction({ kind: 'create_project', name: 'Coffee Shop' });
    expect(res.message).toContain('Coffee Shop');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/api/v1/projects');
    expect(init?.method).toBe('POST');
  });

  it('changes the server-side permission mode', async () => {
    const fetchFn = stubFetch(async () => jsonResponse({ data: { mode: 'full_access' } }));
    const res = await runAppAction({ kind: 'permission_mode', mode: 'full_access' });
    expect(res.message).toContain('Auto');
    expect(fetchFn.mock.calls[0]![1]?.method).toBe('PUT');
  });
});
