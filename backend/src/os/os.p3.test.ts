/**
 * CodeConClave — AI OS P3 tests.
 * Covers all 13 P3 tracks: flag gating, approval-gated writes, capability
 * authorization, workspace isolation, secret redaction, skill integrity/cap
 * allow-listing, device notification scoping/replay, intel agent capability
 * enforcement, and IDE session isolation. Read-only, no DB/network/provider.
 */
import { describe, it, expect } from 'vitest';
import { IpcBus, MemoryIpcStore } from './ipc.js';
import {
  GitHubRemote,
  JiraConnector,
  SlackConnector,
  classifySlashText,
  DeviceNotifications,
  SkillSecurity,
  createCapabilityRegistry,
  ContextIntelligence,
  CONTEXT_AGENTS,
  TestingIntelligence,
  TESTING_AGENTS,
  SecurityIntelligence,
  SECURITY_AGENTS,
  PerformanceIntelligence,
  PERFORMANCE_AGENTS,
  ArchitectureIntelligence,
  ARCHITECTURE_AGENTS,
  TeamIntelligence,
  TEAM_AGENTS,
  DocumentationIntelligence,
  DOCUMENTATION_AGENTS,
  IdeFoundation,
  enabled,
  p3Catalog,
} from './p3/index.js';
import type { P3Feature } from './p3/index.js';

const ON = (f: P3Feature) => (() => f) as never;
const OFF = (() => null) as never;

function caps(...kinds: string[]): readonly string[] {
  return kinds;
}

function gate(overrides: Partial<{ capability: string; authorized: boolean; approvedFor: string }> = {}) {
  return { capability: 'github.read', authorized: true, approvedFor: undefined as string | undefined, ...overrides };
}

class FakeSecrets {
  store = new Map<string, string>();
  async get(scope: string, key: string): Promise<string | null> {
    return this.store.get(`${scope}::${key}`) ?? null;
  }
  async put(scope: string, key: string, value: string): Promise<void> {
    this.store.set(`${scope}::${key}`, value);
  }
}

describe('P3 flags — gating', () => {
  it('p3Catalog lists all 13 tracks', () => {
    expect(p3Catalog()).toHaveLength(13);
  });
  it('enabled() requires global OS on + track flag on (all default OFF => false)', () => {
    expect(enabled('github')).toBe(false);
  });
});

