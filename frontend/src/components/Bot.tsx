/**
 * CodeConClave bots — flat, friendly shapes with two slanted eyes. Each
 * specialist has its own shape and colour; the face and motion always show
 * the REAL state of its work (BotTeam maps coworker runs to these):
 *
 *   idle      eyes open, blinks now and then, gentle float
 *   waiting   eyes closed (– –), slow breathing — queued behind someone
 *   thinking  three dots pulse beside it, eyes glance up — planning/verifying
 *   working   eyes scan side to side, little bounce — running now
 *   blocked   "!" on its face — paused for your approval / blocked
 *   failed    "!" in red, shaken — stopped with an error
 *   done      colourful ribbons orbit it in 3D, then it bursts away
 *
 * Pure SVG + CSS (no WebGL, no images); respects prefers-reduced-motion.
 */
export type BotState = 'idle' | 'waiting' | 'thinking' | 'working' | 'blocked' | 'failed' | 'done';

export type BotShape = 'circle' | 'blob' | 'squircle' | 'pill' | 'triangle' | 'hexagon' | 'cloud' | 'drop';

export interface BotPersona {
  name: string;
  role: string;
  shape: BotShape;
  color: string;
}

/** The specialist roster: names, shapes and colours that match the job. */
export const BOT_PERSONAS: Record<string, BotPersona> = {
  PLANNER: { name: 'Plato', role: 'Planner', shape: 'hexagon', color: '#9b5cff' },
  ARCHITECT: { name: 'Archie', role: 'Architect', shape: 'squircle', color: '#10b8a6' },
  CODER: { name: 'Cody', role: 'Coder', shape: 'circle', color: '#1e88ff' },
  SECURITY: { name: 'Sentry', role: 'Security', shape: 'pill', color: '#ff2d48' },
  TESTER: { name: 'Tess', role: 'Tester', shape: 'triangle', color: '#ff2e9a' },
  PERFORMANCE: { name: 'Turbo', role: 'Performance', shape: 'blob', color: '#ff6b0f' },
  RESEARCH: { name: 'Scout', role: 'Research', shape: 'cloud', color: '#ffa20a' },
  DOCS: { name: 'Doc', role: 'Docs', shape: 'drop', color: '#9a6a3e' },
  REVIEWER: { name: 'Rhea', role: 'Reviewer', shape: 'blob', color: '#f2c230' },
  VERIFY: { name: 'Vera', role: 'Verifier', shape: 'circle', color: '#f3f1ea' },
};

/** Specialists a user can put on a Cowork team (the engine's coworker types). */
export const PICKABLE_BOTS = ['ARCHITECT', 'CODER', 'SECURITY', 'TESTER', 'PERFORMANCE', 'RESEARCH', 'DOCS', 'REVIEWER'] as const;

export function personaFor(kind: string): BotPersona {
  const key = kind.toUpperCase();
  return (
    BOT_PERSONAS[key] ?? {
      name: kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase(),
      role: kind.toLowerCase(),
      shape: 'circle',
      color: '#f2c230',
    }
  );
}

const SHAPES: Record<BotShape, string> = {
  circle: 'M50 10a40 40 0 1 1 0 80a40 40 0 1 1 0-80z',
  blob: 'M52 11c22 0 38 15 37 38c-1 24-17 40-40 40c-22 0-38-14-38-36c0-25 17-42 41-42z',
  squircle: 'M36 12h28c15 0 24 9 24 24v28c0 15-9 24-24 24H36c-15 0-24-9-24-24V36c0-15 9-24 24-24z',
  pill: 'M30 28h40a22 22 0 0 1 0 44H30a22 22 0 0 1 0-44z',
  triangle: 'M44 16c3-5 9-5 12 0l33 60c3 5-1 12-7 12H18c-6 0-10-7-7-12z',
  hexagon: 'M45 10c3-2 7-2 10 0l28 16c3 2 5 5 5 9v30c0 4-2 7-5 9L55 90c-3 2-7 2-10 0L17 74c-3-2-5-5-5-9V35c0-4 2-7 5-9z',
  cloud: 'M28 80c-11 0-18-8-17-17c1-8 8-13 15-13c0-11 9-19 20-18c5-9 19-10 25 0c10-1 18 7 17 16c7 4 8 15 2 22c-3 6-8 10-14 10z',
  drop: 'M50 9c11 17 33 34 33 55c0 17-14 27-33 27S17 81 17 64c0-21 22-38 33-55z',
};

