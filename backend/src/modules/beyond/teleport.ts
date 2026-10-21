/**
 * CodeConClave — Teleport (Beyond agentic #6, from "protocol-agnostic state
 * teleportation"). A whole project — every file, its memories, its
 * instruction and ignore files — packed into ONE sealed bundle that can be
 * moved to another CodeConClave (another account, another server) and
 * unpacked there exactly as it was.
 *
 * Sealed means: every file carries its SHA-256, the manifest is hashed, and
 * the hash is signed with this server's key. On import every file hash is
 * re-computed — a single changed byte rejects the whole bundle — and the
 * signature tells you whether the bundle came from this same server.
 *
 * Adapted honestly: running processes and agent swarms are not "teleported";
 * the project's durable state is. Tasks re-run on the new side.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { createProject, getProject } from '../projects/service.js';
import { listFiles, getFileContent, uploadFile } from '../files/service.js';
import { listMemories, createMemory } from '../memory/service.js';
import { MemorySource, MemoryType } from '@codeconclave/shared';

export const TELEPORT_FORMAT = 'codeconclave-teleport';
export const TELEPORT_VERSION = 1;
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024; // packed (gzip) size
const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_MEMORIES = 500;

interface BundleFile {
  path: string;
  mimeType: string | null;
  sha256: string;
  bytes: number;
  content: string; // base64
}

interface BundleMemory {
  type: string;
  content: string;
  confidence: number;
}

export interface TeleportBundle {
  format: typeof TELEPORT_FORMAT;
  version: number;
  createdAt: string;
  project: { name: string; description: string | null; tags: string[] };
  files: BundleFile[];
  memories: BundleMemory[];
  manifestHash: string;
  signature: string;
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const signingKey = () => crypto.createHash('sha256').update(`codeconclave-teleport-v1:${env.SESSION_SECRET}`).digest();

/** Canonical hash over everything except the file bodies (which are hashed per file). Pure. */
export function manifestHashOf(b: Pick<TeleportBundle, 'format' | 'version' | 'project' | 'files' | 'memories'>): string {
  const canonical = JSON.stringify({
    format: b.format,
    version: b.version,
    project: { name: b.project.name, description: b.project.description, tags: b.project.tags },
    files: b.files.map((f) => [f.path, f.mimeType, f.sha256, f.bytes]),
    memories: b.memories.map((m) => [m.type, sha256(m.content), m.confidence]),
  });
  return sha256(canonical);
}

export function signHash(hash: string): string {
  return crypto.createHmac('sha256', signingKey()).update(hash).digest('hex');
}

/** Pack a project into a sealed, gzipped bundle. */
export async function exportProject(userId: string, projectId: string): Promise<{ filename: string; data: Buffer; fileCount: number; memoryCount: number }> {
  const project = await getProject(userId, projectId);
  const files = (await listFiles(userId, projectId)).filter((f) => !f.isDirectory);
  if (files.length > MAX_FILES) throw AppError.badRequest('teleport_too_many_files', `Teleport packs up to ${MAX_FILES} files; this project has ${files.length}.`);
  const out: BundleFile[] = [];
  let total = 0;
  for (const f of files) {
    const { buffer, mimeType } = await getFileContent(userId, projectId, f.id);
    total += buffer.length;
    if (total > MAX_UNPACKED_BYTES) throw AppError.badRequest('teleport_too_large', 'This project is too large to teleport in one bundle (over 60 MB of files).');
    out.push({ path: f.path, mimeType: mimeType ?? f.mimeType ?? null, sha256: sha256(buffer), bytes: buffer.length, content: buffer.toString('base64') });
  }
  const { items } = await listMemories(userId, { projectId, limit: MAX_MEMORIES });
  const memories: BundleMemory[] = items.map((m) => ({ type: m.type, content: m.content, confidence: Number(m.confidence) }));
  const p = project as unknown as { name: string; description?: string | null; tags?: string[] | null };
  const body = {
    format: TELEPORT_FORMAT,
    version: TELEPORT_VERSION,
    project: { name: p.name, description: p.description ?? null, tags: Array.isArray(p.tags) ? p.tags : [] },
    files: out,
    memories,
  } as const;
  const manifestHash = manifestHashOf(body);
  const bundle: TeleportBundle = { ...body, createdAt: new Date().toISOString(), manifestHash, signature: signHash(manifestHash) };
  const data = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
  if (data.length > MAX_BUNDLE_BYTES) throw AppError.badRequest('teleport_too_large', 'The packed bundle is over 25 MB.');
  const safeName = p.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  return { filename: `${safeName}.ccteleport`, data, fileCount: out.length, memoryCount: memories.length };
}

