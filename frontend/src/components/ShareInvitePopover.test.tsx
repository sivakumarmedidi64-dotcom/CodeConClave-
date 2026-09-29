/**
 * CodeConClave — ShareInvitePopover tests.
 * Exercises the canonical share-link rail through real api helpers:
 * listing (revoked links hidden), creating (mode / one-time / expiry),
 * copying, and revocation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareInvitePopover } from './ShareInvitePopover';
import { createShareLink, listShareLinks, revokeShareLink } from '../lib/api';
import { copyText } from '../lib/clipboard';
import type { ShareLinkView } from '../lib/types';

vi.mock('../lib/api', () => ({
  createShareLink: vi.fn(),
  listShareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
}));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }));

const createShareLinkMock = vi.mocked(createShareLink);
const listShareLinksMock = vi.mocked(listShareLinks);
const revokeShareLinkMock = vi.mocked(revokeShareLink);
const copyTextMock = vi.mocked(copyText);

const link = (token: string, overrides: Partial<ShareLinkView> = {}): ShareLinkView => ({
  conversationId: 'c1',
  token,
  mode: 'WATCH',
  createdAt: Date.now(),
  expiresAt: Date.now() + 1000,
  oneTime: false,
  revokedAt: undefined,
  redeemedBy: null,
  redeemedAt: null,
  url: `https://share.test/${token}`,
  ...overrides,
});

function renderPopover(onClose = vi.fn(), toast = vi.fn()) {
  return render(<ShareInvitePopover conversationId="c1" onClose={onClose} toast={toast} />);
}

beforeEach(() => {
  createShareLinkMock.mockReset();
  listShareLinksMock.mockReset();
  revokeShareLinkMock.mockReset();
  copyTextMock.mockResolvedValue(true);
});

describe('ShareInvitePopover', () => {
  it('lists active links and hides revoked ones', async () => {
    listShareLinksMock.mockResolvedValue([link('t1'), link('t2', { revokedAt: 123 })]);
    renderPopover();
    expect(await screen.findByText('WATCH')).toBeInTheDocument();
    await waitFor(() => expect(listShareLinksMock).toHaveBeenCalledWith('c1'));
  });

  it('creates a link with the chosen role/one-time/expiry and copies it', async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    listShareLinksMock.mockResolvedValue([]);
    createShareLinkMock.mockResolvedValue(link('t3'));
    renderPopover(vi.fn(), toast);
    await user.click(await screen.findByRole('button', { name: 'Co-control' }));
    await user.click(screen.getByLabelText(/One-time use/));
    await user.selectOptions(screen.getByLabelText(/Expires in/), String(60 * 60 * 1000));
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    await waitFor(() =>
      expect(createShareLinkMock).toHaveBeenCalledWith('c1', 'CO_CONTROL', {
        oneTime: true,
        expiresInMs: 60 * 60 * 1000,
      }),
    );
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith('https://share.test/t3'));
    expect(toast).toHaveBeenCalledWith('Link copied', 'info');
    expect(await screen.findByLabelText('Revoke link')).toBeInTheDocument();
  });

  it('revokes a link and removes it from the list', async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    listShareLinksMock.mockResolvedValue([link('t1')]);
    revokeShareLinkMock.mockResolvedValue(undefined);
    renderPopover(vi.fn(), toast);
    const revoke = await screen.findByLabelText('Revoke link');
    await user.click(revoke);
    await waitFor(() => expect(revokeShareLinkMock).toHaveBeenCalledWith('c1', 't1'));
    await waitFor(() => expect(screen.queryByLabelText('Revoke link')).toBeNull());
    expect(toast).toHaveBeenCalledWith('Link revoked');
  });

  it('closes via the Close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    listShareLinksMock.mockResolvedValue([]);
    renderPopover(onClose);
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});