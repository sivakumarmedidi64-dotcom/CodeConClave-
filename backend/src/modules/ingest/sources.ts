/**
 * CodeConClave — Agent Sai Srinivasa Athreya · source registry.
 * PRIVATE agent: single-owner only (see INGEST_AGENT_OWNER_ID in service.ts).
 * Data-Scout ingest agent: 19 final open sources (15 core + 4 guardrail).
 * Every source maps to one diamond box and carries TEXT + IMAGE modalities.
 * Licenses are permissive-only.
 * hfDataset ids are operator-verified on first check — a check that cannot
 * resolve a revision fails CLOSED (UNKNOWN) and never downloads.
 */

export type DiamondBox = 'CODER' | 'PLANNER' | 'VERIFY' | 'SCOUT' | 'GATE';

export type SourceTier = 'T1_SAFE' | 'T2_ATTRIBUTION' | 'EVAL_ONLY';

/** Media this agent stores per source: text records + image payloads (hashed). */
export type Modality = 'text' | 'image';

/** Where the revision signal comes from. huggingface = Hub API sha; the rest
 *  are endpoint-watched (latest-item id hashed). All fail CLOSED on error. */
export type SourceKind = 'huggingface' | 'arxiv' | 'github-trending' | 'stackexchange' | 'hackernews';

export interface IngestSource {
  id: string;
  name: string;
  hfDataset: string;
  license: string;
  tier: SourceTier;
  box: DiamondBox;
  evalOnly?: boolean;
  /** Defaults to ['text','image'] when omitted — all 29 carry both. */
  modalities?: Modality[];
  kind?: SourceKind;
  /** Category/tag/feed for non-HF kinds (e.g. 'cs.SE', 'python', 'top'). */
  ref?: string;
}

export const AGENT_NAME = 'Agent Sai Srinivasa Athreya';

/** Licenses allowed through Gate·sentinel without human approval. */
export const ALLOWED_LICENSES = [
  'Apache-2.0',
  'MIT',
  'BSD',
  'CC0',
  'CC-BY-4.0',
  'Permissive',
  'NVIDIA-Open-Model',
] as const;

/** CC-BY-4.0 entries must keep attribution in the Ledger write. */
export const ATTRIBUTION_REQUIRED = ['CC-BY-4.0'] as const;