export interface VerifyResult {
  bundle: TeleportBundle;
  fileCount: number;
  memoryCount: number;
  signedHere: boolean;
}

/** Unpack and verify a bundle without importing it. Throws on any tampering. */
export function verifyBundle(packed: Buffer): VerifyResult {
  if (packed.length > MAX_BUNDLE_BYTES) throw AppError.badRequest('teleport_too_large', 'The bundle is over 25 MB.');
  let bundle: TeleportBundle;
  try {
    const json = zlib.gunzipSync(packed, { maxOutputLength: MAX_UNPACKED_BYTES * 2 }).toString('utf8');
    bundle = JSON.parse(json) as TeleportBundle;
  } catch {
    throw AppError.badRequest('teleport_unreadable', 'That file is not a CodeConClave Teleport bundle.');
  }
  if (bundle?.format !== TELEPORT_FORMAT || bundle.version !== TELEPORT_VERSION) throw AppError.badRequest('teleport_unreadable', 'That file is not a CodeConClave Teleport bundle (or is from a newer version).');
  if (!Array.isArray(bundle.files) || !Array.isArray(bundle.memories) || bundle.files.length > MAX_FILES || bundle.memories.length > MAX_MEMORIES) {
    throw AppError.badRequest('teleport_unreadable', 'The bundle structure is not valid.');
  }
  for (const f of bundle.files) {
    if (typeof f.path !== 'string' || typeof f.content !== 'string' || typeof f.sha256 !== 'string') throw AppError.badRequest('teleport_unreadable', 'The bundle structure is not valid.');
    const buf = Buffer.from(f.content, 'base64');
    if (sha256(buf) !== f.sha256 || buf.length !== f.bytes) {
      throw AppError.badRequest('teleport_tampered', `The bundle was changed after it was sealed (${f.path.slice(0, 120)} does not match its fingerprint).`);
    }
  }
  if (manifestHashOf(bundle) !== bundle.manifestHash) throw AppError.badRequest('teleport_tampered', 'The bundle was changed after it was sealed (its manifest does not match).');
  const expected = signHash(bundle.manifestHash);
  const signedHere =
    typeof bundle.signature === 'string' &&
    bundle.signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(bundle.signature, 'utf8'), Buffer.from(expected, 'utf8'));
  return { bundle, fileCount: bundle.files.length, memoryCount: bundle.memories.length, signedHere };
}

/** Verify, then recreate the project in this account. */
export async function importBundle(userId: string, packed: Buffer): Promise<{ projectId: string; name: string; fileCount: number; memoryCount: number; signedHere: boolean; skipped: string[] }> {
  const { bundle, signedHere } = verifyBundle(packed);
  const name = `${bundle.project.name}`.slice(0, 90) + ' (teleported)';
  const project = await createProject(userId, { name, description: bundle.project.description ?? undefined, tags: bundle.project.tags?.slice(0, 20) });
  const skipped: string[] = [];
  let fileCount = 0;
  for (const f of bundle.files) {
    try {
      await uploadFile(userId, project.id, f.path, Buffer.from(f.content, 'base64'), f.mimeType ?? undefined);
      fileCount += 1;
    } catch (err) {
      skipped.push(`${f.path}: ${err instanceof Error ? err.message.slice(0, 100) : 'not imported'}`);
    }
  }
  const validTypes = new Set<string>(Object.values(MemoryType));
  let memoryCount = 0;
  for (const m of bundle.memories) {
    if (!validTypes.has(m.type) || typeof m.content !== 'string' || !m.content.trim()) continue;
    try {
      await createMemory(userId, {
        projectId: project.id,
        type: m.type as (typeof MemoryType)[keyof typeof MemoryType],
        source: MemorySource.USER_STATED,
        content: m.content.slice(0, 10_000),
        confidence: Number.isFinite(m.confidence) ? Math.max(0, Math.min(1, m.confidence)) : undefined,
        provenance: 'teleport',
      });
      memoryCount += 1;
    } catch {
      skipped.push('a memory could not be imported');
    }
  }
  return { projectId: project.id, name, fileCount, memoryCount, signedHere, skipped: skipped.slice(0, 50) };
}
