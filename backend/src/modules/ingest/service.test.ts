/**
 * CodeConClave — Agent Sai Srinivasa Athreya · unit tests.
 * Pure-function only: no DB, no network.
 */
import { describe, expect, it } from 'vitest';
import { INGEST_SOURCES, sourceModalities } from './sources.js';
import {
  buildPushEvent,
  decideForSource,
  formatSse,
  gateMediaUrl,
  gateSourceLicense,
  hashMedia,
  isAgentOwner,
  isCacheHit,
  parseScoutRoute,
  secretScanDeny,
  tickSources,
  verifyMediaRecord,
} from './service.js';

describe('Agent Sai Srinivasa Athreya', () => {
  it('registers 19 final sources', () => {
    expect(INGEST_SOURCES).toHaveLength(19);
  });

  it('gates unknown licenses closed', () => {
    expect(gateSourceLicense({ id: 'x', name: 'x', hfDataset: 'x', license: 'GPL-3.0', tier: 'T1_SAFE', box: 'CODER' }).allowed).toBe(false);
    expect(gateSourceLicense(INGEST_SOURCES[0]).allowed).toBe(true);
  });

  it('denies secret-like records', () => {
    expect(secretScanDeny('config/.env')).toBe(true);
    expect(secretScanDeny('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(secretScanDeny('src/coder/plan.ts')).toBe(false);
  });

  it('cache-hits only on hash+dna+tier match', () => {
    const state = { sourceId: 'a', lastHash: 'h1', lastDna: 'v1', lastTier: 'standard', repairCount: 0 };
    expect(isCacheHit(state, { sourceId: 'a', revisionHash: 'h1', dnaVersion: 'v1', tier: 'standard' })).toBe(true);
    expect(isCacheHit(state, { sourceId: 'a', revisionHash: 'h2', dnaVersion: 'v1', tier: 'standard' })).toBe(false);
    expect(isCacheHit(state, { sourceId: 'a', revisionHash: 'h1', dnaVersion: 'v2', tier: 'standard' })).toBe(false);
  });

  it('escalates after 3 repairs and runs one pull per tick', () => {
    const d = decideForSource(
      { sourceId: INGEST_SOURCES[0].id, lastHash: 'h', lastDna: 'v1', lastTier: 'standard', repairCount: 3 },
      { sourceId: INGEST_SOURCES[0].id, revisionHash: 'h2', dnaVersion: 'v1', tier: 'standard' },
    );
    expect(d.action).toBe('BLOCKED');
    const states = INGEST_SOURCES.map((s) => ({ sourceId: s.id, lastHash: 'old', lastDna: 'v1', lastTier: 'standard', repairCount: 0 }));
    const remotes = INGEST_SOURCES.map((s) => ({ sourceId: s.id, revisionHash: 'new', dnaVersion: 'v1', tier: 'standard' }));
    const pulls = tickSources(states, remotes).filter((x) => x.action === 'PULL');
    expect(pulls).toHaveLength(1);
  });

  it('is private: owner gate honors INGEST_AGENT_OWNER_ID', () => {
    const prev = process.env.INGEST_AGENT_OWNER_ID;
    delete process.env.INGEST_AGENT_OWNER_ID;
    expect(isAgentOwner('anyone')).toBe(true);
    process.env.INGEST_AGENT_OWNER_ID = 'usr_owner1';
    expect(isAgentOwner('usr_owner1')).toBe(true);
    expect(isAgentOwner('usr_stranger')).toBe(false);
    if (prev === undefined) delete process.env.INGEST_AGENT_OWNER_ID;
    else process.env.INGEST_AGENT_OWNER_ID = prev;
  });

  it('all 19 sources carry text+image modalities', () => {
    for (const s of INGEST_SOURCES) {
      expect(sourceModalities(s)).toEqual(['text', 'image']);
    }
  });

  it('gates media urls closed: https + public host + no secrets', () => {
    expect(gateMediaUrl('https://huggingface.co/datasets/x/preview.png').allowed).toBe(true);
    expect(gateMediaUrl('http://huggingface.co/x.png').allowed).toBe(false);
    expect(gateMediaUrl('https://169.254.169.254/keys').allowed).toBe(false);
    expect(gateMediaUrl('https://cdn.example.com/.env').allowed).toBe(false);
    expect(gateMediaUrl('not-a-url').allowed).toBe(false);
  });

  it('verifies media records before blob write', () => {
    const sha = hashMedia('bytes');
    expect(verifyMediaRecord({ modality: 'image', storageKey: 'k', url: null, sha256: sha }).pass).toBe(true);
    expect(verifyMediaRecord({ modality: 'image', storageKey: null, url: null, sha256: sha }).pass).toBe(false);
    expect(verifyMediaRecord({ modality: 'image', storageKey: null, url: 'http://x/y.png', sha256: sha }).pass).toBe(false);
  });

  it('builds per-second push events as SSE frames', () => {
    const e = buildPushEvent('heartbeat', 7, { projectId: 'prj_1' });
    expect(e.agent).toContain('Athreya');
    expect(formatSse(e).startsWith('event: heartbeat\ndata: ')).toBe(true);
  });

  it('parses scout routes strictly: malformed fails closed, never rescued', () => {
    const good = parseScoutRoute('{"lane":"CODER","risk":"HIGH"}');
    expect(good.ok).toBe(true);
    expect(parseScoutRoute('```json\n{"lane":"CODER","risk":"HIGH"}\n```').ok).toBe(false);
    expect(parseScoutRoute('{"lane":"CODER"}').ok).toBe(false);
    expect(parseScoutRoute('{"lane":"DESIGNER","risk":"LOW"}').ok).toBe(false);
    expect(parseScoutRoute('{"lane":"CODER","risk":"URGENT"}').ok).toBe(false);
    expect(parseScoutRoute('not json at all').ok).toBe(false);
    expect(parseScoutRoute('["CODER"]').ok).toBe(false);
  });
});
