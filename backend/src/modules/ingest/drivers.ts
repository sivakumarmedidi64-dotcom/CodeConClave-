/**
 * CodeConClave — Resident drivers · 5 tuned models → v3 arc.
 * ONE gateway feeling: Dispatch picks 1 role · 1 run (winner runs).
 * Sai 29 sources feed hashes + DNA; drivers read frozen pins only.
 * No weight merge (different architectures would break).
 */

export type DiamondBox = 'CODER' | 'PLANNER' | 'VERIFY' | 'SCOUT' | 'GATE';

export interface ResidentDriver {
  hubId: string;
  box: DiamondBox;
  roles: string[];
  saiSources: string[];
  contract: string;
  maxTokens: number;
}

export const RESIDENT_DRIVERS: ResidentDriver[] = [
  {
    hubId: 'SaharshMedidi/codeconclave-coder-lite',
    box: 'CODER',
    roles: ['Coder', 'Debugger', 'Tester'],
    saiSources: [
      'opencode-instruct',
      'codex-7m-nonthink',
      'codefeedback-filtered',
      'codesearchnet',
      'synth-text-to-sql',
      'github-trending-python',
      'github-trending-typescript',
    ],
    contract: 'coder-v1',
    maxTokens: 2048,
  },
  {
    hubId: 'SaharshMedidi/codeconclave-scout',
    box: 'SCOUT',
    roles: ['Route-scout', 'UI/UX', 'Documentation'],
    saiSources: ['autoif-instruct-61k', 'glaive-fc-v2', 'so-python', 'so-javascript', 'hn-top', 'hn-newest'],
    contract: 'scout-v1',
    maxTokens: 300,
  },
  {
    hubId: 'SaharshMedidi/codeconclave-reviewer',
    box: 'VERIFY',
    roles: ['Reviewer', 'Security'],
    saiSources: ['nemotron-sft-swe-v2', 'open-r1-codeforces', 'swe-bench', 'intercode'],
    contract: 'reviewer-v1',
    maxTokens: 1024,
  },
  {
    hubId: 'SaharshMedidi/codeconclave-planner-lite',
    box: 'PLANNER',
    roles: ['Architect', 'DevOps'],
    saiSources: [
      'nemotron-sft-opencode-v1',
      'kimi-k2-5-1m',
      'orca-agentinstruct-1m',
      'codex-2m-thinking',
      'rstar-coder',
      'arxiv-cs-se',
      'arxiv-cs-ai',
      'arxiv-cs-lg',
      'arxiv-cs-cl',
    ],
    contract: 'planner-v1',
    maxTokens: 2048,
  },
  {
    hubId: 'SaharshMedidi/codeconclave-fastqa',
    box: 'GATE',
    roles: ['FastQA', 'Quantum Physics', 'Nuclear Physics', 'Computational Math', 'Statistics'],
    saiSources: ['toolbench', 'llama-guard-safety', 'nemotron-sft-if-chat-v2'],
    contract: 'fastqa-v1',
    maxTokens: 1024,
  },
];

/** 13 v3 roles covered exactly once. */
export const V3_ROLES = [
  'Architect',
  'Coder',
  'Debugger',
  'Reviewer',
  'Tester',
  'Security',
  'DevOps',
  'UI/UX',
  'Documentation',
  'Quantum Physics',
  'Nuclear Physics',
  'Computational Math',
  'Statistics',
  'Route-scout',
] as const;

export function driverForRole(role: string): ResidentDriver | undefined {
  return RESIDENT_DRIVERS.find((d) => d.roles.includes(role));
}

export function driverForBox(box: DiamondBox): ResidentDriver | undefined {
  return RESIDENT_DRIVERS.find((d) => d.box === box);
}
