import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BrowserPage, toBrowserUrl } from './BrowserPage';
import type { BrowserPaneState } from '../lib/desktopBridge';

const base: BrowserPaneState = { available: true, open: false, visible: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false };

function installBridge(choice = 'builtin') {
  let state = { ...base };
  const browser = {
    state: vi.fn(async () => state),
    open: vi.fn(async (url: string) => (state = { ...state, open: true, visible: true, url, title: 'Example' })),
    nav: vi.fn(async () => state),
    setBounds: vi.fn(async () => state),
    show: vi.fn(async () => state),
    hide: vi.fn(async () => state),
    close: vi.fn(async () => (state = { ...base })),
    list: vi.fn(async () => ({
      choice,
      builtinAvailable: true,
      browsers: [
        { id: 'builtin', name: 'CodeConClave browser (built in)' },
        { id: 'default', name: 'System default browser' },
        { id: 'chrome', name: 'Google Chrome' },
      ],
    })),
    choose: vi.fn(async (c: string) => ({ choice: c })),
    openExternal: vi.fn(async () => ({ ok: true, openedIn: 'Google Chrome' })),
  };
  (window as unknown as { codeconclave?: unknown }).codeconclave = {
    isDesktopBridge: true,
    desktop: { browser, monitor: { subscribe: async () => () => undefined } },
  };
  return browser;
}

afterEach(() => {
  delete (window as unknown as { codeconclave?: unknown }).codeconclave;
  vi.restoreAllMocks();
});

describe('BrowserPage', () => {
  it('normalises addresses like the desktop pane and refuses non-web schemes', () => {
    expect(toBrowserUrl('example.com')).toBe('https://example.com');
    expect(toBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(toBrowserUrl('https://a.dev/x')).toBe('https://a.dev/x');
    expect(toBrowserUrl('how to center a div')).toBe('https://duckduckgo.com/?q=how%20to%20center%20a%20div');
    expect(toBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(toBrowserUrl('file:///C:/x')).toBeNull();
  });

  it('on the web, says plainly that the built-in browser is in the desktop app and opens a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MemoryRouter><BrowserPage /></MemoryRouter>);
    expect(screen.getByTestId('browser-web')).toHaveTextContent(/desktop app/);
    await userEvent.type(screen.getByLabelText('Address'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });

  it('in the desktop app, opens the built-in pane over the stage and hides it on leave', async () => {
    const browser = installBridge();
    const { unmount } = render(<MemoryRouter><BrowserPage /></MemoryRouter>);
    expect(await screen.findByRole('option', { name: 'Google Chrome' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Address'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(browser.open).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ width: expect.any(Number) })));
    expect(await screen.findByRole('button', { name: 'Close browser' })).toBeInTheDocument();
    unmount();
    expect(browser.hide).toHaveBeenCalled();
  });

  it('opens a link clicked elsewhere in the app (/browser?url=…)', async () => {
    const browser = installBridge();
    render(
      <MemoryRouter initialEntries={['/browser?url=https%3A%2F%2Fexample.com%2Fdocs']}>
        <BrowserPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(browser.open).toHaveBeenCalledWith('https://example.com/docs', expect.anything()));
    expect(screen.getByLabelText('Address')).toHaveValue('https://example.com/docs');
  });

  it('sends pages to the browser the user picked', async () => {
    const browser = installBridge();
    render(<MemoryRouter><BrowserPage /></MemoryRouter>);
    const select = await screen.findByLabelText('Open pages in');
    await screen.findByRole('option', { name: 'Google Chrome' });
    await userEvent.selectOptions(select, 'chrome');
    expect(browser.choose).toHaveBeenCalledWith('chrome');
    await userEvent.type(screen.getByLabelText('Address'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('Opened in Google Chrome.')).toBeInTheDocument();
    expect(browser.open).not.toHaveBeenCalled();
  });
});