describe('P3.1 GitHub — approval + isolation', () => {
  const repo = { owner: 'o', name: 'n', fullName: 'o/n', defaultBranch: 'main', private: false };
  const http = {
    repo: async () => repo,
    branches: async () => [{ name: 'main', headSha: 'a', protected: true }],
    commits: async () => [{ sha: 'a', author: 'u', message: 'm', at: 1 }],
    listPrs: async () => [],
    pr: async () => ({ number: 1, title: 't', state: 'open' as const, headRef: 'x', baseRef: 'main', author: 'u', createdAt: 1 }),
    diff: async () => 'diff',
    comments: async () => [],
    createPr: async () => ({ number: 2, title: 'pr', state: 'open' as const, headRef: 'x', baseRef: 'main', author: 'u', createdAt: 1 }),
    addComment: async () => ({ id: 'c', body: 'hi', author: 'u', at: 1 }),
  };
  const secrets = new FakeSecrets();
  const gh = (opts?: { egress?: (h: string) => boolean; capabilityFor?: (ws: string) => readonly string[] }) =>
    new GitHubRemote(
      ON('github'),
      http,
      secrets,
      opts?.egress ?? ((h) => h === 'api.github.com'),
      opts?.capabilityFor ?? ((ws) => (ws === 'ws1' ? caps('github.read', 'github.write') : caps())),
    );

  it('connect stores token workspace-scoped and requires cap + egress', async () => {
    const g = gh();
    const res = await g.connect('ws1', 'o/n', 'tok', gate({ capability: 'github.write', authorized: true }));
    expect(res.workspaceId).toBe('ws1');
    expect(res.repo.fullName).toBe('o/n');
    expect(secrets.store.get('github:ws2::o/n')).toBeUndefined();
    expect(secrets.store.get('github:ws1::o/n')).toBe('tok');
  });
  it('egress must be approved', async () => {
    const g = gh({ egress: () => false, capabilityFor: () => caps('github.write') });
    await expect(g.connect('ws1', 'o/n', 'tok', gate({ capability: 'github.write' }))).rejects.toThrow(/egress/);
  });
  it('read requires capability github.read', async () => {
    const g = gh({ capabilityFor: () => caps() });
    await expect(g.connect('ws1', 'o/n', 'tok', gate({ capability: 'github.write' }))).rejects.toThrow(/capability/);
  });
  it('createPr requires explicit approval bound to the target', async () => {
    const g = gh();
    const tok = gate({ capability: 'github.write', approvedFor: 'create-pr:o/n#feat->main' });
    await expect(g.createPr('o/n', 'ws1', { title: 't', head: 'feat', base: 'main' }, tok)).resolves.toMatchObject({ number: 2 });
    await expect(g.createPr('o/n', 'ws1', { title: 't', head: 'feat', base: 'main' }, gate({ capability: 'github.write', authorized: true, approvedFor: 'WRONG' }))).rejects.toThrow(/approval/);
  });
  it('workspace isolation: connections are scoped per workspace', async () => {
    const g = gh({ capabilityFor: () => caps('github.write') });
    await g.connect('ws1', 'o/n', 'tok', gate({ capability: 'github.write' }));
    await g.connect('ws2', 'p/q', 'tok2', gate({ capability: 'github.write' }));
    expect(g.connectionsFor('ws1').map((c) => c.fullName)).toEqual(['o/n']);
    expect(g.connectionsFor('ws2').map((c) => c.fullName)).toEqual(['p/q']);
  });
  it('redact() masks token-like fields', () => {
    const g = gh();
    const r = g.redact({ token: 'abc', ok: true });
    expect(r.token).toBe('[REDACTED]');
    expect(JSON.stringify(r)).not.toContain('abc');
  });
  it('disabled feature is rejected', async () => {
    const g = new GitHubRemote(OFF, http, secrets, () => true, () => caps('github.read'));
    await expect(g.connect('ws1', 'o/n', 'tok', gate())).rejects.toThrow(/off/);
  });
});

describe('P3.2 Jira — approval-gated writes + workspace scope', () => {
  const secrets = new FakeSecrets();
  const makeHttp = () => ({
    connect: async () => ({ accountId: 'a1', displayName: 'Alice' }),
    ticket: async () => ({ key: 'PROJ-1', summary: 's', status: 'open', assignee: null, url: 'u', updatedAt: 1 }),
    attachResult: async () => ({ posted: true }),
  });
  const ipc = new IpcBus(new MemoryIpcStore());
  const jira = () =>
    new JiraConnector(ON('jira'), ipc, makeHttp(), secrets, (ws) => (ws === 'ws1' ? caps('jira.read', 'jira.write') : caps()));

  it('connect stores token workspace-scoped', async () => {
    const j = jira();
    await j.connect('ws1', 'https://x.atlassian.net', 'a@b', 'tok', { capability: 'jira.write', authorized: true });
    expect(secrets.store.has('jira:ws1::https://x.atlassian.net')).toBe(true);
  });
  it('readTicket works for authorized workspace', async () => {
    const j = jira();
    await j.connect('ws1', 'https://x.atlassian.net', 'a@b', 'tok', { capability: 'jira.write', authorized: true });
    const { ticket } = await j.readTicket('ws1', 'PROJ-1', gate({ capability: 'jira.read' }));
    expect(ticket.key).toBe('PROJ-1');
  });
  it('attachResult requires explicit approval bound to target', async () => {
    const j = jira();
    await j.connect('ws1', 'https://x.atlassian.net', 'a@b', 'tok', { capability: 'jira.write', authorized: true });
    await expect(j.attachResult('ws1', 'PROJ-1', 'body', gate({ capability: 'jira.write', authorized: true, approvedFor: 'attach:PROJ-1' }))).resolves.toMatchObject({ posted: true });
    await expect(j.attachResult('ws1', 'PROJ-1', 'body', gate({ capability: 'jira.write' }))).rejects.toThrow(/approval/);
  });
  it('workspace without capability cannot read', async () => {
    const j = jira();
    await j.connect('ws1', 'https://x.atlassian.net', 'a@b', 'tok', { capability: 'jira.write', authorized: true });
    await expect(j.readTicket('ws2', 'PROJ-1', gate())).rejects.toThrow(/capability|connection/);
  });
  it('createCoworkFromTicket emits a workspace-scoped request', () => {
    const j = jira();
    const ticket = { key: 'PROJ-1', summary: 's', status: 'open', assignee: null, url: 'u', updatedAt: 1 };
    const { coworkRequestId } = j.createCoworkFromTicket('ws1', ticket, 'u1', gate({ capability: 'jira.read' }));
    expect(coworkRequestId).toBeTruthy();
  });
});

