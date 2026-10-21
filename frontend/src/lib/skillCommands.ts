/**
 * Slash commands contributed by the user's enabled skill plugins. Fetched
 * once per mount; a failure (offline, not entitled) simply yields none — the
 * built-in commands keep working and the server stays authoritative.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { IconName } from '../components/Icon';

const KNOWN_ICONS = new Set<string>([
  'compass', 'code', 'flask', 'gauge', 'book', 'eye', 'map', 'bug', 'git-branch', 'rocket', 'plug',
  'shield', 'search', 'users', 'puzzle', 'brain', 'bolt', 'sparkle', 'terminal', 'file', 'chart', 'mail', 'key',
]);

/** Plugin manifests name an icon; unknown names fall back to the puzzle piece. */
export function pluginIcon(name: string): IconName {
  return (KNOWN_ICONS.has(name) ? name : 'puzzle') as IconName;
}

export interface SkillCommand {
  name: string;
  description: string;
  plugin: string;
  pluginName: string;
  icon: string;
}

export function useSkillCommands(): SkillCommand[] {
  const [commands, setCommands] = useState<SkillCommand[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ commands: SkillCommand[] }>('/api/v1/skill-plugins/commands')
      .then((res) => {
        if (alive) setCommands(Array.isArray(res?.commands) ? res.commands : []);
      })
      .catch(() => {
        if (alive) setCommands([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  return commands;
}

/** Commands whose name starts with what the user typed after the slash. */
export function matchSkillCommands(input: string, commands: SkillCommand[]): SkillCommand[] {
  const m = /^\/([a-z0-9-]*)$/.exec(input.trim());
  if (!m) return [];
  const prefix = m[1] ?? '';
  return commands.filter((c) => c.name.startsWith(prefix));
}
