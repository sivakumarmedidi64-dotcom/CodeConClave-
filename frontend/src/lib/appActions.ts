/**
 * CodeConClave acting inside CodeConClave. Plain-language commands typed in
 * the composer that map to a real app action are executed through the app's
 * own API (never simulated) and confirmed in the chat; anything else goes to
 * the AI as usual. Deterministic patterns — no model guesses what to run.
 */
import { api } from './api';
import { savePrefs } from './prefs';

export type AppAction =
  | { kind: 'create_project'; name: string }
  | { kind: 'permission_mode'; mode: 'ask' | 'accept_edits' | 'full_access' }
  | { kind: 'effort'; effort: 'low' | 'medium' | 'high' }
  | { kind: 'open'; path: string; label: string };

const OPEN_TARGETS: { keys: RegExp; path: string; label: string }[] = [
  { keys: /\b(usage|tokens?)\b/, path: '/settings?tab=usage', label: 'Usage' },
  { keys: /\bpersonali[sz]ation\b/, path: '/settings?tab=personalization', label: 'Personalization' },
  { keys: /\bapi keys?\b/, path: '/settings?tab=apikeys', label: 'API keys' },
  { keys: /\bcode review\b|\breview (my|this|the) code\b/, path: '/code-review', label: 'Code review' },
  { keys: /\blocal files?\b|\bmy (folder|files)\b/, path: '/local', label: 'Local files' },
  { keys: /\ball chats\b|\bsessions\b|\bchat history\b/, path: '/chats', label: 'All chats' },
  { keys: /\bplugins?\b/, path: '/skills', label: 'Plugins' },
  { keys: /\bpermissions?\b|\bcontrol\b/, path: '/control', label: 'Control' },
  { keys: /\bprojects?\b/, path: '/projects', label: 'Projects' },
];

export function parseAppAction(input: string): AppAction | null {
  const text = input.trim();
  const lower = text.toLowerCase();

  const project = /^(?:please\s+)?(?:create|make|start|add|new)\s+(?:a\s+)?(?:new\s+)?project\s+(?:called|named)?\s*["“]?([^"”]{1,80}?)["”]?\s*$/i.exec(text);
  if (project && project[1]!.trim()) return { kind: 'create_project', name: project[1]!.trim() };

  const mode = /^(?:set|switch|change|turn)\s+(?:the\s+)?(?:permission(?:s)?(?:\s+mode)?|mode)\s+(?:to\s+)?(manual|ask|auto[-\s]?accept(?:\s+edits)?|accept edits|auto|full access)\s*$/i.exec(text);
  if (mode) {
    const m = mode[1]!.toLowerCase();
    return { kind: 'permission_mode', mode: m === 'manual' || m === 'ask' ? 'ask' : m.startsWith('auto') && m.length > 4 ? 'accept_edits' : m === 'accept edits' ? 'accept_edits' : 'full_access' };
  }

  const effort = /^(?:set|use|switch|change)\s+(?:the\s+)?effort\s+(?:to\s+)?(low|medium|high)\s*$/i.exec(text);
  if (effort) return { kind: 'effort', effort: effort[1]!.toLowerCase() as 'low' | 'medium' | 'high' };

  if (/^(?:open|show|go to|take me to)\b/.test(lower)) {
    const target = OPEN_TARGETS.find((t) => t.keys.test(lower));
    if (target) return { kind: 'open', path: target.path, label: target.label };
  }
  return null;
}

export interface ActionResult {
  message: string;
  navigateTo?: string;
}

const MODE_LABEL = { ask: 'Manual', accept_edits: 'Auto-accept edits', full_access: 'Auto' } as const;

/** Execute the action for real; throws with a readable message on failure. */
export async function runAppAction(action: AppAction): Promise<ActionResult> {
  switch (action.kind) {
    case 'create_project': {
      const res = await api<{ project: { id: string; name: string } }>('/api/v1/projects', { method: 'POST', body: { name: action.name } });
      return { message: `Created the project **${res.project.name}**. It's ready in Projects — Cowork tasks from Home will use it.` };
    }
    case 'permission_mode': {
      await api('/api/v1/control/permission-mode', { method: 'PUT', body: { mode: action.mode } });
      return { message: `Permission mode is now **${MODE_LABEL[action.mode]}**. Secret files, dangerous commands and ungranted folders stay blocked in every mode.` };
    }
    case 'effort': {
      await savePrefs({ effort: action.effort });
      return { message: `Effort set to **${action.effort}** for your next messages.` };
    }
    case 'open':
      return { message: `Opening ${action.label}…`, navigateTo: action.path };
  }
}
