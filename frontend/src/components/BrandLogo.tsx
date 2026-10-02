import { useState } from 'react';

/**
 * CodeConClave — canonical brand mark. Single canonical source of truth:
 * the primary lockup at /brand/logo-primary.svg (black tile + eye/fan + gold
 * wordmark; assets/brand/ for provenance). The symbol mark at
 * /brand/logo-icon.svg is a legitimate product icon derived from the same
 * artwork; it is used for compact UI. If the lockup is not reachable
 * (LOGO_ASSET_REQUIRED = YES, degraded disk state), the component falls back
 * to the symbol mark instead of rendering a broken image or an invented
 * lockup. Raster PNG derivation of the lockup (MASTER/LARGE/APPLE) stays a
 * founder- or font-rasterizer deliverable pre-launch.
 */
export function BrandLogo({
  variant = 'mark',
  height,
  className,
}: {
  variant?: 'mark' | 'lockup';
  height?: number;
  className?: string;
}) {
  const [missing, setMissing] = useState(false);
  const src = variant === 'lockup' && !missing ? '/brand/logo-primary.svg' : '/brand/logo-icon.svg';
  const style = height ? { height, width: 'auto' } : undefined;
  return (
    <img
      src={src}
      alt="CodeConClave"
      className={className ? `cc-brand-logo ${className}` : 'cc-brand-logo'}
      style={style}
      draggable={false}
      onError={variant === 'lockup' ? () => setMissing(true) : undefined}
    />
  );
}