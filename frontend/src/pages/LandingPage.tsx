/**
 * CodeConClave — public product entry (marketing).
 *
 * Structure: header -> hero -> web/desktop choice -> workflow comparison ->
 * about -> feature showcase -> early-access CTA -> footer.
 *
 * Payment is intentionally absent from this surface: early-access demo access
 * is handled server-side by temporary demo mode. Commercial plans stay in the
 * backend and reappear with the payment surface when demo mode is switched off.
 *
 * Styling is scoped to styles/landing.css so the in-app IDE theme is untouched.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import '../styles/landing.css';

interface InstallInfo {
  available: boolean;
  version: string | null;
  sizeMB: number | null;
}

const DOWNLOAD_URL = '/api/v1/downloads/desktop';
const INFO_URL = '/api/v1/downloads/info';

const PILLARS = ['Memory', 'Execution', 'Continuity', 'Team', 'Control'] as const;

const CHOICES = [
  {
    id: 'web',
    name: 'Web App',
    tag: 'Fastest to start',
    primary: true,
    description: 'Run CodeConClave in your browser.',
    points: ['No installation', 'Instant access', 'Works across devices', 'Best for quick access'],
    cta: 'Open Web App',
    to: '/register',
    external: false,
  },
  {
    id: 'desktop',
    name: 'Desktop App',
    tag: 'Full environment',
    primary: false,
    description: 'Use the full CodeConClave desktop environment.',
    points: [
      'Local project access',
      'Desktop workflow',
      'Local-agent capabilities where supported',
      'Best for development workflows',
    ],
    cta: 'Get Desktop App',
    to: DOWNLOAD_URL,
    external: true,
  },
] as const;

const TRADITIONAL = ['IDE', 'Chatbot', 'Task tracker', 'Terminal', 'Memory', 'Deployment'];
const CONCLAVE = ['Project context', 'AI agents', 'Execution', 'Verification', 'Memory', 'Continuity', 'Control'];
const DEVELOPER_CHAIN = ['Goal', 'Plan', 'Agent execution', 'Verification', 'Artifact', 'Memory', 'Continue'];

const ABOUT = [
  {
    title: 'Project memory',
    body: 'CodeConClave preserves project context, decisions and useful history, so you do not have to repeatedly re-explain the project.',
  },
  {
    title: 'AI agents',
    body: 'Specialized agents can handle architecture, coding, debugging, research, review, testing, security, DevOps, UI/UX and documentation where supported.',
  },
  {
    title: 'Execution',
    body: 'CodeConClave is designed to execute work, not only generate conversational answers.',
  },
  {
    title: 'Verification',
    body: 'Work can be checked through tests, diagnostics and execution verification before you accept it.',
  },
  {
    title: 'Continuity',
    body: 'Tasks, project context and durable state survive refreshes and sessions through the persistent backend architecture.',
  },
  {
    title: 'Control',
    body: 'You retain control through permissions, approvals, stop mechanisms, verification and auditability.',
  },
  {
    title: 'Team',
    body: 'Project and workspace collaboration with structured task workflows and shared project state.',
  },
  {
    title: 'Desktop and web',
    body: 'Reach the same system from a browser or from a desktop workflow on your own machine.',
  },
];

/**
 * Feature showcase. `status` is rendered as visible text, never colour-only, so
 * availability stays honest and legible: anything not fully live is labelled.
 */
const FEATURES: ReadonlyArray<{ title: string; body: string; status: 'Available now' | 'Plan dependent' | 'Proposed' }> = [
  { title: 'AI agent orchestration', body: 'Specialized agent roles run as an ordered pipeline over a shared project task.', status: 'Available now' },
  { title: 'Project memory', body: 'Durable project knowledge, decisions and digests that persist between sessions.', status: 'Available now' },
  { title: 'Persistent context', body: 'Project state and prior-stage context carry forward instead of resetting per turn.', status: 'Available now' },
  { title: 'Task execution', body: 'Structured tasks with risk levels, required approvals and human-in-the-loop dispatch.', status: 'Available now' },
  { title: 'Verification', body: 'Review passes, tests and diagnostics that check produced work rather than assuming it.', status: 'Available now' },
  { title: 'Artifact tracking', body: 'Produced artifacts are stored with a SHA-256 digest and byte count so output stays verifiable.', status: 'Available now' },
  { title: 'Continuity', body: 'Long-running and background work continues across refreshes, restarts and sessions.', status: 'Available now' },
  { title: 'Background work', body: 'A worker loop and scheduler claim queued tasks and report back into the workspace.', status: 'Available now' },
  { title: 'Terminal and tools', body: 'Integrated terminal access and tool-driven execution inside the project workspace.', status: 'Available now' },
  { title: 'Git and development workflows', body: 'Repository-aware code workspace and release workflows around your project.', status: 'Available now' },
  { title: 'Security', body: 'Secret guarding, security review roles and security operations reporting.', status: 'Available now' },
  { title: 'Auditability', body: 'An audit trail records what ran, what changed and what was verified.', status: 'Available now' },
  { title: 'Team workflows', body: 'Shared projects, team agents and collaborative task tracking.', status: 'Available now' },
  { title: 'API access', body: 'Programmatic access through managed API keys, released as its own plan.', status: 'Plan dependent' },
  { title: 'Desktop environment', body: 'A downloadable desktop build for local project access on your own machine.', status: 'Available now' },
  { title: 'Web environment', body: 'The complete workspace in a browser, served same-origin with the API.', status: 'Available now' },
  { title: 'Deployment integrations', body: 'Kuberns deployment is a proposed integration and partnership capability, not live today.', status: 'Proposed' },
];

