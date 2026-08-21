/**
 * CodeConClave — Moon component.
 * Brand rule: moons <= 80px for UI; free-limit moon <= 150px shown once per
 * transition. Monogram derived from initials.
 */

export function initialsOf(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export type MoonSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<MoonSize, string> = {
  sm: 'cc-moon--sm',
  md: 'cc-moon--md',
  lg: 'cc-moon--lg',
};

export function Moon({
  name,
  size = 'md',
  title,
}: {
  name: string | null | undefined;
  size?: MoonSize;
  title?: string;
}) {
  return (
    <span className={`cc-moon ${SIZE_CLASS[size]}`} title={title ?? name ?? undefined}>
      {initialsOf(name)}
    </span>
  );
}

/** Free-limit moon: shown once per downgrade transition, max 150px. */
export function FreeLimitMoon({ name }: { name: string | null | undefined }) {
  return (
    <div className="cc-free-limit-moon" role="img" aria-label={`Free limit — ${name ?? 'user'}`}>
      <Moon name={name} size="lg" />
      <p className="cc-hint">Free tier daily limit reached</p>
    </div>
  );
}