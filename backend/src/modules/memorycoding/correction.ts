/**
 * CodeConClave — PKG-23 Correction Memory.
 *
 * Corrections are durable and propagate: correcting a stale memory marks it
 * CONFIRMED-wrong and superseded; correcting an inferred preference/pattern
 * removes/supersedes the conflicting entry so it will never be re-applied.
 *
 * STALE MEMORY NEVER OVERRIDES CURRENT CODE: if the live repository contradicts
 * a memory, the memory is superseded as stale (via correctMemory), not the
 * opposite.
 */
import { correctMemory, flagMemoryWrong, getMemory } from '../memory/service.js';
import { removePreference } from './preferences.js';
import { supersedePattern } from './codingRecords.js';

export interface CorrectionResult {
  memoryId: string;
  supersededMemoryId: string | null;
  reason: string;
}

/** User states a memory is wrong — supersede it durably, never erase. */
export async function correctStaleMemory(
  userId: string,
  memoryId: string,
  reason: string,
): Promise<CorrectionResult> {
  const existing = await getMemory(userId, memoryId);
  await correctMemory(userId, memoryId, reason);
  return { memoryId, supersededMemoryId: existing.id, reason };
}

/**
 * The live repository contradicts a memory (e.g. the code changed and a memory
 * describes the old behavior). Current code wins: supersede the stale memory.
 */
export async function supersedeStaleByCurrentCode(
  userId: string,
  memoryId: string,
  note: string,
): Promise<CorrectionResult> {
  const existing = await getMemory(userId, memoryId);
  if (!existing) {
    await flagMemoryWrong(userId, memoryId, note).catch(() => undefined);
    return { memoryId, supersededMemoryId: memoryId, reason: note };
  }
  const corrected = await correctMemory(userId, memoryId, `stale vs current code: ${note}`);
  return { memoryId, supersededMemoryId: corrected.id, reason: note };
}

/** Correct a conflicting inferred preference by removing it (durable). */
export async function correctPreference(userId: string, prefId: string, reason: string): Promise<void> {
  await removePreference(userId, prefId);
  void reason;
}

/** Reject a learned pattern that the user/current code contradicts. */
export async function correctPattern(userId: string, patternId: string): Promise<void> {
  await supersedePattern(userId, patternId);
}
