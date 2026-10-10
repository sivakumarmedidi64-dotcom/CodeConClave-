/**
 * CodeConClave — P2 desktop-control policy tests.
 *
 * The desktop policy is the contract between the Cloud control plane and the
 * local agent. These tests pin its deny-by-default surface: a minimal op set,
 * strict action shapes, op→capability enforcement, the server-side app
 * allowlist, anti-loop bounds and honest lifetime clamping.
 */
import { describe, it, expect, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  DESKTOP_CONTROL_ENABLED: 'false',
  DESKTOP_ALLOWED_APPS: 'notepad, calculator',
}));
vi.mock('../../config/env.js', () => ({ env: mockEnv }));

import {
  parseDesktopInstruction,
  desktopControlEnabled,
  desktopAllowedApps,
  desktopInstructionRequiredCapabilities,
  desktopActionRisk,
  DESKTOP_OP_TO_CAPABILITY,
  DESKTOP_MAX_ACTIONS,
} from './desktop-policy.js';
import { DesktopActionOp, DesktopCapability } from '@codeconclave/shared';

const instruction = {
  type: 'desktop',
  grants: { capabilities: ['desktop.inspect', 'desktop.open_app', 'desktop.focus_window'], lifetimeMs: 24 * 60 * 60 * 1000 },
  actions: [{ op: 'list_windows' }, { op: 'open_app', app: 'notepad' }, { op: 'focus_window', title: 'Untitled - Notepad' }],
};

describe('desktop policy — gate + allowlist', () => {
  it('is disabled by default and reads a normalized allowlist', () => {
    expect(desktopControlEnabled()).toBe(false);
    expect(desktopAllowedApps()).toEqual(['notepad', 'calculator']);
  });
});

describe('desktop policy — instruction parsing', () => {
  it('accepts a valid instruction and normalizes it', () => {
    const r = parseDesktopInstruction(instruction);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instruction.type).toBe('desktop');
    expect(r.instruction.actions).toHaveLength(3);
    expect(r.instruction.actions[1]).toEqual({ op: 'open_app', app: 'notepad' });
  });

  it('rejects a non-desktop instruction type', () => {
    expect(parseDesktopInstruction({ ...instruction, type: 'browser' }).ok).toBe(false);
  });

  it('rejects empty capabilities and missing/empty actions', () => {
    expect(parseDesktopInstruction({ ...instruction, grants: { ...instruction.grants, capabilities: [] } }).ok).toBe(false);
    expect(parseDesktopInstruction({ ...instruction, actions: [] }).ok).toBe(false);
    expect(parseDesktopInstruction({ ...instruction, actions: undefined }).ok).toBe(false);
  });

  it('rejects an unknown op and enforces op→capability', () => {
    expect(parseDesktopInstruction({ ...instruction, actions: [{ op: 'screenshot' }] }).ok).toBe(false);
    const noOpen = { ...instruction, grants: { ...instruction.grants, capabilities: ['desktop.inspect'] }, actions: [{ op: 'open_app', app: 'notepad' }] };
    const r = parseDesktopInstruction(noOpen);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('capability_not_granted_open_app');
  });

  it('refuses to launch an app that is not on the server allowlist', () => {
    const r = parseDesktopInstruction({ ...instruction, actions: [{ op: 'open_app', app: 'powershell' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('op_open_app_not_allowlisted');
  });

  it('requires a window title to focus', () => {
    const r = parseDesktopInstruction({ ...instruction, actions: [{ op: 'focus_window' }] });
    expect(r.ok).toBe(false);
  });

  it('bounds the action count', () => {
    const many = { ...instruction, actions: Array.from({ length: DESKTOP_MAX_ACTIONS + 1 }, () => ({ op: 'list_windows' })) };
    const r = parseDesktopInstruction(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('actions_too_many');
  });

  it('clamps the permission lifetime to the maximum', () => {
    const r = parseDesktopInstruction({ ...instruction, grants: { ...instruction.grants, lifetimeMs: Number.MAX_SAFE_INTEGER } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instruction.grants.lifetimeMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });

  it('keeps a pinned device id within bounds', () => {
    const r = parseDesktopInstruction({ ...instruction, pinnedDeviceId: 'dev_1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instruction.pinnedDeviceId).toBe('dev_1');
  });
});

describe('desktop policy — capability + risk model', () => {
  it('maps every op to exactly one capability', () => {
    expect(Object.keys(DESKTOP_OP_TO_CAPABILITY).sort()).toEqual(['focus_window', 'list_windows', 'open_app']);
    expect(DESKTOP_OP_TO_CAPABILITY.list_windows).toBe(DesktopCapability.INSPECT);
    expect(DESKTOP_OP_TO_CAPABILITY.open_app).toBe(DesktopCapability.OPEN_APP);
    expect(DESKTOP_OP_TO_CAPABILITY.focus_window).toBe(DesktopCapability.FOCUS_WINDOW);
  });

  it('computes the required capabilities from the actions', () => {
    const r = parseDesktopInstruction(instruction);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(desktopInstructionRequiredCapabilities(r.instruction)!.sort()).toEqual(['desktop.focus_window', 'desktop.inspect', 'desktop.open_app']);
  });

  it('classifies launch/focus as MEDIUM and inspection as LOW', () => {
    expect(desktopActionRisk(DesktopActionOp.LIST_WINDOWS)).toBe('LOW');
    expect(desktopActionRisk(DesktopActionOp.OPEN_APP)).toBe('MEDIUM');
    expect(desktopActionRisk(DesktopActionOp.FOCUS_WINDOW)).toBe('MEDIUM');
  });
});
