/**
 * CodeConClave — decorative 3D cube accent for the auth visual panel.
 * Lightweight CSS-built cubes (teal + purple) rotating in 3D space.
 * Pure decoration; disabled under prefers-reduced-motion.
 */
import { CSSProperties } from 'react';

const CUBES: Array<{
  cls: string;
  style: CSSProperties;
  faceColor: string;
}> = [
  {
    cls: 'cc-cube cc-cube--a',
    style: { top: '18%', left: '14%' },
    faceColor: '#8A3FFC',
  },
  {
    cls: 'cc-cube cc-cube--b',
    style: { top: '58%', left: '22%' },
    faceColor: '#8A3FFC',
  },
  {
    cls: 'cc-cube cc-cube--c',
    style: { top: '32%', left: '58%' },
    faceColor: '#8A3FFC',
  },
  {
    cls: 'cc-cube cc-cube--d',
    style: { top: '66%', left: '60%' },
    faceColor: '#8A3FFC',
  },
];

function Cube3D({ style, faceColor }: { style: CSSProperties; faceColor: string }) {
  return (
    <div className="cc-cube" style={style}>
      <div className="cc-cube__inner">
        <span className="cc-cube__face cc-cube__face--front" style={{ background: faceColor }} />
        <span className="cc-cube__face cc-cube__face--back" style={{ background: faceColor }} />
        <span className="cc-cube__face cc-cube__face--right" style={{ background: faceColor }} />
        <span className="cc-cube__face cc-cube__face--left" style={{ background: faceColor }} />
        <span className="cc-cube__face cc-cube__face--top" style={{ background: faceColor }} />
        <span className="cc-cube__face cc-cube__face--bottom" style={{ background: faceColor }} />
      </div>
    </div>
  );
}

export function AuthCubes() {
  return (
    <div className="cc-cubes">
      {CUBES.map((c) => (
        <div key={c.cls} className={c.cls} style={c.style}>
          <Cube3D style={c.style} faceColor={c.faceColor} />
        </div>
      ))}
      <div className="cc-cubes__grain" />
    </div>
  );
}
