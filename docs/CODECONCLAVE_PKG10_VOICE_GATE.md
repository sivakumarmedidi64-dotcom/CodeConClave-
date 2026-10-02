# CodeConClave — PKG-10 Voice Gate (`Group F`, 12 capabilities)

Canonical basis: `CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Groups A–L, ≈342).
Group F = Voice (12). This gate covers the PKG-10 voice implementation. It is
additive — no feature was removed, renamed, or merged (`FEATURES_REMOVED = 0`),
and no capability is PASS merely because an interface exists.

---

## 1. Scope (Group F — Voice, 12)

| Capability | Classification | Evidence |
|---|---|---|
| Voice Input | IMPLEMENTABLE_NOW | Frontend `lib/speech.ts` honest browser Web Speech input facade → fills existing PKG-03 chat composer (never auto-executes) |
| Real-Time Transcription | DEFERRED | No live provider/device speech engine; interim transcription is not claimed as real-time provider framing |
| Voice Output | ENVIRONMENT_BLOCKED / NOT_IMPLEMENTED | No provider/on-device TTS engine; browser `speechSynthesis` used only as honest client-side output, not a provider claim |
| Wake Word | NOT_IMPLEMENTED | No real wake-word detector |
| Voice Commands | IMPLEMENTABLE_NOW | 12-command allowlist dispatched through the EXISTING CommandPalette + capability + stop-rule gate (`os/p2/voice-service.ts`) |
| Accent Support | NOT_IMPLEMENTED | No verified speech-recognition accent behavior |
| Offline Voice | NOT_IMPLEMENTED | No real local engine |
| Voice History | IMPLEMENTABLE_NOW | Scoped, stacked `StateStore` persistence (`voice:hist:{workspaceId}:{userId}`) |
| Voice Tone Control | IMPLEMENTABLE_NOW | `tone` threaded into the EXISTING PKG-03 system prompt (`toneInstructions` in `conversations/chat.ts`); preferences persisted |
| Hands-Free | DEFERRED | Continuous recognition only on platforms that genuinely support it |
| Voice Feedback | IMPLEMENTABLE_NOW | Truthful state surface (LISTENING/TRANSCRIBING/EXECUTING/COMPLETED/DENIED/ERROR/UNSUPPORTED/...) |
| Multilingual Voice | NOT_IMPLEMENTED | No real language support |

---

## 2. Delivered implementation

### Backend (`backend/src/os/p2/`)
- `voice-service.ts` — canonical `VoiceService`: transcript → `VoiceIntent` →
  command → capability → stop-rule → `ResourceGovernor` → allowlisted execute.
  Fail-closed: returns `DENIED`/`UNSUPPORTED`, never arbitrary execution.
  Persists preferences (`voice:{scope}:prefs`) and history via the existing
  `StateStore`. Reuses the existing `VoiceGateway` (`voice.ts`, P2.19-21) and the
  existing CommandPalette infrastructure (NO second command system).
- `index.ts` barrel exports `VoiceService` + types/consts. Added
  `VOICE_CONTROL: 'voice.control'` to `CapabilityKind` in `os/types.ts`.
- `voice-service.test.ts` — 17/17 PASS (security-focused, fail-closed).

### Frontend (`frontend/src/`)
- `lib/speech.ts` — honest browser Web Speech capability layer (SUPPORTED /
  UNSUPPORTED / PERMISSION_DENIED / ERROR). It is only an INPUT facade.
- `hooks/useVoice.ts` — `useVoice` hook wiring the facade to the composer.
- `components/VoiceControl.tsx` — truthful mic + state control in the ChatPage
  quickbar; re-uses `setInput` to fill the composer (no auto-send, no bypass).

### Desktop (`desktop/src/`)
- `voice.control` `CapabilityId`; capability-gated `cc:voice:support` channel in
  the frozen IPC allow-list; preload contract + api method. The desktop host
  reports honest browser Web Speech presence and NEVER exposes raw mic audio,
  node, fs, child_process, env, or secrets to the renderer.

### PKG-03 chat tone connection
- `shared/src/contracts.ts`: added optional `tone` (`NEUTRAL|CONCISE|DETAILED|FRIENDLY`,
  default `NEUTRAL`) to `chatMessageSchema`.
- `modules/conversations/chat.ts`: `toneInstructions()` appends a small system-prompt
  suffix to the EXISTING chat path — NOT a separate personality engine.

---

## 3. Security model (B1-aligned)

- Voice never bypasses: capability security, Stop Rules, `ResourceGovernor`,
  command/capability/stop-rule gating, or the existing CommandPalette.
- No payment authority, deploy, real payment, distributed execution, or
  isolation actions are reachable by voice (tests assert this).
- No arbitrary shell execution from a transcript (tests assert `rm -rf /`,
  `curl`, `sudo` are denied).
- Commit still requires explicit non-voice authorization (`git.commit` is not an
  auto-run voice command).
- No raw audio is persisted or exposed; only transcripts/history.

---

## 4. Test evidence

- Backend `os/p2/voice-service.test.ts`: 17/17 PASS.
- Backend `foundation/conversations.test.ts`: 16 PASS; `chat-attachments.test.ts`: 4 PASS.
- Frontend `lib/speech.test.ts`: 10 PASS; `components/VoiceControl.test.tsx`: 4 PASS.
- Backend + frontend + desktop `tsc --noEmit` all clean (EXIT 0).
- No existing tests weakened; features removed = 0.