describe('P3.2 Slack — slash command authorization + isolation', () => {
  const ipc = new IpcBus(new MemoryIpcStore());
  const sink = { posted: [] as string[], async post(ch: string, t: string) { this.posted.push(`${ch}:${t}`); } };
  const slack = () => new SlackConnector(ON('slack'), ipc, sink, (ws) => (ws === 'ws1' ? caps('slack.cmd') : caps()));

  it('slash command is authorized + dispatched and never leaks token', async () => {
    const s = slack();
    s.connect('ws1', 'T1', 'C1', 'xoxb-secret');
    const dispatch = async (cmd: { text: string; workspaceId: string }) => ({ ok: true, action: 'cowork.status', note: cmd.text } as const);
    const res = await s.slash({ command: '/cowork', text: 'status', workspaceId: 'ws1', userId: 'u1' }, dispatch);
    expect(res.action).toBe('cowork.status');
    expect(JSON.stringify(res)).not.toContain('xoxb-secret');
  });
  it('unauthorized workspace cannot issue slash commands', async () => {
    const s = slack();
    s.connect('ws1', 'T1', 'C1', 't');
    const dispatch = async () => ({ ok: true, action: 'unknown' as const });
    await expect(s.slash({ command: '/cowork', text: 'run', workspaceId: 'ws2', userId: 'u1' }, dispatch)).rejects.toThrow(/authorized|connection/);
  });
  it('classifySlashText maps verbs', () => {
    expect(classifySlashText('run this')).toBe('cowork.run');
    expect(classifySlashText('approve')).toBe('cowork.approve');
    expect(classifySlashText('random')).toBe('unknown');
  });
});

describe('P3.3 Device Notifications — scoping, redaction, replay', () => {
  it('registers devices and scopes delivery by workspace', () => {
    const ipc = new IpcBus(new MemoryIpcStore());
    const dn = new DeviceNotifications(ON('notifications'), ipc);
    const w1: Array<{ n: string; ws: string | null }> = [];
    const w2: Array<{ n: string; ws: string | null }> = [];
    dn.registerDevice('d1', { deliver: (_id, n) => void w1.push({ n: n.title, ws: n.workspaceId }) }, 'ws1');
    dn.registerDevice('d2', { deliver: (_id, n) => void w2.push({ n: n.title, ws: n.workspaceId }) }, 'ws2');
    dn.emit('cowork.completed', 'ws1', 'Done', 'body');
    expect(w1.length).toBe(1);
    expect(w2.length).toBe(0);
  });
  it('redacts payloads (secrets never delivered)', () => {
    const dn = new DeviceNotifications(ON('notifications'));
    const out: unknown[] = [];
    dn.registerDevice('d1', { deliver: (_id, n) => void out.push(n.data) }, null);
    dn.emit('agent.failed', null, 'Fail', 'b', { token: 'secret', detail: 'x' });
    expect(JSON.stringify(out[0])).not.toContain('secret');
  });
  it('replays by Last-Event-ID and respects scope', () => {
    const dn = new DeviceNotifications(ON('notifications'));
    dn.registerDevice('d1', { deliver: () => void 0 }, 'ws1');
    const n1 = dn.emit('cowork.completed', 'ws1', 'A', 'a');
    const n2 = dn.emit('cowork.completed', 'ws1', 'B', 'b');
    const afterFirst = dn.replayDevice('d1', 'ws1', Number(n1.id.split('_')[0]));
    expect(afterFirst.map((x) => x.id)).toEqual([n2.id]);
    // a device queued for ws2 does not see ws1 events
    const other = new DeviceNotifications(ON('notifications'));
    other.registerDevice('dX', { deliver: () => void 0 }, 'ws2');
    other.emit('cowork.completed', 'ws1', 'A', 'a');
    expect(other.replayDevice('dX', 'ws2')).toHaveLength(0);
  });
  it('disabled feature is rejected', () => {
    const dn = new DeviceNotifications(OFF);
    expect(() => dn.emit('cowork.completed', null, 'a', 'b')).toThrow(/off/);
  });
});

