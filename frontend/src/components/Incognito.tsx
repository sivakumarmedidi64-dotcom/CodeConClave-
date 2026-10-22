/** Incognito chat: the ghost toggle for new chats and the banner inside one. */
import { Icon } from './Icon';

export function IncognitoToggle({
  on,
  onChange,
  disabled,
  iconOnly,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      className={`cc-incognito-toggle${on ? ' is-on' : ''}${iconOnly ? ' cc-incognito-toggle--icon' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'Incognito on — turn off' : 'Start an incognito chat'}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={
        disabled
          ? 'Incognito is for chats (Cowork runs create tasks that are kept)'
          : on
            ? 'Incognito is on: this new chat won’t be saved to history or memory'
            : 'Start an incognito chat'
      }
      data-testid="incognito-toggle"
    >
      <Icon name="ghost" size={16} />
      {!iconOnly && <span>{on ? 'Incognito on' : 'Incognito'}</span>}
    </button>
  );
}

export function IncognitoBanner({ retentionHours = 24 }: { retentionHours?: number }) {
  return (
    <div className="cc-incognito-banner" role="note" data-testid="incognito-banner">
      <Icon name="ghost" size={18} />
      <div>
        <strong>Incognito chat</strong>
        <span>
          Not saved to your history, not used for memory, and permanently deleted after {retentionHours} hours of inactivity.
        </span>
      </div>
    </div>
  );
}
