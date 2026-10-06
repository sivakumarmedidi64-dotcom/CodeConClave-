/**
 * CodeConClave — Voice Command Parser.
 * Parses natural language voice transcripts into executable commands.
 * Integrates with existing slash command system.
 */

export interface VoiceCommand {
  type: 'slash' | 'navigation' | 'action' | 'query';
  command: string;
  args?: string[];
  raw: string;
  confidence: number;
}

export interface VoiceCommandResult {
  executed: boolean;
  command?: VoiceCommand;
  response?: string;
  error?: string;
}

export interface ParseOptions {
  /**
   * Early access: the commercial billing surface is dormant, so it must not be
   * reachable — or advertised in the help list — as a voice navigation target.
   */
  earlyAccess?: boolean;
}

const SLASH_COMMANDS: Record<string, { pattern: RegExp; description: string }> = {
  '/idea': { pattern: /^(?:add|create|capture)\s+(?:an?\s+)?idea\s+(.+)$/i, description: 'Capture an idea to memory' },
  '/new': { pattern: /^(?:start|create|new)\s+(?:a\s+)?(?:chat|conversation)$/i, description: 'Start new conversation' },
  '/cowork': { pattern: /^(?:switch\s+to\s+)?(?:cowork|co-work)$/i, description: 'Switch to Cowork mode' },
  '/agent': { pattern: /^(?:switch\s+to\s+)?agent$/i, description: 'Switch to Agent mode' },
  '/chat': { pattern: /^(?:switch\s+to\s+)?chat$/i, description: 'Switch to Chat mode' },
};

const NAVIGATION_COMMANDS: Record<string, { pattern: RegExp; target: string; description: string }> = {
  'home': { pattern: /^(?:go\s+to\s+)?(?:home|dashboard)$/i, target: '/home', description: 'Go to Home' },
  'chat': { pattern: /^(?:go\s+to\s+)?chat$/i, target: '/chat', description: 'Go to Chat' },
  'projects': { pattern: /^(?:go\s+to\s+)?projects?$/i, target: '/projects', description: 'Go to Projects' },
  'agents': { pattern: /^(?:go\s+to\s+)?agents?$/i, target: '/agents', description: 'Go to Agents' },
  'memory': { pattern: /^(?:go\s+to\s+)?memory$/i, target: '/memory', description: 'Go to Memory' },
  'dna': { pattern: /^(?:go\s+to\s+)?dna$/i, target: '/dna', description: 'Go to DNA' },
  'tasks': { pattern: /^(?:go\s+to\s+)?(?:tasks?|work)$/i, target: '/work', description: 'Go to Tasks' },
  'settings': { pattern: /^(?:go\s+to\s+)?settings?$/i, target: '/settings', description: 'Go to Settings' },
  'billing': { pattern: /^(?:go\s+to\s+)?billing$/i, target: '/settings?tab=billing', description: 'Go to Billing' },
};

const ACTION_COMMANDS: Record<string, { pattern: RegExp; description: string; handler: 'send' | 'stop' | 'regenerate' | 'clear' | 'continue' }> = {
  'send': { pattern: /^(?:send|submit|execute)$/i, description: 'Send message', handler: 'send' },
  'stop': { pattern: /^(?:stop|cancel|abort)$/i, description: 'Stop generation', handler: 'stop' },
  'regenerate': { pattern: /^(?:regenerate|retry|redo|again)$/i, description: 'Regenerate response', handler: 'regenerate' },
  'clear': { pattern: /^(?:clear|reset)\s*(?:input|composer|draft)?$/i, description: 'Clear composer', handler: 'clear' },
  'continue': { pattern: /^(?:continue|proceed|next)$/i, description: 'Continue', handler: 'continue' },
};

const QUERY_COMMANDS: Record<string, { pattern: RegExp; description: string }> = {
  'memory': { pattern: /^(?:show|search|find)\s+(?:my\s+)?(?:memories?|memory)\s*(.*)$/i, description: 'Search memories' },
  'history': { pattern: /^(?:show|open)\s+history$/i, description: 'Open history' },
  'usage': { pattern: /^(?:show|what'?s)\s+(?:my\s+)?usage$/i, description: 'Show usage' },
  'status': { pattern: /^(?:what'?s\s+)?(?:my\s+)?(?:status|plan)$/i, description: 'Show plan status' },
};

export function parseVoiceCommand(transcript: string, opts: ParseOptions = {}): VoiceCommand | null {
  const normalized = transcript.trim().toLowerCase();
  if (!normalized) return null;

  // Check slash commands first (most specific)
  for (const [cmd, { pattern, description }] of Object.entries(SLASH_COMMANDS)) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        type: 'slash',
        command: cmd,
        args: match.slice(1).filter(Boolean),
        raw: transcript,
        confidence: 0.95,
      };
    }
  }

  // Check navigation commands
  for (const [target, { pattern, description }] of Object.entries(NAVIGATION_COMMANDS)) {
    if (opts.earlyAccess && target === 'billing') continue;
    if (pattern.test(normalized)) {
      return {
        type: 'navigation',
        command: target,
        raw: transcript,
        confidence: 0.9,
      };
    }
  }

  // Check action commands
  for (const [action, { pattern, description, handler }] of Object.entries(ACTION_COMMANDS)) {
    if (pattern.test(normalized)) {
      return {
        type: 'action',
        command: handler,
        raw: transcript,
        confidence: 0.9,
      };
    }
  }

  // Check query commands
  for (const [query, { pattern, description }] of Object.entries(QUERY_COMMANDS)) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        type: 'query',
        command: query,
        args: match.slice(1).filter(Boolean),
        raw: transcript,
        confidence: 0.85,
      };
    }
  }

  // Fallback: treat as general input
  return {
    type: 'action',
    command: 'send',
    raw: transcript,
    confidence: 0.5,
  };
}

export function getVoiceCommandHelp(opts: ParseOptions = {}): string[] {
  const navigation = Object.entries(NAVIGATION_COMMANDS).filter(([target]) => !(opts.earlyAccess && target === 'billing'));
  const lines: string[] = [
    'Voice Commands:',
    '',
    'Navigation:',
    ...navigation.map(([, { description }]) => `  "${description}"`),
    '',
    'Actions:',
    ...Object.values(ACTION_COMMANDS).map(({ description }) => `  "${description}"`),
    '',
    'Slash Commands:',
    ...Object.values(SLASH_COMMANDS).map(({ description }) => `  "${description}"`),
    '',
    'Queries:',
    ...Object.values(QUERY_COMMANDS).map(({ description }) => `  "${description}"`),
  ];
  return lines;
}