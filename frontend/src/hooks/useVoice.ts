/**
 * CodeConClave — useVoice hook.
 * Wraps the honest browser Web Speech capability layer for the UI: a mic
 * button turns browser recognition on/off; a final transcript is handed to the
 * caller (page) which inserts it into the existing chat composer (PKG-03) or
 * uses it for a voice control action. Feedback states mirror the backend
 * VoiceService so the UI never fabricates progress.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelSpeech,
  detectSpeechCapabilities,
  speak,
  startRecognition,
  type SpeechCapabilityStatus,
} from '../lib/speech';

export type VoiceContext =
  | 'IDLE'
  | 'LISTENING'
  | 'TRANSCRIBING'
  | 'COMMAND_DETECTED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'DENIED'
  | 'ERROR'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED';

export interface UseVoiceOptions {
  /** Called with the final transcript from browser recognition. */
  onTranscript: (transcript: string) => void;
  /** Optional: speak text back via browser speechSynthesis when supported. */
  output?: 'none' | 'speech' | 'text';
  lang?: string;
  /** Continuous recognition (hands-free) — only honored when supported. */
  continuous?: boolean;
  voiceEnabled?: boolean;
}

/** Map a raw Web Speech status to the app feedback context. */
function toContext(s: SpeechCapabilityStatus): VoiceContext {
  switch (s) {
    case 'UNSUPPORTED':
      return 'UNSUPPORTED';
    case 'PERMISSION_DENIED':
      return 'PERMISSION_DENIED';
    case 'ERROR':
      return 'ERROR';
    default:
      return 'COMPLETED';
  }
}

export function useVoice(opts: UseVoiceOptions) {
  const { onTranscript, output = 'text', lang = 'en-US', continuous = false, voiceEnabled = true } = opts;
  const [context, setContext] = useState<VoiceContext>('IDLE');
  const [transcript, setTranscript] = useState<string | null>(null);
  const controllerRef = useRef<{ stop(): void } | null>(null);
  const caps = voiceEnabled ? detectSpeechCapabilities() : { recognition: 'UNSUPPORTED' as const, synthesis: 'UNSUPPORTED' as const };
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const isListening = context === 'LISTENING' || context === 'TRANSCRIBING';

  const start = useCallback(() => {
    if (!voiceEnabled || controllerRef.current) return;
    setContext('LISTENING');
    cancelSpeech();
    const ctrl = startRecognition({
      lang,
      continuous,
      onResult: (t) => {
        setContext('TRANSCRIBING');
        setTranscript(t);
        onTranscriptRef.current(t);
        setContext('IDLE');
      },
      onState: (s) => {
        if (s === 'SUPPORTED') {
          // end-of-recognition (session closed cleanly)
          if (context !== 'IDLE') setContext('IDLE');
        } else {
          setContext(toContext(s));
        }
      },
    });
    controllerRef.current = ctrl;
  }, [lang, continuous, voiceEnabled, context]);

  const stop = useCallback(() => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    setContext('IDLE');
  }, []);

  /** Speak a short string back (browser synthesis; no-op when unsupported). */
  const speakText = useCallback(
    (text: string) => {
      if (output === 'speech') speak(text);
    },
    [output],
  );

  useEffect(() => {
    return () => {
      controllerRef.current?.stop();
      controllerRef.current = null;
    };
  }, []);

  return { context, transcript, isListening, start, stop, speakText, capabilities: caps };
}
