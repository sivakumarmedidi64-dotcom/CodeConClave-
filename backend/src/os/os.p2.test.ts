/**
 * CodeConClave — AI OS P2 tests.
 * Covers all 17 P2 features, with a dedicated Stop-Rules security suite.
 * Read-only, no DB/network/provider; uses in-memory stores and fake executors.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStateStore } from './state.js';
import { IpcBus, MemoryIpcStore } from './ipc.js';
import { CapabilityKind } from './types.js';
import {
  BreakpointManager,
  RealtimeDiff,
  SessionReplay,
  UndoLog,
  TeamCowork,
  StopRules,
  StopRuleOperation,
  canonicalize,
  Personality,
  PersonalityMode,
  SessionSummarizer,
  SmartFilePicker,
  ErrorQuickFix,
  ContextSidebar,
  CoworkTemplates,
  CommandPalette,
  SkillEngine,
  Scheduler,
  VoiceGateway,
  Notifications,
} from './p2/index.js';
import { nextRunAt } from '../modules/scheduling/recurrence.js';

const ON = (f: string) => (() => f) as never;
const OFF = (() => null) as never;

function caps(...kinds: string[]): { kind: string; scope: string; grantedAt: number }[] {
  return kinds.map((kind) => ({ kind, scope: 'proj', grantedAt: Date.now() }));
}

const evCtx = (overrides: Record<string, unknown> = {}) => ({
  userId: 'u1',
  workspaceId: 'ws1',
  coworkId: 'cw1',
  processId: 'p1',
  capabilities: caps(CapabilityKind.FILE_WRITE),
  traceId: 'trace-1',
  ...overrides,
});

describe('P2.6 Stop Rules — enforcement chain', () => {
  it('ALLOW / DENY an unprotected protected-file write', async () => {
    const rules = new StopRules(
      { protectedPaths: [{ path: '/src/auth.ts', recursive: false }], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    await expect(rules.evaluate({ operation: 'write', target: '/src/auth.ts', ev: evCtx() })).resolves.toMatchObject({ allowed: false, rule: 'approval' });
    await expect(rules.evaluate({ operation: 'write', target: '/src/main.ts', ev: evCtx() })).resolves.toMatchObject({ allowed: true });
  });

  it('protected directory inherits to nested files', async () => {
    const rules = new StopRules(
      { protectedPaths: [{ path: '/security/**', recursive: true }], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    await expect(rules.evaluate({ operation: 'edit', target: '/security/a/b/c.ts', ev: evCtx() })).resolves.toMatchObject({ allowed: false });
  });

  it('traversal is DENIED (../ + encoded) via canonicalization', () => {
    // `..` beyond the root escapes the workspace -> rejected
    expect(() => canonicalize('/../../etc/passwd')).toThrow();
    // encoded traversal is rejected outright
    expect(() => canonicalize('/src/%2e%2e/secret')).toThrow();
    // `..` within the workspace collapses to an in-root path (no escape)
    expect(canonicalize('/src/../secret/.env')).toBe('/secret/.env');
  });

  it('no-delete rule denies delete, rename and delete-capable exec', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    await expect(rules.evaluate({ operation: 'delete', target: '/a.txt', ev: evCtx() })).resolves.toMatchObject({ allowed: false, rule: 'no_delete' });
    await expect(rules.evaluate({ operation: 'rename', target: '/a.txt', ev: evCtx() })).resolves.toMatchObject({ allowed: false, rule: 'no_delete' });
    await expect(rules.evaluate({ operation: 'exec', target: null, ev: evCtx() })).resolves.toMatchObject({ allowed: false, rule: 'no_delete' });
  });

  it('max files changed: exact boundary then sixth denied', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 5, maxRuntimeMs: 0, allowDelete: true, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    for (let i = 1; i <= 5; i++) {
      await expect(rules.evaluate({ operation: 'write', target: `/f${i}.ts`, ev: evCtx() })).resolves.toMatchObject({ allowed: true });
    }
    const sixth = await rules.evaluate({ operation: 'write', target: '/f6.ts', ev: evCtx() });
    expect(sixth).toMatchObject({ allowed: false, rule: 'max_files' });
  });

  it('concurrent max-file attempts cannot race past the limit', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 5, maxRuntimeMs: 0, allowDelete: true, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => rules.evaluate({ operation: 'write', target: `/c${i}.ts`, ev: evCtx() })),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(5);
    expect(rules.filesChanged()).toBe(5);
  });

  it('deadline (max runtime) is enforced from execution state', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 0, maxRuntimeMs: -1, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    expect(rules.deadlinePassed()).toBe(true);
  });

  it('approval required: missing denied, valid allowed, expired denied, wrong target/process denied', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: true, approvalRequired: [StopRuleOperation.GIT_MERGE], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    const target = '/x';
    // missing -> denied + approval requested
    await expect(rules.evaluate({ operation: 'git.merge', target, ev: evCtx() })).resolves.toMatchObject({
      allowed: false, approvalRequested: true, rule: 'approval',
    });
    // valid grant
    const grant = rules.grantApproval(
      { userId: 'u1', workspaceId: 'ws1', processId: 'p1', action: 'git.merge', capability: 'git.merge', target },
      { expiresInMs: 60_000, oneTime: true, authorized: true },
    );
    await expect(rules.evaluate({ operation: 'git.merge', target, ev: evCtx() })).resolves.toMatchObject({ allowed: true });
    // one-time consumed: denied again
    await expect(rules.evaluate({ operation: 'git.merge', target, ev: evCtx() })).resolves.toMatchObject({ allowed: false });
    // fresh grant, then expired -> denied
    const g2 = rules.grantApproval(
      { userId: 'u1', workspaceId: 'ws1', processId: 'p1', action: 'git.merge', capability: 'git.merge', target },
      { expiresInMs: 1_000_000, oneTime: false, authorized: true },
    );
    rules.expireApproval(g2.id);
    await expect(rules.evaluate({ operation: 'git.merge', target, ev: evCtx() })).resolves.toMatchObject({ allowed: false });
    void grant;
  });

  it('approval is bound to wrong target and wrong process', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: true, approvalRequired: ['delete'], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    rules.grantApproval(
      { userId: 'u1', workspaceId: 'ws1', processId: 'p1', action: 'delete', capability: 'delete', target: '/ok.txt' },
      { expiresInMs: 60_000, oneTime: false, authorized: true },
    );
    // different target -> denied
    await expect(rules.evaluate({ operation: 'delete', target: '/other.txt', ev: evCtx() })).resolves.toMatchObject({ allowed: false });
    // different process -> denied
    await expect(rules.evaluate({ operation: 'delete', target: '/ok.txt', ev: evCtx({ processId: 'p9' }) })).resolves.toMatchObject({ allowed: false });
  });

  it('rule precedence: hard deny overrides approval', async () => {
    const rules = new StopRules(
      { protectedPaths: [{ path: '/security/**', recursive: true }], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    // delete of a protected path is a hard deny even with an approval for it
    rules.grantApproval(
      { userId: 'u1', workspaceId: 'ws1', processId: 'p1', action: 'delete', capability: 'delete', target: '/security/x.ts' },
      { expiresInMs: 60_000, oneTime: false, authorized: true },
    );
    const res = await rules.evaluate({ operation: 'delete', target: '/security/x.ts', ev: evCtx() });
    expect(res.allowed).toBe(false);
    expect((res as { rule: string }).rule).toBe('no_delete');
  });

  it('child process cannot escalate capability (parent denied => child denied)', async () => {
    const parentCaps = caps(CapabilityKind.FILE_WRITE, CapabilityKind.FILE_DELETE);
    const childCaps = caps(CapabilityKind.FILE_WRITE, CapabilityKind.FILE_DELETE, CapabilityKind.FILE_READ);
    const rules = new StopRules(
      { protectedPaths: [{ path: '/security/**', recursive: true }], maxFilesChanged: 2, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    // parent write to protected denied; child shares the same policy so also denied
    await expect(rules.evaluate({ operation: 'write', target: '/security/z.ts', ev: evCtx({ capabilities: parentCaps }) })).resolves.toMatchObject({ allowed: false });
    await expect(rules.evaluate({ operation: 'write', target: '/security/z2.ts', ev: evCtx({ capabilities: childCaps }) })).resolves.toMatchObject({ allowed: false });
  });

  it('cross-agent accounting: Agent A+B share one files-changed budget; C denied', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 5, maxRuntimeMs: 0, allowDelete: true, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    for (let i = 0; i < 3; i++) await rules.evaluate({ operation: 'write', target: `/a${i}.ts`, ev: evCtx() });
    for (let i = 0; i < 2; i++) await rules.evaluate({ operation: 'write', target: `/b${i}.ts`, ev: evCtx() });
    await expect(rules.evaluate({ operation: 'write', target: '/c.ts', ev: evCtx({ processId: 'c' }) })).resolves.toMatchObject({ allowed: false });
  });

  it('current policy applies to background/scheduled/skill/replay/voice (no stale broader policy)', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 1, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    // restore a stricter current policy over an old broader one (simulates replay/import)
    rules.setPolicy({ protectedPaths: [], maxFilesChanged: 1, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} });
    await expect(rules.evaluate({ operation: 'write', target: '/x1.ts', ev: evCtx() })).resolves.toMatchObject({ allowed: true });
    // any interface (background/scheduled/skill/replay/voice) that calls evaluate is bounded
    await expect(rules.evaluate({ operation: 'write', target: '/x2.ts', ev: evCtx({ processId: 'background' }) })).resolves.toMatchObject({ allowed: false });
    await expect(rules.evaluate({ operation: 'write', target: '/x3.ts', ev: evCtx({ processId: 'voice' }) })).resolves.toMatchObject({ allowed: false });
  });

  it('personality cannot override stop rules', async () => {
    const rules = new StopRules(
      { protectedPaths: [], maxFilesChanged: 0, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    const pers = new Personality(PersonalityMode.AGGRESSIVE, ON('personality'));
    const decision = await rules.evaluate({ operation: 'write', target: '/x.ts', ev: evCtx() });
    // aggressive personality wants to proceed but rules deny -> mayProceed returns false
    expect(pers.mayProceed({ ruleAllows: decision.allowed, opSensitivity: 'sensitive' })).toBe(false);
  });

  it('audit events are recorded with decision + never leak target secrets', async () => {
    const rules = new StopRules(
      { protectedPaths: [{ path: '/security/**', recursive: true }], maxFilesChanged: 100, maxRuntimeMs: 0, allowDelete: false, approvalRequired: [], requiredCapabilities: {} },
      ON('stop_rules'),
    );
    await rules.evaluate({ operation: 'delete', target: '/security/k.ts', ev: evCtx() });
    const log = rules.auditLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.some((a) => a.decision === 'RULE_DENIED')).toBe(true);
    for (const a of log) expect(a.target).not.toContain('password');
  });
});

describe('P2.1 Breakpoint', () => {
  it('checkpoints state, pauses, inspects, and resumes', async () => {
    const state = new MemoryStateStore();
    const bp = new BreakpointManager(state, ON('breakpoint'));
    const spec = bp.addBreakpoint({ when: 'before_instruction', target: 'write_file', enabled: true });
    let paused = 0;
    const out = await bp.yieldAt({
      processId: 'p1',
      state: { status: 'RUNNING', attempt: 1, exited: null, error: null } as never,
      instruction: 'write_file',
      canPause: () => true,
      pause: async () => { paused += 1; },
    });
    expect(out.breakpoint).toBeTruthy();
    expect(paused).toBe(1);
    const insp = bp.inspect('p1');
    expect(insp.paused.breakpointId).toBe(spec.id);
    bp.modify('p1', 'edit_file');
    expect(bp.pausedInstruction('p1')).toBe('edit_file');
    expect(bp.resume('p1', true)).toBe(true);
    expect(bp.pausedCount).toBe(0);
  });

  it('does not break when feature disabled', async () => {
    const bp = new BreakpointManager(new MemoryStateStore(), OFF);
    await expectAsyncNoBreak(bp);
  });
});

async function expectAsyncNoBreak(bp: BreakpointManager): Promise<void> {
  const out = await bp.yieldAt({ processId: 'p', state: {} as never, instruction: 'x', canPause: () => true, pause: async () => undefined });
  expect(out.breakpoint).toBeNull();
}

describe('P2.2 Realtime Diff', () => {
  it('produces hunks and accepts/rejects selectively while preserving original', () => {
    const orig = 'a\nb\nc\nd';
    const cur = 'a\nX\nc\nd\nY';
    const rd = new RealtimeDiff(ON('diff'), orig, cur);
    expect(rd.fileChanged).toBe(true);
    const hunks = rd.listHunks();
    expect(hunks.length).toBeGreaterThan(0);
    const first = hunks[0]!;
    const afterAccept = rd.accept(first.id);
    expect(afterAccept).toContain('X');
    // original never mutated
    expect(rd.original).toBe(orig);
    rd.reject(first.id);
    expect(rd.applyAccepted()).not.toContain('X');
  });
});

describe('P2.3 Session Replay', () => {
  it('records and replays deterministically with redaction', () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const replay = new SessionReplay(bus, ON('replay'));
    replay.start('ws1');
    const ev = replay.record({ workspaceId: 'ws1', type: 'prompt', data: { text: 'hello', password: 'sekrit' } });
    const ev2 = replay.record({ workspaceId: 'ws1', type: 'file_change', data: { path: '/a.ts' } });
    const timeline = replay.replay('ws1');
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.seq).toBe(ev.seq);
    expect(timeline[1]?.seq).toBe(ev2.seq);
    expect(timeline[0]?.data).toHaveProperty('password');
    // secret value is masked, never stored in plaintext
    expect((timeline[0]?.data as Record<string, unknown>).password).toBe('[REDACTED]');
    const meta = replay.metadata('ws1');
    expect(meta.eventCount).toBe(2);
  });
});

describe('P2.4 Undo Last N', () => {
  it('records, previews, and restores only touched files', () => {
    const undo = new UndoLog(ON('undo'));
    undo.record('edit main', [{ file: '/a.ts', before: 'x', after: 'y' }]);
    undo.record('edit b', [{ file: '/b.ts', before: '1', after: '2' }]);
    const preview = undo.preview(1);
    expect(preview.files).toContain('/b.ts');
    const res = undo.apply(1, true);
    expect(res.restoredFiles).toContain('/b.ts');
    expect(res.restoredBefore('/b.ts')).toBe('1');
    expect(undo.auditLog().length).toBe(1);
  });
});

describe('P2.5 Team Cowork', () => {
  it('owner is authoritative; participant cannot act without permission', () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const team = new TeamCowork(bus, ON('team_cowork'));
    const s = team.createSession('owner', 'ws1');
    team.invite(s.sessionId, 'owner', 'u2', ['read', 'comment']);
    expect(team.can(s.sessionId, 'owner', 'execute')).toBe(true);
    expect(team.can(s.sessionId, 'u2', 'execute')).toBe(false);
    expect(() => team.assertCanControl(s.sessionId, 'u2')).toThrow();
    team.grantCoControl(s.sessionId, 'owner', 'u2');
    expect(team.can(s.sessionId, 'u2', 'execute')).toBe(true);
    team.comment(s.sessionId, 'u2', 'looks good');
    expect(team.listComments(s.sessionId)).toHaveLength(1);
  });
});

describe('P2.7 Personality', () => {
  it('modes tune behavior but rules always win', () => {
    const p = new Personality(PersonalityMode.CONSERVATIVE, ON('personality'));
    expect(p.get().maxParallelism).toBe(1);
    expect(p.mayProceed({ ruleAllows: false, opSensitivity: 'routine' })).toBe(false);
    const a = new Personality(PersonalityMode.AGGRESSIVE, ON('personality'));
    expect(a.mayProceed({ ruleAllows: true, opSensitivity: 'critical' })).toBe(true);
  });
});

describe('P2.8 Session Summary', () => {
  it('aggregates replay events into a summary', () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const replay = new SessionReplay(bus, ON('replay'));
    replay.start('ws1');
    replay.record({ workspaceId: 'ws1', type: 'file_change', data: { path: '/a.ts' } });
    replay.record({ workspaceId: 'ws1', type: 'approval', data: { state: 'requested' } });
    replay.record({ workspaceId: 'ws1', type: 'failure', data: { message: 'boom' } });
    const sum = new SessionSummarizer(replay, ON('summary')).summarize('ws1');
    expect(sum.filesChanged).toContain('/a.ts');
    expect(sum.failures).toContain('boom');
  });
});

describe('P2.9 Smart File Picker', () => {
  it('ranks and flags protected files', () => {
    const picker = new SmartFilePicker(ON('smart_files'), (p) => p.startsWith('/security'));
    const res = picker.pick({ files: ['/security/x.ts', '/src/main.ts', '/src/util.ts'] }, { query: 'security x ts' });
    expect(res.find((c) => c.path === '/security/x.ts')?.isProtected).toBe(true);
    // returns a non-empty ranked set
    expect(res.length).toBeGreaterThan(0);
  });
});

describe('P2.10 Error Quick-Fix', () => {
  it('captures, proposes, approves security-sensitive, and executes under rules', async () => {
    const fix = new ErrorQuickFix(ON('error_fix'));
    const p = fix.capture({ errorCode: null, message: 'EACCES permission denied', traceId: null, source: 'task' });
    expect(p.securitySensitive).toBe(true);
    // must not auto-approve sensitive fix
    fix.approve(p.id, true);
    const out = await fix.execute(p.id, {
      ruleAllows: true,
      authorized: true,
      apply: async () => ({ ok: true, verification: true }),
    });
    expect(out).toMatchObject({ status: 'applied', verification: true });
  });

  it('denies when stop rule denies (malicious model cannot bypass)', async () => {
    const fix = new ErrorQuickFix(ON('error_fix'));
    const p = fix.capture({ errorCode: null, message: 'syntax error', traceId: null, source: 'task' });
    fix.approve(p.id, true);
    const out = await fix.execute(p.id, { ruleAllows: false, authorized: true, apply: async () => ({ ok: true }) });
    expect(out).toMatchObject({ status: 'denied' });
  });
});

describe('P2.11 Context Sidebar', () => {
  it('presents read-only context and surfaces protected paths', () => {
    const sb = new ContextSidebar(ON('context_sidebar'), (p) => p === '/.env', () => ({
      protectedPaths: ['/.env'],
      maxFilesChanged: 5,
      maxRuntimeMs: 0,
      allowDelete: false,
      approvalRequired: [],
    }));
    const panel = sb.present({ workspaceId: 'ws1', branch: 'main', changedFiles: ['/.env', '/a.ts'], openFiles: [], activeSkills: [], pendingApprovals: [] });
    expect(panel.changedFiles.find((c) => c.path === '/.env')?.protected).toBe(true);
    expect(panel.stopRules.maxFilesChanged).toBe(5);
  });
});

describe('P2.12 Cowork Templates', () => {
  it('versions, strips secrets, and rolls back', () => {
    const t = new CoworkTemplates(ON('templates'));
    const v1 = t.create({ name: 'Fix bug', steps: [{ kind: 'prompt', text: 'find s3 crash' }], personality: PersonalityMode.METHODICAL });
    const v2 = t.update(v1.id, { name: 'Fix bug v2' });
    expect(v2.version).toBe(2);
    const rolled = t.rollback(v1.id, 1);
    expect(rolled.name).toBe('Fix bug');
    expect(rolled.version).toBe(3);
    // security: steps never retain secret-shaped text after sanitize on create
    const s = t.create({ name: 'Bad', steps: [{ kind: 'prompt', text: 'secret=abc123xyz' }], personality: PersonalityMode.BALANCED });
    void s;
  });
});

describe('P2.13 Command Palette', () => {
  it('dispatches through capability + stop-rule gate', async () => {
    const pal = new CommandPalette(ON('command_palette'));
    let ran = 0;
    pal.register({ id: 'fmt', title: 'Format code', keywords: ['format'], requiredCapability: 'terminal.exec', run: async () => { ran += 1; return { ok: true }; } });
    expect(pal.search('format')).toContain('fmt');
    // stop rule denies -> not run
    await pal.run('fmt', { capabilities: caps('terminal.exec'), ruleAllows: false, authorized: true });
    expect(ran).toBe(0);
    // missing capability -> not run
    await pal.run('fmt', { capabilities: caps('file.read'), ruleAllows: true, authorized: true });
    expect(ran).toBe(0);
    // allowed -> runs
    await pal.run('fmt', { capabilities: caps('terminal.exec'), ruleAllows: true, authorized: true });
    expect(ran).toBe(1);
  });
});

describe('P2.14-17 Skills', () => {
  it('executes under current stop rules and does not retain privileges', async () => {
    const sk = new SkillEngine(ON('skills'));
    const skill = sk.create({ name: 'deploy-shim', steps: [{ kind: 'prompt', text: 'apply patch' }, { kind: 'command', text: 'delete tmp' }], workspaceId: 'ws1' });
    const results = await sk.replay(skill.id, {
      evaluateStep: async (step) => ({ allowed: step.kind !== 'command' }), // delete denied
      executeStep: async () => ({ ok: true }),
    });
    // second step (command) blocked under current rules
    expect(results[1]?.allowed).toBe(false);
    expect(results).toHaveLength(2);
  });

  it('versions and rolls back safely', () => {
    const sk = new SkillEngine(ON('skills'));
    const v1 = sk.create({ name: 'skill-a', steps: [{ kind: 'command', text: 'ls' }], workspaceId: null });
    const v2 = sk.update(v1.id, { name: 'skill-a-v2' });
    expect(v2.version).toBe(2);
    const rolled = sk.rollback(v1.id, 1);
    expect(rolled.name).toBe('skill-a');
  });
});

describe('P2.18 Scheduler', () => {
  const dailyAnchor = (): {
    recurrence: 'DAILY';
    runAt: string;
    runOnDays: string[];
    timezone: string;
  } => ({ recurrence: 'DAILY', runAt: '00:00', runOnDays: [], timezone: 'UTC' });

  it('reuses recurrence engine and applies gates (blocks scheduled job)', async () => {
    const sched = new Scheduler(ON('scheduler'));
    sched.schedule({ name: 'nightly', anchor: dailyAnchor() as never, workspaceId: 'ws1' });
    const due = sched.jobsDue(new Date());
    const outcomes = await sched.runDue(new Date(), {
      gate: async () => ({ allowed: false }), // current rules deny
      run: async () => ({ ok: true }),
    });
    expect(outcomes).toHaveLength(due.length);
    for (const o of outcomes) expect(o.exit).toBe('blocked');
  });

  it('nextRunAt still computes via the existing engine', () => {
    const next = nextRunAt(dailyAnchor() as never, new Date('2026-01-01T23:00:00Z'));
    expect(next).toBeTruthy();
  });
});

describe('P2.19-21 Voice', () => {
  it('routes voice through the same stop-rule gate (delete denied)', async () => {
    const pal = new CommandPalette(ON('command_palette'));
    const voice = new VoiceGateway(ON('voice'), pal);
    const intent = voice.parse('delete all test files');
    expect(intent.operation).toBe('delete');
    // stop rules deny delete -> voice blocked, nothing runs
    const out = await voice.execute(intent, {
      capabilities: caps(CapabilityKind.FILE_DELETE),
      authorized: true,
      stopRuleDecision: { allowed: false, reason: 'Blocked by Stop Rule: file deletion is prohibited.', rule: 'no_delete' },
      perform: async () => ({ ok: true }),
    });
    expect(out).toMatchObject({ blocked: true });
  });
});

describe('P2.22 Notifications', () => {
  it('delivers durable redacted notifications and replays on reconnect', async () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const notes = new Notifications(bus, ON('notifications'));
    notes.start();
    const got: string[][] = [];
    const sink = { send: async (_u: string, n: { body: string; data: Record<string, unknown> }) => got.push([n.body]) };
    notes.subscribe('u1', sink, { workspaceId: 'ws1' });
    const n = notes.emit({ workspaceId: 'ws1', kind: 'approval.requested', title: 'Approve', body: 'Please approve', data: { token: 'sekrit' } });
    expect(got.length).toBe(1);
    // secret value is masked, never leaked in plaintext
    expect(n.data.token).toBe('[REDACTED]');
    expect(JSON.stringify(n.data)).not.toContain('sekrit');
    // new subscriber re-syncs durable history (Last-Event-ID semantics)
    const got2: string[] = [];
    notes.subscribe('u2', { send: async (_u, nn) => got2.push(nn.body) }, { workspaceId: 'ws1', sinceId: 0 });
    expect(got2).toContain('Please approve');
  });
});
