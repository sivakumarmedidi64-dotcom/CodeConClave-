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
    expect(groups[0]!.getAttribute('label')).toContain('Premium');
    expect(groups[1]!.getAttribute('label')).toContain('Capable');
    expect(groups[2]!.getAttribute('label')).toContain('Efficient');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options.some((t) => t.includes('Claude Opus 4.1 (anthropic)'))).toBe(true);
    expect(options.some((t) => t.includes('GPT-4o mini (openai)'))).toBe(true);
    await userEvent.selectOptions(select, 'sonnet');
    expect(change).toHaveBeenCalledWith('sonnet');
  });

  it('disables locked (entitlement) and DOWN models', async () => {
    const { change } = renderPicker(
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
    const select = await screen.findByLabelText('Model') as HTMLSelectElement;
    const disabled = Array.from(select.querySelectorAll('option[disabled]')).map((o) => o.textContent ?? '');
    expect(disabled.some((t) => t.includes('Claude Opus'))).toBe(true);
    expect(disabled.some((t) => t.includes('(down)'))).toBe(true);
    expect(select.value).toBe('mini');
    void change;
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
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('mini'));
  });

  it('renders a placeholder while the registry is empty', async () => {
    renderPicker(modelsEndpoint([], null));
    const select = await screen.findByLabelText('Model') as HTMLSelectElement;
    expect(select.querySelector('option')?.textContent).toBe('model…');
  });
});