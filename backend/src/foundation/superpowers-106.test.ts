/**
 * CodeConClave — Stage 106 SUPERPOWERS Tranche AB: Component Graveyard, Responsive Forge,
 * Interaction Definer, Form Builder, Theme Enforcer.
 *
 *   COMPONENT GRAVEYARD (#117)  — finds every unused/broken/dead component.
 *   RESPONSIVE FORGE (#118)     — auto-generates responsive layouts from breakpoints.
 *   INTERACTION DEFINER (#119)  — vague interaction spec → full animation + states.
 *   FORM BUILDER (#120)         — AI-powered form generation from field specs.
 *   THEME ENFORCER (#121)       — design system theme enforcement with violations.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    dead_components: [] as Array<Record<string, unknown>>,
    responsive_generations: [] as Array<Record<string, unknown>>,
    interaction_specs: [] as Array<Record<string, unknown>>,
    form_builds: [] as Array<Record<string, unknown>>,
    theme_violations: [] as Array<Record<string, unknown>>,
  };
  const now = () => {
    tick += 1;
    return new Date(tick).toISOString();
  };
  return { tables, now };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '');
  }
  function parseVal(col: string, val: unknown): unknown {
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { return JSON.parse(val); } catch { /* keep */ }
    }
    return val;
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\)]+)\)\s*values\s*\((.*)\)/is.exec(text);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const row: Record<string, unknown> = { created_at: store.now(), updated_at: store.now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1]!) - 1];
          row[col] = parseVal(col, val);
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.toUpperCase().startsWith('NOW()')) {
          row[col] = store.now();
        } else if (tok.startsWith("'")) {
          row[col] = tok.slice(1, tok.endsWith("'") ? -1 : undefined);
        }
      });
      storeRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^update \w+/.test(text.toLowerCase().trim())) {
      const table = /^update (\w+)/.exec(text.toLowerCase())![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(text);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1]!) - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(text);
      if (setMatch && target) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const col = cleanCol(pair.slice(0, eq));
          const ref = pair.slice(eq + 1).trim();
          const dollar = /^\$(\d+)$/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (/^(\w+)\s*\+\s*\$(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*\$(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(params[Number(m[2]!) - 1]);
          } else if (/^(\w+)\s*\+\s*(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(m[2]!);
          } else if (dollar) {
            const val = params[Number(dollar[1]!) - 1];
            target[col] = parseVal(col, val);
          } else if (/^now\(\)/i.test(ref)) {
            target[col] = store.now();
          } else if (ref.startsWith("'") && ref.endsWith("'")) {
            target[col] = ref.slice(1, -1);
          }
        }
      }
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }

    if (/select \*/.test(text.toLowerCase())) {
      const tableMatch = /from (\w+)/i.exec(text);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereTail = (/where\s+(.+)$/is.exec(text)?.[1] ?? '').replace(/\s+limit\s+\d+$/i, '');
      let filtered = [...rows];
      for (const clause of whereTail.split(/\s+and\s+/i)) {
        const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
        if (m) {
          const val = params[Number(m[2]!) - 1];
          filtered = filtered.filter((r) => String(r[cleanCol(m[1]!)] ?? '') === String(val ?? ''));
        }
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    pool: { query: queryImpl },
    queryMany: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows),
    queryOne: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    COMPONENT_GRAVEYARD: 'cgv',
    RESPONSIVE_FORGE: 'rsf',
    INTERACTION_DEFINER: 'itd',
    FORM_BUILDER: 'fmb',
    THEME_ENFORCER: 'tfe',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createGraveyardEntry, removeComponent, getGraveyardEntry, listGraveyardEntries, componentGraveyardReport } from '../modules/superpowers/componentGraveyard.js';
