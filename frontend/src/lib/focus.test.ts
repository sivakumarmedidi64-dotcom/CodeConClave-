import { describe, expect, it } from 'vitest';
import { detectFocus } from './focus';

describe('Focus Morph', () => {
  it('finds the focus from what is typed', () => {
    expect(detectFocus('Fix the login token refresh')?.id).toBe('security');
    expect(detectFocus('My build is failing with a stack trace')?.id).toBe('debug');
    expect(detectFocus('analyze this csv of sales')?.id).toBe('data');
    expect(detectFocus('Make the landing page responsive')?.id).toBe('design');
    expect(detectFocus('Write an email to the team')?.id).toBe('writing');
    expect(detectFocus('Draft a launch roadmap')?.id).toBe('planning');
  });

  it('stays quiet for short text, slash commands and plain chat', () => {
    expect(detectFocus('bug')).toBeNull();
    expect(detectFocus('/bugfix the crash')).toBeNull();
    expect(detectFocus('hello, how are you today?')).toBeNull();
  });

  it('puts security first when a message touches several areas', () => {
    expect(detectFocus('the login page crashes with an error')?.id).toBe('security');
  });

  it('offers real CodeConClave actions for each focus', () => {
    const f = detectFocus('there is a bug in checkout')!;
    expect(f.actions.map((a) => a.insert)).toEqual(['/bugfix ', '/debug ']);
    expect(f.label).toBe('Debugging focus');
  });
});
