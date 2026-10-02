/**
 * CodeConClave — VoiceControl UI strip.
 * A minimal, honest mic + feedback-state control that does NOT redesign the
 * app. Renders SUPPORTED states truthfully; reports UNSUPPORTED / PERMISSION
 * DENIED when that is reality. Never claims provider-backed voice.
 */
import type { VoiceContext } from '../hooks/useVoice';

function stateMeta(s: VoiceContext): { label: string; cls: string } {
  switch (s) {
    case 'LISTENING':
      return { label: 'Listening…', cls: 'cc-voice-on' };
    case 'TRANSCRIBING':
      return { label: 'Transcribing…', cls: 'cc-voice-on' };
    case 'COMMAND_DETECTED':
      return { label: 'Command detected', cls: 'cc-voice-on' };
    case 'EXECUTING':
      return { label: 'Executing…', cls: 'cc-voice-on' };
    case 'COMPLETED':
      return { label: 'Done', cls: 'cc-voice-ok' };
    case 'DENIED':
      return { label: 'Denied', cls: 'cc-voice-err' };
    case 'ERROR':
      return { label: 'Speech error', cls: 'cc-voice-err' };
    case 'UNSUPPORTED':
      return { label: 'Speech not supported here', cls: 'cc-voice-err' };
    case 'PERMISSION_DENIED':
      return { label: 'Microphone permission denied', cls: 'cc-voice-err' };
    default:
      return { label: '', cls: '' };
  }
}

export function VoiceControl(props: {
  context: VoiceContext;
  isListening: boolean;
  start: () => void;
  stop: () => void;
  transcript: string | null;
}) {
  const { context, isListening, start, stop, transcript } = props;
  const meta = stateMeta(context);
  return (
    <div className="cc-voicebar" data-testid="voicebar">
      <button
        type="button"
        className="cc-btn"
        disabled={context === 'UNSUPPORTED' || context === 'PERMISSION_DENIED'}
        aria-pressed={isListening}
        onClick={isListening ? stop : start}
        data-testid="voice-toggle"
      >
        {isListening ? '\u25a0 Stop voice' : '\u25b3 Voice'}
      </button>
      {context !== 'IDLE' && <span className={`cc-voice-state ${meta.cls}`} data-testid="voice-state">{meta.label}</span>}
      {transcript && <span className="cc-voice-transcript" data-testid="voice-transcript">{transcript}</span>}
    </div>
  );
}

/** Re-export the state type to keep import sites small. */
export type { VoiceContext } from '../hooks/useVoice';
export { useVoice } from '../hooks/useVoice';
export type { UseVoiceOptions } from '../hooks/useVoice';
