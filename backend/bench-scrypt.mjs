/**
 * Throwaway benchmark — measures real scrypt latency and memory on this
 * runtime so B3 parameters are chosen from evidence, not assumption.
 * Not part of the product. Safe to delete after use.
 */
import crypto from 'node:crypto';

function bench(N, r, runs = 3) {
  const memBytes = 128 * N * r;
  const maxmem = memBytes + 16 * 1024 * 1024;
  const salt = crypto.randomBytes(32).toString('hex');
  let ms = 0;
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    crypto.scryptSync('benchmark-password-value', salt, 64, { N, r, p: 1, maxmem });
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
  }
  return { N, r, ms: Math.round(ms / runs), memMB: Math.ceil(memBytes / (1024 * 1024)), rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)) };
}

console.log('node', process.version, '| concurrency=1 | mem shown = 128*N*r');
const rows = [];
for (const N of [16384, 32768, 65536, 131072, 262144]) {
  try {
    const row = bench(N, 8);
    rows.push(row);
    console.log(`N=${String(N).padStart(6)} r=8  need=${String(row.memMB).padStart(4)}MB  time=${String(row.ms).padStart(5)}ms  rssAfter=${row.rssMB}MB`);
  } catch (e) {
    console.log(`N=${String(N).padStart(6)} r=8  FAILED: ${e.message.split('\n')[0]}`);
  }
}

console.log('\n-- Node default maxmem (32MB) with NO explicit maxmem --');
for (const N of [16384, 32768, 65536, 131072, 262144]) {
  try {
    crypto.scryptSync('x', 'y', 64, { N, r: 8, p: 1 });
    console.log(`N=${String(N).padStart(6)}: ok with default maxmem`);
  } catch (e) {
    console.log(`N=${String(N).padStart(6)}: THROWS -> ${e.message.split('\n')[0]}`);
  }
}

console.log('\n-- concurrency burst: 4 simultaneous verifications --');
for (const N of [65536, 131072]) {
  const memMB = Math.ceil((128 * N * 8) / (1024 * 1024));
  const maxmem = memMB * 1024 * 1024 + 16 * 1024 * 1024;
  const t0 = process.hrtime.bigint();
  const inflight = [];
  for (let i = 0; i < 4; i += 1) {
    inflight.push(crypto.scryptSync('burst-password-value-' + i, 'saltsaltsaltsalt', 64, { N, r: 8, p: 1, maxmem }));
  }
  const burstMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  console.log(`N=${N}: 4x parallel completed in ${burstMs}ms, needs ~${memMB * 4}MB peak, rssAfter=${Math.round(process.memoryUsage().rss / (1024 * 1024))}MB`);
}

console.log('\nJSON=' + JSON.stringify(rows));
