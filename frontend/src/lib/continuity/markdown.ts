/**
 * CodeConClave — decision memory export ("CodeConClave decision.md").
 * A pure, deterministic markdown renderer over the decision records already
 * returned by the API. It never invents content — every line comes from a
 * row the server sent. The file is assembled for human handoff: scope,
 * status, impact, the decision text, rationale, alternatives, consequences,
 * source references, and timestamps.
 */
import type { DecisionRow } from '../types';

const STATUS_BADGES: Record<string, string> = {
  ACTIVE: 'ACTIVE',
  TENTATIVE: 'TENTATIVE',
  SUPERSEDED: 'SUPERSEDED',
  REJECTED: 'REJECTED',
  ARCHIVED: 'ARCHIVED',
};

function bullet(items: unknown[] | undefined): string {
  if (!items || items.length === 0) return '';
  return items
    .map((i) => String(i).trim())
    .filter(Boolean)
    .map((i) => `- ${i}`)
    .join('\n') + '\n';
}

function dateLine(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(iso);
  }
}

export function buildDecisionMarkdown(decisions: DecisionRow[]): string {
  const lines: string[] = [
    '# CodeConClave decision.md',
    '',
    `Exported ${new Date().toISOString().replace('T', ' ').slice(0, 19)}Z. Generated from the recorded decision rows only — no content is invented.`,
    '',
  ];
  if (decisions.length === 0) {
    lines.push('_No recorded decisions._');
    return lines.join('\n');
  }

  decisions.forEach((d, idx) => {
    lines.push(`## ${idx + 1}. ${d.title}`);
    lines.push('');
    const meta = [
      `Status: ${STATUS_BADGES[d.status] ?? 'ACTIVE'}`,
      `Scope: ${d.scope ?? 'PERSONAL'}`,
      `Impact: ${d.impact}`,
      `Recorded: ${dateLine(d.created_at)}`,
    ];
    if (d.updated_at && d.updated_at !== d.created_at) meta.push(`Updated: ${dateLine(d.updated_at)}`);
    lines.push(meta.join(' · '));
    lines.push('');
    if (d.decision) {
      lines.push('**Decision**');
      lines.push('');
      lines.push(d.decision);
      lines.push('');
    }
    if (d.context) {
      lines.push('**Context**');
      lines.push('');
      lines.push(d.context);
      lines.push('');
    }
    if (d.rationale) {
      lines.push('**Rationale**');
      lines.push('');
      lines.push(d.rationale);
      lines.push('');
    }
    const alternatives = bullet(d.alternatives);
    if (alternatives) {
      lines.push('**Alternatives considered**');
      lines.push('');
      lines.push(alternatives);
    }
    const consequences = bullet(d.consequences);
    if (consequences) {
      lines.push('**Consequences**');
      lines.push('');
      lines.push(consequences);
    }
    const refs: string[] = [];
    if (d.source_conversation_id) refs.push(`Conversation: ${d.source_conversation_id}`);
    if (d.source_task_id) refs.push(`Task: ${d.source_task_id}`);
    if (d.evidence_ref) refs.push(`Evidence: ${d.evidence_ref}`);
    if (d.superseded_by_id) refs.push(`Superseded by: ${d.superseded_by_id}`);
    if (d.source_message_ids?.length) refs.push(`Source messages: ${d.source_message_ids.join(', ')}`);
    if (refs.length) {
      lines.push('**Sources**');
      lines.push('');
      for (const r of refs) {
        lines.push(`- ${r}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

export function downloadDecisionMarkdown(content: string, filename = 'CodeConClave decision.md'): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build the markdown from rows fetched via the provided loader. */
export async function exportDecisionsFromApi(
  loader: () => Promise<DecisionRow[]>,
  download: (content: string, filename?: string) => void = downloadDecisionMarkdown,
): Promise<string> {
  const decisions = await loader();
  const content = buildDecisionMarkdown(decisions);
  download(content);
  return content;
}