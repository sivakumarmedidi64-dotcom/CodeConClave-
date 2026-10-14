import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { streamChat, type ChatStreamEvent } from '../lib/sse';
import { api } from '../lib/api';
import { armResponseSound, playResponseReadySound, loadResponseSoundEnabled } from '../lib/responseSound';
import { newClientId } from '../lib/continuity';
import { useAuth } from '../auth/AuthProvider';
import { ModelPicker } from './ModelPicker';
import { ThinkingMoon } from './ThinkingMoon';
import { ChatMarkdown } from './ChatMarkdown';
import { Icon } from './Icon';

const MODEL_KEY = 'cc:home:model';
const MODE_KEY = 'cc:home:chatmode';
const PLACEHOLDER = 'Ask anything\u2026';
const MAX_ATTACH_CHARS = 100000;

/** "Go to ideas" style navigation: the assistant travels with you through
    the app. Pure client-side routing over real routes — the model is never
    asked to fake navigation it cannot perform. */
const NAV_TARGETS: { path: string; hash?: string; label: string; keys: string[] }[] = [
  { path: '/home', label: 'Home', keys: ['home'] },
  { path: '/chat', label: 'Chat', keys: ['chat'] },
  { path: '/coworker', label: 'Coworker', keys: ['coworker', 'cowork'] },
  { path: '/coworker', hash: '#email', label: 'Mail', keys: ['mail', 'email', 'inbox', 'gmail'] },
  { path: '/coworker', hash: '#scan', label: 'Code Map', keys: ['code map', 'codemap', 'scan', 'project scan'] },
  { path: '/ideas', label: 'Ideas', keys: ['ideas', 'idea'] },
  { path: '/work', label: 'Tasks', keys: ['tasks', 'task', 'work'] },
  { path: '/approvals', label: 'Approvals', keys: ['approvals', 'approval'] },
  { path: '/files', label: 'Files', keys: ['files', 'file'] },
  { path: '/terminal', label: 'Terminal', keys: ['terminal'] },
  { path: '/teams', label: 'Teams', keys: ['teams', 'team'] },
  { path: '/projects', label: 'Projects', keys: ['projects', 'project'] },
  { path: '/agents', label: 'Agents', keys: ['agents', 'agent'] },
  { path: '/remote', label: 'Remote', keys: ['remote', 'pairing', 'pair'] },
  { path: '/plugins', label: 'Connectors', keys: ['connectors', 'connector', 'plugins', 'integrations'] },
  { path: '/settings', label: 'Settings', keys: ['settings', 'setting'] },
  { path: '/memory', label: 'Memory', keys: ['memory'] },
  { path: '/history', label: 'History', keys: ['history'] },
];

export function parseNavCommand(text: string): { path: string; hash?: string; label: string; rest: string } | null {
  const m = text.trim().match(/^(?:go to|goto|open|show|take me to|navigate to)\s+(.+)$/i);
  if (!m) return null;
  let tail = m[1]!.trim().replace(/[.!\s]+$/, '');
  let rest = '';
  const split = tail.match(/^(.*?)(?:\s+and\s+|\s*[:,]\s+)(.+)$/i);
  if (split) {
    tail = split[1]!.trim();
    rest = split[2]!.trim();
  }
  const lower = ` ${tail.toLowerCase()} `;
  const hit = NAV_TARGETS.find((t) => t.keys.some((k) => lower.includes(` ${k}`) || lower.includes(`${k} tab`) || lower.includes(`${k} page`)));
  if (!hit) return null;
  return { path: hit.path, hash: hit.hash, label: hit.label, rest };
}

interface VoiceRecognizer {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type VoiceRecognizerCtor = new () => VoiceRecognizer;

function voiceRecognizerCtor(): VoiceRecognizerCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as VoiceRecognizerCtor | undefined;
  return typeof ctor === 'function' ? ctor : null;
}

interface Row {
  key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: boolean;
  decisionRecorded?: { id: string; title: string; status: string } | null;
}