/** Where the eyes sit on each shape (upper-right, like a glance). */
const EYES: Record<BotShape, { x: number; y: number }> = {
  circle: { x: 58, y: 30 },
  blob: { x: 58, y: 30 },
  squircle: { x: 58, y: 32 },
  pill: { x: 60, y: 40 },
  triangle: { x: 52, y: 52 },
  hexagon: { x: 57, y: 34 },
  cloud: { x: 56, y: 44 },
  drop: { x: 50, y: 52 },
};

const RIBBONS = ['#7ad97a', '#c36be0', '#f2c230', '#4cc7d9', '#ef7aa8'];

function Face({ shape, state }: { shape: BotShape; state: BotState }) {
  const e = EYES[shape];
  if (state === 'blocked' || state === 'failed') {
    return (
      // Outer group positions (SVG attribute); inner group animates (CSS) —
      // a CSS transform on the same element would replace the position.
      <g transform={`translate(${e.x + 4} ${e.y - 2})`}>
        <g className="cc-bb__alert">
          <rect x="-3.5" y="0" width="7" height="20" rx="3.5" />
          <circle cx="0" cy="28" r="4" />
        </g>
      </g>
    );
  }
  if (state === 'waiting') {
    return (
      <g className="cc-bb__eyes cc-bb__eyes--closed" transform={`translate(${e.x} ${e.y + 8})`}>
        <rect x="-6" y="-2.5" width="12" height="5" rx="2.5" transform="rotate(8 0 0)" />
        <rect x="10" y="-0.5" width="12" height="5" rx="2.5" transform="rotate(8 16 2)" />
      </g>
    );
  }
  return (
    <g className="cc-bb__eyes" transform={`translate(${e.x} ${e.y})`}>
      <g className="cc-bb__look">
        <rect className="cc-bb__eye" x="-3" y="0" width="7" height="17" rx="3.5" transform="rotate(-22 0 8)" />
        <rect className="cc-bb__eye" x="10" y="0" width="7" height="17" rx="3.5" transform="rotate(-22 13 8)" />
      </g>
    </g>
  );
}

export function Bot({ kind, state, size = 64, showName = true }: { kind: string; state: BotState; size?: number; showName?: boolean }) {
  const p = personaFor(kind);
  const label = `${p.name}, ${p.role} — ${state}`;
  return (
    <div
      className={`cc-bb cc-bb--${state} cc-bb--${p.shape}`}
      style={{ ['--bb-size' as string]: `${size}px`, ['--bb-color' as string]: p.color }}
      role="img"
      aria-label={label}
      title={label}
    >
      <div className="cc-bb__stage">
        <div className="cc-bb__float">
          <svg className="cc-bb__svg" viewBox="0 0 100 100" aria-hidden="true">
            <defs>
              <radialGradient id={`bb-shine-${p.shape}`} cx="32%" cy="26%" r="70%">
                <stop offset="0%" stopColor="#fff" stopOpacity="0.32" />
                <stop offset="55%" stopColor="#fff" stopOpacity="0" />
                <stop offset="100%" stopColor="#000" stopOpacity="0.18" />
              </radialGradient>
            </defs>
            <path className="cc-bb__body" d={SHAPES[p.shape]} fill={p.color} />
            <path d={SHAPES[p.shape]} fill={`url(#bb-shine-${p.shape})`} />
            <Face shape={p.shape} state={state} />
          </svg>
          {state === 'done' && (
            <span className="cc-bb__ribbons" aria-hidden="true">
              {RIBBONS.map((c, i) => (
                <i key={c} style={{ ['--r' as string]: String(i), borderColor: c }} />
              ))}
            </span>
          )}
          {state === 'done' && (
            <span className="cc-bb__burst" aria-hidden="true">
              {Array.from({ length: 12 }, (_, i) => (
                <i key={i} style={{ ['--i' as string]: String(i), background: RIBBONS[i % RIBBONS.length] }} />
              ))}
            </span>
          )}
        </div>
        {state === 'thinking' && (
          <span className="cc-bb__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="cc-bb__shadow" aria-hidden="true" />
      </div>
      {showName && (
        <>
          <span className="cc-bb__name">{p.name}</span>
          <span className="cc-bb__role">{p.role}</span>
        </>
      )}
    </div>
  );
}