import { generateResponsive, getResponsiveGeneration, listResponsiveGenerations, responsiveForgeReport } from '../modules/superpowers/responsiveForge.js';
import { defineInteraction, getInteractionSpec, listInteractionSpecs, interactionDefinerReport } from '../modules/superpowers/interactionDefiner.js';
import { generateForm, getFormBuild, listFormBuilds, formBuilderReport } from '../modules/superpowers/formBuilder.js';
import { flagViolation, fixViolation, getThemeViolation, listThemeViolations, themeEnforcerReport } from '../modules/superpowers/themeEnforcer.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('COMPONENT GRAVEYARD (#117)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a graveyard entry, removes it, and audits both', async () => {
    const entry = await createGraveyardEntry(USER, { component_name: 'OldButton', usage_count: 0 });
    expect(entry.id).toMatch(/^cgv-/);
    expect(entry.component_name).toBe('OldButton');
    expect(entry.usage_count).toBe(0);
    expect(entry.status).toBe('FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.dead_component_found');

    const removed = await removeComponent(USER, entry.id);
    expect(removed.status).toBe('REMOVED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.dead_component_removed');
  });

  it('reports graveyard totals', async () => {
    const e1 = await createGraveyardEntry(USER, { component_name: 'A', usage_count: 0 });
    await createGraveyardEntry(USER, { component_name: 'B', usage_count: 3 });
    await removeComponent(USER, e1.id);

    const report = await componentGraveyardReport(USER);
    expect(report.entries).toBe(2);
    expect(report.flagged).toBe(1);
    expect(report.removed).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const e = await createGraveyardEntry(USER, { component_name: 'X', usage_count: 1 });
    await expect(getGraveyardEntry(OTHER, e.id)).rejects.toThrow(/dead_component_not_found/);
    await expect(listGraveyardEntries(OTHER)).resolves.toHaveLength(0);
    await expect(createGraveyardEntry(USER, { component_name: '', usage_count: 0 })).rejects.toThrow(/component name is required/);
    await expect(createGraveyardEntry(USER, { component_name: 'X', usage_count: -1 })).rejects.toThrow(/usage count must be a non-negative number/);
  });
});

describe('RESPONSIVE FORGE (#118)', () => {
  beforeEach(() => { cleartables(); });

  it('generates responsive layouts from breakpoints and audits', async () => {
    const gen = await generateResponsive(USER, { component: 'Header', breakpoints: ['mobile', 'tablet', 'desktop'] });
    expect(gen.id).toMatch(/^rsf-/);
    expect(gen.component).toBe('Header');
    expect(gen.breakpoints).toEqual(['mobile', 'tablet', 'desktop']);
    expect(gen.generated_layout).toContain('mobile: auto');
    expect(gen.status).toBe('GENERATED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.responsive_forge_generated');
  });

  it('reports responsive forge totals', async () => {
    await generateResponsive(USER, { component: 'Nav', breakpoints: ['sm', 'md'] });
    await generateResponsive(USER, { component: 'Footer', breakpoints: ['mobile', 'desktop'] });

    const report = await responsiveForgeReport(USER);
    expect(report.generations).toBe(2);
    expect(report.generated).toBe(2);
  });

  it('validates and stays owner-scoped', async () => {
    const g = await generateResponsive(USER, { component: 'A', breakpoints: ['x'] });
    await expect(getResponsiveGeneration(OTHER, g.id)).rejects.toThrow(/responsive_generation_not_found/);
    await expect(listResponsiveGenerations(OTHER)).resolves.toHaveLength(0);
    await expect(generateResponsive(USER, { component: '', breakpoints: ['x'] })).rejects.toThrow(/component name is required/);
    await expect(generateResponsive(USER, { component: 'A', breakpoints: [] })).rejects.toThrow(/at least one breakpoint is required/);
  });
});

describe('INTERACTION DEFINER (#119)', () => {
  beforeEach(() => { cleartables(); });

  it('defines an interaction spec and audits', async () => {
    const spec = await defineInteraction(USER, { component: 'Tooltip', description: 'appears on hover, disappears on click', states: ['idle', 'hovering', 'visible'] });
    expect(spec.id).toMatch(/^itd-/);
    expect(spec.component).toBe('Tooltip');
    expect(spec.states).toEqual(['idle', 'hovering', 'visible']);
    expect(spec.status).toBe('DEFINED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.interaction_spec_defined');
  });

  it('reports interaction definer totals', async () => {
    await defineInteraction(USER, { component: 'Modal', description: 'opens on click', states: ['closed', 'open'] });
    await defineInteraction(USER, { component: 'Dropdown', description: 'opens on click', states: ['closed', 'open', 'selected'] });

    const report = await interactionDefinerReport(USER);
    expect(report.specs).toBe(2);
    expect(report.defined).toBe(2);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await defineInteraction(USER, { component: 'X', description: 'y', states: ['a'] });
    await expect(getInteractionSpec(OTHER, s.id)).rejects.toThrow(/interaction_spec_not_found/);
    await expect(listInteractionSpecs(OTHER)).resolves.toHaveLength(0);
    await expect(defineInteraction(USER, { component: '', description: 'y', states: ['a'] })).rejects.toThrow(/component name is required/);
    await expect(defineInteraction(USER, { component: 'X', description: '', states: ['a'] })).rejects.toThrow(/description is required/);
    await expect(defineInteraction(USER, { component: 'X', description: 'y', states: [] })).rejects.toThrow(/at least one interaction state is required/);
  });
});

