import { describe, expect, it } from 'vitest';
import { newId } from './contracts.js';
import { PaymentState, TaskStatus, ProPlan } from './constants.js';

describe('shared', () => {
  it('newId produces prefixed ids', () => {
    const id = newId('task');
    expect(id).toMatch(/^task_[a-z0-9]{20}$/);
  });

  it('payment state machine constants are frozen', () => {
    expect(PaymentState.VERIFIED).toBe('VERIFIED');
    expect(PaymentState.PENDING).toBe('PENDING');
  });

  it('task statuses include all mandated states', () => {
    const required = [
      'CREATED', 'PLANNED', 'WAITING_APPROVAL', 'RUNNING', 'TESTING',
      'VERIFIED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED',
      'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW',
    ];
    for (const s of required) expect(TaskStatus[s as keyof typeof TaskStatus]).toBe(s);
  });

  it('pro plan price and link are the frozen values', () => {
    expect(ProPlan.PRICE_INR).toBe(999);
    expect(ProPlan.PAYMENT_LINK).toBe('https://rzp.io/rzp/sAgHIpxS');
  });
});
