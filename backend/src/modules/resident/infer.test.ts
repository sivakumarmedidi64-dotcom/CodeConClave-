/**
 * CodeConclave AI — resident routing tests (no DB, no network).
 * v3 Dispatch: task type → exactly one tuned driver, or gateway.
 */
import { describe, expect, it } from 'vitest';
import { residentRoleForTask, guardScout } from './infer.js';
import { driverForRole } from '../ingest/drivers.js';

describe('resident routing', () => {
  it('maps code tasks to the Coder driver', () => {
    for (const t of ['CODING', 'DEBUGGING', 'REFACTORING', 'TEST_GENERATION']) {
      const role = residentRoleForTask(t);
      expect(role).toBe('Coder');
      expect(driverForRole(role!)?.hubId).toContain('coder-lite');
    }
  });

  it('maps review + plan tasks to their drivers', () => {
    expect(driverForRole(residentRoleForTask('CODE_REVIEW')!)?.hubId).toContain('reviewer');
    expect(driverForRole(residentRoleForTask('ARCHITECTURE')!)?.hubId).toContain('planner-lite');
    expect(driverForRole(residentRoleForTask('PLANNING')!)?.hubId).toContain('planner-lite');
  });

  it('leaves chat, vision, tools and science tasks to the gateway', () => {
    for (const t of ['GENERAL_CHAT', 'MULTIMODAL_ANALYSIS', 'TOOL_USE', 'TERMINAL_EXECUTION', undefined]) {
      expect(residentRoleForTask(t)).toBeUndefined();
    }
  });

  it('rejects malformed scout JSON (fail-closed to operator)', () => {
    expect(guardScout('{"lane":"CODER","risk":"LOW"}')).toBe(true);
    expect(guardScout('sure, CODER looks good')).toBe(false);
  });
});

import { afterEach, beforeEach, vi } from 'vitest';
import {
  _resetResidentHealth,
  residentComplete,
  residentReady,
  residentStatus,
  residentTransport,
  servedModelName,
} from './infer.js';

describe('resident transports', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    _resetResidentHealth();
    delete process.env.RESIDENT_OPENAI_BASE_URL;
    delete process.env.RESIDENT_API_KEY;
    delete process.env.RESIDENT_MODEL_MAP;
    delete process.env.HF_DRIVER_TOKEN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it('prefers an OpenAI-compatible host, then HF, else none', () => {
    expect(residentTransport().kind).toBe('none');
    process.env.HF_DRIVER_TOKEN = 'hf_test';
    expect(residentTransport().kind).toBe('hf');
    process.env.RESIDENT_OPENAI_BASE_URL = 'http://localhost:11434/v1/';
    const t = residentTransport();
    expect(t).toMatchObject({ kind: 'openai', baseUrl: 'http://localhost:11434/v1' });
  });

  it('names served models by repo name unless mapped', () => {
    expect(servedModelName('SaharshMedidi/codeconclave-coder-lite', {})).toBe('codeconclave-coder-lite');
    expect(servedModelName('SaharshMedidi/codeconclave-coder-lite', { 'SaharshMedidi/codeconclave-coder-lite': 'ccc-coder:q4' })).toBe('ccc-coder:q4');
  });

  it('is never tried when nothing is configured (no wasted call per chat)', () => {
    expect(residentReady('Coder')).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('calls /chat/completions with the served name and records success', async () => {
    process.env.RESIDENT_OPENAI_BASE_URL = 'http://localhost:11434/v1';
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'patched' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const ans = await residentComplete('Coder', 'fix it', 4096);
    expect(ans).toMatchObject({ hubId: 'SaharshMedidi/codeconclave-coder-lite', text: 'patched' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number };
    expect(body.model).toBe('codeconclave-coder-lite');
    expect(body.max_tokens).toBe(2048); // capped by the driver contract
  });

  it('uses the HF router (not the dead api-inference host) without echoing the prompt', async () => {
    process.env.HF_DRIVER_TOKEN = 'hf_test';
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([{ generated_text: 'ok' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    await residentComplete('Coder', 'hi');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://router.huggingface.co/hf-inference/models/SaharshMedidi/codeconclave-coder-lite');
    expect(JSON.parse(String(init.body)).parameters.return_full_text).toBe(false);
  });

  it('cools a failing driver down so the next chat skips it', async () => {
    process.env.RESIDENT_OPENAI_BASE_URL = 'http://localhost:11434/v1';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(residentComplete('Coder', 'x')).rejects.toThrow('resident_infer_failed:404');
    expect(residentReady('Coder')).toEqual({ ok: false, reason: 'resident_infer_failed:404' });
    expect(residentReady('Reviewer').ok).toBe(true); // other drivers unaffected
  });

  it('status probe marks drivers the host does not serve as UNAVAILABLE', async () => {
    process.env.RESIDENT_OPENAI_BASE_URL = 'http://localhost:11434/v1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'codeconclave-coder-lite:latest' }] }), { status: 200 })),
    );
    const s = await residentStatus(true);
    expect(s).toMatchObject({ transport: 'openai', host: 'localhost:11434', anyReady: true });
    expect(s.drivers.find((d) => d.hubId.endsWith('coder-lite'))?.state).toBe('READY');
    expect(s.drivers.find((d) => d.hubId.endsWith('reviewer'))).toMatchObject({ state: 'UNAVAILABLE' });
    expect(residentReady('Reviewer').ok).toBe(false);
  });

  it('reports NOT_CONFIGURED honestly when no host is set', async () => {
    const s = await residentStatus(true);
    expect(s.anyReady).toBe(false);
    expect(s.drivers.every((d) => d.state === 'NOT_CONFIGURED')).toBe(true);
  });
});
