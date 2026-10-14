/**
 * CodeConClave — ModelPicker tests (PHASE 5).
 * Single dropdown grouped by tier; locked (entitlement) and DOWN models are
 * disabled; server default is applied when the current selection is unusable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './ModelPicker';

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

function modelFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-4o-mini',
    providerId: 'openai',
    label: 'GPT-4o mini',
    description: null,
    tier: 'EFFICIENT',
    computeClass: 'A',
    health: 'HEALTHY',
    locked: false,
    available: true,
    ...overrides,
  };
}

function renderPicker(handler: (url: string) => Promise<Response>, value?: string, onChange?: (id: string) => void) {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const change = vi.fn(onChange ?? (() => undefined));
  const result = render(<ModelPicker value={value} onChange={change} />);
  return { fetchFn, change, ...result };
}

const modelsEndpoint = (models: Array<Record<string, unknown>>, defaultModel: string | null) =>
  async (url: string) => {
    if (url === '/api/v1/ai/models') {
      return jsonResponse({ data: { models, defaultModel } });
    }
    return jsonResponse({ data: {} });
  };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelPicker', () => {
  it('groups models by tier with provider-qualified labels', async () => {
    const { change } = renderPicker(
      modelsEndpoint(
        [
          modelFixture({ id: 'opus', label: 'Claude Opus 4.1', providerId: 'anthropic', tier: 'PREMIUM' }),
          modelFixture({ id: 'sonnet', label: 'Claude Sonnet', providerId: 'anthropic', tier: 'CAPABLE' }),
          modelFixture({ id: 'mini', label: 'GPT-4o mini', tier: 'EFFICIENT' }),
        ],
        'mini',
      ),
      'mini',
    );
    const select = await screen.findByLabelText('Model');
    const groups = select.querySelectorAll('optgroup');
    expect(groups).toHaveLength(3);
    expect(groups[0]!.getAttribute('label')).toContain('Reasoning');
    expect(groups[1]!.getAttribute('label')).toContain('Coding');
    expect(groups[2]!.getAttribute('label')).toContain('Fast');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options.some((t) => t.includes('Claude Opus 4.1 (anthropic)'))).toBe(true);
    expect(options.some((t) => t.includes('GPT-4o mini (openai)'))).toBe(true);
    await userEvent.selectOptions(select, 'sonnet');
    expect(change).toHaveBeenCalledWith('sonnet');
  });

  it('hides locked (entitlement) and DOWN models instead of listing them', async () => {
    renderPicker(
      modelsEndpoint(
        [
          modelFixture({ id: 'opus', label: 'Claude Opus', tier: 'PREMIUM', locked: true }),
          modelFixture({ id: 'down', label: 'Broken', health: 'DOWN' }),
          modelFixture({ id: 'mini', label: 'GPT-4o mini', tier: 'EFFICIENT' }),
        ],
        'mini',
      ),
      'mini',
    );
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    // Only what the user can actually use is listed — nothing disabled, nothing teased.
    expect(options.some((t) => t.includes('Claude Opus'))).toBe(false);
    expect(options.some((t) => t.includes('Broken'))).toBe(false);
    expect(options.some((t) => t.includes('GPT-4o mini (openai)'))).toBe(true);
    expect(select.querySelectorAll('option[disabled]').length).toBe(0);
    expect(select.value).toBe('mini');
  });

  it('applies the server default when the current selection is unusable', async () => {
    const onChange = vi.fn();
    renderPicker(
      modelsEndpoint(
        [
          modelFixture({ id: 'opus', label: 'Claude Opus', tier: 'PREMIUM', locked: true }),
          modelFixture({ id: 'mini', label: 'GPT-4o mini', tier: 'EFFICIENT' }),
        ],
        'mini',
      ),
      'opus',
      onChange,
    );
    // CodeConClave AI (resident) leads the list, so it wins the fallback.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('codeconclave-ai'));
  });

  it('hides rate-limited providers instead of showing a throttled option', async () => {
    const handler = async (url: string) => {
      if (url === '/api/v1/ai/models') {
        return jsonResponse({
          data: {
            // Registry maps a rate-limited provider to DEGRADED model health;
            // the snapshot status carries the precise, actionable reason.
            models: [modelFixture({ id: 'small', label: 'Mistral Small', providerId: 'mistral', health: 'DEGRADED' })],
            defaultModel: 'small',
          },
        });
      }
      if (url === '/api/v1/ai/providers') {
        return jsonResponse({
          data: { providers: [{ providerId: 'mistral', status: 'RATE_LIMITED', keyState: 'VERIFIED' }], live: [] },
        });
      }
      return jsonResponse({ data: {} });
    };
    renderPicker(handler, 'small');
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
      // A throttled model is not offered at all — never a dead option, never a billing confusion.
      expect(options.some((t) => t.includes('Mistral Small'))).toBe(false);
    });
  });

  it('hides quota-exhausted providers instead of offering them', async () => {
    const handler = async (url: string) => {
      if (url === '/api/v1/ai/models') {
        return jsonResponse({
          data: {
            models: [modelFixture({ id: 'small', label: 'Mistral Small', providerId: 'mistral', health: 'DEGRADED' })],
            defaultModel: 'small',
          },
        });
      }
      if (url === '/api/v1/ai/providers') {
        return jsonResponse({
          data: { providers: [{ providerId: 'mistral', status: 'QUOTA_EXHAUSTED', keyState: 'VERIFIED' }], live: [] },
        });
      }
      return jsonResponse({ data: {} });
    };
    renderPicker(handler, 'small');
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
      expect(options.some((t) => t.includes('Mistral Small'))).toBe(false);
    });
  });

  it('exposes a responsive width hook so narrow viewports can narrow the picker', async () => {
    renderPicker(modelsEndpoint([modelFixture({})], 'mini'), 'mini');
    const select = await screen.findByLabelText('Model');
    expect(select.classList.contains('cc-model-select')).toBe(true);
  });

  it('shows AUTO plus CodeConClave AI even when the registry is empty', async () => {
    renderPicker(modelsEndpoint([], null));
    const select = await screen.findByLabelText('Model') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options[0]).toBe('AUTO');
    // Resident drivers need no provider key — the empty state can never occur.
    expect(options.some((t) => t.includes('CodeConClave AI'))).toBe(true);
    expect(options.includes('No models available — connect a provider')).toBe(false);
  });

  it('hides models whose provider key is invalid instead of offering them', async () => {
    const handler = async (url: string) => {
      if (url === '/api/v1/ai/models') {
        return jsonResponse({ data: { models: [modelFixture({ id: 'mini', label: 'GPT-4o mini', providerId: 'openai' })], defaultModel: 'mini' } });
      }
      if (url === '/api/v1/ai/providers') {
        return jsonResponse({
          data: {
            providers: [
              { providerId: 'openai', status: 'UNAVAILABLE', keyState: 'KEY_INVALID' },
              { providerId: 'google', status: 'AVAILABLE', keyState: 'VERIFIED' },
            ],
            live: ['google'],
          },
        });
      }
      return jsonResponse({ data: {} });
    };
    renderPicker(handler, 'mini');
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
      // Key-invalid provider: its models are not offered at all.
      expect(options.some((t) => t.includes('GPT-4o mini'))).toBe(false);
    });
  });
});