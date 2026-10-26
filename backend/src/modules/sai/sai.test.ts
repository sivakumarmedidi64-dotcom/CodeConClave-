/** Agent Sai Srinivasa Athreya — catalog + connector sanity (offline, no network). */
import { describe, it, expect } from 'vitest';
import { SAI_SOURCES, SAI_AGENT_NAME, sourceById, sourcesByCategory } from './sources.js';
import { liveSourceIds } from './connectors.js';
import { readCaseFile, writeCaseFile, caseFileCount, sweepCaseFile, SAI_REGION } from './caseFile.js';
import type { SaiEvidence } from './connectors.js';

describe('Agent Sai Srinivasa Athreya catalog', () => {
  it('carries the founder master list (140 sources) with the right name', () => {
    expect(SAI_AGENT_NAME).toBe('Agent Sai Srinivasa Athreya');
    expect(SAI_SOURCES.length).toBeGreaterThanOrEqual(140);
  });

  it('has unique ids and real categories', () => {
    const ids = SAI_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(sourcesByCategory()).length).toBeGreaterThanOrEqual(10);
    expect(SAI_SOURCES.every((s) => ['P1', 'P2', 'P3'].includes(s.priority))).toBe(true);
  });

  it('every live connector points at a real catalogued source (no orphan, no fake)', () => {
    const live = liveSourceIds();
    expect(live.length).toBeGreaterThanOrEqual(8);
    for (const id of live) expect(sourceById(id), `live id ${id} must be in the catalog`).toBeTruthy();
  });

  it('flags India sources that make it different (India Post, Agmarknet)', () => {
    expect(sourceById('india-post-pincode')).toBeTruthy();
    expect(sourceById('agmarknet')).toBeTruthy();
  });
});

describe('Agent Sai shared case file — graceful when the database is unreachable', () => {
  // The test env points DATABASE_URL at a server that is not running, so these
  // prove the shared case file NEVER breaks or stalls an answer: it fails quiet
  // and the caller falls back to a real live fetch. Nothing here is faked.
  const evidence: SaiEvidence = {
    sourceId: 'x', source: 'X', query: 'q', summary: 's', data: null,
    sourceUrl: 'https://example.com', fetchedAt: new Date().toISOString(), cached: false, ageSeconds: 0,
  };

  it('has a region tag (defaults to global)', () => {
    expect(typeof SAI_REGION).toBe('string');
    expect(SAI_REGION.length).toBeGreaterThan(0);
  });

  it('read returns null instead of throwing', async () => {
    await expect(readCaseFile('x\nq')).resolves.toBeNull();
  });

  it('write never throws (fire-and-forget)', async () => {
    await expect(writeCaseFile('x\nq', 'x', 'q', evidence, Date.now(), Date.now() + 60_000)).resolves.toBeUndefined();
  });

  it('count and sweep fall back to 0', async () => {
    await expect(caseFileCount()).resolves.toBe(0);
    await expect(sweepCaseFile()).resolves.toBe(0);
  });
});
