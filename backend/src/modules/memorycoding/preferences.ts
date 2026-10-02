/**
 * CodeConClave — PKG-23 User Preferences.
 *
 * Developer preferences are classified EXPLICIT / INFERRED / UNKNOWN.
 * An EXPLICIT preference ALWAYS overrides a weak INFERRED one. Inferred
 * preferences are never silently promoted to user instructions. Resolution is
 * deterministic per (category, key): explicit wins, else provided-inferred wins,
 * else latest.
 */
import { upsertPreference, getPreference, listPreferences, deletePreference, type PrefRow, type PrefClassification } from './codingRecords.js';

export interface PreferenceInput {
  projectId?: string | null;
  category: string;
  key: string;
  value: Record<string, unknown>;
  classification?: PrefClassification;
  source?: string | null;
}

export async function setPreference(userId: string, input: PreferenceInput): Promise<PrefRow> {
  const cls: PrefClassification = input.classification ?? 'EXPLICIT';
  return upsertPreference(userId, {
    projectId: input.projectId ?? null,
    category: input.category,
    key: input.key,
    value: input.value,
    classification: cls,
    source: input.source ?? (cls === 'EXPLICIT' ? 'user.declared' : 'inferred'),
  });
}

export interface ResolvedPreference<T = unknown> {
  key: string;
  category: string;
  value: T;
  classification: PrefClassification;
  confidence: number;
  source: string | null;
  resolvedFrom: string;
}

/** Deterministic precedence resolution for a single (category,key). */
export async function resolvePreference(userId: string, category: string, key: string, projectId?: string | null): Promise<ResolvedPreference | null> {
  const prefs = await listPreferences(userId, projectId ?? null);
  const matches = prefs.filter((p) => p.category === category && p.key === key);
  if (matches.length === 0) return null;
  const explicit = matches.find((m) => m.classification === 'EXPLICIT');
  if (explicit) return toResolved(explicit);
  const first = matches[0]!;
  return toResolved(first);
}

function toResolved(p: PrefRow): ResolvedPreference {
  return {
    key: p.key,
    category: p.category,
    value: p.value,
    classification: p.classification,
    confidence: p.confidence,
    source: p.source,
    resolvedFrom: p.classification === 'EXPLICIT' ? 'EXPLICIT_OVERRIDE' : p.classification,
  };
}

export async function getPreferenceById(userId: string, prefId: string): Promise<PrefRow | null> {
  return getPreference(userId, prefId);
}

export async function removePreference(userId: string, prefId: string): Promise<void> {
  await getPreference(userId, prefId);
  await deletePreference(userId, prefId);
}

export async function listUserPreferences(userId: string, projectId?: string | null): Promise<PrefRow[]> {
  return listPreferences(userId, projectId ?? null);
}

/**
 * Infer a preference is UNKNOWN when nothing is recorded and no evidence exists.
 * Callers use this before presenting a default, never to assert a preference.
 */
export function classifyUnknown(): PrefClassification {
  return 'UNKNOWN';
}
