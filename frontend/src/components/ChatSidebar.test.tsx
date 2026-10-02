/**
 * CodeConClave — ChatSidebar tests: grouping (pinned/recent/archived),
 * server search (debounced, replace-with-results, clear), unread dots,
 * and row actions (pin / rename / archive / unarchive / delete).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatSidebar } from './ChatSidebar';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';

vi.mock('../lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

const conv = (id: string, title: string, opts: Partial<Conversation> = {}): Conversation => ({
  id,
  projectId: null,
  title,
  mode: 'CHAT',
  archived: false,
  favorite: false,
  tags: [],
  sharing: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  deletedAt: null,
  ...opts,
});

const noop = () => undefined;

beforeEach(() => {
  apiMock.mockReset();
});

describe('ChatSidebar — grouping + unread', () => {
  it('shows pinned, recent and archived groups', () => {
    const conversations = [
      conv('a1', 'Archived 1', { archived: true }),
      conv('p1', 'Pinned 1', { favorite: true }),
      conv('r1', 'Recent 1'),
    ];
    render(
      <ChatSidebar
        conversations={conversations}
        activeId={null}
        lastSeen={{}}
        onSelect={noop}
        onNew={noop}
        onTogglePin={noop}
        onArchive={noop}
        onUnarchive={noop}
        onDelete={noop}
        onRename={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByLabelText('Conversation Pinned 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Conversation Recent 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Conversation Archived 1')).toBeInTheDocument();
  });

  it('marks a conversation unread only when updated after lastSeen and never for the active one', () => {
    const seen = { seenChat: Date.parse('2026-01-03T00:00:00.000Z') };
    render(
      <ChatSidebar
        conversations={[
          conv('seenChat', 'Seen', { updatedAt: '2026-01-02T00:00:00.000Z' }),
          conv('newChat', 'New', { updatedAt: '2026-01-04T00:00:00.000Z' }),
          conv('activeChat', 'Active', { updatedAt: '2026-01-05T00:00:00.000Z' }),
        ]}
        activeId="activeChat"
        lastSeen={seen}
        onSelect={noop}
        onNew={noop}
        onTogglePin={noop}
        onArchive={noop}
        onUnarchive={noop}
        onDelete={noop}
        onRename={vi.fn(async () => undefined)}
      />,
    );
    // Seen (update < lastSeen) → no dot; New (update > lastSeen) → dot;
    // Active (last updated) → never a dot (it is open right now).
    const seenItem = screen.getByLabelText('Conversation Seen');
    const newItem = screen.getByLabelText('Conversation New');
    const activeItem = screen.getByLabelText('Conversation Active');
    expect(seenItem.querySelector('.cc-unread-dot')).toBeNull();
    expect(newItem.querySelector('.cc-unread-dot')).not.toBeNull();
    expect(activeItem.querySelector('.cc-unread-dot')).toBeNull();
  });

  it('renders the empty state when no conversations exist', () => {
    render(
      <ChatSidebar
        conversations={[]}
        activeId={null}
        lastSeen={{}}
        onSelect={noop}
        onNew={noop}
        onTogglePin={noop}
        onArchive={noop}
        onUnarchive={noop}
        onDelete={noop}
        onRename={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
  });
});

describe('ChatSidebar — server search', () => {
  it('searches the bank-end and replaces the list with results; clear restores groups', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ conversations: [conv('s1', 'found chat')] });
    render(
      <ChatSidebar
        conversations={[conv('r1', 'regular chat')]}
        activeId={null}
        lastSeen={{}}
        onSelect={noop}
        onNew={noop}
        onTogglePin={noop}
        onArchive={noop}
        onUnarchive={noop}
        onDelete={noop}
        onRename={vi.fn(async () => undefined)}
      />,
    );
    const search = await screen.findByLabelText('Search chats');
    await user.type(search, 'found');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/conversations/search?q=found'));
    expect(await screen.findByText('found chat')).toBeInTheDocument();
    expect(screen.queryByText('regular chat')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('regular chat')).toBeInTheDocument();
  });

  it('shows an honest no-results state and does not hit the bank-end for empty input', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ conversations: [] });
    render(
      <ChatSidebar
        conversations={[conv('r1', 'regular chat')]}
        activeId={null}
        lastSeen={{}}
        onSelect={noop}
        onNew={noop}
        onTogglePin={noop}
        onArchive={noop}
        onUnarchive={noop}
        onDelete={noop}
        onRename={vi.fn(async () => undefined)}
      />,
    );
    const search = await screen.findByLabelText('Search chats');
    await user.type(search, 'zzz');
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No chats match.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});

describe('ChatSidebar — row actions', () => {
  it('calls the pin, archive, unarchive, delete and rename callbacks', async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    const onArchive = vi.fn();
    const onUnarchive = vi.fn();
    const onDelete = vi.fn();
    const onRename = vi.fn(async () => undefined);
    const c = conv('c1', 'My chat');
    const cArch = conv('c2', 'Archived chat', { archived: true });
    render(
      <ChatSidebar
        conversations={[c, cArch]}
        activeId={null}
        lastSeen={{}}
        onSelect={noop}
        onNew={noop}
        onTogglePin={onTogglePin}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={onDelete}
        onRename={onRename}
      />,
    );
    await user.click(screen.getAllByLabelText('Pin conversation')[0]!);
    expect(onTogglePin).toHaveBeenCalledWith(c);
    await user.click(screen.getByLabelText('Archive conversation'));
    expect(onArchive).toHaveBeenCalledWith('c1');
    await user.click(screen.getByLabelText('Unarchive conversation'));
    expect(onUnarchive).toHaveBeenCalledWith('c2');
    const deleteButtons = screen.getAllByLabelText('Delete conversation');
    expect(deleteButtons).toHaveLength(2);
    await user.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledWith('c1');
    const c1Item = screen.getByLabelText('Conversation My chat');
    await user.click(within(c1Item).getByLabelText('Rename conversation'));
    const input = within(c1Item).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Renamed title{Enter}');
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('c1', 'Renamed title'));
  });
});