import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BeyondPage } from './BeyondPage';
import { draftFromFinding, type CouncilFinding } from '../components/beyond/CouncilPanel';
import { filenameFrom } from '../components/beyond/TeleportPanel';
import { layout, type GravityMap } from '../components/beyond/GravityPanel';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const PROJECT = { id: 'prj_1', name: 'Shop', deleted_at: null };

const snapshot = (temperature: number) => ({
  id: `tmp_${temperature}`,
  temperature,
  level: temperature >= 50 ? 'HOT' : 'COOL',
  components: {
    duplication: { value: 0.4, duplicatedLines: 40, totalLines: 100 },
    size: { value: 0, linesInLargeFiles: 0, largeFiles: 0 },
    nesting: { value: 0.5, deepFiles: 1, codeFiles: 2 },
    markers: { value: 0.1, count: 1, per1kLines: 10 },
    findings: { value: 0.2, weighted: 2, per1kLines: 20, bySeverity: { HIGH: 1 } },
  },
  hottest: [{ path: 'src/cart.ts', heat: 71, lines: 80, reasons: ['40 duplicated lines', 'nested 7 levels'] }],
  codeFiles: 2,
  lines: 100,
  createdAt: new Date().toISOString(),
  delta: null,
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <BeyondPage />
    </MemoryRouter>,
  );

describe('Beyond page', () => {
  it('measures the thermostat from the server and shows every part of the number', async () => {
    let history: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/projects') return json({ projects: [PROJECT] });
        if (url.endsWith('/thermostat') && init?.method === 'POST') {
          history = [snapshot(42)];
          return json({ snapshot: { ...snapshot(42), delta: null } });
        }
        if (url.endsWith('/thermostat')) return json({ history });
        return json({}, 404);
      }),
    );
    renderAt('/beyond');
    expect(await screen.findByTestId('thermo-empty')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Measure now' }));
    expect(await screen.findByTestId('thermo-temp')).toHaveTextContent('42°');
    expect(screen.getByRole('img', { name: 'Temperature 42 of 100, Cool' })).toBeInTheDocument();
    expect(screen.getByText('40 of 100 code lines are in repeated 6-line blocks')).toBeInTheDocument();
    expect(screen.getByText('src/cart.ts')).toBeInTheDocument();
    expect(screen.getByText('40 duplicated lines · nested 7 levels')).toBeInTheDocument();
  });

  it('says so when there is no project instead of showing sample data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ projects: [] })));
    renderAt('/beyond?tab=gravity');
    expect(await screen.findByTestId('beyond-no-project')).toHaveTextContent('Gravity Map works on a project');
  });

  it('runs the Council on a real file and turns a finding into a vaccine', async () => {
    const result = {
      path: 'src/db.ts',
      lines: 12,
      consensus: { verdict: 'DO_NOT_SHIP', summary: 'Sentry blocks: SQL built by string concatenation.' },
      ai: { requested: false, available: false },
      lenses: [
        {
          lens: 'security',
          bot: 'Sentry',
          role: 'Security',
          verdict: 'BLOCK',
          findings: [{ lens: 'security', rule: 'sql-concat', severity: 'HIGH', line: 4, title: 'SQL built by string concatenation', evidence: "query('SELECT * FROM users WHERE id=' + id)", fix: 'Use parameters ($1).' }],
        },
        { lens: 'performance', bot: 'Turbo', role: 'Performance', verdict: 'PASS', findings: [] },
        { lens: 'simplicity', bot: 'Rhea', role: 'Simplicity', verdict: 'PASS', findings: [] },
        { lens: 'correctness', bot: 'Tess', role: 'Correctness', verdict: 'PASS', findings: [] },
      ],
    };
    let councilBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/projects') return json({ projects: [PROJECT] });
        if (url.startsWith('/api/v1/files?projectId=prj_1'))
          return json({ files: [{ id: 'fil_1', path: 'src/db.ts', is_directory: false }, { id: 'fil_2', path: 'README.md', is_directory: false }, { id: 'dir', path: 'src', is_directory: true }] });
        if (url === '/api/v1/beyond/council') {
          councilBody = JSON.parse(String(init?.body));
          return json({ result });
        }
        if (url === '/api/v1/beyond/immunity') return json({ vaccines: [] });
        return json({}, 404);
      }),
    );
    renderAt('/beyond?tab=council');
    const select = await screen.findByRole('combobox', { name: 'File' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    // Code files are listed first; directories are not offered.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick a file…', 'src/db.ts', 'README.md']);
    await userEvent.selectOptions(select, 'fil_1');
    await userEvent.click(screen.getByRole('button', { name: 'Convene the Council' }));
    expect(await screen.findByTestId('council-result')).toHaveTextContent('Do not ship');
    expect(councilBody).toEqual({ projectId: 'prj_1', fileId: 'fil_1', withAi: false });
    expect(screen.getByText('SQL built by string concatenation')).toBeInTheDocument();
    expect(screen.getByText('· line 4')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Vaccinate' }));
    // The Immunity tab opens with the form filled in; saving is still the user's choice.
    expect(await screen.findByRole('tab', { name: /Immunity/, selected: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('SQL built by string concatenation'));
    expect(screen.getByLabelText('Pattern')).toHaveValue("query('SELECT * FROM users WHERE id=' + id)");
    expect(screen.getByLabelText('Severity')).toHaveValue('HIGH');
  });

  it('adds a vaccine, scans every project and shows where it was found', async () => {
    const vaccine = { id: 'vac_1', name: 'Token logged', pattern: 'console.log(token', kind: 'literal', fileGlob: null, fixNote: 'Never log tokens', severity: 'HIGH', lastScanAt: null, lastMatchCount: 0, lastMatches: [] };
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/projects') return json({ projects: [PROJECT] });
        if (url === '/api/v1/beyond/immunity' && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return json({ vaccine }, 201);
        }
        if (url === '/api/v1/beyond/immunity') return json({ vaccines: [] });
        if (url === '/api/v1/beyond/immunity/scan')
          return json({
            vaccines: [{ ...vaccine, lastScanAt: new Date().toISOString(), lastMatchCount: 1, lastMatches: [{ projectId: 'prj_1', projectName: 'Shop', path: 'src/auth.ts', line: 9, preview: 'console.log(token)' }] }],
            projectsScanned: 1,
            filesScanned: 7,
            failed: [],
          });
        return json({}, 404);
      }),
    );
    renderAt('/beyond?tab=immunity');
    expect(await screen.findByTestId('immunity-empty')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Token logged');
    await userEvent.type(screen.getByLabelText('Pattern'), 'console.log(token');
    await userEvent.type(screen.getByLabelText('How to fix'), 'Never log tokens');
    await userEvent.click(screen.getByRole('button', { name: 'Add vaccine' }));
    expect(await screen.findByTestId('vaccine')).toHaveTextContent('Token logged');
    expect(posted).toMatchObject({ name: 'Token logged', pattern: 'console.log(token', kind: 'literal', fileGlob: null, fixNote: 'Never log tokens', severity: 'MEDIUM' });
    await userEvent.click(screen.getByRole('button', { name: 'Scan all projects' }));
    expect(await screen.findByTestId('immunity-scan')).toHaveTextContent('Checked 7 files in 1 project.');
    expect(screen.getByText('1 match')).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts:9')).toBeInTheDocument();
  });

  it('runs the Night Shift now and saves the schedule', async () => {
    let put: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/projects') return json({ projects: [PROJECT] });
        if (url === '/api/v1/beyond/night-shift/run')
          return json({
            report: {
              id: 'nsr_1',
              trigger: 'manual',
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              summary: {
                headline: 'Shop warmed 3° to 45°; 1 file needs a fix first',
                projects: [{ id: 'prj_1', name: 'Shop', temperature: 45, level: 'WARM', delta: 3, hottest: [] }],
                council: [{ projectId: 'prj_1', projectName: 'Shop', path: 'src/db.ts', verdict: 'FIX_FIRST', top: ['SQL built by string concatenation'] }],
                immunity: [{ vaccineId: 'vac_1', name: 'Token logged', matches: 2 }],
                filesReviewed: 1,
                durationMs: 1200,
                errors: [],
              },
            },
          });
        if (url === '/api/v1/beyond/night-shift/settings') {
          put = JSON.parse(String(init?.body));
          return json({ settings: put });
        }
        if (url === '/api/v1/beyond/night-shift') return json({ reports: [], settings: { enabled: false, hour: 2 } });
        return json({}, 404);
      }),
    );
    renderAt('/beyond?tab=night');
    expect(await screen.findByTestId('night-empty')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const report = await screen.findByTestId('night-report');
    expect(report).toHaveTextContent('Shop warmed 3° to 45°; 1 file needs a fix first');
    expect(report).toHaveTextContent('Token logged: 2 matches');
    expect(report).toHaveTextContent('Council reviewed 1 file changed today');
    expect(report).toHaveTextContent('1.2s');
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
    await userEvent.click(screen.getByTestId('night-enabled'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'At' }), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(put).toEqual({ enabled: true, hour: 3 }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
  });

  it('checks a teleport bundle before importing it', async () => {
    const sent: { url: string; type: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/projects') return json({ projects: [PROJECT] });
        if (url.startsWith('/api/v1/beyond/teleport/')) sent.push({ url, type: new Headers(init?.headers).get('Content-Type') });
        if (url === '/api/v1/beyond/teleport/verify') return json({ name: 'Shop', createdAt: new Date().toISOString(), fileCount: 3, memoryCount: 1, signedHere: false, intact: true });
        if (url === '/api/v1/beyond/teleport/import')
          return json({ imported: { projectId: 'prj_2', name: 'Shop (teleported)', fileCount: 3, memoryCount: 1, signedHere: false, skipped: [] } }, 201);
        return json({}, 404);
      }),
    );
    renderAt('/beyond?tab=teleport');
    const input = await screen.findByLabelText('Teleport bundle');
    const file = new File([new Uint8Array([31, 139, 8, 0])], 'shop.ccteleport', { type: 'application/octet-stream' });
    if (typeof file.arrayBuffer !== 'function') Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([31, 139, 8, 0]).buffer });
    await userEvent.upload(input, file);
    const verified = await screen.findByTestId('teleport-verified');
    expect(verified).toHaveTextContent('Intact.');
    expect(verified).toHaveTextContent('3 files · 1 memories');
    expect(verified).toHaveTextContent('Sealed by a different CodeConClave server');
    await userEvent.click(screen.getByRole('button', { name: 'Import as a new project' }));
    expect(await screen.findByTestId('teleport-imported')).toHaveTextContent('Created Shop (teleported) with 3 files and 1 memories.');
    expect(sent).toEqual([
      { url: '/api/v1/beyond/teleport/verify', type: 'application/octet-stream' },
      { url: '/api/v1/beyond/teleport/import', type: 'application/octet-stream' },
    ]);
  });

  it('shows the Limit Guard reason when the plan is missing', async () => {
    const hits: unknown[] = [];
    const on = (e: Event) => hits.push((e as CustomEvent).detail);
    window.addEventListener('cc:usage-limit-hit', on);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/v1/projects') return json({ projects: [PROJECT] });
        return json({ code: 'plan_required', message: 'This needs an active plan.' }, 402);
      }),
    );
    renderAt('/beyond?tab=night');
    expect(await screen.findByRole('alert')).toHaveTextContent('This needs an active plan.');
    window.removeEventListener('cc:usage-limit-hit', on);
    expect(hits).toEqual([expect.objectContaining({ code: 'plan_required' })]);
  });
});

