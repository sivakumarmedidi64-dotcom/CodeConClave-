/**
 * CodeConClave — PKG-24 AI Developer Copilot — Ask CodeConClave.
 *
 * Answers project-aware questions ("Where is auth handled?", "Why does this API
 * return 401?", "Have we solved this bug before?") citing evidence from source,
 * memory, runtime, diagnostics, and deployment records. Source references are
 * never fabricated: every citation points to a real file/record returned by the
 * retrieval layer. A live model synthesizes the answer; without one we return
 * the honest evidence set and a provider state.
 */
import type { GatewayContext } from '../ai/gateway.js';
import { providerState } from './provider.js';
import { runCompletion } from './provider.js';
import { COPILOT_CONFIG } from './config.js';

export interface AskEvidence {
  kind: 'source' | 'memory' | 'runtime' | 'diagnostic' | 'deployment' | 'symbol';
  ref: string;
  detail: string;
  confidence: number;
}

export interface AskDeps {
  listFiles(projectId: string): Promise<string[]>;
  readFile(projectId: string, path: string): Promise<string | null>;
  relevantMemories(userId: string, projectId: string): Promise<AskEvidence[]>;
  runtimeEvidence(userId: string, projectId: string): Promise<AskEvidence[]>;
  deploymentEvidence(userId: string, projectId: string): Promise<AskEvidence[]>;
}

export interface AskResult {
  answer: string;
  synthesizedWithModel: boolean;
  evidence: AskEvidence[];
  provider: Awaited<ReturnType<typeof providerState>>;
}

export async function askCopilot(
  ctx: GatewayContext,
  projectId: string,
  question: string,
  deps: AskDeps,
): Promise<AskResult> {
  const provider = await providerState(ctx.userId);
  const [files, memories, runtime, deployments] = await Promise.all([
    deps.listFiles(projectId),
    deps.relevantMemories(ctx.userId, projectId),
    deps.runtimeEvidence(ctx.userId, projectId),
    deps.deploymentEvidence(ctx.userId, projectId),
  ]);

  const evidence: AskEvidence[] = [];
  const q = question.toLowerCase();

  // Deterministic evidence retrieval (works with no model).
  const candidateFiles = files
    .filter((f) => /\.(ts|tsx|js|jsx|py|go|rb|java|sql)$/.test(f))
    .slice(0, CONFIG.fileScanLimit);

  // Keyword-guided source scan (bounded).
  const queryTokens = q.split(/\W+/).filter((w) => w.length > 3).slice(0, 6);
  for (const f of candidateFiles) {
    const content = await deps.readFile(projectId, f);
    if (!content) continue;
    const lowered = content.toLowerCase();
    const hits = queryTokens.filter((t) => lowered.includes(t));
    if (hits.length >= 1) {
      evidence.push({
        kind: 'source',
        ref: f,
        detail: `File matches query terms: ${hits.join(', ')}`,
        confidence: Math.min(0.5 + hits.length * 0.15, 0.9),
      });
    }
  }
  evidence.push(...memories.filter((m) => queryTokens.some((t) => m.detail.toLowerCase().includes(t))));
  evidence.push(...runtime);
  evidence.push(...deployments);

  const sorted = evidence.slice(0, COPILOT_CONFIG.maxAskEvidence);
  const live =
    provider.state === 'LIVE_PROVIDER' || provider.state === 'LOCAL_MODEL' || provider.state === 'FALLBACK';

  let synthesized = false;
  if (live && sorted.length > 0) {
    const userText =
      `Answer the developer's question using ONLY the cited evidence below. ` +
      `Do not invent file references, bugs, or causes. If the evidence is ` +
      `insufficient, say so explicitly. Cite evidence by ref.\n\n` +
      `Question: ${question}\n\nEvidence:\n${sorted.map((e) => `- [${e.kind}] ${e.ref}: ${e.detail} (conf ${e.confidence})`).join('\n')}`;
    const res = await runCompletion({
      ctx,
      messages: [
        { role: 'system', content: 'You are CodeConClave\'s project-aware assistant. Answer from evidence only.' },
        { role: 'user', content: userText },
      ],
      opts: { computeClass: COPILOT_CONFIG.computeClass, coding: true, coworkerType: 'COPILOT' },
      maxTokens: 800,
    });
    if ('summary' in res) {
      synthesized = true;
      return { answer: res.summary.text, synthesizedWithModel: true, evidence: sorted, provider };
    }
  }

  const answer =
    sorted.length === 0
      ? 'No evidence matched the question in the current project. Try a more specific question, or narrow the files/runtime you are asking about.'
      : `Evidence-based answer (no live model): found ${sorted.length} relevant item(s).\n` +
        sorted.map((e) => `- [${e.kind}] ${e.ref}: ${e.detail}`).join('\n');

  return { answer, synthesizedWithModel: synthesized, evidence: sorted, provider };
}

const CONFIG = { fileScanLimit: 60 };