describe('FORM BUILDER (#120)', () => {
  beforeEach(() => { cleartables(); });

  it('generates a form from fields and audits', async () => {
    const form = await generateForm(USER, { form_name: 'Login', fields: [{ type: 'email', label: 'Email' }, { type: 'password', label: 'Password' }] });
    expect(form.id).toMatch(/^fmb-/);
    expect(form.form_name).toBe('Login');
    expect(form.fields).toHaveLength(2);
    expect(form.generated_code).toContain('Email (email)');
    expect(form.status).toBe('GENERATED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.form_build_generated');
  });

  it('reports form builder totals', async () => {
    await generateForm(USER, { form_name: 'A', fields: [{ type: 'text', label: 'Name' }] });
    await generateForm(USER, { form_name: 'B', fields: [{ type: 'email', label: 'E' }, { type: 'password', label: 'P' }] });

    const report = await formBuilderReport(USER);
    expect(report.builds).toBe(2);
    expect(report.generated).toBe(2);
    expect(report.total_fields).toBe(3);
  });

  it('validates and stays owner-scoped', async () => {
    const f = await generateForm(USER, { form_name: 'X', fields: [{ type: 'text', label: 'A' }] });
    await expect(getFormBuild(OTHER, f.id)).rejects.toThrow(/form_build_not_found/);
    await expect(listFormBuilds(OTHER)).resolves.toHaveLength(0);
    await expect(generateForm(USER, { form_name: '', fields: [{ type: 'text', label: 'A' }] })).rejects.toThrow(/form name is required/);
    await expect(generateForm(USER, { form_name: 'X', fields: [] })).rejects.toThrow(/at least one form field is required/);
  });
});

describe('THEME ENFORCER (#121)', () => {
  beforeEach(() => { cleartables(); });

  it('flags a theme violation, fixes it, and audits both', async () => {
    const v = await flagViolation(USER, { component: 'Button', violation_type: 'wrong_color', severity: 'HIGH' });
    expect(v.id).toMatch(/^tfe-/);
    expect(v.component).toBe('Button');
    expect(v.severity).toBe('HIGH');
    expect(v.status).toBe('FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.theme_violation_flagged');

    const fixed = await fixViolation(USER, v.id);
    expect(fixed.status).toBe('FIXED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.theme_violation_fixed');
  });

  it('reports theme enforcer totals', async () => {
    const v1 = await flagViolation(USER, { component: 'A', violation_type: 'font', severity: 'LOW' });
    await flagViolation(USER, { component: 'B', violation_type: 'spacing', severity: 'MEDIUM' });
    await fixViolation(USER, v1.id);

    const report = await themeEnforcerReport(USER);
    expect(report.violations).toBe(2);
    expect(report.flagged).toBe(1);
    expect(report.fixed).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const v = await flagViolation(USER, { component: 'X', violation_type: 'color', severity: 'LOW' });
    await expect(getThemeViolation(OTHER, v.id)).rejects.toThrow(/theme_violation_not_found/);
    await expect(listThemeViolations(OTHER)).resolves.toHaveLength(0);
    await expect(flagViolation(USER, { component: '', violation_type: 'color', severity: 'LOW' })).rejects.toThrow(/component name is required/);
    await expect(flagViolation(USER, { component: 'X', violation_type: '', severity: 'LOW' })).rejects.toThrow(/violation type is required/);
    await expect(flagViolation(USER, { component: 'X', violation_type: 'color', severity: '' })).rejects.toThrow(/severity is required/);
  });
});
