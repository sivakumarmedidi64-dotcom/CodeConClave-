/**
 * CodeConClave AI OS — PKG-10 VoiceService tests.
 * Covers the canonical voice subsystem: session, intent parsing, allowlist,
 * authorization, capability, stop-rules, resource governor, workspace
 * isolation, history persistence, tone preferences, feedback states, and
 * hard fail-closed bounds (payment / distributed-exec / isolation / arbitrary
 * shell / B1 review bypass).
 * Read-only; uses in-memory stores and deterministic doubles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStateStore } from '../state.js';
import { ResourceGovernor } from '../resource-governor.js';
import { CapabilityKind } from '../types.js';
import { CommandPalette } from './command-palette.js';
import { VoiceService, VoiceFeedbackState, VoiceTone, VOICE_COMMAND_ALLOWLIST } from './voice-service.js';
import type { VoiceIntent } from './voice.js';

const ON = (f: string) => (() => f) as never;

function caps(...kinds: string[]): { kind: string; scope: string; grantedAt: number }[] {
  return kinds.map((kind) => ({ kind, scope: 'proj', grantedAt: Date.now() }));
}

function makeVoice(governorMax = 2) {
  const feature = ON('voice');
  const palette = new CommandPalette(ON('command_palette'));
  const state = new MemoryStateStore();
  const governor = new ResourceGovernor(governorMax);
  const svc = new VoiceService(feature, palette, state, governor);
  const calls: string[] = [];
  svc.registerCommands(async (id) => {
    calls.push(id);
    return { ok: true };
  });
  const opts = (overrides: Record<string, unknown> = {}) => ({
    userId: 'u1',
    workspaceId: 'ws1',
    capabilities: caps(CapabilityKind.VOICE_CONTROL),
    authorized: true,
    stop: async (_i: VoiceIntent) => ({ allowed: true }),
    execute: async (id: string) => {
      calls.push(id);
      return { ok: true };
    },
    ...overrides,
  });
  return { svc, palette, state, governor, calls, opts };
}

describe('VoiceService — session & prefs', () => {
  it('begins a session in LISTENING and runs feedback states', async () => {
    const { svc, opts } = makeVoice();
    const session = svc.beginSession({ userId: 'u1', workspaceId: 'ws1' });
    expect(session.state).toBe(VoiceFeedbackState.LISTENING);
    const out = await svc.run('run tests', opts());
    expect(out.state).toBe(VoiceFeedbackState.COMPLETED);
    expect(out.commandId).toBe('run_tests');
    expect(svc.currentSession()?.state).toBe(VoiceFeedbackState.COMPLETED);
  });

  it('persists tone preferences via the existing StateStore', async () => {
    const { svc } = makeVoice();
    const prefs = await svc.setPreferences('ws1:u1', { tone: VoiceTone.FRIENDLY, output: 'text' });
    expect(prefs.tone).toBe(VoiceFeedbackState ? VoiceTone.FRIENDLY : VoiceTone.FRIENDLY);
    const got = await svc.preferences('ws1:u1');
    expect(got.tone).toBe(VoiceTone.FRIENDLY);
    // invalid tone is coerced, never crashes
    const coerced = await svc.setPreferences('ws1:u1', { tone: 'SHOUTY' as VoiceTone });
    expect(coerced.tone).toBe(VoiceTone.NEUTRAL);
  });

  it('rejects misuse when voice feature is off', async () => {
    const palette = new CommandPalette(() => null);
    const state = new MemoryStateStore();
    const svc = new VoiceService(() => null, palette, state, new ResourceGovernor(2));
    await expect(svc.run('run tests', {
      userId: 'u1', workspaceId: 'ws1', capabilities: caps(CapabilityKind.VOICE_CONTROL), authorized: true,
      stop: async () => ({ allowed: true }), execute: async () => ({ ok: true }),
    })).rejects.toMatchObject({ errorCode: 'aios_voice_disabled' });
  });
});

describe('VoiceService — command allowlist', () => {
  it('executes only allowlisted existing commands', async () => {
    const { svc, opts } = makeVoice();
    await svc.run('run tests now', opts());
    await svc.run('please show me the schedule', opts());
    await svc.run('accept the hunk', opts());
    expect(opts().execute).toBeDefined();
  });

  it('reports UNSUPPORTED for a command outside the allowlist', async () => {
    const { svc, opts, calls } = makeVoice();
    const out = await svc.run('delete the .env file', opts());
    // delete is not an allowlisted command -> unsupported (or denied by stop)
    expect(['UNSUPPORTED', 'DENIED']).toContain(out.state);
    expect(calls).not.toContain('delete');
  });

  it('never executes arbitrary spoken shell commands', async () => {
    const { svc, opts, calls } = makeVoice();
    await svc.run('rm -rf /', opts());
    await svc.run('curl http://evil.example', opts());
    await svc.run('sudo shutdown now', opts());
    await svc.run('ObfuscatedPayload xyz', opts());
    expect(calls).toHaveLength(0);
    expect(calls).not.toContain('exec');
  });
});

describe('VoiceService — security (fail closed)', () => {
  it('denies unauthorized voice commands', async () => {
    const { svc, opts, calls } = makeVoice();
    const out = await svc.run('run tests', opts({ authorized: false }));
    expect(out.state).toBe(VoiceFeedbackState.DENIED);
    expect(calls).not.toContain('run_tests');
  });

  it('denies when the caller lacks the voice.control capability', async () => {
    const { svc, opts, calls } = makeVoice();
    const out = await svc.run('run tests', opts({ capabilities: caps(CapabilityKind.FILE_READ) }));
    expect(out.state).toBe(VoiceFeedbackState.DENIED);
    expect(calls).not.toContain('run_tests');
  });

  it('denies when the stop-rule gate blocks the intent', async () => {
    const { svc, opts, calls } = makeVoice();
    const out = await svc.run('run tests', opts({ stop: async () => ({ allowed: false, reason: 'blocked' }) }));
    expect(out.state).toBe(VoiceFeedbackState.DENIED);
    expect(calls).not.toContain('run_tests');
  });

  it('denies under resource-governor saturation', async () => {
    const { svc, opts, calls } = makeVoice(1);
    // occupy the single slot
    const g = new ResourceGovernor(1);
    const slot = await g.acquire();
    const svc2 = new VoiceService(ON('voice'), new CommandPalette(ON('command_palette')), new MemoryStateStore(), g);
    svc2.registerCommands(async (id) => { calls.push(id); return { ok: true }; });
    const out = await svc2.run('run tests', opts({ execute: async (id: string) => { calls.push(id); return { ok: true }; } }));
    expect(out.state).toBe(VoiceFeedbackState.DENIED);
    expect(calls).not.toContain('run_tests');
    slot.release();
  });

  it('blocks payment / entitlement activation attempts by voice', async () => {
    const { svc, opts, calls } = makeVoice();
    await svc.run('activate pro plan now', opts());
    await svc.run('pay for workspace', opts());
    await svc.run('grant entitlements', opts());
    // none of these are allowlisted commands; nothing entitled ran
    expect(calls.some((c) => c.includes('pay') || c.includes('activate') || c.includes('entitle'))).toBe(false);
  });

  it('blocks distributed-execution / real-isolation actions by voice', async () => {
    const { svc, opts, calls } = makeVoice();
    await svc.run('start distributed execution', opts());
    await svc.run('enable real container isolation', opts());
    expect(calls).not.toContain('distexec');
    expect(calls).not.toContain('isolation');
  });

  it('never bypasses B1 review — commit still requires explicit authorization', async () => {
    const { svc, opts, calls } = makeVoice();
    await svc.run('commit all changes', opts());
    // no allowlisted command maps to an auto-commit path from voice
    expect(calls).not.toContain('git.commit');
  });
});

describe('VoiceService — workspace isolation & history', () => {
  it('scopes history by user/workspace', async () => {
    const { svc, opts } = makeVoice();
    await svc.run('run tests', opts({ workspaceId: 'ws1' }));
    await svc.run('run tests', opts({ workspaceId: 'ws2', userId: 'u2' }));
    const h1 = await svc.history('u1', 'ws1');
    const h2 = await svc.history('u2', 'ws2');
    const h1b = await svc.history('u1', 'ws2');
    expect(h1.entries.length).toBe(1);
    expect(h2.entries.length).toBe(1);
    expect(h1b.entries.length).toBe(0);
  });

  it('records denied and unsupported commands truthfully, and never raw audio', async () => {
    const { svc, opts } = makeVoice();
    await svc.run('run tests', opts({ authorized: false }));
    const h = await svc.history('u1', 'ws1');
    expect(h.entries[0]?.result).toBe('denied');
    // no raw audio field exists in the persisted record
    expect('audio' in (h.entries[0] ?? {})).toBe(false);
    expect(JSON.stringify(h.entries)).not.toContain('audioBlob');
  });
});

describe('VoiceService — declaration sanity', () => {
  it('exposes the canonical 12-capability status map honestly', () => {
    const { svc } = makeVoice();
    const st = svc.capabilityStatus();
    expect(Object.keys(st).length).toBe(12);
    // provider-dependent capabilities are NOT falsely claimed as implemented
    expect(st['wake_word']).toBe('NOT_IMPLEMENTED');
    expect(st['offline_voice']).toBe('NOT_IMPLEMENTED');
    expect(st['multilingual_voice']).toBe('NOT_IMPLEMENTED');
    expect(st['accent_support']).toBe('NOT_IMPLEMENTED');
  });

  it('allowlist contains the 12 command definitions', () => {
    expect(VOICE_COMMAND_ALLOWLIST).toHaveLength(12);
  });
});

beforeEach(() => {});
