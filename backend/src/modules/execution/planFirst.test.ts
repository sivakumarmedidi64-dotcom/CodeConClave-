/**
 * Article 5 (plan first, then act): the chat text shows the real plan, says
 * nothing runs until approval, and is honest about where the plan came from.
 * The full flow (task held → approve → queued; reject → cancelled) is
 * exercised against real Postgres in the e2e harness.
 */
import { describe, it, expect } from 'vitest';
import { describePlanForChat } from './orchestrator.js';

describe('plan-first chat text', () => {
  const entries = [
    { coworker: 'ARCHITECT', acceptanceCriteria: 'design the endpoint' },
    { coworker: 'CODER' },
    { coworker: 'TESTER', acceptanceCriteria: 'tests pass' },
  ];

  it('lists every step in order and says nothing runs before approval', () => {
    const text = describePlanForChat({ entries, source: 'planner' }, 30);
    expect(text).toContain("Nothing runs until you approve it");
    expect(text).toContain('1. **Architect** — design the endpoint');
    expect(text).toContain('2. **Coder**');
    expect(text).toContain('3. **Tester** — tests pass');
    expect(text).toContain('30 minutes');
    expect(text).not.toContain('standard team plan');
  });

  it('says so when the planner was unavailable', () => {
    expect(describePlanForChat({ entries, source: 'default_fallback' }, 30)).toContain("standard team plan");
  });

  it('says so when the plan is the team the user picked', () => {
    expect(describePlanForChat({ entries, source: 'user' }, 30)).toContain('the team you picked');
  });
});
