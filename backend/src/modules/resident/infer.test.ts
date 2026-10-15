/**
 * CodeConclave AI — resident routing tests (no DB, no network).
 * v3 Dispatch: task type → exactly one tuned driver, or gateway.
 */
import { describe, expect, it } from 'vitest';
import { residentRoleForTask, guardScout } from './infer.js';
import { driverForRole } from '../ingest/drivers.js';

describe('resident routing', () => {
  it('maps code tasks to the Coder driver', () => {
    for (const t of ['CODING', 'DEBUGGING', 'REFACTORING', 'TEST_GENERATION']) {
      const role = residentRoleForTask(t);
      expect(role).toBe('Coder');
      expect(driverForRole(role!)?.hubId).toContain('coder-lite');
    }
  });

  it('maps review + plan tasks to their drivers', () => {
    expect(driverForRole(residentRoleForTask('CODE_REVIEW')!)?.hubId).toContain('reviewer');
    expect(driverForRole(residentRoleForTask('ARCHITECTURE')!)?.hubId).toContain('planner-lite');
    expect(driverForRole(residentRoleForTask('PLANNING')!)?.hubId).toContain('planner-lite');
  });

  it('leaves chat, vision, tools and science tasks to the gateway', () => {
    for (const t of ['GENERAL_CHAT', 'MULTIMODAL_ANALYSIS', 'TOOL_USE', 'TERMINAL_EXECUTION', undefined]) {
      expect(residentRoleForTask(t)).toBeUndefined();
    }
  });

  it('rejects malformed scout JSON (fail-closed to operator)', () => {
    expect(guardScout('{"lane":"CODER","risk":"LOW"}')).toBe(true);
    expect(guardScout('sure, CODER looks good')).toBe(false);
  });
});
