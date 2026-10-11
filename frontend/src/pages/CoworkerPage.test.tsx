/**
 * CodeConClave — Coworker page tests.
 *
 * Pins the honest contract: each engine card posts to its real endpoint,
 * renders real returned state, and shows server refusals verbatim. Empty
 * prerequisites (no mail connection, no device, no delivered digest) render
 * as plain explanations — never demo data.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CoworkerPage } from './CoworkerPage';

function json(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

function setup(route: (url: string, init: RequestInit) => Response | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return route(url, init ?? {}) ?? json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter>
      <CoworkerPage />
    </MemoryRouter>,
  );
  return fetchMock;
}

describe('CoworkerPage', () => {
  it('triages email through the real endpoint and shows decisions + drafts', async () => {
    let posted: Record<string, unknown> = {};
    setup((url, init) => {
      if (url.includes('/local-workspace/devices')) return json({ data: { devices: [] } });
      if (url.includes('/digests/latest')) return json({ data: { digest: null } });
      if (url.includes('/comms/email/triage') && init.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({
          data: {
            summary: {
              decisions: [{ thread: { id: 'm1', from: 'a@b.com', subject: 'Call?' }, verdict: 'DRAFT_CANDIDATE', reasons: ['scheduling ask'] }],
              counts: { DRAFT_CANDIDATE: 1, NEEDS_REVIEW: 0, NOISE: 0 },
            },
            drafts: [{ to: ['a@b.com'], subject: 'Re: Call?', bodyTemplate: 'Hi', sendPolicy: 'APPROVAL_REQUIRED', sourceThreadId: 'm1' }],
          },
        });
      }
      return null;
    });
    const user = userEvent.setup();
    await user.type(screen.getByTestId('coworker-email-project'), 'p1');
    await user.type(screen.getByTestId('coworker-email-connection'), 'conn-1');
    await user.click(screen.getByTestId('coworker-email-run'));
    await waitFor(() => expect(screen.getByTestId('coworker-email-decisions')).toBeInTheDocument());
    expect(posted).toMatchObject({ projectId: 'p1', connectionId: 'conn-1' });
    expect(screen.getByTestId('coworker-email-counts')).toHaveTextContent('Draft candidates: 1');
    expect(screen.getByTestId('coworker-email-drafts')).toHaveTextContent('approval-gated');
  });

  it('surfaces a triage refusal verbatim (e.g. mail not connected)', async () => {
    setup((url, init) => {
      if (url.includes('/local-workspace/devices')) return json({ data: { devices: [] } });
      if (url.includes('/digests/latest')) return json({ data: { digest: null } });
      if (url.includes('/comms/email/triage')) return json({ error: { code: 'plugin_not_connected', message: 'Plugin is disconnected; connect it before use' } }, 409);
      return null;
    });
    const user = userEvent.setup();
    await user.type(screen.getByTestId('coworker-email-project'), 'p1');
    await user.type(screen.getByTestId('coworker-email-connection'), 'conn-9');
    await user.click(screen.getByTestId('coworker-email-run'));
    await waitFor(() => expect(screen.getByTestId('coworker-email-error')).toBeInTheDocument());
    expect(screen.getByTestId('coworker-email-error')).toHaveTextContent('disconnected');
  });

  it('scans a project on the selected device and shows real counts', async () => {
    setup((url, init) => {
      if (url.includes('/local-workspace/devices')) {
        return json({ data: { devices: [{ id: 'd1', name: 'Workstation', presence: 'ONLINE' }] } });
      }
      if (url.includes('/digests/latest')) return json({ data: { digest: null } });
      if (url.includes('/local-workspace/scan') && init.method === 'POST') {
        return json({ data: { nodes: ['a.ts', 'b.ts'], edges: [['a.ts', 'b.ts']], cycles: [['a.ts', 'b.ts', 'a.ts']], deadFiles: [], fileCount: 2, truncated: false } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('coworker-scan-device')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('coworker-scan-device'), 'd1');
    await user.type(screen.getByTestId('coworker-scan-path'), '/proj');
    await user.click(screen.getByTestId('coworker-scan-run'));
    await waitFor(() => expect(screen.getByTestId('coworker-scan-result')).toBeInTheDocument());
    expect(screen.getByTestId('coworker-scan-result')).toHaveTextContent('Cycles: 1');
  });

  it('states plainly when no digest has been delivered yet', async () => {
    setup((url) => {
      if (url.includes('/local-workspace/devices')) return json({ data: { devices: [] } });
      if (url.includes('/digests/latest')) return json({ data: { digest: null } });
      return null;
    });
    await waitFor(() => expect(screen.getByTestId('coworker-digest')).toBeInTheDocument());
    expect(screen.getByTestId('coworker-digest')).toHaveTextContent('No digest delivered yet');
  });
});
