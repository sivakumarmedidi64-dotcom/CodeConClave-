/**
 * CodeConClave — honest browser Web Speech capability tests.
 * These verify the INPUT facade only (what the browser actually exposes). They
 * never claim provider-backed STT/TTS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectSpeechCapabilities,
  startRecognition,
  speak,
  cancelSpeech,
  __resetSpeechCache,
  type SpeechCapabilityStatus,
} from './speech';

beforeEach(() => {
  __resetSpeechCache();
  vi.unstubAllGlobals();
});

describe('detectSpeechCapabilities', () => {
  it('reports both UNSUPPORTED when there is no browser speech surface', () => {
    const caps = detectSpeechCapabilities({});
    expect(caps.recognition).toBe('UNSUPPORTED');
    expect(caps.synthesis).toBe('UNSUPPORTED');
  });

  it('reports recognition SUPPORTED when SpeechRecognition exists', () => {
    const caps = detectSpeechCapabilities({ SpeechRecognition: class {} });
    expect(caps.recognition).toBe('SUPPORTED');
  });

  it('reports recognition SUPPORTED via the webkit prefixed ctor', () => {
    const caps = detectSpeechCapabilities({ webkitSpeechRecognition: class {} });
    expect(caps.recognition).toBe('SUPPORTED');
  });

  it('reports synthesis SUPPORTED when speechSynthesis.speak is a function', () => {
    const caps = detectSpeechCapabilities({ speechSynthesis: { speak: () => undefined, cancel: () => undefined } });
    expect(caps.synthesis).toBe('SUPPORTED');
  });

  it('caches the detection result for the load', () => {
    detectSpeechCapabilities({ SpeechRecognition: class {} });
    expect(detectSpeechCapabilities({}).recognition).toBe('SUPPORTED');
  });
});

describe('startRecognition', () => {
  function stubRecorder() {
    const rec: {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((e: { results: { length: number; [i: number]: { 0: { transcript: string } } } }) => void) | null;
      onerror: ((e: { error: string }) => void) | null;
      onend: (() => void) | null;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    } = {
      lang: '',
      continuous: false,
      interimResults: false,
      onresult: null,
      onerror: null,
      onend: null,
      start: vi.fn(),
      stop: vi.fn(),
    };
    vi.stubGlobal('window', { ...window, SpeechRecognition: class { constructor() { return rec; } } });
    return rec;
  }

  it('reports UNSUPPORTED and returns null when no ctor exists', () => {
    const states: SpeechCapabilityStatus[] = [];
    vi.stubGlobal('window', { ...window, SpeechRecognition: undefined, webkitSpeechRecognition: undefined });
    const ctrl = startRecognition({ onResult: () => undefined, onState: (s) => states.push(s) });
    expect(ctrl).toBeNull();
    expect(states).toContain('UNSUPPORTED');
  });

  it('delivers the final transcript via onResult and can be stopped', () => {
    const rec = stubRecorder();
    const transcripts: string[] = [];
    const ctrl = startRecognition({
      onResult: (t) => transcripts.push(t),
      onState: () => undefined,
    });
    expect(ctrl).not.toBeNull();
    expect(rec.start).toHaveBeenCalled();
    rec.onresult?.({ results: { length: 1, 0: { 0: { transcript: 'run tests' } } } });
    expect(transcripts).toEqual(['run tests']);
    ctrl?.stop();
    expect(rec.stop).toHaveBeenCalled();
  });

  it('reports PERMISSION_DENIED on a not-allowed error', () => {
    const rec = stubRecorder();
    const states: SpeechCapabilityStatus[] = [];
    startRecognition({ onResult: () => undefined, onState: (s) => states.push(s) });
    rec.onerror?.({ error: 'not-allowed' });
    expect(states).toContain('PERMISSION_DENIED');
  });
});

describe('speak / cancelSpeech', () => {
  it('is a no-op when synthesis is unsupported', () => {
    vi.stubGlobal('window', { ...window, speechSynthesis: undefined });
    expect(() => speak('hi')).not.toThrow();
  });

  it('calls speechSynthesis.speak when supported', () => {
    const speakFn = vi.fn();
    const cancelFn = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: speakFn, cancel: cancelFn });
    vi.stubGlobal('SpeechSynthesisUtterance', class { rate = 1 });
    vi.stubGlobal('window', { ...window, speechSynthesis: speakFn ? { speak: speakFn, cancel: cancelFn } : undefined });
    speak('hi');
    expect(speakFn).toHaveBeenCalled();
    cancelSpeech();
    expect(cancelFn).toHaveBeenCalled();
  });
});
