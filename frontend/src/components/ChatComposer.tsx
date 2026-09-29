/**
 * CodeConClave — Compact Chat Composer.
 * Small, elegant, only real working controls.
 * Feels like an intelligent command terminal.
 */
import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';
import { VoiceControl, useVoice } from './VoiceControl';

interface AttachItem {
  id: string;
  file: File;
  fileId?: string;
  name: string;
  sizeBytes: number;
  type: string;
  state: 'uploading' | 'ready' | 'failed';
  progress: number;
  thumb?: string;
}

interface ChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onAttachClick: () => void;
  onModelFocus: () => void;
  onImageModeToggle: () => void;
  onAutomationNavigate: () => void;
  onRegenerate: () => void;
  attachItems: AttachItem[];
  onRemoveAttach: (id: string) => void;
  streaming: boolean;
  imageMode: boolean;
  mode: 'CHAT' | 'COWORK';
  modelId?: string;
  onModelChange: (model?: string) => void;
  hasUserMessage: boolean;
  disabled?: boolean;
  placeholder?: string;
  showSlash?: boolean;
  onSlashCommand?: (cmd: string) => void;
}

const SLASH_COMMANDS = [
  { id: '/idea', label: '/idea <text>', hint: 'Capture as idea (saved to Memory)' },
  { id: '/new', label: '/new', hint: 'Start a new conversation' },
  { id: '/cowork', label: '/cowork', hint: 'Switch to Cowork mode' },
  { id: '/chat', label: '/chat', hint: 'Switch to Chat mode' },
];

export function ChatComposer({
  input,
  onInputChange,
  onSend,
  onStop,
  onAttachClick,
  onModelFocus,
  onImageModeToggle,
  onAutomationNavigate,
  onRegenerate,
  attachItems,
  onRemoveAttach,
  streaming,
  imageMode,
  mode,
  modelId,
  onModelChange,
  hasUserMessage,
  disabled = false,
  placeholder,
  showSlash = false,
  onSlashCommand,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);

  const voice = useVoice({
    onTranscript: (t) => onInputChange(`${input} ${t}`.trim()),
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (showSlashMenu) {
        setShowSlashMenu(false);
        return;
      }
      if (streaming) {
        onStop();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim().startsWith('/')) {
        const consumed = onSlashCommand?.(input);
        if (consumed) return;
      }
      onSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onInputChange(e.target.value);
    setShowSlashMenu(e.target.value.trim().startsWith('/') && !streaming);
  };

  return (
    <div className="cc-composer" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <VoiceControl
        context={voice.context}
        isListening={voice.isListening}
        start={voice.start}
        stop={voice.stop}
        transcript={voice.transcript}
      />

      {attachItems.length > 0 && (
        <div className="cc-attach-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {attachItems.map((a) => (
            <div key={a.id} className="cc-pill cc-attach-chip" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {a.thumb && <img src={a.thumb} alt="" className="cc-attach-thumb" style={{ width: 20, height: 20, objectFit: 'cover', borderRadius: 4 }} />}
              <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>
                {a.name}
              </span>
              <span className="cc-hint" style={{ fontSize: '11px' }}>· {a.type || 'file'} · {a.sizeBytes >= 1024 * 1024 ? `${(a.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(a.sizeBytes / 1024))} KB`}</span>
              {a.state === 'uploading' && <span className="cc-hint" style={{ fontSize: '11px' }}>· {Math.round(a.progress * 100)}%</span>}
              {a.state === 'failed' && <span className="cc-hint cc-hint--danger" style={{ fontSize: '11px' }}>· failed</span>}
              <button className="cc-btn cc-btn--ghost cc-btn--sm" aria-label={`Remove ${a.name}`} onClick={() => onRemoveAttach(a.id)} style={{ padding: '2px 6px', display: 'inline-flex', alignItems: 'center' }}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* File selection is owned by the parent (it uploads into the active
          project with real progress); no decorative input lives here. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
        {showSlashMenu && !streaming && (
          <div className="cc-popover" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, zIndex: 20 }}>
            {SLASH_COMMANDS.map((c) => (
              <button key={c.id} className="cc-popover__item" onClick={() => { onInputChange(c.id === '/idea' ? '/idea ' : c.id); setShowSlashMenu(false); }}>
                <strong>{c.label}</strong>
                <div className="cc-popover__hint">{c.hint}</div>
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <textarea
              ref={textareaRef}
              className="cc-textarea"
              rows={1}
              aria-label={placeholder || (imageMode ? 'Image prompt' : mode === 'CHAT' ? 'Message CodeConClave' : 'Coworker brief')}
              value={input}
              placeholder={placeholder || (imageMode ? 'Describe the image to generate…' : mode === 'CHAT' ? 'Message CodeConClave… (/idea, /new, /cowork, /chat)' : 'Brief a coworker (task auto-created)…')}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              disabled={streaming || disabled}
              style={{
                resize: 'vertical',
                minHeight: '40px',
                maxHeight: '140px',
                lineHeight: '1.5',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onAttachClick} aria-label="Add file" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon name="paperclip" size={14} />
            </button>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onModelFocus} aria-label="Choose model" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon name="spark" size={14} />
            </button>
            {mode === 'CHAT' && (
              <button
                className={`cc-btn cc-btn--ghost cc-btn--sm ${imageMode ? 'cc-btn--primary' : ''}`}
                onClick={onImageModeToggle}
                aria-pressed={imageMode}
                title={imageMode ? 'Image mode on — generates an image' : 'Switch to Image mode'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                <Icon name="spark" size={14} />
                <span className="cc-sidebar__label" style={{ fontSize: '12px' }}>Image</span>
                {imageMode && <span className="cc-hint" style={{ fontSize: '11px' }}>on</span>}
              </button>
            )}
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onAutomationNavigate} aria-label="Schedule task" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon name="clock" size={14} />
            </button>
            {streaming ? (
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onStop} aria-label="Stop generation" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="stop" size={14} />
                <span className="cc-sidebar__label" style={{ fontSize: '12px' }}>Stop</span>
              </button>
            ) : hasUserMessage && !streaming && (
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onRegenerate} aria-label="Continue" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="arrowRight" size={14} />
                <span className="cc-sidebar__label" style={{ fontSize: '12px' }}>Continue</span>
              </button>
            )}

            <ModelPicker value={modelId} onChange={onModelChange} />
            <button
              className="cc-btn cc-btn--primary"
              disabled={streaming || !input.trim() || attachItems.some((a) => a.state === 'uploading') || disabled}
              onClick={onSend}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: '40px' }}
            >
              <Icon name="send" size={14} />
              {streaming ? 'Streaming…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}