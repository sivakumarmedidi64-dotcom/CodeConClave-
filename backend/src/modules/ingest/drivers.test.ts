/**
 * CodeConClave — Resident drivers · unit tests (no DB, no network).
 * v3 arc: 5 drivers cover 14 registry slots (13 roles + Route-scout),
 * Dispatch picks exactly 1 role · 1 run.
 */
import { describe, expect, it } from 'vitest';
import { RESIDENT_DRIVERS, V3_ROLES, driverForBox, driverForRole } from './drivers.js';

describe('resident drivers → v3 arc', () => {
  it('registers exactly 5 tuned drivers', () => {
    expect(RESIDENT_DRIVERS).toHaveLength(5);
  });

  it('covers every v3 role exactly once', () => {
    const covered = RESIDENT_DRIVERS.flatMap((d) => d.roles).sort();
    expect(covered.sort()).toEqual([...V3_ROLES].sort());
  });

  it('scout stays ≤300 tokens', () => {
    expect(driverForBox('SCOUT')?.maxTokens).toBeLessThanOrEqual(300);
  });

  it('resolves driver per role and per box', () => {
    expect(driverForRole('Coder')?.hubId).toContain('coder-lite');
    expect(driverForRole('Reviewer')?.hubId).toContain('reviewer');
    expect(driverForBox('PLANNER')?.hubId).toContain('planner-lite');
    expect(driverForBox('GATE')?.hubId).toContain('fastqa');
  });

  it('every driver binds contract + Sai sources', () => {
    for (const d of RESIDENT_DRIVERS) {
      expect(d.contract.length).toBeGreaterThan(0);
      expect(d.saiSources.length).toBeGreaterThan(0);
    }
  });
});