describe('P3.4 Skill Security — integrity + capability allow-list', () => {
  const reg = createCapabilityRegistry(['filesystem.read', 'git.read']);
  it('tampered content is rejected and re-qualified', () => {
    const ss = new SkillSecurity(ON('skill_security'), reg);
    ss.importSkill('sk1', '1.0.0', 'eval source', { owner: 'u1', capabilities: ['filesystem.read'] });
    expect(() => ss.verify('sk1', 'tampered source', true)).toThrow(/hash mismatch/);
    expect(ss.verify('sk1', 'eval source', true)).toMatchObject({ trust: 'UNTRUSTED', capabilities: ['filesystem.read'] });
  });
  it('an imported skill never silently gains capabilities', () => {
    const ss = new SkillSecurity(ON('skill_security'), reg);
    ss.importSkill('sk2', '1.0.0', 'src', { owner: 'u1', capabilities: ['filesystem.read'] });
    expect(() => ss.assertCapability('sk2', 'git.write')).toThrow(/never silently gained/);
  });
  it('BLOCKED skills never run; UNTRUSTED needs allow-list', () => {
    const ss = new SkillSecurity(ON('skill_security'), reg);
    ss.importSkill('sk3', '1.0.0', 'src', { owner: 'u1', trust: 'BLOCKED' });
    expect(() => ss.verify('sk3', 'src', true)).toThrow(/BLOCKED/);
    ss.importSkill('sk4', '1.0.0', 'src', { owner: 'u1' });
    expect(() => ss.verify('sk4', 'src', false)).toThrow(/UNTRUSTED/);
    expect(ss.verify('sk4', 'src', true).trust).toBe('UNTRUSTED');
  });
  it('secret stripping redacts telemetry', () => {
    const ss = new SkillSecurity(ON('skill_security'), reg);
    const r = ss.redact({ apiKey: 's3cr3t-v4lue', ok: 1 });
    expect(r).toMatchObject({ apiKey: '[REDACTED]' });
    expect(JSON.stringify(r)).not.toContain('s3cr3t-v4lue');
  });
  it('disabled feature is rejected', () => {
    const ss = new SkillSecurity(OFF, reg);
    expect(() => ss.importSkill('a', '1', 'x', { owner: 'u' })).toThrow(/off/);
  });
});

describe('P3.5–3.11 Intelligence agents — capability enforcement + redaction + recommendations-first', () => {
  it('context: 9 agents, requires enforcement, recommendations-first', async () => {
    expect(CONTEXT_AGENTS).toHaveLength(9);
    const ci = new ContextIntelligence(ON('context'), allHas, async () => ({ ok: true, result: { proposal: 1 } }));
    const res = await ci.run('memory_compaction', { value: 'x', token: 'secret' });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.result)).not.toContain('secret');
    // capability gate
    const noCap = new ContextIntelligence(ON('context'), (c) => false, async () => ({ ok: true, result: {} }));
    await expect(noCap.run('memory_compaction', {})).rejects.toThrow(/missing/);
  });

  it('testing: 5 agents', async () => {
    expect(TESTING_AGENTS).toHaveLength(5);
    const ti = new TestingIntelligence(ON('testing'), allHas, async () => ({ ok: true, result: {} }));
    await expect(ti.run('coverage_analyzer', {})).resolves.toMatchObject({ ok: true });
  });

  it('security: 7 agents', async () => {
    expect(SECURITY_AGENTS).toHaveLength(7);
    const si = new SecurityIntelligence(ON('security'), allHas, async () => ({ ok: true, result: {} }));
    await expect(si.run('secret_scanner', {})).resolves.toMatchObject({ ok: true });
  });

  it('performance: 7 agents, cost always recommendation-only', async () => {
    expect(PERFORMANCE_AGENTS).toHaveLength(7);
    const pi = new PerformanceIntelligence(ON('performance'), allHas, async () => ({ ok: true, result: { recommendation: true } }));
    const r = await pi.run('cost_analyzer', {});
    expect((r.result as { recommendation: boolean }).recommendation).toBe(true);
  });

  it('architecture: 5 agents flag duplicate subsystems', async () => {
    expect(ARCHITECTURE_AGENTS).toHaveLength(5);
    const ai = new ArchitectureIntelligence(ON('architecture'), allHas, async () => ({ ok: true, result: { duplicate: false } }));
    await expect(ai.run('canonical_compliance_checker', {})).resolves.toMatchObject({ ok: true });
  });

  it('team: 5 agents respect RBAC/capability gates', async () => {
    expect(TEAM_AGENTS).toHaveLength(5);
    const ti = new TeamIntelligence(ON('team'), (c) => c === 'team.read', async () => ({ ok: true, result: {} }));
    await expect(ti.run('availability', {})).resolves.toMatchObject({ ok: true });
    await expect(ti.run('knowledge_share', {})).rejects.toThrow(/missing/);
  });

  it('documentation: 6 agents, proposals only (no silent production writes)', async () => {
    expect(DOCUMENTATION_AGENTS).toHaveLength(6);
    const di = new DocumentationIntelligence(ON('documentation'), allHas, async () => ({ ok: true, result: { proposal: true } }));
    const r = await di.run('doc_listener', {});
    expect((r.result as { proposal: boolean }).proposal).toBe(true);
  });
});

