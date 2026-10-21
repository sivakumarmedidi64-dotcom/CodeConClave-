/**
 * Deterministic, seedable PRNG (mulberry32). Every random draw in the kernel
 * (numeric spot checks, bootstrap, shots) comes from a seed that is recorded
 * in the proof, so anyone can re-run the exact same check.
 */
import { createHash } from 'node:crypto';

export function seedFrom(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
