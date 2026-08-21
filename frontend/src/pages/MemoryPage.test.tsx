/**
 * CodeConClave — MemoryPage tests (PHASE 11).
 * Verify/reject post the real verification state; merge requires exactly two
 * selections; details load sources + relationships; delete moves to trash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { MemoryPage } from './MemoryPage';
import { jsonResponse, stubFetch } from '../testutils';

const MEMORY = {
  id: 'm1',
  projectId: null,
  type: 'EPISODIC',
  source: 'USER_STATED',
  content: 'The build takes 90 seconds',
  confidence: 'medium',
  structured: null,
  flagged: false,
  verificationState: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function memoryHandler(extra?: (url: string, init?: RequestInit) => Promise<Response | null>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (extra) {
      const r = await extra(url, init);
      if (r) return r;
    }
    if (url.includes('/api/v1/memory') && !url.includes('/sources') && !url.includes('/relationships')) {
      return jsonResponse({ data: { memories: [MEMORY] } });
    }
    if (url.includes('/api/v1/memory/m1/sources')) return jsonResponse({ data: { sources: [{ sourceLabel: 'OBSERVED', sourceRef: 'task:t1' }] } });
    if (url.includes('/api/v1/memory/m1/relationships')) {
      return jsonResponse({ data: { relationships: [{ targetMemoryId: 'm2', relation: 'supports', targetContent: 'tests are fast' }] } });
    }
    return jsonResponse({ data: {} });
  };
}

function renderMemory() {
  return render(
    <ToastProvider>
      <MemoryPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('MemoryPage', () => {
  it('lists memories with verification state badges', async () => {
    stubFetch(
      memoryHandler(async (url) => {
        if (url.includes('/api/v1/memory')) return jsonResponse({ data: { memories: [{ ...MEMORY, verificationState: 'VERIFIED' }] } });
        return null;
      }),
    );
    renderMemory();
    await waitFor(() => expect(screen.getByText('The build takes 90 seconds')).toBeInTheDocument());
    expect(screen.getByText('verified')).toBeInTheDocument();
  });

  it('posts the verification state when a memory is verified', async () => {
    const fetchFn = stubFetch(memoryHandler());
    renderMemory();
    const verify = (await screen.findAllByText('Verify'))[0]!;
    await userEvent.click(verify);
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/memory/m1/verify' && i?.method === 'POST');
      expect(call).toBeDefined();
    });
    const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/memory/m1/verify');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ state: 'VERIFIED' });
  });

  it('shows sources and relationships in the details panel', async () => {
    stubFetch(memoryHandler());
    renderMemory();
    await userEvent.click(await screen.findByText('Details'));
    await waitFor(() => expect(screen.getByText(/OBSERVED — task:t1/)).toBeInTheDocument());
    expect(screen.getByText(/supports → tests are fast/)).toBeInTheDocument();
  });

  it('requires exactly two memories to offer merge', async () => {
    stubFetch(memoryHandler());
    renderMemory();
    await screen.findByText('The build takes 90 seconds');
    expect(screen.queryByText('Merge selected (target → into)')).toBeNull();
    await userEvent.click(screen.getByLabelText(/Select memory for merge/));
    expect(screen.queryByText('Merge selected (target → into)')).toBeNull();
  });

  it('moves a memory to trash via DELETE', async () => {
    const fetchFn = stubFetch(memoryHandler());
    renderMemory();
    await userEvent.click(await screen.findByText('To trash'));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/memory/m1' && i?.method === 'DELETE');
      expect(call).toBeDefined();
    });
    expect(screen.getByText('Moved to Gain Trash')).toBeInTheDocument();
  });
});