export const INGEST_SOURCES: IngestSource[] = [
  // ---- CODER · Qwen-27B (5) ----
  { id: 'opencode-instruct', name: 'OpenCodeInstruct', hfDataset: 'nvidia/OpenCodeInstruct', license: 'Apache-2.0', tier: 'T1_SAFE', box: 'CODER' },
  { id: 'codex-7m-nonthink', name: 'CodeX-7M-Non-Thinking', hfDataset: 'Modotte/CodeX-7M-Non-Thinking', license: 'Permissive', tier: 'T1_SAFE', box: 'CODER' },
  { id: 'codefeedback-filtered', name: 'CodeFeedback-Filtered-Instruction', hfDataset: 'm-a-p/CodeFeedback-Filtered-Instruction', license: 'MIT', tier: 'T1_SAFE', box: 'CODER' },
  { id: 'codesearchnet', name: 'CodeSearchNet', hfDataset: 'code-search-net/code_search_net', license: 'MIT', tier: 'T1_SAFE', box: 'CODER' },
  { id: 'synth-text-to-sql', name: 'synthetic_text_to_sql', hfDataset: 'gretelai/synthetic_text_to_sql', license: 'Permissive', tier: 'T1_SAFE', box: 'CODER' },
  // ---- PLANNER · Nemotron-8B (5) ----
  { id: 'nemotron-sft-opencode-v1', name: 'Nemotron-SFT-OpenCode-v1', hfDataset: 'nvidia/Nemotron-SFT-OpenCode-v1', license: 'NVIDIA-Open-Model', tier: 'T1_SAFE', box: 'PLANNER' },
  { id: 'kimi-k2-5-1m', name: 'KIMI-K2.5-1000000x', hfDataset: 'ianncity/KIMI-K2.5-1000000x', license: 'CC-BY-4.0', tier: 'T2_ATTRIBUTION', box: 'PLANNER' },
  { id: 'orca-agentinstruct-1m', name: 'orca-agentinstruct-1M-v1', hfDataset: 'microsoft/orca-agentinstruct-1M-v1', license: 'MIT', tier: 'T1_SAFE', box: 'PLANNER' },
  { id: 'codex-2m-thinking', name: 'CodeX-2M-Thinking', hfDataset: 'Modotte/CodeX-2M-Thinking', license: 'Permissive', tier: 'T1_SAFE', box: 'PLANNER' },
  { id: 'rstar-coder', name: 'rStar-Coder', hfDataset: 'microsoft/rStar-Coder', license: 'Apache-2.0', tier: 'T1_SAFE', box: 'PLANNER' },
  // ---- VERIFY · judge + repair (4) ----
  { id: 'nemotron-sft-swe-v2', name: 'Nemotron-SFT-SWE-v2', hfDataset: 'nvidia/Nemotron-SFT-SWE-v2', license: 'NVIDIA-Open-Model', tier: 'T1_SAFE', box: 'VERIFY' },
  { id: 'open-r1-codeforces', name: 'open-r1/codeforces', hfDataset: 'open-r1/codeforces', license: 'CC-BY-4.0', tier: 'T2_ATTRIBUTION', box: 'VERIFY' },
  { id: 'swe-bench', name: 'SWE-bench / Lite', hfDataset: 'princeton-nlp/SWE-bench', license: 'MIT', tier: 'EVAL_ONLY', box: 'VERIFY', evalOnly: true },
  { id: 'intercode', name: 'InterCode', hfDataset: 'epinnock/intercode-nl2bash-curated', license: 'Apache-2.0', tier: 'T1_SAFE', box: 'VERIFY' },
  // ---- SCOUT + GATE · Llama-8B / sentinel (5) ----
  { id: 'autoif-instruct-61k', name: 'AutoIF-instruct-61k-with-funcs', hfDataset: 'Post-training-Data-Flywheel/AutoIF-instruct-61k-with-funcs', license: 'MIT', tier: 'T1_SAFE', box: 'SCOUT' },
  { id: 'glaive-fc-v2', name: 'Glaive Function Calling v2', hfDataset: 'glaiveai/glaive-function-calling-v2', license: 'Apache-2.0', tier: 'T1_SAFE', box: 'SCOUT' },
  { id: 'toolbench', name: 'ToolBench', hfDataset: 'Maurus/ToolBench', license: 'Apache-2.0', tier: 'T1_SAFE', box: 'GATE' },
  { id: 'llama-guard-safety', name: 'Llama-Guard Safety Dataset', hfDataset: 'AuroraQuantum/llama-guard-safety-eval', license: 'Permissive', tier: 'T1_SAFE', box: 'GATE' },
  { id: 'nemotron-sft-if-chat-v2', name: 'Nemotron-SFT-Instruction-Following-Chat-v2', hfDataset: 'nvidia/Nemotron-SFT-Instruction-Following-Chat-v2', license: 'NVIDIA-Open-Model', tier: 'T1_SAFE', box: 'GATE' },
  // ---- Phase B · endpoint-watched (10): change detection only in v1,
  // ---- full content pulls wait for per-repo license review. Verified live.
  { id: 'arxiv-cs-se', name: 'arXiv cs.SE', hfDataset: 'arxiv:cs.SE', license: 'Permissive', tier: 'T1_SAFE', box: 'PLANNER', kind: 'arxiv', ref: 'cs.SE' },
  { id: 'arxiv-cs-ai', name: 'arXiv cs.AI', hfDataset: 'arxiv:cs.AI', license: 'Permissive', tier: 'T1_SAFE', box: 'PLANNER', kind: 'arxiv', ref: 'cs.AI' },
  { id: 'arxiv-cs-lg', name: 'arXiv cs.LG', hfDataset: 'arxiv:cs.LG', license: 'Permissive', tier: 'T1_SAFE', box: 'PLANNER', kind: 'arxiv', ref: 'cs.LG' },
  { id: 'arxiv-cs-cl', name: 'arXiv cs.CL', hfDataset: 'arxiv:cs.CL', license: 'Permissive', tier: 'T1_SAFE', box: 'PLANNER', kind: 'arxiv', ref: 'cs.CL' },
  { id: 'github-trending-python', name: 'GitHub trending python', hfDataset: 'github-trending:python', license: 'Permissive', tier: 'T1_SAFE', box: 'CODER', kind: 'github-trending', ref: 'python' },
  { id: 'github-trending-typescript', name: 'GitHub trending typescript', hfDataset: 'github-trending:typescript', license: 'Permissive', tier: 'T1_SAFE', box: 'CODER', kind: 'github-trending', ref: 'typescript' },
  { id: 'so-python', name: 'StackOverflow python', hfDataset: 'stackexchange:python', license: 'CC-BY-4.0', tier: 'T2_ATTRIBUTION', box: 'SCOUT', kind: 'stackexchange', ref: 'python' },
  { id: 'so-javascript', name: 'StackOverflow javascript', hfDataset: 'stackexchange:javascript', license: 'CC-BY-4.0', tier: 'T2_ATTRIBUTION', box: 'SCOUT', kind: 'stackexchange', ref: 'javascript' },
  { id: 'hn-top', name: 'HackerNews top', hfDataset: 'hackernews:top', license: 'Permissive', tier: 'T1_SAFE', box: 'SCOUT', kind: 'hackernews', ref: 'top' },
  { id: 'hn-newest', name: 'HackerNews newest', hfDataset: 'hackernews:newest', license: 'Permissive', tier: 'T1_SAFE', box: 'SCOUT', kind: 'hackernews', ref: 'newest' },
];

export const sourceById = (id: string): IngestSource | undefined =>
  INGEST_SOURCES.find((s) => s.id === id);

/** Effective modalities — every source stores text + image unless narrowed. */
export const sourceModalities = (s: IngestSource): Modality[] =>
  s.modalities ?? ['text', 'image'];