export function LandingPage() {
  const [info, setInfo] = useState<InstallInfo>({ available: false, version: null, sizeMB: null });

  useEffect(() => {
    let cancelled = false;
    void fetch(INFO_URL)
      .then((r) => (r.ok ? (r.json() as Promise<{ available: boolean; version: string | null; sizeMB: number | null }>) : null))
      .then((data) => {
        if (cancelled) return;
        if (data) setInfo({ available: Boolean(data.available), version: data.version, sizeMB: data.sizeMB });
      })
      .catch(() => {
        if (!cancelled) setInfo({ available: false, version: null, sizeMB: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installLine = info.available
    ? `Windows installer · v${info.version}${info.sizeMB ? ` · ${info.sizeMB} MB` : ''}`
    : 'Windows installer';

  return (
    <div className="lp-root">
      <a className="lp-skip" href="#lp-main">
        Skip to content
      </a>

      <header className="lp-header">
        <div className="lp-header__inner">
          <Link to="/" className="lp-brand">
            <BrandLogo height={30} />
            <span>CodeConClave</span>
          </Link>
          <nav className="lp-nav" aria-label="Primary">
            <a className="lp-nav__link lp-nav__link--secondary" href="#lp-choose">
              Choose an app
            </a>
            <a className="lp-nav__link lp-nav__link--secondary" href="#lp-about">
              About
            </a>
            <a className="lp-nav__link lp-nav__link--secondary" href="#lp-features">
              Features
            </a>
            <Link to="/login" className="lp-btn lp-btn--ghost lp-btn--sm">
              Sign in
            </Link>
            <Link to="/register" className="lp-btn lp-btn--primary lp-btn--sm">
              Enter CodeConClave
            </Link>
          </nav>
        </div>
      </header>

      <main id="lp-main">
        {/* ------------------------------------------------------------ hero */}
        <section className="lp-hero">
          <div className="lp-shell lp-hero__inner">
            <p className="lp-badge">
              <span className="lp-badge__dot" aria-hidden="true" />
              Early Access
            </p>
            <h1 className="lp-hero__title">
              CodeConClave
              <br />{' '}
              <span className="lp-hero__accent">AI Developer &amp; Founder Operating System</span>
            </h1>
            <p className="lp-hero__lede">
              Build software with an AI operating layer that understands your project, executes work, verifies results and
              preserves context.
            </p>
            <div className="lp-hero__actions">
              <Link to="/register" className="lp-btn lp-btn--primary">
                Enter CodeConClave
              </Link>
              <Link to="/login" className="lp-btn lp-btn--ghost">
                Explore CodeConClave
              </Link>
            </div>
            <ul className="lp-pillars" aria-label="Core concepts">
              {PILLARS.map((p) => (
                <li key={p} className="lp-pillar">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------- web / desktop choice */}
        <section className="lp-choice" id="lp-choose">
          <div className="lp-shell">
            <div className="lp-section__head">
              <p className="lp-section__eyebrow">Get started</p>
              <h2 className="lp-section__title">Choose how you want to use CodeConClave</h2>
              <p className="lp-section__sub">
                Both options use the same account. Pick the environment that fits how you work.
              </p>
            </div>

            <div className="lp-choice__grid">
              {CHOICES.map((c) => (
                <article
                  key={c.id}
                  className={`lp-choice__card${c.primary ? ' lp-choice__card--primary' : ''}`}
                  aria-labelledby={`lp-choice-${c.id}-name`}
                >
                  <p className="lp-choice__tag">{c.tag}</p>
                  <h3 className="lp-choice__name" id={`lp-choice-${c.id}-name`}>
                    {c.name}
                  </h3>
                  <p className="lp-choice__desc">{c.description}</p>
                  <ul className="lp-choice__list">
                    {c.points.map((p) => (
                      <li key={p}>
                        <span className="lp-choice__check" aria-hidden="true">
                          ✓
                        </span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                  {c.external ? (
                    <a className="lp-btn lp-btn--block lp-btn--primary" href={c.to}>
                      {c.cta}
                    </a>
                  ) : (
                    <Link className="lp-btn lp-btn--block lp-btn--primary" to={c.to}>
                      {c.cta}
                    </Link>
                  )}
                  {c.id === 'desktop' ? <p className="lp-choice__meta">{installLine}</p> : null}
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ workflow framing */}
        <section className="lp-flow" aria-labelledby="lp-flow-title">
          <div className="lp-shell">
            <div className="lp-section__head">
              <p className="lp-section__eyebrow">Why it is different</p>
              <h2 className="lp-section__title" id="lp-flow-title">
                One workflow instead of six disconnected tools
              </h2>
            </div>

            <div className="lp-flow__grid">
              <div className="lp-flow__col">
                <p className="lp-flow__title">Traditional workflow</p>
                <div className="lp-flow__stack">
                  {TRADITIONAL.map((s) => (
                    <div key={s} className="lp-flow__step">
                      {s}
                    </div>
                  ))}
                </div>
                <p className="lp-flow__op" aria-hidden="true">
                  results in
                </p>
                <p className="lp-flow__result">Fragmented workflow</p>
              </div>

              <div className="lp-flow__col lp-flow__col--accent">
                <p className="lp-flow__title">CodeConClave</p>
                <div className="lp-flow__stack">
                  {CONCLAVE.map((s) => (
                    <div key={s} className="lp-flow__step">
                      {s}
                    </div>
                  ))}
                </div>
                <p className="lp-flow__op" aria-hidden="true">
                  results in
                </p>
                <p className="lp-flow__result">One AI development workflow</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- about */}
        <section className="lp-about" id="lp-about">
          <div className="lp-shell">
            <div className="lp-section__head">
              <p className="lp-section__eyebrow">About</p>
              <h2 className="lp-section__title">What is CodeConClave?</h2>
            </div>

            <p className="lp-about__lead">
              CodeConClave is an AI-native developer and founder operating system that brings project context, AI agents,
              execution, verification, memory, continuity and control into one workflow.
            </p>

            <div className="lp-about__grid">
              {ABOUT.map((a) => (
                <article key={a.title} className="lp-about__card">
                  <h3>{a.title}</h3>
                  <p>{a.body}</p>
                </article>
              ))}
            </div>

            <div className="lp-about__card" style={{ marginTop: 18 }}>
              <h3>Developer workflow</h3>
              <p>
                A task moves through the same loop every time, so progress stays visible and resumable instead of living in a
                chat transcript.
              </p>
              <div className="lp-chain">
                {DEVELOPER_CHAIN.map((step, i) => (
                  <span key={step} style={{ display: 'contents' }}>
                    {i > 0 ? (
                      <span className="lp-chain__arrow" aria-hidden="true">
                        →
                      </span>
                    ) : null}
                    <span className="lp-chain__node">{step}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="lp-about__card" style={{ marginTop: 18 }}>
              <h3>Deployment</h3>
              <p>
                Deployment integrations are part of the broader platform direction. Kuberns deployment is a proposed
                integration and partnership capability and is not live today.
              </p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- features */}
        <section className="lp-features" id="lp-features">
          <div className="lp-shell">
            <div className="lp-section__head">
              <p className="lp-section__eyebrow">Capabilities</p>
              <h2 className="lp-section__title">What CodeConClave does</h2>
              <p className="lp-section__sub">
                Availability is labelled honestly on every item, including what is still proposed rather than shipped.
              </p>
            </div>

            <div className="lp-features__grid">
              {FEATURES.map((f) => (
                <article key={f.title} className="lp-feature">
                  <h3 className="lp-feature__title">{f.title}</h3>
                  <p className="lp-feature__body">{f.body}</p>
                  <p
                    className={`lp-feature__status${f.status === 'Available now' ? ' lp-feature__status--live' : ''}`}
                  >
                    {f.status}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- cta */}
        <section className="lp-cta">
          <div className="lp-shell lp-cta__inner">
            <h2 className="lp-section__title">CodeConClave is currently available in Early Access</h2>
            <p className="lp-section__sub">
              Create an account and go straight into the workspace. No payment is required during early access.
            </p>
            <div className="lp-hero__actions">
              <Link to="/register" className="lp-btn lp-btn--primary">
                Enter CodeConClave
              </Link>
              <a href="#lp-choose" className="lp-btn lp-btn--ghost">
                Compare the apps
              </a>
            </div>
            <p className="lp-cta__note">Early access. Capabilities are labelled individually above.</p>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-shell lp-footer__inner">
          <span>© {new Date().getFullYear()} CodeConClave</span>
          <nav className="lp-footer__links" aria-label="Footer">
            <Link to="/login">Sign in</Link>
            <Link to="/register">Create account</Link>
            <a href={DOWNLOAD_URL}>Get Desktop App</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
