/**
 * CodeConClave — ElevenLabs voice service (TTS proxy).
 * Key stays server-side (ELEVENLABS_API_KEY env). Browser never sees it.
 * Fail-closed: no key → honest 503, never silent text; upstream error →
 * message with status, never fake audio.
 */

const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export function voiceConfigured(): boolean {
  const v = (process.env.ELEVENLABS_API_KEY ?? '').trim();
  return v.length >= 8;
}

export async function speakText(text: string, voiceId?: string): Promise<{ audio: Uint8Array; mime: string }> {
  const key = (process.env.ELEVENLABS_API_KEY ?? '').trim();
  if (!key) throw new Error('voice_not_configured');
  const clean = text.trim().slice(0, 2000);
  if (!clean) throw new Error('voice_empty_text');
  const voice = (voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM').trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${TTS_URL}/${encodeURIComponent(voice)}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: clean, model_id: 'eleven_turbo_v2_5' }),
    });
    if (!res.ok) throw new Error(`voice_upstream_${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('voice_empty_audio');
    return { audio: buf, mime: 'audio/mpeg' };
  } finally {
    clearTimeout(timer);
  }
}
