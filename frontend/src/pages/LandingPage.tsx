/**
 * CodeConClave — public landing page (marketing).
 * Shown to unauthenticated visitors at "/": brand, what it is, how it works,
 * a website section and a desktop installer download button. Same design
 * tokens as the app (global.css variables + cc-btn classes).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';

interface InstallInfo {
  available: boolean;
  version: string | null;
  sizeMB: number | null;
}

const DOWNLOAD_URL = '/api/v1/downloads/desktop';
const INFO_URL = '/api/v1/downloads/info';
const FOUNDER_EMAIL = 'medidisaharsh@gmail.com';

const STEPS: Array<{ n: string; title: string; body: string }> = [
  { n: '01', title: 'Create your account', body: 'Sign up with your email in a few seconds — account creation is instant and free, then pick a plan to unlock your workspace.' },
  { n: '02', title: 'Pick a plan', body: 'Solo starts at ₹999/mo, Team and API plans scale with you. Pay once, unpack immediately.' },
  { n: '03', title: 'Open your workspace', body: 'Chat with AI, manage projects, agents, files, terminals, memory and approvals — all in one place.' },
  { n: '04', title: 'Run it anywhere', body: 'Use the web app in any browser, or install the desktop app for your own machine.' },
];

export function LandingPage() {
  const [info, setInfo] = useState<InstallInfo>({ available: false, version: null, sizeMB: null });
  const [photoMissing, setPhotoMissing] = useState(false);

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

  const btn = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontWeight: 700,
    fontSize: 16,
    padding: '14px 26px',
    borderRadius: 12,
    textDecoration: 'none',
    transition: 'transform .12s ease, opacity .12s ease',
  } as const;

  return (
    <div style={{ minHeight: '100%', background: 'var(--cc-bg)', color: 'var(--cc-text)', fontFamily: 'Arial,Helvetica,sans-serif' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 32px',
          borderBottom: '1px solid var(--cc-border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BrandLogo height={32} />
          <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: 0.5 }}>CodeConClave</span>
        </div>
        <nav style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a
            href={`mailto:${FOUNDER_EMAIL}`}
            style={{ color: 'var(--cc-text)', fontSize: 14, fontWeight: 600, textDecoration: 'none' }}
            aria-label="Contact the founder"
          >
            Contact founder
          </a>
          <Link to="/login" className="cc-btn cc-btn--ghost">
            Sign in
          </Link>
          <Link to="/register" className="cc-btn cc-btn--gradient">
            Open web app
          </Link>
        </nav>
      </header>

      <main>
        <section
          style={{
            position: 'relative',
            background: '#000000',
            color: '#ffffff',
            padding: '72px 32px 96px',
            overflow: 'hidden',
          }}
        >
          <div style={{ maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
              <BrandLogo variant="lockup" height={72} />
            </div>
            <h1 style={{ fontSize: 44, lineHeight: 1.15, margin: '0 0 14px', letterSpacing: -0.5 }}>
              Your AI <span style={{ color: '#ffd400' }}>developer coworker</span>
            </h1>
            <p style={{ fontSize: 18, color: '#d4d4d8', margin: '0 auto 36px', maxWidth: 640, lineHeight: 1.6 }}>
              CodeConClave is a workspace where code, agents, memory and automation live together. Build with AI — on the web or
              on your desktop.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center' }}>
              <Link
                to="/register"
                style={{ ...btn, background: '#ffd400', color: '#000000' }}
                aria-label="Use CodeConClave in your browser"
              >
                Use in browser
              </Link>
              <a
                href={DOWNLOAD_URL}
                style={{ ...btn, background: '#ffffff', color: '#000000' }}
                aria-label="Download the desktop app"
              >
                Download for desktop
              </a>
              <a
                href={`mailto:${FOUNDER_EMAIL}`}
                style={{
                  ...btn,
                  background: 'transparent',
                  color: '#d4d4d8',
                  border: '1px solid #52525b',
                }}
                aria-label="Contact the founder"
              >
                Contact founder
              </a>
            </div>
            <p style={{ marginTop: 18, fontSize: 13, color: '#a1a1aa' }}>
              {info.available
                ? `Windows installer • v${info.version}${info.sizeMB ? ` • ${info.sizeMB} MB` : ''}`
                : 'Download available for Windows'}
            </p>
            <div
              style={{
                maxWidth: 560,
                margin: '26px auto 0',
                padding: '14px 18px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,212,0,0.35)',
                borderRadius: 12,
                textAlign: 'left',
                fontSize: 14,
                lineHeight: 1.6,
                color: '#e4e4e7',
              }}
            >
              <strong style={{ color: '#ffd400' }}>Installing on Windows:</strong> Microsoft Defender SmartScreen may say this app is
              unrecognized because it isn't signed yet. That's expected — click <strong>More info</strong> then{' '}
              <strong>Run anyway</strong>. The file comes straight from our servers and is safe.
            </div>
          </div>
        </section>

        <section style={{ maxWidth: 940, margin: '0 auto', padding: '64px 32px 24px' }}>
          <h2 style={{ fontSize: 30, margin: '0 0 10px', color: 'var(--cc-accent)' }}>What is CodeConClave?</h2>
          <p style={{ fontSize: 17, lineHeight: 1.7, margin: '0 0 10px', maxWidth: 760 }}>
            CodeConClave is a complete AI development workspace. Talk to AI, spin up agents, manage projects, files and
            terminals, keep a long-term memory, and review every change before it ships — one place for your whole build.
          </p>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: '#6b7280', margin: 0, maxWidth: 720 }}>
            Founded by{' '}
            <strong style={{ color: 'var(--cc-text)' }}>MEDIDI SAHARSH</strong>, built as a real, usage-ready product — with
            payments, email sign-in, and a desktop app — shipped at zero budget.
          </p>
        </section>

        <section style={{ maxWidth: 940, margin: '0 auto', padding: '32px 32px 72px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr',
              gap: 28,
              alignItems: 'center',
              background: 'var(--cc-surface)',
              border: '1px solid var(--cc-border)',
              borderRadius: 18,
              padding: 28,
            }}
          >
            <div
              style={{
                width: 200,
                height: 200,
                borderRadius: '50%',
                overflow: 'hidden',
                border: '3px solid #ffd400',
                background: '#000000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
              }}
            >
              {photoMissing ? (
                <span style={{ fontSize: 64, fontWeight: 800, color: '#ffd400' }}>MS</span>
              ) : (
                <img
                  src="/brand/founder-photo.jpg"
                  alt="MEDIDI SAHARSH — Founder of CodeConClave"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={() => setPhotoMissing(true)}
                />
              )}
            </div>
            <div>
              <h2 style={{ fontSize: 26, margin: '0 0 6px', color: 'var(--cc-accent)' }}>The 16-year-old founder behind it</h2>
              <p style={{ fontSize: 15, lineHeight: 1.7, margin: '0 0 12px', color: '#6b7280' }}>
                CodeConClave is made by <strong style={{ color: 'var(--cc-text)' }}>MEDIDI SAHARSH</strong> — a 16-year-old
                builder who shipped a complete product with <strong style={{ color: 'var(--cc-text)' }}>₹0</strong> budget:
                no funding, no paid tools, no shortcuts. Payments, email sign-in, a full AI workspace and a desktop app — all
                built from a single laptop.
              </p>
              <p style={{ fontSize: 15, lineHeight: 1.7, margin: 0, color: '#6b7280' }}>
                The story behind it is simple: if a teenager can ship this with nothing but free tools and late nights,
                imagine what the people using it can build.
              </p>
              <div style={{ marginTop: 18 }}>
                <a
                  href={`mailto:${FOUNDER_EMAIL}`}
                  className="cc-btn cc-btn--gradient"
                  aria-label="Contact the founder"
                >
                  Contact the founder
                </a>
                <p style={{ fontSize: 13, color: '#6b7280', margin: '10px 0 0' }}>
                  {FOUNDER_EMAIL}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section style={{ maxWidth: 940, margin: '0 auto', padding: '24px 32px 72px' }}>
          <h2 style={{ fontSize: 30, margin: '0 0 26px', color: 'var(--cc-accent)' }}>How it works</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 18 }}>
            {STEPS.map((s) => (
              <div
                key={s.n}
                style={{
                  background: 'var(--cc-surface)',
                  border: '1px solid var(--cc-border)',
                  borderRadius: 14,
                  padding: '20px 18px',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 800, color: '#ffd400' }}>{s.n}</div>
                <h3 style={{ fontSize: 17, margin: '8px 0 6px' }}>{s.title}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0, color: '#6b7280' }}>{s.body}</p>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 36 }}>
            <Link to="/register" className="cc-btn cc-btn--gradient">
              Start building
            </Link>
            <a href={DOWNLOAD_URL} className="cc-btn cc-btn--ghost">
              Download desktop app
            </a>
          </div>
        </section>
      </main>

      <footer
        style={{
          borderTop: '1px solid var(--cc-border)',
          padding: '28px 32px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          fontSize: 13,
          color: '#6b7280',
        }}
      >
        <span>© {new Date().getFullYear()} CodeConClave</span>
        <span>
          THANK YOU &lt;&lt;&lt; <strong style={{ color: 'var(--cc-text)' }}>MEDIDI SAHARSH (Founder of CodeConClave)</strong>
        </span>
      </footer>
    </div>
  );
}