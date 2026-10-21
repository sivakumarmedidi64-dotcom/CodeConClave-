/**
 * Profile picture: pastel initials, an emoji, or one of the CodeConClave bots.
 * Chosen in Settings → General; stored in preferences as `avatar`:
 *   "initials:<n>" | "emoji:<char>" | "bot:<KIND>"
 */
import { Bot } from './Bot';
import { savePrefs, usePref } from '../lib/prefs';

const PASTELS: { bg: string; fg: string }[] = [
  { bg: '#fde2e4', fg: '#c2185b' },
  { bg: '#fff1d6', fg: '#e07a00' },
  { bg: '#e2f5e9', fg: '#2e7d4f' },
  { bg: '#e3effd', fg: '#1e5fbf' },
  { bg: '#efe6fd', fg: '#6a3fbf' },
  { bg: '#fdeee2', fg: '#b4541a' },
];

export const AVATAR_EMOJI = ['🚀', '🦊', '🐸', '🦄', '👾', '🤖', '🍊', '❤️', '⚡', '🎧', '🐙', '🌙'];
export const AVATAR_BOTS = ['CODER', 'ARCHITECT', 'TESTER', 'SECURITY', 'PERFORMANCE', 'RESEARCH', 'DOCS', 'REVIEWER'];

export function initialsOf(name: string): string {
  // An email address contributes only its local part ("sam@x.io" → "SA").
  const base = name.includes('@') ? name.split('@')[0]! : name;
  const parts = base.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : (parts[0]?.[1] ?? ''))).toUpperCase();
}

export function AvatarView({ value, name, size = 28 }: { value: string | undefined; name: string; size?: number }) {
  const [type, rest] = (value ?? '').split(/:(.*)/s);
  if (type === 'bot' && rest) {
    return (
      <span className="cc-avatar cc-avatar--bot" style={{ width: size, height: size }} aria-hidden="true">
        <Bot kind={rest} state="idle" size={Math.round(size * 0.82)} showName={false} />
      </span>
    );
  }
  if (type === 'emoji' && rest) {
    return (
      <span className="cc-avatar" style={{ width: size, height: size, fontSize: size * 0.55, background: PASTELS[rest.codePointAt(0)! % PASTELS.length]!.bg }} aria-hidden="true">
        {rest}
      </span>
    );
  }
  const idx = type === 'initials' ? Number(rest) % PASTELS.length || 0 : (name.charCodeAt(0) || 0) % PASTELS.length;
  const c = PASTELS[idx]!;
  return (
    <span className="cc-avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: c.bg, color: c.fg }} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/** The signed-in user's avatar (reactive to Settings changes). */
export function UserAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const value = usePref<string>('avatar');
  return <AvatarView value={value} name={name} size={size} />;
}

export function AvatarPicker({ name }: { name: string }) {
  const value = usePref<string>('avatar');
  const choose = (v: string) => void savePrefs({ avatar: v });
  const options = [
    ...PASTELS.map((_, i) => `initials:${i}`),
    ...AVATAR_EMOJI.map((e) => `emoji:${e}`),
    ...AVATAR_BOTS.map((b) => `bot:${b}`),
  ];
  return (
    <div className="cc-avatar-picker" role="radiogroup" aria-label="Profile picture">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o || (!value && o === 'initials:0')}
          aria-label={o.startsWith('bot:') ? `Bot ${o.slice(4).toLowerCase()}` : o.startsWith('emoji:') ? `Emoji ${o.slice(6)}` : `Initials, colour ${Number(o.slice(9)) + 1}`}
          className={`cc-avatar-picker__opt${value === o ? ' is-active' : ''}`}
          onClick={() => choose(o)}
        >
          <AvatarView value={o} name={name} size={44} />
        </button>
      ))}
    </div>
  );
}
