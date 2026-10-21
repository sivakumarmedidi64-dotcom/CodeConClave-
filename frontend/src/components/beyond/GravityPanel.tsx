/**
 * Gravity Map panel — constellations of files that belong together (from real
 * imports), the gravity wells everything depends on, files nothing uses, and
 * files that are mostly used by another folder.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { errMessage } from './shared';

export interface GravityMap {
  nodes: { path: string; folder: string; inDegree: number; outDegree: number; cluster: number }[];
  edges: { from: string; to: string }[];
  constellations: { id: number; files: string[]; mainFolder: string; cohesion: number }[];
  wells: { path: string; dependents: number }[];
  drifters: string[];
  misplaced: { path: string; folder: string; pulledTo: string; share: number }[];
  unresolved: number;
}

const HUES = [42, 200, 280, 140, 10, 320, 90, 240, 170, 60];

/** Deterministic layout: constellations on a grid, files on a ring inside each. Pure. */
export function layout(
  map: GravityMap,
  width = 640,
): { positions: Map<string, { x: number; y: number; r: number; hue: number }>; labels: { x: number; y: number; text: string; hue: number }[]; height: number } {
  const groups = map.constellations.slice(0, 12);
  const cols = Math.max(1, Math.min(4, groups.length));
  const cellW = width / cols;
  const cellH = Math.min(cellW, 220);
  const positions = new Map<string, { x: number; y: number; r: number; hue: number }>();
  const labels: { x: number; y: number; text: string; hue: number }[] = [];
  groups.forEach((g, gi) => {
    const cx = (gi % cols) * cellW + cellW / 2;
    const cy = Math.floor(gi / cols) * cellH + cellH / 2 - 8;
    const ring = Math.min(cellH / 2 - 30, cellW / 2 - 24, 22 + g.files.length * 6);
    const hue = HUES[gi % HUES.length]!;
    labels.push({ x: cx, y: cy + ring + 24, text: g.mainFolder, hue });
    g.files.slice(0, 40).forEach((f, i) => {
      const a = (2 * Math.PI * i) / Math.min(g.files.length, 40) - Math.PI / 2;
      const node = map.nodes.find((n) => n.path === f);
      const r = 4 + Math.min(9, (node?.inDegree ?? 0) * 2);
      positions.set(f, { x: cx + ring * Math.cos(a), y: cy + ring * Math.sin(a), r, hue });
    });
  });
  return { positions, labels, height: Math.ceil(groups.length / cols) * cellH || 120 };
}

export function GravityPanel({ projectId }: { projectId: string }) {
  const [map, setMap] = useState<GravityMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api<{ map: GravityMap }>(`/api/v1/beyond/projects/${encodeURIComponent(projectId)}/gravity`)
      .then((r) => alive && setMap(r.map))
      .catch((err) => alive && setError(errMessage(err, 'Could not build the map.')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId]);

  const lay = map ? layout(map) : null;

  return (
    <section className="bx-panel" aria-label="Gravity Map">
      <header className="bx-panel__head">
        <div>
          <h2>Gravity Map</h2>
          <p className="cc-hint">Files pull together through their real imports. Constellations are files that belong together; bigger dots are files many others depend on.</p>
        </div>
      </header>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="cc-hint">Mapping…</p>
      ) : map && lay ? (
        <>
          <p className="cc-hint" data-testid="gravity-stats">
            {map.nodes.length} code files · {map.edges.length} links · {map.constellations.length} constellation{map.constellations.length === 1 ? '' : 's'}
            {map.unresolved ? ` · ${map.unresolved} local imports not found` : ''}
          </p>
          {map.constellations.length > 0 && (
            <svg className="bx-map" viewBox={`0 0 640 ${lay.height}`} role="img" aria-label="Constellation map">
              {map.edges.map((e) => {
                const a = lay.positions.get(e.from);
                const b = lay.positions.get(e.to);
                return a && b ? <line key={`${e.from}>${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="bx-map__edge" /> : null;
              })}
              {[...lay.positions.entries()].map(([path, p]) => (
                <circle key={path} cx={p.x} cy={p.y} r={p.r} style={{ fill: `hsl(${p.hue} 70% 55%)` }}>
                  <title>{path}</title>
                </circle>
              ))}
              {lay.labels.map((l) => (
                <text key={`${l.text}@${l.x},${l.y}`} x={l.x} y={l.y} textAnchor="middle" className="bx-map__label" style={{ fill: `hsl(${l.hue} 60% 60%)` }}>
                  {l.text}
                </text>
              ))}
            </svg>
          )}
          <div className="bx-cols">
            <div>
              <h3 className="bx-sub">Gravity wells</h3>
              {map.wells.length === 0 ? (
                <p className="cc-hint">No file is used by two or more others yet.</p>
              ) : (
                <ul className="bx-list bx-list--tight">
                  {map.wells.map((w) => (
                    <li key={w.path}>
                      <code className="cc-md-code">{w.path}</code> <span className="cc-muted">used by {w.dependents}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="bx-sub">Belongs elsewhere?</h3>
              {map.misplaced.length === 0 ? (
                <p className="cc-hint">Every file lives near the files that use it.</p>
              ) : (
                <ul className="bx-list bx-list--tight" data-testid="gravity-misplaced">
                  {map.misplaced.map((m) => (
                    <li key={m.path}>
                      <code className="cc-md-code">{m.path}</code> — {Math.round(m.share * 100)}% of its users are in <code className="cc-md-code">{m.pulledTo}</code>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="bx-sub">Drifting (nothing uses them)</h3>
              {map.drifters.length === 0 ? (
                <p className="cc-hint">None.</p>
              ) : (
                <ul className="bx-list bx-list--tight">
                  {map.drifters.slice(0, 15).map((d) => (
                    <li key={d}>
                      <code className="cc-md-code">{d}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
