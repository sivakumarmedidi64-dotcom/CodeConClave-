import { describe, expect, it } from 'vitest';
import { personalInstructionsBlock } from './chat.js';

describe('personalInstructionsBlock', () => {
  it('is empty when nothing is set', () => {
    expect(personalInstructionsBlock({})).toBe('');
    expect(personalInstructionsBlock({ call_me: '  ', personal_instructions: '' })).toBe('');
  });

  it('labels the block as user preferences beneath the rules', () => {
    const block = personalInstructionsBlock({ call_me: 'Sam', personal_instructions: 'Prefer TypeScript.' });
    expect(block).toContain('never override the rules above');
    expect(block).toContain('Address the user as: Sam');
    expect(block).toContain('Prefer TypeScript.');
    expect(block.split('\n').length).toBeGreaterThan(3);
  });

  it('caps long instructions', () => {
    expect(personalInstructionsBlock({ personal_instructions: 'x'.repeat(10_000) }).length).toBeLessThan(3200);
  });
});

import { parseTeam } from './chat.js';

describe('parseTeam (user-picked Cowork bots)', () => {
  it('keeps known roles, de-duplicates, and drops everything else', () => {
    expect(parseTeam(['coder', 'CODER', 'tester', 'root', 42])).toEqual(['CODER', 'TESTER']);
    expect(parseTeam([])).toBeUndefined();
    expect(parseTeam('CODER')).toBeUndefined();
  });
});

import { EFFORT_MAX_TOKENS, effortInstructions, parseEffort } from './chat.js';

describe('effort', () => {
  it('accepts only low/medium/high and scales the answer budget', () => {
    expect(parseEffort('high')).toBe('high');
    expect(parseEffort('max')).toBeUndefined();
    expect(EFFORT_MAX_TOKENS.low).toBeLessThan(EFFORT_MAX_TOKENS.medium);
    expect(EFFORT_MAX_TOKENS.medium).toBeLessThan(EFFORT_MAX_TOKENS.high);
    expect(effortInstructions('medium')).toBe('');
    expect(effortInstructions('high')).toContain('step by step');
  });
});
