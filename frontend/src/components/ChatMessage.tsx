/**
 * CodeConClave — Compact Chat Message.
 * No giant cards. Uses whitespace, typography, subtle dividers.
 * Expandable technical details for code work.
 */
import { useEffect, useId, useState } from 'react';
import { splitCodeBlocks } from '../lib/clipboard';
import { Icon } from './Icon';

interface UiMessage {
  key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: boolean;
  replayId?: string;
  image?: { fileId: string; mimeType: string } | null;
  externalRun?: { externalId: string; status: string } | null;
}

interface ChatMessageProps {
  message: UiMessage;
  isEditing?: boolean;
  editContent?: string;
  onEditChange?: (content: string) => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
  actions?: React.ReactNode;
  showExpandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  executionPhase?: string;
  executionDetails?: {
    what?: string;
    checked?: string;
    evidence?: string;
  };
}

export function ChatMessage({
  message,
  isEditing,
  editContent,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  actions,
  showExpandable = false,
  expanded = false,
  onToggleExpand,
  executionPhase,
  executionDetails,
}: ChatMessageProps) {
  const [localExpanded, setLocalExpanded] = useState(expanded);
  const detailsId = useId();

  /* Follow the parent: an external `expanded` change must win over local
     toggle state instead of going stale after first render. */
  useEffect(() => {
    setLocalExpanded(expanded);
  }, [expanded]);

  const handleToggleExpand = () => {
    setLocalExpanded((prev) => !prev);
    onToggleExpand?.();
  };

  const renderContent = () => {
    if (message.image) {
      return (
        <div className="cc-msg-image" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <span className="cc-hint">Image generated (file {message.image.fileId})</span>
        </div>
      );
    }
    if (message.thinking && !message.content) {
      return <span className="cc-think">thinking…</span>;
    }
    const segments = splitCodeBlocks(message.content);
    return (
      <div className="cc-msg-content" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {message.externalRun && (
          <span className="cc-hint" style={{ fontSize: '12px' }}>
            External agent · {message.externalRun.status} · {message.externalRun.externalId}
          </span>
        )}
        {segments.map((seg, i) =>
          seg.kind === 'code' ? (
            <div key={i} className="cc-code">
              <div className="cc-code__bar">
                <span className="cc-hint">code</span>
              </div>
              <pre><code>{seg.content}</code></pre>
            </div>
          ) : (
            <span key={i} className="cc-msg-text">{seg.content}</span>
          ),
        )}
      </div>
    );
  };

  const renderExecutionDetails = () => {
    if (!executionDetails || !showExpandable) return null;
    /* Controlled disclosure (button + region) instead of native
       <details onToggle>: the native toggle fires after the DOM already
       flipped, which desynced from React state and announced poorly. */
    return (
      <div className="cc-msg-details">
        <button
          type="button"
          className="cc-msg-details-summary cc-btn cc-btn--ghost cc-btn--sm"
          aria-expanded={localExpanded}
          aria-controls={detailsId}
          onClick={handleToggleExpand}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <span>{localExpanded ? 'Hide details' : 'Show details'}</span>
          <Icon name={localExpanded ? 'chevronUp' : 'chevronDown'} size={12} />
        </button>
        {localExpanded && (
        <div id={detailsId} role="region" aria-label="Execution details" className="cc-msg-details-content" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, paddingLeft: 12, borderLeft: '2px solid #e5e7eb' }}>
          {executionPhase && (
            <div className="cc-msg-phase">
              <span className="cc-hint" style={{ textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.05em' }}>Phase</span>
              <div style={{ fontWeight: 500 }}>{executionPhase}</div>
            </div>
          )}
          {executionDetails.what && (
            <div className="cc-msg-what">
              <span className="cc-hint" style={{ textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.05em' }}>WHAT</span>
              <div>{executionDetails.what}</div>
            </div>
          )}
          {executionDetails.checked && (
            <div className="cc-msg-checked">
              <span className="cc-hint" style={{ textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.05em' }}>CHECKED</span>
              <div>{executionDetails.checked}</div>
            </div>
          )}
          {executionDetails.evidence && (
            <div className="cc-msg-evidence">
              <span className="cc-hint" style={{ textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.05em' }}>EVIDENCE</span>
              <div style={{ fontFamily: 'var(--cc-mono)', fontSize: '12px' }}>{executionDetails.evidence}</div>
            </div>
          )}
        </div>
        )}
      </div>
    );
  };

  const getRoleStyle = (role: string): React.CSSProperties => {
    switch (role) {
      case 'user':
        return { textAlign: 'right', color: 'var(--cc-text)' };
      case 'assistant':
        return { textAlign: 'left', color: 'var(--cc-text)' };
      case 'system':
        return { textAlign: 'center', color: 'var(--cc-text-muted)', fontSize: '13px' };
      default:
        return {};
    }
  };

  const getRolePrefix = (role: string): string => {
    switch (role) {
      case 'user':
        return 'You';
      case 'assistant':
        return 'AI';
      case 'system':
        return 'System';
      default:
        return role;
    }
  };

  return (
    <div
      className={`cc-msg-compact ${message.role}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 0',
        borderBottom: '1px solid #f3f4f6',
        ...getRoleStyle(message.role),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
        {message.role !== 'system' && (
          <span className="cc-msg-role" style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0, marginTop: 2 }}>
            {getRolePrefix(message.role)}
          </span>
        )}
        <div style={{ maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 4, textAlign: message.role === 'user' ? 'right' : 'left' }}>
          {isEditing ? (
            <textarea
              className="cc-textarea"
              value={editContent}
              onChange={(e) => onEditChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onCommitEdit?.();
                }
                if (e.key === 'Escape') onCancelEdit?.();
              }}
              autoFocus
              rows={3}
              style={{ minWidth: '200px' }}
            />
          ) : (
            renderContent()
          )}
          {actions && !isEditing && (
            <div className="cc-msg-actions" style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {actions}
            </div>
          )}
        </div>
      </div>
      {renderExecutionDetails()}
    </div>
  );
}