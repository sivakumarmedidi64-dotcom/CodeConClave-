/**
 * CodeConClave — RESPONSE_READY notification sound (§6).
 *
 * Generated in real time with the Web Audio API (never a static file).
 * Safety rules enforced here:
 *  - plays ONLY on RESPONSE_READY (a meaningful user-facing result became
 *    ready) — never on tokens, chunks, page load, task start, or tool calls;
 *  - exactly once per response via an explicit "armed" single-shot state;
 *  - duplicating surfaces (rerender / reconnect / resume / mobile-web / sync)
 *    never replay it because only a fresh user request re-arms the sound;
 *  - browser autoplay restrictions are respected: if the AudioContext cannot
 *    start, the sound is queued and played at the first user interaction;
 *  - accessible preference: preferred `response_ready_sound` (default ON).
 */
export const RESPONSE_READY_SOUND_PREF_KEY = 'response_ready_sound';

type ProduceSound = (audioCtx: AudioContext, now: number) => void;

let soundEnabled: boolean | null = null;
let armed = false;
let audioCtx: AudioContext | null = null;
let produce: ProduceSound = defaultEagleCall;
let autoplayQueued = false;

/** The provided eagle call (§6) — sawtooth glide, ~1.2s, real-time only. */
function defaultEagleCall(ac: AudioContext, now: number): void {
  const osc = ac.createOscillator();
  const gainNode = ac.createGain();

  osc.type = 'sawtooth';

  osc.frequency.setValueAtTime(3800, now);
  osc.frequency.exponentialRampToValueAtTime(2200, now + 0.3);
  osc.frequency.exponentialRampToValueAtTime(3300, now + 0.6);
  osc.frequency.exponentialRampToValueAtTime(2000, now + 1.0);

  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(0.25, now + 0.04);
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

  osc.connect(gainNode);
  gainNode.connect(ac.destination);

  osc.start(now);
  osc.stop(now + 1.2);
}

function readStored(): boolean | null {
  if (soundEnabled !== null) return soundEnabled;
  try {
    const v = window.localStorage.getItem(RESPONSE_READY_SOUND_PREF_KEY);
    if (v === 'false') return false;
    if (v === 'true') return true;
  } catch {
    /* ignored */
  }
  return null;
}

function store(value: boolean): void {
  soundEnabled = value;
  try {
    window.localStorage.setItem(RESPONSE_READY_SOUND_PREF_KEY, String(value));
  } catch {
    /* ignored */
  }
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}

function playNow(): void {
  const ac = getContext();
  if (!ac) return;
  produce(ac, ac.currentTime);
}

function queueForFirstInteraction(): void {
  if (autoplayQueued) return;
  autoplayQueued = true;
  const resume = () => {
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
    autoplayQueued = false;
    const ac = getContext();
    if (!ac) return;
    void ac
      .resume()
      .catch(() => undefined)
      .then(() => {
        if (ac.state === 'running') playNow();
      });
  };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
}

/**
 * Set the accessible preference (default ON). Persisted to the server via
 * workspace preferences and mirrored locally.
 */
export function setResponseSoundEnabled(value: boolean): void {
  store(value);
}

/** Load the server-held preference; falls back to local/default (ON). */
export async function loadResponseSoundEnabled(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/workspace/preferences', { credentials: 'same-origin' });
    if (res.ok) {
      const body = (await res.json()) as { data?: { prefs?: Record<string, unknown> } };
      const v = body?.data?.prefs?.[RESPONSE_READY_SOUND_PREF_KEY];
      if (typeof v === 'boolean') {
        store(v);
        return v;
      }
    }
  } catch {
    /* offline-safe */
  }
  return readStored() ?? true;
}

/** Arm the single RESPONSE_READY shot. Only a fresh user request arms it. */
export function armResponseSound(): void {
  armed = true;
}

/**
 * RESPONSE_READY — play the sound exactly once. No-op when the preference is
 * OFF, when nothing was armed (rerender/reconnect/resume/sync paths), or when
 * the browser cannot produce audio.
 */
export function playResponseReadySound(): void {
  if (!armed) return;
  armed = false;
  if (readStored() === false) return;
  const ac = getContext();
  if (!ac) return;
  if (ac.state === 'running') {
    playNow();
    return;
  }
  // Autoplay restricted: play at the first valid user interaction.
  queueForFirstInteraction();
}

/** Test seam: swap the real Web Audio producer for a counted stub. */
export function __setSoundProducerForTests(p: ProduceSound | null): void {
  produce = p ?? defaultEagleCall;
}