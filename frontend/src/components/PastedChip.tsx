/** Pasted content shown as one clear, labelled unit (composer + sent message). */
import { useState } from 'react';
import { Icon, type IconName } from './Icon';
import { CopyButton } from './CopyButton';
import { pasteSummary, splitPasted, type PasteInfo } from '../lib/paste';

const KIND_ICON: Record<string, IconName> = {
  code: 'code',
  json: 'code',
  csv: 'database',
  tsv: 'database',
  log: 'terminal',
  markdown: 'file',
  links: 'link',
  text: 'file',
};

export function PastedChip({ info, text, onRemove }: { info: PasteInfo; text: string; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cc-pasted${open ? ' is-open' : ''}`} data-testid="pasted-chip">
      <div className="cc-pasted__head">
        <button type="button" className="cc-pasted__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name={KIND_ICON[info.kind] ?? 'file'} size={14} />
          <span className="cc-pasted__label">{pasteSummary(info)}</span>
          <span className="cc-muted">{info.chars.toLocaleString()} chars</span>
        </button>
        <CopyButton text={text} label="Copy pasted content" size={12} />
        {onRemove && (
          <button type="button" className="cc-icon-btn" aria-label="Remove pasted content" onClick={onRemove}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {open && <pre className="cc-pasted__body">{text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (${(text.length - 20_000).toLocaleString()} more characters)` : text}</pre>}
    </div>
  );
}

/** A user message: typed text plus any pasted blocks as chips. */
export function UserMessageContent({ content }: { content: string }) {
  const parts = splitPasted(content);
  if (parts.length === 1 && parts[0]!.type === 'text') return <>{content}</>;
  return (
    <div className="cc-usermsg">
      {parts.map((p, i) =>
        p.type === 'pasted' ? <PastedChip key={i} info={p.info!} text={p.text} /> : <div key={i} className="cc-usermsg__text">{p.text.trim()}</div>,
      )}
    </div>
  );
}
