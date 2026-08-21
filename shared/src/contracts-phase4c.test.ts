/**
 * CodeConClave — PHASE 4C contract tests.
 * Guards the Approval Center contracts: proposal (action type, risk level,
 * justification, affected resources, proposed action, expiry window),
 * human-gate execution (tool + input + optional device), and the new
 * status/audit/timeout constants.
 */
import { describe, expect, it } from 'vitest';
import {
  approvalResourceSchema,
  approvalProposeSchema,
  approvalExecuteSchema,
} from './contracts.js';
import {
  ApprovalActionType,
  ApprovalExecutionState,
  ApprovalStatus,
  AuditAction,
  Timeouts,
} from './constants.js';

describe('phase 4c approval proposal contract', () => {
  const base = {
    actionType: ApprovalActionType.FILE_WRITE,
    justification: 'apply the reviewed patch',
    affectedResources: [{ type: 'file', ref: 'src/app.ts' }],
    proposedAction: { tool: 'write_file', input: { path: 'src/app.ts' } },
  };

  it('accepts a full proposal with defaults applied', () => {
    const input = approvalProposeSchema.parse(base);
    expect(input.riskLevel).toBeUndefined();
    expect(input.model).toBeUndefined();
    expect(input.proposedAction).toEqual({ tool: 'write_file', input: { path: 'src/app.ts' } });
    expect(input.expiresInMs).toBeUndefined();
  });

  it('accepts every frozen action type', () => {
    for (const t of Object.values(ApprovalActionType)) {
      const input = approvalProposeSchema.parse({ ...base, actionType: t });
      expect(input.actionType).toBe(t);
    }
  });

  it('accepts HIGH risk and metadata fields', () => {
    const input = approvalProposeSchema.parse({
      ...base,
      riskLevel: 'CRITICAL',
      coworker: 'tester',
      model: 'deepseek-v4',
      taskId: 'tsk_1',
      expiresInMs: 30 * 60 * 1000,
    });
    expect(input.riskLevel).toBe('CRITICAL');
    expect(input.coworker).toBe('tester');
    expect(input.model).toBe('deepseek-v4');
    expect(input.taskId).toBe('tsk_1');
  });

  it('rejects empty justification, empty resources and unknown actions', () => {
    expect(() => approvalProposeSchema.parse({ ...base, justification: '   ' })).toThrow();
    expect(() => approvalProposeSchema.parse({ ...base, affectedResources: [] })).toThrow();
    expect(() => approvalProposeSchema.parse({ ...base, actionType: 'rm_rf' })).toThrow();
  });

  it('caps resources and expiry at the frozen limits', () => {
    const many = Array.from({ length: Timeouts.APPROVAL_MAX_RESOURCES + 1 }, (_, i) => ({
      type: 'file',
      ref: `f${i}`,
    }));
    expect(() => approvalProposeSchema.parse({ ...base, affectedResources: many })).toThrow();
    expect(() => approvalProposeSchema.parse({ ...base, expiresInMs: 59_999 })).toThrow();
    expect(() => approvalProposeSchema.parse({ ...base, expiresInMs: Timeouts.APPROVAL_DEFAULT_EXPIRY_MS + 1 })).toThrow();
    expect(() => approvalProposeSchema.parse({ ...base, expiresInMs: 10 * 60 * 1000 })).not.toThrow();
  });
});

describe('phase 4c approval execution contract', () => {
  it('accepts a tool call with optional device id', () => {
    const input = approvalExecuteSchema.parse({
      tool: 'run_command',
      input: { command: 'git status' },
      deviceId: 'dev_1',
    });
    expect(input.tool).toBe('run_command');
    expect(input.deviceId).toBe('dev_1');
  });

  it('rejects empty tool names and non-object inputs', () => {
    expect(() => approvalExecuteSchema.parse({ tool: '', input: {} })).toThrow();
    expect(() => approvalExecuteSchema.parse({ tool: 'x', input: 'nope' })).toThrow();
  });
});

describe('phase 4c constants', () => {
  it('approval lifecycle includes EXECUTED and CANCELLED', () => {
    expect(ApprovalStatus.EXECUTED).toBe('EXECUTED');
    expect(ApprovalStatus.CANCELLED).toBe('CANCELLED');
  });

  it('action types are frozen to the spec list', () => {
    expect(Object.values(ApprovalActionType)).toEqual([
      'file_read',
      'file_write',
      'file_create',
      'file_delete',
      'terminal_exec',
      'network_request',
      'plugin_action',
      'publish',
      'deploy',
      'production_op',
      'secret_access',
      'policy_override',
      'payment_op',
      'remote_exec',
      'batch',
    ]);
  });

  it('execution states are RUNNING/SUCCEEDED/FAILED', () => {
    expect(Object.values(ApprovalExecutionState)).toEqual(['RUNNING', 'SUCCEEDED', 'FAILED']);
  });

  it('adds phase 4c audit actions', () => {
    expect(AuditAction.APPROVAL_CREATED).toBe('approval.created');
    expect(AuditAction.APPROVAL_EXECUTION_STARTED).toBe('approval.execution_started');
    expect(AuditAction.APPROVAL_EXECUTION_SUCCEEDED).toBe('approval.execution_succeeded');
    expect(AuditAction.APPROVAL_EXECUTION_FAILED).toBe('approval.execution_failed');
    expect(AuditAction.APPROVAL_EXPIRED).toBe('approval.expired');
  });

  it('phase 4c defaults: 30-minute expiry, 50 resources max', () => {
    expect(Timeouts.APPROVAL_DEFAULT_EXPIRY_MS).toBe(30 * 60 * 1000);
    expect(Timeouts.APPROVAL_MAX_RESOURCES).toBe(50);
  });
});
