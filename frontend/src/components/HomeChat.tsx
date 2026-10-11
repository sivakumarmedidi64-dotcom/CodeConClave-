import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatStreamEvent } from '../lib/sse';
import { api } from '../lib/api';
import { armResponseSound, playResponseReadySound, loadResponseSoundEnabled } from '../lib/responseSound';
import { newClientId } from '../lib/continuity';
import { ModelPicker } from './ModelPicker';
import { ThinkingMoon } from './ThinkingMoon';
import { Icon } from './Icon';

const MODEL_KEY = 'cc:home:model';
const MODE_KEY = 'cc:home:chatmode';
const PLACEHOLDER = 'Ask anything\u2026';

interface Row {
  key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: boolean;
  decisionRecorded?: { id: string; title: string; status: string } | null;
}

export function HomeChat() {
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState<string | undefined>(() => localStorage.getItem(MODEL_KEY) ?? undefined);
  const [routing, setRouting] = useState<{ provider?: string; model?: string; reason?: string } | null>(null);
  const [chatMode, setChatMode] = useState<'CHAT' | 'AGENT' | 'COWORK'>(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === 'AGENT' || saved === 'COWORK' ? saved : 'CHAT';
  });
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const selectModel = (id: string) => {
    setModelId(id);
    if (id) localStorage.setItem(MODEL_KEY, id);
    else localStorage.removeItem(MODEL_KEY);
  };
  const handleRouting = useCallback((r: { provider?: string; model?: string; reason?: string } | null) => {
    setRouting(r);
  }, []);

  const selectMode = (next: 'CHAT' | 'AGENT' | 'COWORK') => {
    if (next === 'AGENT' && agentOnline !== true) return;
    setChatMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  const contextLine = modelId
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
    void loadResponseSoundEnabled();
    // Agent-mode availability comes from real device presence: an online
    // paired device means the model can drive this laptop; otherwise the
    // Agent toggle stays disabled with a pairing hint (never a dead switch).
    void api<{ devices: { id: string; presence: string }[] }>('/api/v1/local-workspace/devices')
      .then((d) => setAgentOnline((d.devices ?? []).some((x) => x.presence === 'ONLINE')))
      .catch(() => setAgentOnline(false));
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

  const send = async () => {
    const content = input.trim();
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
    // Agent mode reaches the laptop-driving loop; without an online device we
    // never send AGENT (the toggle is disabled too — belt and suspenders).
    // Cowork mode opens the persisted task + specialist pipeline.
    const effectiveMode = chatMode === 'AGENT' && agentOnline === true ? 'AGENT' : chatMode === 'COWORK' ? 'COWORK' : 'CHAT';
    try {
      await streamChat({ content, mode: effectiveMode, modelId, clientId: newClientId() }, onEvent(asstKey, state), controller.signal);
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
    <div className={`cc-homechat${rows.length === 0 ? ' cc-homechat--empty' : ''}`}>
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
                  {row.content}
                  {row.decisionRecorded && (
                    <Link
                      className="cc-homechat__decision"
                      to="/memory"
                      title="Open Memory to replay, inspect sources, or export"
                      aria-label={`Decision recorded: ${row.decisionRecorded.title} (${row.decisionRecorded.status}). Open Memory to inspect sources.`}
                    >
                      <Icon name="spark" size={12} />
                      Decision recorded: {row.decisionRecorded.title} ({row.decisionRecorded.status}) — view in Memory
                    </Link>
                  )}
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

      <div className="cc-home__command cc-homechat__bar">
        <Icon name="spark" size={16} className="cc-homechat__icon" />        <textarea
          ref={inputRef}
          rows={1}
          className="cc-homechat__input"
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
        <ModelPicker value={modelId} onChange={selectModel} onRouting={handleRouting} />
        <div className="cc-toggle" role="tablist" aria-label="Home chat mode" data-testid="homechat-mode">
          <button type="button" className={chatMode === 'CHAT' ? 'on' : ''} onClick={() => selectMode('CHAT')} aria-pressed={chatMode === 'CHAT'}>
            Chat
          </button>
          <button type="button" className={chatMode === 'COWORK' ? 'on' : ''} onClick={() => selectMode('COWORK')} aria-pressed={chatMode === 'COWORK'} title="Planned task with the specialist team (architect, coder, reviewer, tester…)">
            Cowork
          </button>
          <button
            type="button"
            className={chatMode === 'AGENT' ? 'on' : ''}
            onClick={() => selectMode('AGENT')}
            aria-pressed={chatMode === 'AGENT'}
            disabled={agentOnline !== true}
            title={agentOnline === true ? 'The model can run commands and work files on this laptop via your paired agent' : 'Pair your laptop first (Remote page) to enable Agent mode'}
          >
            Agent
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
            disabled={!input.trim()}
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