export function HomeChat() {
  let authUser: { displayName?: string | null; name?: string | null } | null = null;
  try {
    authUser = useAuth().user as unknown as typeof authUser;
  } catch {
    authUser = null;
  }
  const firstName = (authUser?.displayName ?? authUser?.name ?? '').trim().split(/\s+/)[0] ?? '';
  const [typedLine, setTypedLine] = useState('');
  useEffect(() => {
    const full = 'SYSTEM ONLINE — ask, cowork, verified.';
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedLine(full.slice(0, i));
      if (i >= full.length) window.clearInterval(timer);
    }, 28);
    return () => window.clearInterval(timer);
  }, []);
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState<string | undefined>(() => localStorage.getItem(MODEL_KEY) ?? undefined);
  const [routing, setRouting] = useState<{ provider?: string; model?: string; reason?: string } | null>(null);
  const [chatMode, setChatMode] = useState<'CHAT' | 'COWORK'>(() => {
    const saved = localStorage.getItem(MODE_KEY) as string | null;
    return saved === 'CHAT' ? 'CHAT' : 'COWORK';
  });
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; content: string }[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => voiceRecognizerCtor() !== null);
  const navigate = useNavigate();
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<VoiceRecognizer | null>(null);

  const selectModel = (id: string) => {
    setModelId(id);
    if (id) localStorage.setItem(MODEL_KEY, id);
    else localStorage.removeItem(MODEL_KEY);
  };
  const handleRouting = useCallback((r: { provider?: string; model?: string; reason?: string } | null) => {
    setRouting(r);
  }, []);

  const selectMode = (next: 'CHAT' | 'COWORK') => {
    setChatMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  const contextLine = modelId === 'codeconclave-ai'
    ? 'CodeConClave AI · your 5 drivers, router picks 1 per task'
    : modelId
      ? `Model: ${modelId}`
      : `Context: AUTO${routing?.provider ? ` → ${routing.provider}/${routing.model ?? ''}` : ''}${routing?.reason ? ` · ${routing.reason}` : ' · router decides per turn'}`;

  useEffect(() => {
    // Follow the conversation upward: newest rows append at the bottom, so
    // keep the latest visible as messages stream in.
    const el = listRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, [rows]);

  useEffect(() => {
    let online = false;
    void loadResponseSoundEnabled();
    // Agent-mode availability comes from real device presence: an online
    // paired device means the model can drive this laptop; otherwise the
    // Agent toggle stays disabled with a pairing hint (never a dead switch).
    const check = () =>
      api<{ devices: { id: string; presence: string }[] }>('/api/v1/local-workspace/devices')
        .then((d) => {
          online = (d.devices ?? []).some((x) => x.presence === 'ONLINE');
          setAgentOnline(online);
        })
        .catch(() => setAgentOnline(false));
    void check();
    // Re-poll while offline so pairing unlocks Agent mode without a reload.
    const timer = window.setInterval(() => {
      if (!online) void check();
    }, 20000);
    return () => window.clearInterval(timer);
  }, []);

  const onEvent = (asstKey: string, state: { receivedTerminal: boolean }) => (ev: ChatStreamEvent) => {
    switch (ev.type) {
      case 'thinking_start':
        setRows((prev) => prev.map((m) => (m.key === asstKey ? { ...m, thinking: true } : m)));
        break;
      case 'delta':
        setRows((prev) => prev.map((m) => (m.key === asstKey ? { ...m, content: m.content + ev.data.delta, thinking: false } : m)));
        break;
      case 'error':
        state.receivedTerminal = true;
        setRows((prev) => [
          ...prev.map((m) => (m.key === asstKey ? { ...m, thinking: false } : m)),
          { key: `s:${Date.now()}`, role: 'system', content: ev.data.message },
        ]);
        break;
      case 'limit_reached':
        state.receivedTerminal = true;
        setRows((prev) => [
          ...prev.map((m) => (m.key === asstKey ? { ...m, thinking: false } : m)),
          { key: `s:${Date.now()}`, role: 'system', content: 'Usage limit reached for this rolling window.' },
        ]);
        break;
      case 'done':
        state.receivedTerminal = true;
        playResponseReadySound();
        setRows((prev) =>
          prev
            .map((m) => {
              if (m.key === asstKey && ev.data.decisionRecorded) return { ...m, decisionRecorded: ev.data.decisionRecorded };
              return { ...m, thinking: false };
            })
            .filter((m) => m.content.length > 0),
        );
        break;
    }
  };

  const pushSystem = useCallback((content: string) => {
    setRows((prev) => [...prev, { key: `s:${Date.now()}:${prev.length}`, role: 'system', content }]);
  }, []);

  const attachFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const picked = Array.from(files);
      if (picked.length > 5) pushSystem('Keeping the first 5 files — attach the rest separately.');
      for (const f of picked.slice(0, 5)) {
        const looksText =
          (f.type || '').startsWith('text/') ||
          /\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|py|java|kt|log|yaml|yml|xml|html|css|sql|sh)$/i.test(f.name);
        if (!looksText || f.size > MAX_ATTACH_CHARS) {
          pushSystem(`Skipped ${f.name} — text files under 100 KB only.`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result ?? '').slice(0, MAX_ATTACH_CHARS);
          setAttachments((prev) => [...prev.filter((a) => a.name !== f.name), { name: f.name, content: text }]);
        };
        reader.onerror = () => pushSystem(`Could not read ${f.name}.`);
        reader.readAsText(f);
      }
    },
    [pushSystem],
  );

  const toggleVoice = useCallback(() => {
    if (voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setListening(false);
      return;
    }
    const Ctor = voiceRecognizerCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onresult = (e) => {
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) {
        const alt = e.results[i]?.[0];
        if (alt) parts.push(alt.transcript);
      }
      const said = parts.join(' ').trim();
      if (said) setInput((prev) => (prev ? `${prev} ${said}` : said));
    };
    rec.onerror = () => {
      voiceRef.current = null;
      setListening(false);
    };
    rec.onend = () => {
      voiceRef.current = null;
      setListening(false);
    };
    voiceRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      voiceRef.current = null;
    }
  }, []);

  const send = async () => {
    let content = input.trim();
    if ((!content && attachments.length === 0) || streaming) return;
    // "Go to ideas" — travel through the app first, then keep talking.
    // Pure destinations navigate (this composer unmounts on arrival, so a
    // command carrying a task stays here and answers in place instead of
    // stranding the message on a dead screen).
    const nav = parseNavCommand(content);
    if (nav && !nav.rest) {
      setInput('');
      navigate(nav.hash ? { pathname: nav.path, hash: nav.hash } : nav.path);
      return;
    }
    if (nav && nav.rest) {
      pushSystem(`Staying here so nothing is lost — say "go to ${nav.label}" alone to travel there.`);
      content = nav.rest;
    }
    if (attachments.length > 0) {
      const ctx = attachments
        .map((a) => `[Attached file: ${a.name}]\n\`\`\`\n${a.content}\n\`\`\``)
        .join('\n\n');
      content = content ? `${content}\n\n${ctx}` : ctx;
      setAttachments([]);
    }
    if (!content || streaming) return;
    setInput('');
    const userKey = `u:${Date.now()}`;
    const asstKey = `a:${Date.now()}`;
    setRows((prev) => [...prev, { key: userKey, role: 'user', content }, { key: asstKey, role: 'assistant', content: '', thinking: true }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    armResponseSound();
    const state = { receivedTerminal: false };
    // Home offers Chat + Cowork only. Agent driving lives in the sidebar
    // (/agents + Remote pairing) — home never sends AGENT.
    const effectiveMode = chatMode === 'COWORK' ? 'COWORK' : 'CHAT';
    // 'codeconclave-ai' is the frontend resident label — the server registry
    // doesn't carry it yet, so send AUTO and let the router decide. Full
    // weight-serving lands with the LOCAL_DRIVER_URLS hook (no arc change).
    const outModelId = modelId === 'codeconclave-ai' ? undefined : modelId;
    try {
      await streamChat({ content, mode: effectiveMode, modelId: outModelId, clientId: newClientId() }, onEvent(asstKey, state), controller.signal);
    } catch (err) {
      state.receivedTerminal = true;
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (!aborted) {
        setRows((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: err instanceof Error ? err.message : 'Stream failed.' }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (!state.receivedTerminal) {
        setRows((prev) => [
          ...prev.filter((m) => m.key !== asstKey),
          { key: `s:${Date.now()}`, role: 'system', content: 'Connection interrupted \u2014 the stream closed before the response completed.' },
        ]);
      }
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  return (
    <div className={`cc-homechat cc-homechat--normal${rows.length === 0 ? ' cc-homechat--empty' : ''}`}>
      {rows.length === 0 && (
        <div className="cc-homechat__hero" data-testid="homechat-hero">
          <h1 className="cc-homechat__hi">Hi{firstName ? ` ${firstName}` : ''}</h1>
          <p className="cc-homechat__sysline" aria-live="polite">
            <span className="cc-homechat__sysline-3d">{typedLine}</span>
            <span className="cc-homechat__caret" aria-hidden="true">▌</span>
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <div className="cc-homechat__log" ref={listRef}>
          {rows.map((row) => (
            <div key={row.key} className={`cc-homechat__row cc-homechat__row--${row.role}`}>
              {row.role === 'assistant' && row.thinking ? (
                <div className="cc-homechat__bubble cc-homechat__bubble--assistant cc-homechat__thinking">
                  <span className="cc-think-dots">
                    <i /><i /><i />
                  </span>
                  <span>CodeConClave is thinking&hellip;</span>
                </div>
              ) : (
                <div className={`cc-homechat__bubble cc-homechat__bubble--${row.role}`}>
                  {row.role === 'assistant' ? <ChatMarkdown text={row.content} /> : row.content}
                </div>
              )}
            </div>
          ))}
          {streaming && rows[rows.length - 1]?.key !== rows.find((r) => r.role === 'assistant' && r.thinking)?.key && (
            <div className="cc-homechat__row cc-homechat__row--assistant">
              <div className="cc-homechat__bubble cc-homechat__thinking">
                <span className="cc-think-dots">
                  <i /><i /><i />
                </span>
                <span>CodeConClave is thinking&hellip;</span>
              </div>
            </div>
          )}
        </div>
      )}

      {streaming && (
        <div className="cc-homechat__moon" data-testid="homechat-thinking-moon">
          <ThinkingMoon active streaming={rows.some((r) => r.role === 'assistant' && !r.thinking && r.content.length > 0)} />
        </div>
      )}
      {streaming && chatMode === 'COWORK' && (
        <p className="cc-hint" data-testid="homechat-status">
          Specialist team is running your task — watch <Link to="/work">Tasks</Link> for live progress.
        </p>
      )}
      <p className="cc-hint" data-testid="homechat-agent-hint">
        Laptop driving lives under <Link to="/agents">Agents</Link> + <Link to="/remote">Remote</Link> — home stays Chat / Cowork.
      </p>

      {attachments.length > 0 && (
        <div className="cc-homechat__attachments" data-testid="homechat-attachments">
          {attachments.map((a) => (
            <span key={a.name} className="cc-chip">
              {a.name}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.name !== a.name))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="cc-home__command cc-homechat__bar cc-homechat__bar--normal">
        <Icon name="spark" size={16} className="cc-homechat__icon" />        <textarea
          ref={inputRef}
          rows={2}
          className="cc-homechat__input cc-homechat__input--normal"
          style={{ maxHeight: 140 }}
          aria-label="Message CodeConClave"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={PLACEHOLDER}
        />
        <ModelPicker value={modelId} onChange={selectModel} onRouting={handleRouting} residentOnly />
        <input
          ref={fileRef}
          type="file"
          multiple
          className="cc-sr-only"
          data-testid="homechat-file"
          aria-label="Attach text files"
          onChange={(e) => {
            attachFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          data-testid="homechat-attach"
          className="cc-icon-btn"
          aria-label="Attach files"
          title="Attach text files (they travel with your next message)"
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="file" size={15} />
        </button>
        {voiceSupported && (
          <button
            type="button"
            data-testid="homechat-voice"
            className="cc-icon-btn"
            aria-label={listening ? 'Stop listening' : 'Dictate with your voice'}
            aria-pressed={listening}
            title={listening ? 'Stop listening' : 'Dictate with your voice'}
            onClick={toggleVoice}
          >
            <Icon name="radio" size={15} />
          </button>
        )}
        <div className="cc-toggle" role="tablist" aria-label="Home chat mode" data-testid="homechat-mode">
          <button type="button" className={chatMode === 'CHAT' ? 'on' : ''} onClick={() => selectMode('CHAT')} aria-pressed={chatMode === 'CHAT'}>
            Chat
          </button>
          <button type="button" className={chatMode === 'COWORK' ? 'on' : ''} onClick={() => selectMode('COWORK')} aria-pressed={chatMode === 'COWORK'} title="Planned task with the specialist team (architect, coder, reviewer, tester…)">
            Cowork
          </button>
        </div>
        {streaming ? (
          <button
            className="cc-btn cc-btn--danger cc-btn--sm cc-homechat__action"
            type="button"
            onClick={stop}
            aria-label="Stop response"
          >
            <Icon name="close" size={13} />
            Stop
          </button>
        ) : (
          <button
            className="cc-btn cc-btn--primary cc-btn--sm cc-homechat__action"
            type="button"
            disabled={!input.trim() && attachments.length === 0}
            onClick={() => void send()}
          >
            <Icon name="send" size={13} />
            Send
          </button>
        )}
      </div>

      <div className="cc-homechat__context cc-hint" data-testid="homechat-context">
        {contextLine}
      </div>
      {agentOnline === false && (
        <p className="cc-hint" data-testid="homechat-pair-hint">
          Agent mode needs your laptop paired — <Link to="/remote">pair it on the Remote page</Link>, then the model can
          work your real files and terminal from here.
        </p>
      )}
    </div>
  );
}
