/**
 * CodeConClave — acceptance gate status (Prompt 6, Part 7/9).
 * Reads the shared human-acceptance evidence file and prints, per gate:
 * id, human requirement, current status, evidence needed. RELEASE_READY is
 * derived purely from evidence — an absent/partial/missing gate can never be
 * auto-promoted to PASS. No secrets are read or printed.
 *
 * Evidence file: docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EvidenceGate {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'HUMAN_REQUIRED' | 'NOT_PERFORMED' | 'BLOCKED';
  evidence: string[];
  performedBy: string | null;
  performedAt: string | null;
}

export interface EvidenceFile {
  generatedAt: string;
  gates: EvidenceGate[];
}

const GATE_ORDER = [
  'GOOGLE_OAUTH_LOGIN',
  'PRODUCTION_PAYMENT',
  'WINDOWS_INSTALL',
  'OFFLINE_MODE',
  'PROVIDER_REPROBE',
  'WEB_E2E',
  'DESKTOP_E2E',
  'WEB_DESKTOP_PARITY',
  'FULL_PRODUCT',
];

export function loadEvidence(): EvidenceFile {
  const p = resolve(fileURLToPath(new URL('../../../docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json', import.meta.url)));
  if (!existsSync(p)) {
    return { generatedAt: new Date().toISOString(), gates: [] };
  }
  return JSON.parse(readFileSync(p, 'utf8')) as EvidenceFile;
}

export function acceptanceStatusDescription(status: string): string {
  switch (status) {
    case 'PASS':
      return 'PASS — evidence provided by the founder';
    case 'FAIL':
      return 'FAIL — evidence rejected';
    case 'NOT_PERFORMED':
      return 'HUMAN_REQUIRED — not yet performed';
    case 'BLOCKED':
      return 'BLOCKED — environment or dependency missing';
    default:
      return 'HUMAN_REQUIRED — no valid evidence on file';
  }
}

export function computeGates(evidence: EvidenceFile): EvidenceGate[] {
  const byId = new Map(evidence.gates.map((g) => [g.id, g]));
  return GATE_ORDER.map((id) => {
    const g = byId.get(id);
    if (!g) {
      return {
        id,
        title: id.replaceAll('_', ' '),
        status: 'HUMAN_REQUIRED' as const,
        evidence: [],
        performedBy: null,
        performedAt: null,
      };
    }
    const status: EvidenceGate['status'] = g.status === 'PASS' && g.performedBy ? 'PASS' : g.status === 'PASS' ? 'HUMAN_REQUIRED' : g.status;
    return { ...g, status };
  });
}

export function runStatus(): { releaseReady: boolean; gates: EvidenceGate[] } {
  const evidence = loadEvidence();
  const gates = computeGates(evidence);
  const releaseReady = gates.every((g) => g.status === 'PASS');
  const passCount = gates.filter((g) => g.status === 'PASS').length;

  console.log('CODECONCLAVE HUMAN ACCEPTANCE GATES');
  console.log('----------------------------------');
  for (const g of gates) {
    const evidenceLine = g.evidence.length ? g.evidence.join('; ') : '(no evidence on record)';
    console.log(`[${g.status}] ${g.id} — ${g.title}`);
    console.log(`    status: ${acceptanceStatusDescription(g.status)}`);
    console.log(`    evidence: ${evidenceLine}`);
    if (g.performedBy && g.performedAt) console.log(`    performed: ${g.performedBy} at ${g.performedAt}`);
  }
  console.log('----------------------------------');
  console.log(`PASS_GATES = ${passCount} / ${GATE_ORDER.length}`);
  console.log(`RELEASE_READY = ${releaseReady ? 'YES' : 'NO'}`);
  console.log('POLICY = human-only gates remain HUMAN_REQUIRED unless the founder supplies real evidence; nothing is auto-fabricated.');
  return { releaseReady, gates };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runStatus();
  process.exit(0);
}