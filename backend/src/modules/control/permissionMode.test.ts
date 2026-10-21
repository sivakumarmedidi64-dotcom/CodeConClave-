/**
 * Permission modes only waive approval PROMPTS for edits (and MEDIUM commands
 * in full_access). Denials, deletes and HIGH/CRITICAL actions never change.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyPermissionMode, evaluateToolCall, type PolicyDecision } from '../execution/policy.js';
import { _setPermissionModeForTests, isPermissionMode, permissionModeFor } from './permissionMode.js';

const ask = (risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): PolicyDecision => ({ allowed: true, risk, requiresApproval: true });
const denied: PolicyDecision = { allowed: false, deniedBy: 'baseline_secrets', reason: 'no' };

describe('applyPermissionMode', () => {
  it('ask changes nothing', () => {
    expect(applyPermissionMode('file_write', ask('MEDIUM'), 'ask')).toEqual(ask('MEDIUM'));
  });

  it('accept_edits waives approval for writes and creates only', () => {
    expect(applyPermissionMode('file_write', ask('MEDIUM'), 'accept_edits')).toMatchObject({ requiresApproval: false, approvalWaivedBy: 'accept_edits' });
    expect(applyPermissionMode('file_create', ask('MEDIUM'), 'accept_edits')).toMatchObject({ requiresApproval: false });
    expect(applyPermissionMode('terminal_exec', ask('MEDIUM'), 'accept_edits').allowed && applyPermissionMode('terminal_exec', ask('MEDIUM'), 'accept_edits')).toMatchObject({ requiresApproval: true });
  });

  it('full_access also waives MEDIUM commands but never HIGH/CRITICAL or deletes', () => {
    expect(applyPermissionMode('terminal_exec', ask('MEDIUM'), 'full_access')).toMatchObject({ requiresApproval: false, approvalWaivedBy: 'full_access' });
    expect(applyPermissionMode('terminal_exec', ask('HIGH'), 'full_access')).toMatchObject({ requiresApproval: true });
    expect(applyPermissionMode('terminal_exec', ask('CRITICAL'), 'full_access')).toMatchObject({ requiresApproval: true });
    expect(applyPermissionMode('file_delete', ask('HIGH'), 'full_access')).toMatchObject({ requiresApproval: true });
  });

  it('never turns a denial into an allow', () => {
    for (const mode of ['ask', 'accept_edits', 'full_access'] as const) {
      expect(applyPermissionMode('file_write', denied, mode)).toEqual(denied);
    }
  });
});

describe('evaluateToolCall with a cached mode', () => {
  afterEach(() => _setPermissionModeForTests('usr_pm', null));

  it('defaults to ask when nothing is cached', () => {
    expect(permissionModeFor('usr_unknown')).toBe('ask');
  });

  it('full_access still denies secret paths and dangerous commands', () => {
    _setPermissionModeForTests('usr_pm', 'full_access');
    expect(evaluateToolCall({ tool: 'file_write', input: { path: '.env' }, userId: 'usr_pm' }).allowed).toBe(false);
    expect(evaluateToolCall({ tool: 'terminal_exec', input: { command: 'rm -rf /' }, userId: 'usr_pm' }).allowed).toBe(false);
  });

  it('validates mode names', () => {
    expect(isPermissionMode('full_access')).toBe(true);
    expect(isPermissionMode('bypass')).toBe(false);
  });
});

describe('Power Mode (time-boxed permission mode)', () => {
  afterEach(() => _setPermissionModeForTests('usr_pw', null));

  it('applies until it expires, then falls back to the previous mode — even from cache', () => {
    _setPermissionModeForTests('usr_pw', 'full_access', { expiresAt: Date.now() + 60_000, revertTo: 'accept_edits' });
    expect(permissionModeFor('usr_pw')).toBe('full_access');
    _setPermissionModeForTests('usr_pw', 'full_access', { expiresAt: Date.now() - 1, revertTo: 'accept_edits' });
    expect(permissionModeFor('usr_pw')).toBe('accept_edits');
  });

  it('a lapsed grant with an unknown fallback drops to the strictest mode', () => {
    _setPermissionModeForTests('usr_pw', 'full_access', { expiresAt: Date.now() - 1, revertTo: undefined as never });
    expect(permissionModeFor('usr_pw')).toBe('ask');
  });

  it('while live it waives edit approvals; once lapsed, edits ask again', () => {
    // The policy engine applies whatever permissionModeFor() returns.
    const edit = () => applyPermissionMode('file_write', ask('MEDIUM'), permissionModeFor('usr_pw'));
    _setPermissionModeForTests('usr_pw', 'full_access', { expiresAt: Date.now() + 60_000, revertTo: 'ask' });
    expect(edit()).toMatchObject({ requiresApproval: false, approvalWaivedBy: 'full_access' });
    _setPermissionModeForTests('usr_pw', 'full_access', { expiresAt: Date.now() - 1, revertTo: 'ask' });
    expect(edit()).toMatchObject({ requiresApproval: true });
  });
});
