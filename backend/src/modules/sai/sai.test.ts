/** Agent Sai Srinivasa Athreya — catalog + connector sanity (offline, no network). */
import { describe, it, expect } from 'vitest';
import { SAI_SOURCES, SAI_AGENT_NAME, sourceById, sourcesByCategory } from './sources.js';
import { liveSourceIds } from './connectors.js';

describe('Agent Sai Srinivasa Athreya catalog', () => {
  it('carries the founder master list (140 sources) with the right name', () => {
    expect(SAI_AGENT_NAME).toBe('Agent Sai Srinivasa Athreya');
    expect(SAI_SOURCES.length).toBe(140);
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