describe('Beyond helpers', () => {
  it('turns a finding into a vaccine draft, but never a hidden credential', () => {
    const f: CouncilFinding = { lens: 'security', rule: 'eval', severity: 'HIGH', line: 2, title: 'eval() runs text as code', evidence: 'eval(input)', fix: 'Parse it instead.' };
    expect(draftFromFinding(f)).toEqual({ name: 'eval() runs text as code', pattern: 'eval(input)', kind: 'literal', fixNote: 'Parse it instead.', severity: 'HIGH' });
    expect(draftFromFinding({ ...f, evidence: '[value hidden]' })).toBeNull();
    expect(draftFromFinding({ ...f, evidence: 'x' })).toBeNull();
    expect(draftFromFinding({ ...f, rule: 'no-tests', line: null, evidence: 'db.test.* not found' })).toBeNull();
  });

  it('reads the bundle filename from the download header', () => {
    expect(filenameFrom('attachment; filename="shop.ccteleport"', 'project.ccteleport')).toBe('shop.ccteleport');
    expect(filenameFrom(null, 'project.ccteleport')).toBe('project.ccteleport');
  });

  it('lays the gravity map out the same way every time', () => {
    const map: GravityMap = {
      nodes: [
        { path: 'a.ts', folder: '.', inDegree: 2, outDegree: 0, cluster: 0 },
        { path: 'b.ts', folder: '.', inDegree: 0, outDegree: 1, cluster: 0 },
        { path: 'c.ts', folder: '.', inDegree: 0, outDegree: 1, cluster: 0 },
      ],
      edges: [
        { from: 'b.ts', to: 'a.ts' },
        { from: 'c.ts', to: 'a.ts' },
      ],
      constellations: [{ id: 0, files: ['a.ts', 'b.ts', 'c.ts'], mainFolder: '.', cohesion: 1 }],
      wells: [{ path: 'a.ts', dependents: 2 }],
      drifters: [],
      misplaced: [],
      unresolved: 0,
    };
    const one = layout(map);
    const two = layout(map);
    expect([...one.positions.entries()]).toEqual([...two.positions.entries()]);
    expect(one.positions.get('a.ts')!.r).toBeGreaterThan(one.positions.get('b.ts')!.r);
  });
});
