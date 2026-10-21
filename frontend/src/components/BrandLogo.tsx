import { useState } from 'react';

/**
 * CodeConClave — canonical brand mark. The lockup is the founder's ORIGINAL
 * raster (/brand/logo-original.png: black tile, striped eye, gold wordmark),
 * restored 2026-10-20. If it cannot load, the vector reconstruction at
 * /brand/logo-primary.svg is used, then the symbol mark. The symbol mark at
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
  // 0 = original raster, 1 = vector reconstruction, 2 = symbol mark.
  const [fallback, setFallback] = useState(0);
  const src =
    variant !== 'lockup' || fallback >= 2
      ? '/brand/logo-icon.svg'
      : fallback === 0
        ? '/brand/logo-original.png'
        : '/brand/logo-primary.svg';
  const style = height ? { height, width: 'auto' } : undefined;
  return (
    <img
      src={src}
      alt="CodeConClave"
      className={className ? `cc-brand-logo ${className}` : 'cc-brand-logo'}
      style={style}
      draggable={false}
      onError={variant === 'lockup' && fallback < 2 ? () => setFallback((f) => f + 1) : undefined}
    />
  );
}