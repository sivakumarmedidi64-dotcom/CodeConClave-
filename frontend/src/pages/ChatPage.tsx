/**
 * CodeConClave — Chat workspace.
 * - CHAT/COWORK mode switch (inside the workspace, not the sidebar);
 *   ?mode= URL param (command palette) restores the mode
 * - single model dropdown in the composer
 * - SSE streaming via POST /api/v1/conversations/chat
 * - AI Thinking Moon while a real generation is in progress (reduced
 *   intensity once the response streams; gone completely on completion)
 * - Free Limit Moon overlay, only when the server reports the limit
 *   transition (limit_reached + showMoon) — never guessed, never replayed
 * - conversation scroll position is persisted and restored (continuity)
 * - slash commands: /idea (captures a memory), /new, /cowork, /chat
 * - Esc cancels the active stream; attachments upload to Files (honest:
 *   in-chat attachments are not part of the chat API yet)
 * - server-authoritative workspace restoration: current conversation,
 *   mode and model are persisted via /api/v1/workspace/state/:key
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, uploadForm } from '../lib/api';
import { streamChat } from '../lib/sse';
import type { ChatStreamEvent } from '../lib/sse';
import { ModelPicker } from '../components/ModelPicker';
import { ThinkingMoon } from '../components/ThinkingMoon';
import { FreeLimitMoon } from '../components/FreeLimitMoon';
import type { Conversation, Memory, Message, Project, WorkspaceStateEntry } from '../lib/types';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth/AuthProvider';

interface UiMessage {
  key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: boolean;
  /** Phase 17: message id of a replayed (missed) SSE message — dedupes replays. */
  replayId?: string;
}

const STATE_KEYS = {
  project: 'current_project',
  conversation: 'current_conversation',
  mode: 'current_mode',
  model: 'current_model',
  scroll: 'conversation_scroll',
} as const;

const SLASH_COMMANDS = [
  { id: '/idea', label: '/idea <text>', hint: 'Capture the text as an idea (saved to Memory)' },
  { id: '/new', label: '/new', hint: 'Start a new conversation' },
  { id: '/cowork', label: '/cowork', hint: 'Switch to Cowork mode' },
  { id: '/chat', label: '/chat', hint: 'Switch to Chat mode' },
];

