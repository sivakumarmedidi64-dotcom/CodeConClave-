import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatStreamEvent } from '../lib/sse';
import { armResponseSound, playResponseReadySound, loadResponseSoundEnabled } from '../lib/responseSound';
import { newClientId } from '../lib/continuity';
import { ModelPicker } from './ModelPicker';
import { Icon } from './Icon';

const MODEL_KEY = 'cc:home:model';
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

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' });
    else el.scrollTop = 0;
  }, [rows]);

  useEffect(() => {
    void loadResponseSoundEnabled();
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
    try {
      await streamChat({ content, mode: 'CHAT', modelId, clientId: newClientId() }, onEvent(asstKey, state), controller.signal);
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
    <div className="cc-homechat">
      <div className="cc-home__command cc-homechat__bar">
        <Icon name="spark" size={16} className="cc-homechat__icon" />
        <textarea
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
        <ModelPicker value={modelId} onChange={selectModel} />
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

      {rows.length > 0 && (
        <div className="cc-homechat__log" ref={listRef}>
          {[...rows].reverse().map((row) => (
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

      <div className="cc-homechat__foot">
        <Link className="cc-hint cc-homechat__more" to="/chat">
          Open full chat <span aria-hidden="true">&rarr;</span>
        </Link>
      </div>
    </div>
  );
}
