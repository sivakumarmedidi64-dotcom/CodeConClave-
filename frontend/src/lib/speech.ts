/**
 * CodeConClave — honest browser Web Speech capability support.
 *
 * This is browser capability support ONLY. It is NOT a claim of provider-backed
 * (server/on-device) STT/TTS. Detects what the browser actually exposes and
 * reports SUPPORTED / UNSUPPORTED / PERMISSION_DENIED / ERROR truthfully.
 *
 * It is used only as an INPUT facade: a final transcript is inserted into the
 * existing chat composer (PKG-03 chat), never a bypass of command/capability/
 * stop-rule gating (that gating lives in the backend VoiceService).
 */

export type SpeechCapabilityStatus =
  | 'SUPPORTED'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'ERROR';

export interface SpeechCapabilities {
  recognition: SpeechCapabilityStatus;
  synthesis: SpeechCapabilityStatus;
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: { length: number; [i: number]: { 0: { transcript: string } } } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

let cached: SpeechCapabilities | null = null;

/** Detect what the current browser supports (honest, caches per load). */
export function detectSpeechCapabilities(env: unknown = typeof window !== 'undefined' ? window : null): SpeechCapabilities {
  if (cached) return cached;
  const w = env as Window | null;
  const hasRec =
    !!w &&
    (typeof w.SpeechRecognition === 'function' || typeof w.webkitSpeechRecognition === 'function');
  const hasSynth = !!w && typeof w.speechSynthesis === 'object' && typeof w.speechSynthesis.speak === 'function';
  cached = {
    recognition: hasRec ? 'SUPPORTED' : 'UNSUPPORTED',
    synthesis: hasSynth ? 'SUPPORTED' : 'UNSUPPORTED',
  };
  return cached;
}

export interface RecognitionController {
  stop(): void;
}

/**
 * Start one-shot browser recognition. Returns transcripts via `onResult`.
 * Falls back to an honest UNSUPPORTED / PERMISSION_DENIED / ERROR result.
 */
export function startRecognition(opts: {
  lang?: string;
  continuous?: boolean;
  onResult: (transcript: string) => void;
  onState: (s: SpeechCapabilityStatus) => void;
}): RecognitionController | null {
  const w = typeof window !== 'undefined' ? window : null;
  const Ctor = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  if (!Ctor) {
    opts.onState('UNSUPPORTED');
    return null;
  }
  try {
    const rec = new Ctor();
    rec.lang = opts.lang ?? 'en-US';
    rec.continuous = opts.continuous ?? false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const n = e.results.length;
      const t = n > 0 ? e.results[n - 1]?.[0]?.transcript : '';
      if (t) opts.onResult(t);
    };
    rec.onerror = (e) => {
      opts.onState(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'PERMISSION_DENIED' : 'ERROR');
    };
    rec.onend = () => opts.onState('SUPPORTED');
    rec.start();
    return { stop: () => rec.stop() };
  } catch {
    opts.onState('ERROR');
    return null;
  }
}

/** Speak a short string via the browser's speechSynthesis (honest; no-op if unsupported). */
export function speak(text: string, rate = 1): void {
  const w = typeof window !== 'undefined' ? window : null;
  if (!w?.speechSynthesis || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  w.speechSynthesis.speak(u);
}

export function cancelSpeech(): void {
  const w = typeof window !== 'undefined' ? window : null;
  w?.speechSynthesis?.cancel();
}

/** Test stub support (for deterministic unit tests). */
export function __resetSpeechCache(): void {
  cached = null;
}
