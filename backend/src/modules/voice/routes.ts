/**
 * CodeConClave — voice routes (ElevenLabs TTS proxy).
 * POST /api/v1/voice/speak { text, voiceId? } → audio/mpeg bytes.
 * Auth required (paid gate at mount). Key never leaves the server.
 */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { speakText, voiceConfigured } from './service.js';

export const voiceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get('/status', ( _req, res) => {
    res.json({ data: { configured: voiceConfigured() } });
  });

  router.post(
    '/speak',
    asyncRoute(async (req, res) => {
      const { text, voiceId } = (req.body ?? {}) as { text?: string; voiceId?: string };
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw AppError.badRequest('voice_text_required', 'text is required (max 2000 chars)');
      }
      if (!voiceConfigured()) throw AppError.badRequest('voice_not_configured', 'Voice is not configured on the server');
      try {
        const { audio, mime } = await speakText(text, voiceId);
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(audio.length));
        res.send(Buffer.from(audio));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'voice_failed';
        if (msg === 'voice_not_configured') throw AppError.badRequest('voice_not_configured', 'Voice is not configured on the server');
        throw AppError.badRequest('voice_failed', `Voice synthesis failed (${msg})`);
      }
    }),
  );

  return router;
};