export function ChatPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ui, setUi] = useState<UiMessage[]>([]);
  const [mode, setMode] = useState<'CHAT' | 'COWORK'>(searchParams.get('mode') === 'cowork' ? 'COWORK' : 'CHAT');
  const [modelId, setModelId] = useState<string>();
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming'>('idle');
  const [freeLimit, setFreeLimit] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const scrollTimerRef = useRef<number | null>(null);
  /** Phase 17: last confirmed `msg_<id>` per conversation (the SSE replay anchor). */
  const lastEventIdRef = useRef<Record<string, string>>({});
  /** Message ids already rendered (from loads or prior replays) — replay dedupe. */
  const renderedReplayRef = useRef<Set<string>>(new Set());

  const saveState = useCallback((key: string, value: Record<string, unknown>) => {
    void api(`/api/v1/workspace/state/${key}`, { method: 'PUT', body: { value } }).catch(() => {
      /* continuity is best-effort */
    });
  }, []);

  const loadConvs = useCallback(
    async (preserveSelection: boolean) => {
      try {
        const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
        const res = await api<{ conversations: Conversation[] }>(`/api/v1/conversations${q}`);
        setConvs(res.conversations);
        if (!preserveSelection && res.conversations.length > 0 && !convId) {
          setConvId(res.conversations[0]!.id);
        } else if (!res.conversations.some((c) => c.id === convId)) {
          setConvId(res.conversations[0]?.id ?? null);
        }
      } catch {
        /* ignore */
      }
    },
    [convId, projectId],
  );

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await api<{ messages: Message[] }>(`/api/v1/conversations/${id}/messages`);
      setMessages(res.messages);
      for (const m of res.messages) {
        // Seed replay dedupe with both forms so replayed `msg_<id>` deltas that
        // were already loaded (or streamed) are never rendered twice.
        renderedReplayRef.current.add(m.id);
        renderedReplayRef.current.add(`msg_${m.id}`);
      }
      setUi(
        res.messages.map((m) => ({
          key: m.id,
          role: m.role,
          content: m.content,
        })),
      );
      requestAnimationFrame(() => {
        const savedTop = pendingScrollRef.current;
        if (savedTop !== null) {
          pendingScrollRef.current = null;
          listRef.current?.scrollTo({ top: savedTop });
        } else {
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
        }
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadConvs(false);
  }, [loadConvs]);

  useEffect(() => {
    if (convId) void loadMessages(convId);
  }, [convId, loadMessages]);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const [stateRes, projectsRes] = await Promise.all([
          api<{ state: WorkspaceStateEntry[] }>('/api/v1/workspace/state'),
          api<{ projects: Project[] }>('/api/v1/projects'),
        ]);
        if (cancelled) return;
        setProjects(projectsRes.projects.filter((p) => p.deleted_at === null && p.status !== 'ARCHIVED'));
        const byKey = new Map(stateRes.state.map((e) => [e.key, e.value]));
        const project = byKey.get(STATE_KEYS.project)?.projectId;
        const conversation = byKey.get(STATE_KEYS.conversation)?.conversationId;
        const savedMode = byKey.get(STATE_KEYS.mode)?.mode;
        const savedModel = byKey.get(STATE_KEYS.model)?.modelId;
        const savedScroll = byKey.get(STATE_KEYS.scroll)?.top;
        if (typeof project === 'string') setProjectId(project);
        if (savedMode === 'CHAT' || savedMode === 'COWORK') setMode(savedMode);
        if (typeof savedModel === 'string') setModelId(savedModel);
        if (typeof conversation === 'string') setConvId(conversation);
        if (typeof savedScroll === 'number') pendingScrollRef.current = savedScroll;
      } catch {
        /* restore is best-effort */
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const changeMode = (next: 'CHAT' | 'COWORK') => {
    setMode(next);
    saveState(STATE_KEYS.mode, { mode: next });
  };

  const changeModel = (next?: string) => {
    setModelId(next);
    if (next) saveState(STATE_KEYS.model, { modelId: next });
  };

  const createConv = async () => {
    try {
      const res = await api<{ conversation: Conversation }>('/api/v1/conversations', {
        method: 'POST',
        body: { title: 'New conversation', mode, projectId: projectId ?? undefined },
      });
      setConvs((prev) => [res.conversation, ...prev]);
      setConvId(res.conversation.id);
      setMessages([]);
      setUi([]);
      saveState(STATE_KEYS.conversation, { conversationId: res.conversation.id });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || streaming) return;
    setInput('');
    setStreaming(true);
    setPhase('thinking');
    const userKey = `u:${Date.now()}`;
    const asstKey = `a:${Date.now()}`;
    setUi((prev) => [
      ...prev,
      { key: userKey, role: 'user', content },
      { key: asstKey, role: 'assistant', content: '', thinking: true },
    ]);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    const abort = new AbortController();
    abortRef.current = abort;

    let streamEnded = false;
    let abortedByUser = false;

    const onEvent = (ev: ChatStreamEvent) => {
      if (ev.type === 'thinking_start') {
        setPhase('thinking');
        setUi((prev) => prev.map((m) => (m.key === asstKey ? { ...m, thinking: true } : m)));
      } else if (ev.type === 'delta') {
        setPhase('streaming');
        const delta = ev.data.delta;
        const replayId = ev.data.id ?? null;
        if (replayId) {
          // Replayed missed message (Phase 17): render once per message id —
          // a duplicate replay of the same id is skipped, never re-appended.
          if (renderedReplayRef.current.has(replayId)) return;
          renderedReplayRef.current.add(replayId);
          setUi((prev) => {
            const existing = prev.find((m) => m.replayId === replayId);
            if (existing) {
              return prev.map((m) => (m.replayId === replayId ? { ...m, content: m.content + delta } : m));
            }
            return [...prev, { key: `r:${replayId}`, role: 'assistant', content: delta, replayId }];
          });
          return;
        }
        setUi((prev) =>
          prev.map((m) =>
            m.key === asstKey ? { ...m, content: m.content + delta, thinking: false } : m,
          ),
        );
      } else if (ev.type === 'limit_reached') {
        streamEnded = true;
        setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: 'Free tier daily limit reached.' }]);
        if (ev.data.showMoon) setFreeLimit(true);
      } else if (ev.type === 'error') {
        streamEnded = true;
        setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: ev.data.message }]);
      } else if (ev.type === 'done') {
        streamEnded = true;
        const messageId = (ev.data as { messageId?: unknown }).messageId;
        if (convId && typeof messageId === 'string') {
          lastEventIdRef.current[convId] = `msg_${messageId}`;
        }
        setUi((prev) => prev.filter((m) => m.content.length > 0));
      }
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    };

    try {
      await streamChat(
        {
          content,
          conversationId: convId ?? undefined,
          projectId: projectId ?? undefined,
          mode,
          modelId,
        },
        onEvent,
        abort.signal,
        convId ? lastEventIdRef.current[convId] : undefined,
      );
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (aborted) {
        abortedByUser = true;
      } else {
        streamEnded = true;
        setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: err instanceof Error ? err.message : 'stream failed' }]);
      }
    } finally {
      setStreaming(false);
      setPhase('idle');
      abortRef.current = null;
      void loadConvs(false);
      if (convId) void loadMessages(convId);
    }
    // Silent disconnect (no done/error/limit event, no user cancel): the
    // stream closed without a terminal event — surface it honestly.
    if (!streamEnded && !abortedByUser) {
      setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: 'Connection interrupted — the stream closed before the response completed.' }]);
    }
  };

  /** Persist scroll position (debounced) for continuity across reloads/devices. */
  const onScrollSave = () => {
    const el = listRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      saveState(STATE_KEYS.scroll, { top: el.scrollTop });
    }, 500);
  };

  const selectConversation = (id: string) => {
    setConvId(id);
    saveState(STATE_KEYS.conversation, { conversationId: id });
  };

  const selectProject = (id: string | null) => {
    setProjectId(id);
    setConvId(null);
    setUi([]);
    setMessages([]);
    saveState(STATE_KEYS.project, { projectId: id ?? null });
  };

  const captureIdea = async (content: string) => {
    try {
      const created = await api<{ memory: Memory }>('/api/v1/memory', {
        method: 'POST',
        body: { type: 'SEMANTIC', source: 'USER_STATED', content },
      });
      await api(`/api/v1/memory/${created.memory.id}`, {
        method: 'PATCH',
        body: { structured: { idea: true } },
      });
      toast('Idea captured to Memory');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'idea failed', 'error');
    }
  };

  /** Slash commands run real actions; returns true when a command consumed the input. */
  const runSlash = async (value: string): Promise<boolean> => {
    const trimmed = value.trim();
    if (trimmed.startsWith('/idea ')) {
      const idea = trimmed.slice('/idea '.length).trim();
      if (idea) {
        setInput('');
        await captureIdea(idea);
        return true;
      }
      return false;
    }
    if (trimmed === '/new') {
      setInput('');
      await createConv();
      return true;
    }
    if (trimmed === '/cowork') {
      setInput('');
      changeMode('COWORK');
      return true;
    }
    if (trimmed === '/chat') {
      setInput('');
      changeMode('CHAT');
      return true;
    }
    return false;
  };

  const onComposerKey = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (streaming && abortRef.current) {
        abortRef.current.abort();
        toast('Generation cancelled');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim().startsWith('/')) {
        const consumed = await runSlash(input);
        if (consumed) return;
      }
      void send();
    }
  };

  const onAttach = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (!projectId) {
      toast('Select a project first — files are uploaded into a project', 'error');
      return;
    }
    const file = list[0]!;
    void api('/api/v1/files/upload', {
      method: 'POST',
      body: uploadForm([file], { projectId }),
    })
      .then(() => {
        toast(`Uploaded "${file.name}" to Files`);
        toast('In-chat attachments are not supported by the chat API yet — the file is available under Files.', 'error');
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'upload failed', 'error'));
    if (attachRef.current) attachRef.current.value = '';
    setAttachOpen(false);
  };

  const showSlash = input.trim().startsWith('/');

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h1>Chat</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="cc-input"
            style={{ width: 200 }}
            value={projectId ?? ''}
            onChange={(e) => selectProject(e.target.value || null)}
            aria-label="Project"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="cc-toggle" role="tablist" aria-label="Chat mode">
            <button className={mode === 'CHAT' ? 'on' : ''} onClick={() => changeMode('CHAT')} aria-pressed={mode === 'CHAT'}>
              Chat
            </button>
            <button className={mode === 'COWORK' ? 'on' : ''} onClick={() => changeMode('COWORK')} aria-pressed={mode === 'COWORK'}>
              Cowork
            </button>
          </div>
        </div>
      </div>
      <div className="cc-grid cc-chat-layout" style={{ gridTemplateColumns: '220px 1fr', flex: 1, minHeight: 0 }}>
        <div className="cc-card" style={{ overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <button className="cc-btn cc-btn--sm" onClick={() => void createConv()} style={{ marginBottom: 10 }}>
            + New conversation
          </button>
          {convs.map((c) => (
            <button
              key={c.id}
              className="cc-sidebar__item"
              style={{ color: 'var(--cc-text)' }}
              onClick={() => selectConversation(c.id)}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.title}
              </span>
              <span className="cc-pill" style={{ fontSize: 10 }}>
                {c.mode}
              </span>
            </button>
          ))}
        </div>
        <div className="cc-card cc-chat" style={{ minHeight: 0 }}>
          <div ref={listRef} className="cc-chat__messages" onScroll={onScrollSave}>
            {ui.length === 0 && <div className="cc-empty">Start a conversation.</div>}
            {ui.map((m) =>
              m.role === 'user' ? (
                <div key={m.key} className="cc-msg cc-msg--user">
                  {m.content}
                </div>
              ) : m.role === 'system' ? (
                <div key={m.key} className="cc-msg cc-msg--system">
                  {m.content}
                </div>
              ) : (
                <div key={m.key} className="cc-msg cc-msg--assistant">
                  {m.thinking && m.content === '' ? (
                    <span className="cc-think">thinking…</span>
                  ) : (
                    m.content
                  )}
                </div>
              ),
            )}
            {streaming && <ThinkingMoon active streaming={phase === 'streaming'} />}
          </div>
          <div className="cc-chat__composer">
            <div style={{ position: 'relative' }}>
              <button
                className="cc-btn cc-btn--ghost cc-btn--sm"
                onClick={() => setAttachOpen((o) => !o)}
                aria-label="Attach file"
                title="Attach a file (uploads to Files)"
              >
                📎
              </button>
              {attachOpen && (
                <div className="cc-popover" style={{ left: 0, bottom: 40, width: 300, padding: 10 }}>
                  <p className="cc-hint" style={{ margin: '0 0 8px' }}>
                    The chat API does not support attachments yet — files upload into the
                    current project&apos;s Files and can be referenced from there.
                  </p>
                  <button className="cc-btn cc-btn--sm" onClick={() => attachRef.current?.click()}>
                    Upload to Files…
                  </button>
                  <input
                    ref={attachRef}
                    type="file"
                    style={{ display: 'none' }}
                    aria-hidden="true"
                    tabIndex={-1}
                    onChange={(e) => onAttach(e.target.files)}
                  />
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {showSlash && !streaming && (
                <div className="cc-popover" style={{ bottom: '100%', left: 0, right: 0, marginBottom: 6 }}>
                  {SLASH_COMMANDS.map((c) => (
                    <button
                      key={c.id}
                      className="cc-popover__item"
                      onClick={() => {
                        setInput(c.id === '/idea' ? '/idea ' : c.id);
                      }}
                    >
                      <strong>{c.label}</strong>
                      <div className="cc-popover__hint">{c.hint}</div>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                className="cc-textarea"
                value={input}
                placeholder={
                  mode === 'CHAT' ? 'Message CodeConClave… (/idea, /new, /cowork, /chat)' : 'Brief a coworker (task auto-created)…'
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => void onComposerKey(e)}
              />
            </div>
            <ModelPicker value={modelId} onChange={changeModel} />
            <button className="cc-btn" disabled={streaming || !input.trim()} onClick={() => void send()}>
              {streaming ? 'Streaming…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
      {freeLimit && (
        <FreeLimitMoon
          name={user?.displayName}
          onUpgrade={() => {
            setFreeLimit(false);
            navigate('/settings');
          }}
          onClose={() => setFreeLimit(false)}
        />
      )}
    </div>
  );
}