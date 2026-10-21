import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { TeamPicker } from './TeamPicker';
import { Bot, personaFor } from './Bot';
import { AvatarPicker, AvatarView, initialsOf } from './UserAvatar';
import { _resetPrefsCache } from '../lib/prefs';
import { jsonResponse, stubFetch } from '../testutils';

function Harness({ onChange }: { onChange: (v: string[]) => void }) {
  const [team, setTeam] = useState<string[]>([]);
  return (
    <TeamPicker
      value={team}
      onChange={(v) => {
        setTeam(v);
        onChange(v);
      }}
    />
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetPrefsCache();
});

describe('Bot faces', () => {
  it('each specialist has its own shape and the state is announced', () => {
    expect(personaFor('CODER').shape).toBe('circle');
    expect(personaFor('TESTER').shape).toBe('triangle');
    render(<Bot kind="SECURITY" state="blocked" />);
    expect(screen.getByRole('img', { name: 'Sentry, Security — blocked' })).toBeInTheDocument();
  });

  it('done bots carry orbit ribbons', () => {
    const { container } = render(<Bot kind="CODER" state="done" />);
    expect(container.querySelectorAll('.cc-bb__ribbons i').length).toBe(5);
  });
});

describe('TeamPicker', () => {
  it('starts on Auto, adds bots in roster order, and resets', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByText(/Team: Auto/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add Tess the Tester' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Cody the Coder' }));
    expect(onChange).toHaveBeenLastCalledWith(['CODER', 'TESTER']);
    expect(screen.getByText('Team: 2 bots')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Cody the Coder' }));
    expect(onChange).toHaveBeenLastCalledWith(['TESTER']);
    await userEvent.click(screen.getByRole('button', { name: 'Reset to Auto' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe('avatars', () => {
  it('derives initials and renders each avatar kind', () => {
    expect(initialsOf('Sam Medidi')).toBe('SM');
    expect(initialsOf('sam@x.test')).toBe('SA');
    const { container, rerender } = render(<AvatarView value="emoji:🚀" name="Sam" />);
    expect(container.textContent).toBe('🚀');
    rerender(<AvatarView value="bot:TESTER" name="Sam" />);
    expect(container.querySelector('.cc-bb--triangle')).not.toBeNull();
    rerender(<AvatarView value={undefined} name="Sam Medidi" />);
    expect(container.textContent).toBe('SM');
  });

  it('saves the chosen picture to preferences', async () => {
    const fetchFn = stubFetch(async (_url, init) =>
      init?.method === 'PUT' ? jsonResponse({ data: { prefs: { avatar: 'bot:CODER' } } }) : jsonResponse({ data: { prefs: {} } }),
    );
    render(<AvatarPicker name="Sam" />);
    await userEvent.click(screen.getByRole('radio', { name: 'Bot coder' }));
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([, i]) => i?.method === 'PUT' && String(i.body).includes('"avatar":"bot:CODER"'))).toBe(true),
    );
  });
});
