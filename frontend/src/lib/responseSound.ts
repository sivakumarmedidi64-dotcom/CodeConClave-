/**
 * CodeConClave — RESPONSE_READY notification sound (§6).
 *
 * Plays the CodeConClave brand cue (public/sounds/notify.mp3, a 3-second cut
 * of the upbeat guitar cue) through Web Audio with a short fade-out. If the
 * clip cannot be fetched or decoded, the synthesized call below is used, so
 * a missing asset never silences the notification.
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
let produce: ProduceSound = brandCue;
let autoplayQueued = false;

export const BRAND_CUE_URL = '/sounds/notify.mp3';
const CUE_VOLUME = 0.7;
const CUE_FADE_START = 4.0;
const CUE_END = 4.8;
let cueBuffer: AudioBuffer | null = null;
let cueLoad: Promise<AudioBuffer | null> | null = null;

function loadCue(ac: AudioContext): Promise<AudioBuffer | null> {
  if (cueBuffer) return Promise.resolve(cueBuffer);
  if (!cueLoad) {
    cueLoad = fetch(BRAND_CUE_URL)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`cue ${r.status}`))))
      .then((data) => ac.decodeAudioData(data))
      .then((decoded) => (cueBuffer = decoded))
      .catch(() => null);
  }
  return cueLoad;
}

function playBuffer(ac: AudioContext, buffer: AudioBuffer, now: number): void {
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  src.buffer = buffer;
  gain.gain.setValueAtTime(CUE_VOLUME, now);
  gain.gain.setValueAtTime(CUE_VOLUME, now + CUE_FADE_START);
  gain.gain.linearRampToValueAtTime(0.0001, now + CUE_END);
  src.connect(gain);
  gain.connect(ac.destination);
  src.start(now);
  src.stop(now + CUE_END);
}

/** Brand cue: decoded once, then replayed from memory. */
function brandCue(ac: AudioContext, now: number): void {
  if (cueBuffer) {
    playBuffer(ac, cueBuffer, now);
    return;
  }
  void loadCue(ac).then((buffer) => {
    if (buffer) playBuffer(ac, buffer, ac.currentTime);
    else defaultEagleCall(ac, ac.currentTime);
  });
}

/** Fallback: the synthesized eagle call (§6) — sawtooth glide, ~1.2s. */
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

/** Load the server-held preference; falls back to local/default (OFF, like Claude). */
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
  return readStored() ?? false;
}

// Repeat-until-seen: if the answer lands while you are looking away, keep
// chiming the cue until you come back to the tab (then stop at once).
const REPEAT_MS = 25000;
let repeatTimer: number | null = null;
let seenHandlersBound = false;

function userIsLooking(): boolean {
  try {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return true;
  }
}

function stopRepeat(): void {
  if (repeatTimer !== null) {
    window.clearInterval(repeatTimer);
    repeatTimer = null;
  }
}

function bindSeenHandlersOnce(): void {
  if (seenHandlersBound || typeof window === 'undefined') return;
  seenHandlersBound = true;
  const onSeen = () => {
    if (userIsLooking()) stopRepeat();
  };
  document.addEventListener('visibilitychange', onSeen);
  window.addEventListener('focus', onSeen);
}

/** After a RESPONSE_READY chime, keep replaying it until the user returns. */
function startRepeatUntilSeen(): void {
  stopRepeat();
  if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
  if (userIsLooking()) return; // already here — one chime is enough
  bindSeenHandlersOnce();
  repeatTimer = window.setInterval(() => {
    if (userIsLooking() || readStored() !== true) {
      stopRepeat();
      return;
    }
    playNow();
  }, REPEAT_MS);
}

/** Arm the single RESPONSE_READY shot. Only a fresh user request arms it. */
export function armResponseSound(): void {
  armed = true;
  stopRepeat(); // a new request clears any lingering "come back" chime
}

/**
 * RESPONSE_READY — play the sound exactly once. No-op when the preference is
 * OFF, when nothing was armed (rerender/reconnect/resume/sync paths), or when
 * the browser cannot produce audio.
 */
export function playResponseReadySound(): void {
  if (!armed) return;
  armed = false;
  // Quiet by default (like Claude): play only when the user turned the sound ON.
  if (readStored() !== true) return;
  const ac = getContext();
  if (!ac) return;
  if (ac.state === 'running') {
    playNow();
    startRepeatUntilSeen(); // keep chiming if the user is looking away
    return;
  }
  // Autoplay restricted: play at the first valid user interaction.
  queueForFirstInteraction();
}

/** Settings "Play sample": a direct user click, so autoplay rules allow it. */
export function previewResponseSound(): void {
  const ac = getContext();
  if (!ac) return;
  void ac
    .resume()
    .catch(() => undefined)
    .then(() => playNow());
}

/** Test seam: swap the real Web Audio producer for a counted stub. */
export function __setSoundProducerForTests(p: ProduceSound | null): void {
  produce = p ?? brandCue;
}