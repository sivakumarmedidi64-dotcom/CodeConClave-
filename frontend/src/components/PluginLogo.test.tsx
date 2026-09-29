import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PluginLogo, BRAND_COLOR, PLUGIN_LOGO_FALLBACK_COLOR } from './PluginLogo';

describe('PluginLogo', () => {
  it('renders a brand mark for known plugin types', () => {
    for (const type of ['github', 'slack', 'vercel', 'google', 'cloudflare']) {
      const { unmount } = render(<PluginLogo type={type} />);
      expect(screen.getByLabelText(`${type} logo`)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders every brand mark with its official brand color so it is visible on the dark UI', () => {
    for (const [type, color] of Object.entries(BRAND_COLOR)) {
      const { unmount } = render(<PluginLogo type={type} />);
      const svg = screen.getByLabelText(`${type} logo`);
      expect(svg).toHaveStyle({ color });
      expect(svg.querySelector('path')).toHaveAttribute('fill', 'currentColor');
      unmount();
    }
  });

  it('falls back to the accent-colored puzzle glyph for unknown types without faking a logo', () => {
    render(<PluginLogo type="not-a-real-brand" />);
    expect(screen.getByLabelText('not-a-real-brand logo')).toHaveStyle({ color: PLUGIN_LOGO_FALLBACK_COLOR });
  });
});
