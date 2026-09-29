/**
 * CodeConClave — VoiceControl tests.
 * The component is a pure prop-driven strip. It renders honest state labels and
 * never claims provider-backed voice. Disabled when unsupported/permission denied.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceControl, type VoiceContext } from './VoiceControl';

function cases(): { ctx: VoiceContext; label: string; disabled: boolean }[] {
  return [
    { ctx: 'IDLE', label: '', disabled: false },
    { ctx: 'LISTENING', label: 'Listening…', disabled: false },
    { ctx: 'TRANSCRIBING', label: 'Transcribing…', disabled: false },
    { ctx: 'COMPLETED', label: 'Done', disabled: false },
    { ctx: 'DENIED', label: 'Denied', disabled: false },
    { ctx: 'ERROR', label: 'Speech error', disabled: false },
    { ctx: 'UNSUPPORTED', label: 'Speech not supported here', disabled: true },
    { ctx: 'PERMISSION_DENIED', label: 'Microphone permission denied', disabled: true },
  ];
}

describe('VoiceControl', () => {
  it('renders the toggle and reflects the state label honestly', () => {
    for (const c of cases()) {
      cleanup();
      render(
        <VoiceControl context={c.ctx} isListening={false} start={() => undefined} stop={() => undefined} transcript={null} />,
      );
      if (c.label) expect(screen.getByTestId('voice-state')).toHaveTextContent(c.label);
      expect(screen.getByTestId('voice-toggle')).toBeTruthy();
    }
  });

  it('activates and deactivates listening on click', async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    const stop = vi.fn();
    render(
      <VoiceControl context="LISTENING" isListening={false} start={start} stop={stop} transcript={null} />,
    );
    await user.click(screen.getByTestId('voice-toggle'));
    expect(start).toHaveBeenCalled();
    cleanup();
    render(
      <VoiceControl context="LISTENING" isListening={true} start={start} stop={stop} transcript={null} />,
    );
    await user.click(screen.getByTestId('voice-toggle'));
    expect(stop).toHaveBeenCalled();
  });

  it('is disabled when speech is UNSUPPORTED or PERMISSION_DENIED', () => {
    for (const ctx of ['UNSUPPORTED', 'PERMISSION_DENIED'] as const) {
      cleanup();
      render(
        <VoiceControl context={ctx} isListening={false} start={() => undefined} stop={() => undefined} transcript={null} />,
      );
      expect(screen.getByTestId('voice-toggle')).toBeDisabled();
    }
  });

  it('shows the transcript when one is present', () => {
    render(
      <VoiceControl context="LISTENING" isListening={true} start={() => undefined} stop={() => undefined} transcript="run tests" />,
    );
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('run tests');
  });
});
