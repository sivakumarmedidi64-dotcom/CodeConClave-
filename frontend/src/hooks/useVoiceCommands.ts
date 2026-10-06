/**
 * CodeConClave — useVoiceCommands hook.
 * Wraps useVoice to parse transcripts into executable commands.
 * Returns handlers for executing parsed commands.
 */

import { useCallback, useRef } from 'react';
import { useVoice, type VoiceContext } from '../components/VoiceControl';
import { parseVoiceCommand, type VoiceCommand, type VoiceCommandResult } from '../lib/voiceCommands';
import { useEarlyAccess } from '../lib/accessMode';
import { useToast } from '../components/Toast';

export interface UseVoiceCommandsOptions {
  /** Current chat mode */
  mode?: 'CHAT' | 'COWORK' | 'AGENT';
  /** Current project ID */
  projectId?: string | null;
  /** Callback to send a message */
  onSend?: (content: string) => void;
  /** Callback to stop generation */
  onStop?: () => void;
  /** Callback to regenerate last response */
  onRegenerate?: () => void;
  /** Callback to clear composer */
  onClear?: () => void;
  /** Callback to continue conversation */
  onContinue?: () => void;
  /** Callback to navigate */
  onNavigate?: (path: string) => void;
  /** Callback to run slash command */
  onRunSlash?: (command: string, args?: string[]) => Promise<boolean>;
  /** Callback to search memories */
  onSearchMemory?: (query: string) => void;
  /** Callback to change mode */
  onChangeMode?: (mode: 'CHAT' | 'COWORK' | 'AGENT') => void;
  /** Enable voice output (TTS) */
  voiceOutput?: boolean;
  /** Voice language */
  lang?: string;
  /** Continuous recognition */
  continuous?: boolean;
}

export function useVoiceCommands(opts: UseVoiceCommandsOptions) {
  const {
    mode,
    projectId,
    onSend,
    onStop,
    onRegenerate,
    onClear,
    onContinue,
    onNavigate,
    onRunSlash,
    onSearchMemory,
    onChangeMode,
    voiceOutput = false,
    lang = 'en-US',
    continuous = true,
  } = opts;

  const { toast } = useToast();
  // Early access: the dormant billing target is not offered as a voice command.
  const earlyAccess = useEarlyAccess();
  const lastCommandRef = useRef<{ cmd: string; time: number } | null>(null);

  const executeCommand = useCallback(
    async (cmd: ReturnType<typeof parseVoiceCommand>): Promise<VoiceCommandResult> => {
      if (!cmd) return { executed: false, error: 'No command parsed' };

      // Debounce duplicate commands within 2 seconds
      const now = Date.now();
      if (lastCommandRef.current && lastCommandRef.current.cmd === cmd.command && now - lastCommandRef.current.time < 2000) {
        return { executed: false, error: 'Duplicate command ignored' };
      }
      lastCommandRef.current = { cmd: cmd.command, time: now };

      try {
        switch (cmd.type) {
          case 'slash': {
            if (!onRunSlash) return { executed: false, error: 'Slash handler not available' };
            const fullCmd = `${cmd.command}${cmd.args?.length ? ` ${cmd.args.join(' ')}` : ''}`;
            const consumed = await onRunSlash(fullCmd);
            if (consumed) {
              return { executed: true, command: cmd, response: `Executed: ${fullCmd}` };
            }
            return { executed: false, error: `Slash command "${cmd.command}" not recognized` };
          }

          case 'navigation': {
            if (!onNavigate) return { executed: false, error: 'Navigation handler not available' };
            onNavigate(cmd.command);
            return { executed: true, command: cmd, response: `Navigated to ${cmd.command}` };
          }

          case 'action': {
            switch (cmd.command) {
              case 'send':
                if (onSend) {
                  onSend(cmd.raw);
                  return { executed: true, command: cmd, response: 'Sending message' };
                }
                return { executed: false, error: 'Send handler not available' };
              case 'stop':
                if (onStop) {
                  onStop();
                  return { executed: true, command: cmd, response: 'Stopped generation' };
                }
                return { executed: false, error: 'Stop handler not available' };
              case 'regenerate':
                if (onRegenerate) {
                  onRegenerate();
                  return { executed: true, command: cmd, response: 'Regenerating' };
                }
                return { executed: false, error: 'Regenerate handler not available' };
              case 'clear':
                if (onClear) {
                  onClear();
                  return { executed: true, command: cmd, response: 'Cleared composer' };
                }
                return { executed: false, error: 'Clear handler not available' };
              case 'continue':
                if (onContinue) {
                  onContinue();
                  return { executed: true, command: cmd, response: 'Continuing' };
                }
                return { executed: false, error: 'Continue handler not available' };
              default:
                return { executed: false, error: `Unknown action: ${cmd.command}` };
            }
          }

          case 'query': {
            switch (cmd.command) {
              case 'memory':
                if (onSearchMemory) {
                  const query = cmd.args?.join(' ') ?? '';
                  onSearchMemory(query);
                  return { executed: true, command: cmd, response: query ? `Searching memories: ${query}` : 'Opening memories' };
                }
                return { executed: false, error: 'Memory search not available' };
              case 'history':
                if (onNavigate) {
                  onNavigate('/history');
                  return { executed: true, command: cmd, response: 'Opening history' };
                }
                return { executed: false, error: 'History not available' };
              case 'usage':
              case 'status':
                if (onNavigate) {
                  onNavigate('/settings');
                  return { executed: true, command: cmd, response: 'Opening settings' };
                }
                return { executed: false, error: 'Settings not available' };
              default:
                return { executed: false, error: `Unknown query: ${cmd.command}` };
            }
          }

          default:
            return { executed: false, error: `Unknown command type: ${cmd.type}` };
        }
      } catch (err) {
        return { executed: false, error: err instanceof Error ? err.message : 'Command execution failed' };
      }
    },
    [onSend, onStop, onRegenerate, onClear, onContinue, onNavigate, onRunSlash, onSearchMemory, onChangeMode]
  );

  const voice = useVoice({
    onTranscript: async (transcript: string) => {
      const cmd = parseVoiceCommand(transcript, { earlyAccess });
      if (!cmd) return;

      const result = await executeCommand(cmd);

      if (result.executed) {
        if (voiceOutput && result.response) {
          // Speak confirmation (optional)
          const w = typeof window !== 'undefined' ? window : null;
          if (w?.speechSynthesis && result.response) {
            const u = new SpeechSynthesisUtterance(result.response);
            u.rate = 1.2;
            w.speechSynthesis.speak(u);
          }
        }
        toast(result.response ?? 'Command executed', 'info');
      } else if (cmd.confidence > 0.7) {
        // Only toast errors for high-confidence misrecognitions
        toast(result.error ?? 'Command not recognized', 'error');
      }
    },
    output: voiceOutput ? 'speech' : 'text',
    lang,
    continuous,
    voiceEnabled: true,
  });

  return {
    ...voice,
    executeCommand,
    parseVoiceCommand,
  };
}