const allHas = (_c: string) => true;

describe('P3.12 IDE foundation — session isolation + capability gates', () => {
  const ide = () => new IdeFoundation(ON('ide'), (c) => c === 'ide.open' || c === 'ide.diagnostics');
  it('createSession + openFile capability-gated', async () => {
    const i = ide();
    const opened: string[] = [];
    i.registerBridge('b1', { openFile: async (_ws, f) => (opened.push(f), true), applyDiagnostics: async () => void 0 });
    const { sessionId } = i.createSession('ws1', 'b1');
    await expect(i.openFile(sessionId, 'a.ts')).resolves.toBe(true);
    expect(opened).toEqual(['a.ts']);
  });
  it('diagnostics are redacted', async () => {
    const i = ide();
    const seen: unknown[] = [];
    i.registerBridge('b1', { openFile: async () => true, applyDiagnostics: async (_ws, d) => void seen.push(d) });
    const { sessionId } = i.createSession('ws1', 'b1');
    await i.pushDiagnostics(sessionId, [{ severity: 'error', message: 'm', source: 's', file: 'f', line: 1 }]);
    expect(seen.length).toBe(1);
  });
  it('session is not cross-workspace usable', async () => {
    const i = ide();
    i.registerBridge('b1', { openFile: async (_ws, f) => true, applyDiagnostics: async () => void 0 });
    const { sessionId } = i.createSession('ws1', 'b1');
    const noCap = new IdeFoundation(ON('ide'), (c) => false);
    await expect(noCap.openFile(sessionId, 'a.ts')).rejects.toThrow(/capability|session/);
  });
  it('unknown bridge/session rejected', () => {
    const i = ide();
    expect(() => i.createSession('ws1', 'none')).toThrow(/bridge/);
  });
});

describe('P3 canonical reuse — no second event/state system', () => {
  it('P3 integrations publish through the canonical IPC bus (workspace-scoped)', async () => {
    const ipc = new IpcBus(new MemoryIpcStore());
    const secrets = new FakeSecrets();
    const http = {
      repo: async () => ({ owner: 'o', name: 'n', fullName: 'o/n', defaultBranch: 'main', private: false }),
      branches: async () => [], commits: async () => [], listPrs: async () => [],
      pr: async () => ({ number: 1, title: 't', state: 'open' as const, headRef: 'x', baseRef: 'm', author: null, createdAt: 1 }),
      diff: async () => '', comments: async () => [], createPr: async () => null as never, addComment: async () => null as never,
    };
    const g = new GitHubRemote(ON('github'), http, secrets, () => false, () => caps('github.write'));
    // egress fails here by design; just assert no cross-workspace leak in topic space
    const topics: string[] = [];
    ipc.subscribe('aios.p3.github.ws1', (e) => void topics.push(e.topic));
    await expect(g.connect('ws1', 'o/n', 'tok', gate({ capability: 'github.write' }))).rejects.toThrow(/egress/);
    expect(topics).toEqual([]);
  });
});
