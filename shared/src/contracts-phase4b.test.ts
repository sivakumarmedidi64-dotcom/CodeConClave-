/**
 * CodeConClave — PHASE 4B contract tests.
 * Guards terminal, remote-control and device-pairing contracts:
 * terminal session create/input schemas, shell/timeout validation,
 * remote session schema, pairing code format, state/audit constants.
 */
import { describe, expect, it } from 'vitest';
import {
  terminalCreateSchema,
  terminalInputSchema,
  terminalListQuerySchema,
  terminalSearchQuerySchema,
  remoteSessionCreateSchema,
  pairingCodeSchema,
} from './contracts.js';
import {
  TerminalState,
  TerminalShell,
  RemoteSessionState,
  DevicePresence,
  AuditAction,
  Timeouts,
} from './constants.js';

describe('phase 4b terminal contracts', () => {
  it('terminalCreateSchema accepts a real shell and clamps defaults', () => {
    const input = terminalCreateSchema.parse({ deviceId: 'dev_abc' });
    expect(input.shell).toBe('bash');
    expect(input.timeoutMs).toBeUndefined();
    const full = terminalCreateSchema.parse({
      deviceId: 'dev_abc',
      shell: 'powershell',
      cwd: 'C:\\repo',
      timeoutMs: 300_000,
    });
    expect(full.shell).toBe('powershell');
    expect(full.timeoutMs).toBe(300_000);
  });

  it('terminalCreateSchema rejects unknown shells and out-of-range timeouts', () => {
    expect(() => terminalCreateSchema.parse({ deviceId: 'dev_abc', shell: 'csh' })).toThrow();
    expect(() => terminalCreateSchema.parse({ deviceId: 'dev_abc', timeoutMs: 500 })).toThrow();
    expect(() => terminalCreateSchema.parse({ deviceId: 'dev_abc', timeoutMs: 25 * 60 * 60 * 1000 })).toThrow();
    expect(() => terminalCreateSchema.parse({ deviceId: '', shell: 'bash' })).toThrow();
  });

  it('terminalInputSchema requires bounded input text', () => {
    expect(terminalInputSchema.parse({ input: 'git status' }).input).toBe('git status');
    expect(() => terminalInputSchema.parse({ input: '' })).toThrow();
  });

  it('terminal query schemas coerce limits and require a search term', () => {
    expect(terminalListQuerySchema.parse({}).limit).toBe(50);
    expect(terminalSearchQuerySchema.parse({ q: 'error', limit: '25' }).limit).toBe(25);
    expect(() => terminalSearchQuerySchema.parse({ q: '  ' })).toThrow();
  });

  it('remoteSessionCreateSchema requires a device id', () => {
    expect(remoteSessionCreateSchema.parse({ deviceId: 'dev_abc' }).deviceId).toBe('dev_abc');
    expect(() => remoteSessionCreateSchema.parse({})).toThrow();
  });

  it('pairingCodeSchema only accepts 6 digits', () => {
    expect(pairingCodeSchema.parse('123456')).toBe('123456');
    expect(() => pairingCodeSchema.parse('12345')).toThrow();
    expect(() => pairingCodeSchema.parse('12345a')).toThrow();
  });
});

describe('phase 4b constants', () => {
  it('terminal state machine matches the frozen spec', () => {
    expect(Object.values(TerminalState)).toEqual([
      'PLANNED',
      'STARTING',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'KILLED',
      'TIMED_OUT',
    ]);
  });

  it('terminal shells are the real supported shells', () => {
    expect(Object.values(TerminalShell)).toEqual(['bash', 'zsh', 'node', 'python', 'powershell']);
  });

  it('remote session states are ACTIVE/EXPIRED/REVOKED', () => {
    expect(Object.values(RemoteSessionState)).toEqual(['ACTIVE', 'EXPIRED', 'REVOKED']);
  });

  it('device presence is derived from the live hub socket', () => {
    expect(Object.values(DevicePresence)).toEqual(['ONLINE', 'STALE', 'OFFLINE']);
  });

  it('adds terminal/remote audit actions', () => {
    expect(AuditAction.TERMINAL_SESSION_CREATED).toBe('terminal.session_created');
    expect(AuditAction.TERMINAL_SESSION_KILLED).toBe('terminal.session_killed');
    expect(AuditAction.REMOTE_SESSION_CREATED).toBe('remote.session_created');
    expect(AuditAction.REMOTE_SESSION_REVOKED).toBe('remote.session_revoked');
    expect(AuditAction.REMOTE_SCREENSHOT_AUTHORIZED).toBe('remote.screenshot_authorized');
  });

  it('frozen phase 4b limits and timeouts', () => {
    expect(Timeouts.MAX_PAIRED_DEVICES).toBe(3);
    expect(Timeouts.PAIRING_CODE_TTL_MS).toBe(10 * 60 * 1000);
    expect(Timeouts.REMOTE_SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
    expect(Timeouts.REMOTE_SCREENSHOT_AUTH_TTL_MS).toBe(15 * 60 * 1000);
    expect(Timeouts.AGENT_PRESENCE_STALE_MS).toBe(90 * 1000);
    expect(Timeouts.MAX_TERMINAL_TABS).toBe(8);
  });
});