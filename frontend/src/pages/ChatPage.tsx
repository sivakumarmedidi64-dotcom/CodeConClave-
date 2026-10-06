/**
 * CodeConClave — Chat workspace.
 * - CHAT/COWORK mode switch (inside the workspace, not the sidebar)
 * - chat sidebar: new/search/rename/pin/archive/unarchive/delete + unread dots
 * - in-chat attachments (upload into the project, real progress, chips) — the
 *   chat API accepts attachments and fails closed on tampered/stale ids
 * - message actions: Copy (incl. fenced code blocks), Edit + Resend (PATCH
 *   preserves the audit trail + editCount, then a NEW assistant turn is
 *   streamed — history is never rewritten), Regenerate / Retry, 👍/👎 feedback
 *   (stored through the canonical per-message reaction rail), Share/Invite
 *   (canonical share links: role, one-time, expiry, revocation, audit)
 * - Stop / Continue on the canonical stream lifecycle (no second cancel system)
 * - response status pill (Thinking / Generating / Completed / Error / Stopped)
 * - keyboard: "?" opens shortcuts help; Esc cancels; Enter sends
 * - brand (canonical mark) in the empty state with useful actions
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { streamChat } from '../lib/sse';
import type { ChatStreamEvent } from '../lib/sse';
import { getContinuityCache, enqueuePendingMessage, newClientId, syncAllPending, pendingOutboxCount } from '../lib/continuity';
import { copyText, splitCodeBlocks } from '../lib/clipboard';
import { uploadFileWithProgress } from '../lib/upload';
import { armResponseSound, playResponseReadySound, loadResponseSoundEnabled } from '../lib/responseSound';
import { useEarlyAccess } from '../lib/accessMode';
import { ModelPicker } from '../components/ModelPicker';
import { AICompanion, type CompanionState } from '../components/AICompanion';
import { ThinkingMoon } from '../components/ThinkingMoon';
import { FreeLimitMoon } from '../components/FreeLimitMoon';
import { BrandLogo } from '../components/BrandLogo';
import { ChatSidebar } from '../components/ChatSidebar';
import { ShareInvitePopover } from '../components/ShareInvitePopover';
import { ShortcutsHelp } from '../components/ShortcutsHelp';
import type { Conversation, Memory, Message, Project, WorkspaceStateEntry } from '../lib/types';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth/AuthProvider';
import { VoiceControl, useVoice } from '../components/VoiceControl';
import { useVoiceCommands } from '../hooks/useVoiceCommands';
import { Icon } from '../components/Icon';

interface UiMessage {
  key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: boolean;
  /** Phase 17: message id of a replayed (missed) SSE message — dedupes replays. */
  replayId?: string;
  /** IMAGE_GENERATION: persisted file id + mime — the renderer shows the artifact. */
  image?: { fileId: string; mimeType: string } | null;
  /** EXTERNAL_AGENT: provider-reported run fact (never implies execution). */
  externalRun?: { externalId: string; status: string } | null;
  /** Continuity: message is queued locally (offline) awaiting exactly-once sync. */
  pending?: boolean;
  /** Continuity: the completed exchange recorded a decision — surface a chip. */
  decisionRecorded?: { id: string; title: string; status: string } | null;
}

interface AttachItem {
  id: string;
  file: File;
  fileId?: string;
  name: string;
  sizeBytes: number;
  type: string;
  state: 'uploading' | 'ready' | 'failed';
  progress: number;
  thumb?: string;
}

const STATE_KEYS = {
  project: 'current_project',
  conversation: 'current_conversation',
  mode: 'current_mode',
  model: 'current_model',
  scroll: 'conversation_scroll',
  lastSeen: 'chat_last_seen',
} as const;

const MAX_ATTACHMENTS = 16;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const SLASH_COMMANDS = [
  { id: '/idea', label: '/idea <text>', hint: 'Capture the text as an idea (saved to Memory)' },
  { id: '/new', label: '/new', hint: 'Start a new conversation' },
  { id: '/cowork', label: '/cowork', hint: 'Switch to Cowork mode' },
  { id: '/agent', label: '/agent', hint: 'Switch to Agent mode (model controls this laptop)' },
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
  const [mode, setMode] = useState<'CHAT' | 'COWORK' | 'AGENT'>(searchParams.get('mode') === 'cowork' ? 'COWORK' : searchParams.get('mode') === 'agent' ? 'AGENT' : 'CHAT');
  const [imageMode, setImageMode] = useState(false);
  const [modelId, setModelId] = useState<string>();
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming'>('idle');
  /** Companion presence — always derived from the real stream lifecycle. */
  const [companion, setCompanion] = useState<CompanionState>('idle');
  const [freeLimit, setFreeLimit] = useState(false);
  const earlyAccess = useEarlyAccess();
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachItems, setAttachItems] = useState<AttachItem[]>([]);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [editState, setEditState] = useState<{ key: string; content: string } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  const [myReactions, setMyReactions] = useState<Map<string, Set<string>>>(new Map());
  /** Continuity: count of local outbox rows still awaiting server confirmation. */
  const [pendingCount, setPendingCount] = useState(0);
  /** Continuity: cache backend badge ("indexeddb" | "memory") for transparency. */
  const [cacheBackend, setCacheBackend] = useState<string | null>(null);
  const attachRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  /** Phase 17: last confirmed `msg_<id>` per conversation (the SSE replay anchor). */
  const lastEventIdRef = useRef<Record<string, string>>({});
  /** Message ids already rendered (from loads or prior replays) — replay dedupe. */
  const renderedReplayRef = useRef<Set<string>>(new Set());

  const saveState = useCallback((key: string, value: Record<string, unknown>) => {
    void api(`/api/v1/workspace/state/${key}`, { method: 'PUT', body: { value } }).catch(() => {
      /* continuity is best-effort */
    });
  }, []);

  const flashStatus = useCallback((label: string) => {
    setStatusLabel(label);
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => setStatusLabel(null), 3000);
  }, []);

  const markSeen = useCallback(
    (id: string) => {
      setLastSeen((prev) => {
        const next = { ...prev, [id]: Date.now() };
        saveState(STATE_KEYS.lastSeen, next);
        return next;
      });
    },
    [saveState],
  );

  /** Continuity: refresh the pending (offline) outbox count from the cache. */
  const refreshPendingCount = useCallback(async () => {
    try {
      const cache = await getContinuityCache();
      setCacheBackend(cache.backend);
      setPendingCount(await pendingOutboxCount(cache));
    } catch {
      /* cache unavailable — indicator stays off */
    }
  }, []);

  const loadConvs = useCallback(
    async (preserveSelection: boolean) => {
      try {
        const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
        const qArchived = projectId ? `?projectId=${encodeURIComponent(projectId)}&archived=1` : '?archived=1';
        const [active, archived] = await Promise.all([
          api<{ conversations: Conversation[] }>(`/api/v1/conversations${q}`),
          api<{ conversations: Conversation[] }>(`/api/v1/conversations${qArchived}`),
        ]);
        const merged = new Map<string, Conversation>();
        for (const c of [...active.conversations, ...archived.conversations]) merged.set(c.id, c);
        const list = [...merged.values()];
        setConvs(list);
        if (!preserveSelection && list.length > 0 && !convId) {
          setConvId(list[0]!.id);
        } else if (list.length > 0 && !list.some((c) => c.id === convId)) {
          // Only drop the selection when the list has other content; an
          // empty (briefly empty) list keeps the current conversation.
          setConvId(null);
        }
      } catch {
        /* ignore */
      }
    },
    [convId, projectId],
  );

  const loadMessages = useCallback(
    async (id: string) => {
      try {
        const res = await api<{ messages?: Message[] }>(`/api/v1/conversations/${id}/messages`);
        const msgs = res.messages ?? [];
        if (msgs.length > 0) {
          setMessages(msgs);
          for (const m of msgs) {
            // Seed replay dedupe with both forms so replayed `msg_<id>` deltas that
            // were already loaded (or streamed) are never rendered twice.
            renderedReplayRef.current.add(m.id);
            renderedReplayRef.current.add(`msg_${m.id}`);
          }
          setUi(
            msgs.map((m) => ({
              key: m.id,
              role: m.role,
              content: m.content,
              image: m.imageFileId ? { fileId: m.imageFileId, mimeType: m.imageMime ?? '' } : null,
            })),
          );
        }
        // Nothing persisted yet (brand-new conversation or a stub that did not
        // include messages): never wipe the live streamed UI, but still honor
        // scroll continuity.
        markSeen(id);
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
    },
    [markSeen],
  );

  /** Continuity: flush any locally queued messages through /sync (pull-biased). */
  const flushPending = useCallback(async () => {
    try {
      const cache = await getContinuityCache();
      await syncAllPending(cache);
    } catch {
      /* next reconnect retries */
    } finally {
      await refreshPendingCount();
      if (convId) {
        void loadMessages(convId);
        void loadConvs(true);
      }
    }
  }, [convId, loadConvs, loadMessages, refreshPendingCount]);

  const loadReactions = useCallback(
    async (id: string) => {
      if (!user) return;
      try {
        const res = await api<{ reactions: { message_id: string; emoji: string; user_id: string }[] }>(
          `/api/v1/conversations/${id}/reactions`,
        );
        const map = new Map<string, Set<string>>();
        for (const r of res.reactions ?? []) {
          if (r.user_id !== user.id) continue;
          const set = map.get(r.message_id) ?? new Set<string>();
          set.add(r.emoji);
          map.set(r.message_id, set);
        }
        setMyReactions(map);
      } catch {
        /* ignore */
      }
    },
    [user],
  );

  useEffect(() => {
    void loadConvs(false);
  }, [loadConvs]);

  useEffect(() => {
    if (convId) {
      void loadMessages(convId);
      void loadReactions(convId);
    }
  }, [convId, loadMessages, loadReactions]);

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
        const savedLastSeen = byKey.get(STATE_KEYS.lastSeen) as Record<string, number> | undefined;
        if (typeof project === 'string') setProjectId(project);
        if (savedMode === 'CHAT' || savedMode === 'COWORK' || savedMode === 'AGENT') setMode(savedMode);
        if (typeof savedModel === 'string') setModelId(savedModel);
        if (typeof conversation === 'string') setConvId(conversation);
        if (typeof savedScroll === 'number') pendingScrollRef.current = savedScroll;
        if (savedLastSeen && typeof savedLastSeen === 'object') setLastSeen(savedLastSeen);
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
      if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      e.preventDefault();
      setShortcutsOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void loadResponseSoundEnabled();
  }, []);

  // Continuity: on mount, reconcile the local cache and surface the pending count.
  // On reconnect, flush the outbox through the server sync (exactly-once).
  useEffect(() => {
    void refreshPendingCount();
    const onOnline = () => void flushPending();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushPending, refreshPendingCount]);

  const changeMode = (next: 'CHAT' | 'COWORK' | 'AGENT') => {
    setMode(next);
    if (next === 'COWORK' || next === 'AGENT') setImageMode(false);
    saveState(STATE_KEYS.mode, { mode: next });
  };

  /** PKG-10 Voice: browser-only input facade; transcript flows into the composer. */
  const voice = useVoiceCommands({
    mode,
    projectId,
    onSend: () => send(),
    onStop: () => stop(),
    onRegenerate: () => regenerate(),
    onClear: () => clearDraft(),
    onContinue: () => regenerate(),
    onNavigate: (path) => navigate(path),
    onRunSlash: async (command) => {
      // Reuse existing runSlash logic
      const trimmed = command.trim();
      if (trimmed.startsWith('/idea ')) {
        const idea = trimmed.slice('/idea '.length).trim();
        if (idea) {
          clearDraft();
          await captureIdea(idea);
          return true;
        }
        return false;
      }
      if (trimmed === '/new') {
        clearDraft();
        await createConv();
        return true;
      }
      if (trimmed === '/cowork') {
        clearDraft();
        changeMode('COWORK');
        return true;
      }
      if (trimmed === '/agent') {
        clearDraft();
        changeMode('AGENT');
        return true;
      }
      if (trimmed === '/chat') {
        clearDraft();
        changeMode('CHAT');
        return true;
      }
      return false;
    },
    onSearchMemory: (query) => {
      // Navigate to memory page with search query
      navigate(`/memory?q=${encodeURIComponent(query)}`);
    },
    onChangeMode: changeMode,
    voiceOutput: true, // Enable TTS confirmations
    lang: 'en-US',
    continuous: true,
  });

  const changeModel = (next?: string) => {
    setModelId(next);
    if (next) saveState(STATE_KEYS.model, { modelId: next });
  };

  const refreshConvs = useCallback(() => {
    void loadConvs(true);
  }, [loadConvs]);

  const createConv = async () => {
    try {
      const res = await api<{ conversation: Conversation }>('/api/v1/conversations', {
        method: 'POST',
        body: { title: 'New conversation', mode, projectId: projectId ?? undefined },
      });
      setConvs((prev) => [res.conversation, ...prev.filter((c) => c.id !== res.conversation.id)]);
      setConvId(res.conversation.id);
      setMessages([]);
      setUi([]);
      setAttachItems([]);
      saveState(STATE_KEYS.conversation, { conversationId: res.conversation.id });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    }
  };

  const runStream = async (content: string, attachments: { fileId: string; name: string }[] | undefined, model?: string, imageRequest?: boolean) => {
    const trimmed = content.trim();
    if (!trimmed || streaming) return;
    setStreaming(true);
    setPhase('thinking');
    setCompanion('thinking');
    const userKey = `u:${Date.now()}`;
    const asstKey = `a:${Date.now()}`;
    // Continuity: one idempotency key per user turn. If the stream dies and the
    // user resends (or the outbox flush replays), the server dedupes on it —
    // the exact same message is never inserted twice.
    const clientId = newClientId();
    setUi((prev) => [
      ...prev,
      { key: userKey, role: 'user', content: trimmed },
      { key: asstKey, role: 'assistant', content: '', thinking: true },
    ]);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    const abort = new AbortController();
    abortRef.current = abort;
    armResponseSound();

    let streamEnded = false;
    let abortedByUser = false;

    const onEvent = (ev: ChatStreamEvent) => {
      if (ev.type === 'thinking_start') {
        setPhase('thinking');
        setCompanion('thinking');
        setStatusLabel('Thinking…');
        setUi((prev) => prev.map((m) => (m.key === asstKey ? { ...m, thinking: true } : m)));
      } else if (ev.type === 'delta') {
        setPhase('streaming');
        setCompanion('working');
        setStatusLabel('Generating…');
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
        setCompanion('waiting');
        flashStatus('Limit reached');
        setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: 'Usage limit reached for this rolling window.' }]);
        if (ev.data.showMoon) setFreeLimit(true);
      } else if (ev.type === 'image') {
        // IMAGE_GENERATION: the persisted artifact is referenced by id only;
        // its bytes are streamed from the project file content endpoint.
        setUi((prev) => prev.map((m) => (m.key === asstKey ? { ...m, image: ev.data, thinking: false } : m)));
      } else if (ev.type === 'external_agent') {
        // EXTERNAL_AGENT: verbatim provider-reported lifecycle fact.
        setUi((prev) =>
          prev.map((m) =>
            m.key === asstKey ? { ...m, externalRun: { externalId: ev.data.externalId, status: ev.data.status }, thinking: false } : m,
          ),
        );
        setStatusLabel(ev.data.status === 'running' ? 'Agent running…' : `Agent ${ev.data.status}`);
      } else if (ev.type === 'error') {
        streamEnded = true;
        setCompanion('error');
        flashStatus('Error');
        setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: ev.data.message }]);
      } else if (ev.type === 'done') {
        streamEnded = true;
        setCompanion('done');
        flashStatus('Completed');
        playResponseReadySound();
        const messageId = ev.data.messageId;
        if (convId && typeof messageId === 'string') {
          lastEventIdRef.current[convId] = `msg_${messageId}`;
        }
        // Continuity: a decision recorded during this exchange rides the done
        // payload — render a real chip (never guessed when absent).
        const dr = ev.data.decisionRecorded;
        setUi((prev) =>
          prev
            .filter((m) => m.content.length > 0)
            .map((m) => {
              if (m.key === userKey) return { ...m, pending: false };
              if (m.key === asstKey && dr) return { ...m, decisionRecorded: dr };
              return m;
            }),
        );
      }
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    };

    try {
      await streamChat(
        {
          content: trimmed,
          conversationId: convId ?? undefined,
          projectId: projectId ?? undefined,
          mode,
          modelId: imageRequest ? undefined : model,
          attachments,
          imageRequest,
          clientId,
        },
        onEvent,
        abort.signal,
        convId ? lastEventIdRef.current[convId] : undefined,
      );
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (aborted) {
        abortedByUser = true;
        setCompanion('idle');
        flashStatus('Stopped');
      } else {
        streamEnded = true;
        setCompanion('error');
        flashStatus('Error');
        setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: err instanceof Error ? err.message : 'stream failed' }]);
        // Continuity: the message never reached the server — park it in the
        // outbox (clientId-keyed, exactly-once) so a reconnect flush delivers it.
        if (convId) {
          void enqueuePendingMessage(await getContinuityCache(), convId, clientId, trimmed)
            .then(() => {
              setUi((prev) => prev.map((m) => (m.key === userKey ? { ...m, pending: true } : m)));
              return refreshPendingCount();
            })
            .catch(() => undefined);
        }
      }
    } finally {
      setStreaming(false);
      setPhase('idle');
      abortRef.current = null;
      void loadConvs(false);
      if (convId) void loadMessages(convId);
    }
    // Silent disconnect (no done/error/limit event, no user cancel): the
    // stream closed without a terminal event — surface it honestly and park
    // the user message in the outbox for exactly-once retry on reconnect.
    if (!streamEnded && !abortedByUser) {
      flashStatus('Error');
      setCompanion('error');
      setUi((prev) => [...prev, { key: `s:${Date.now()}`, role: 'system', content: 'Connection interrupted — the stream closed before the response completed.' }]);
      if (convId) {
        void enqueuePendingMessage(await getContinuityCache(), convId, clientId, trimmed)
          .then(() => {
            setUi((prev) => prev.map((m) => (m.key === userKey ? { ...m, pending: true } : m)));
            return refreshPendingCount();
          })
          .catch(() => undefined);
      }
    }
  };

  const send = () => {
    const ready = attachItems.filter((a) => a.state === 'ready' && a.fileId);
    if (imageMode && !projectId) {
      toast('Select a project first — generated images are stored there', 'error');
      return;
    }
    if (attachItems.some((a) => a.state === 'uploading')) {
      toast('Waiting for uploads to finish…', 'error');
      return;
    }
    void runStream(
      input,
      ready.map((a) => ({ fileId: a.fileId!, name: a.name })),
      modelId,
      imageMode && mode === 'CHAT',
    );
    setInput('');
    setAttachItems([]);
    setAttachOpen(false);
    if (imageMode) setImageMode(false);
  };

  const stop = () => {
    if (streaming && abortRef.current) {
      abortRef.current.abort();
      toast('Generation cancelled');
    }
  };

  const lastUserContent = (): string | null => {
    const fromMessages = [...messages].reverse().find((m) => m.role === 'user');
    if (fromMessages) return fromMessages.content;
    const fromUi = [...ui].reverse().find((m) => m.role === 'user');
    return fromUi ? fromUi.content : null;
  };

  const regenerate = () => {
    const content = lastUserContent();
    if (!content) {
      toast('No user message to regenerate.', 'error');
      return;
    }
    void runStream(content, undefined, modelId);
  };

  const commitEdit = async (key: string, newContent: string) => {
    const trimmed = newContent.trim();
    setEditState(null);
    if (!trimmed || !convId) return;
    const loaded = messages.find((m) => m.id === key);
    if (loaded) {
      try {
        await api(`/api/v1/conversations/${convId}/messages/${loaded.id}`, {
          method: 'PATCH',
          body: { content: trimmed },
        });
      } catch (err) {
        toast(err instanceof Error ? err.message : 'edit failed', 'error');
        return;
      }
      setUi((prev) => prev.map((m) => (m.key === key ? { ...m, content: trimmed } : m)));
    }
    void runStream(trimmed, undefined, modelId);
  };

  const toggleFeedback = async (messageId: string, emoji: '👍' | '👎') => {
    if (!convId) return;
    const mine = myReactions.get(messageId) ?? new Set<string>();
    const has = mine.has(emoji);
    const other = emoji === '👍' ? '👎' : '👍';
    try {
      if (has) {
        await api(`/api/v1/conversations/${convId}/messages/${messageId}/react`, { method: 'DELETE', body: { emoji } });
      } else {
        if (mine.has(other)) {
          await api(`/api/v1/conversations/${convId}/messages/${messageId}/react`, { method: 'DELETE', body: { emoji: other } });
        }
        await api(`/api/v1/conversations/${convId}/messages/${messageId}/react`, { method: 'POST', body: { emoji } });
      }
      setMyReactions((prev) => {
        const next = new Map(prev);
        const cur = new Set(next.get(messageId) ?? []);
        if (has) cur.delete(emoji);
        else {
          cur.delete(other);
          cur.add(emoji);
        }
        next.set(messageId, cur);
        return next;
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'feedback failed', 'error');
    }
  };

  const copyMessage = async (content: string) => {
    const ok = await copyText(content);
    toast(ok ? 'Copied' : 'Copy failed', ok ? 'info' : 'error');
  };

  const isEditing = (key: string) => editState?.key === key;

  const renderContent = (m: UiMessage) => {
    if (m.image) {
      const src = projectId
        ? `/api/v1/files/${m.image.fileId}/content?projectId=${encodeURIComponent(projectId)}`
        : null;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {src ? (
            <div className="cc-img-preview" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
              <img src={src} alt="Generated image" style={{ maxWidth: 'min(100%, 420px)', borderRadius: 8 }} />
              <a className="cc-btn cc-btn--sm" href={src} download>Download</a>
            </div>
          ) : (
            <span className="cc-hint">Image generated (file {m.image.fileId}).</span>
          )}
          {m.externalRun && (
            <span className="cc-hint">External agent run · {m.externalRun.status} · {m.externalRun.externalId}</span>
          )}
          {m.content ? (
            <>
              {splitCodeBlocks(m.content).map((seg, i) =>
                seg.kind === 'code' ? (
                  <div key={i} className="cc-code">
                    <div className="cc-code__bar">
                      <span className="cc-hint">code</span>
                      <button
                        className="cc-btn cc-btn--ghost cc-btn--sm"
                        onClick={() => void copyMessage(seg.content)}
                        aria-label="Copy code"
                      >
                        Copy
                      </button>
                    </div>
                    <pre><code>{seg.content}</code></pre>
                  </div>
                ) : (
                  <span key={i} className="cc-msg-text">{seg.content}</span>
                ),
              )}
            </>
          ) : null}
        </div>
      );
    }
    if (m.thinking && m.content === '') return <span className="cc-think">thinking…</span>;
    const segments = splitCodeBlocks(m.content);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {m.externalRun && (
          <span className="cc-hint">External agent run · {m.externalRun.status} · {m.externalRun.externalId}</span>
        )}
        {m.decisionRecorded && (
          <Link
            to="/memory"
            className="cc-pill cc-decision-chip"
            title={`Decision ${m.decisionRecorded.id} recorded — open Memory to replay, inspect sources, or export`}
            aria-label={`Decision recorded: ${m.decisionRecorded.title} (${m.decisionRecorded.status}). Open Memory to inspect sources.`}
            style={{ textDecoration: 'none' }}
          >
            ✦ Decision recorded: {m.decisionRecorded.title} ({m.decisionRecorded.status}) — view in Memory
          </Link>
        )}
        {m.pending && <span className="cc-hint cc-hint--pending">queued locally — will sync on reconnect</span>}
        {segments.map((seg, i) =>
          seg.kind === 'code' ? (
            <div key={i} className="cc-code">
              <div className="cc-code__bar">
                <span className="cc-hint">code</span>
                <button
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  onClick={() => void copyMessage(seg.content)}
                  aria-label="Copy code"
                >
                  Copy
                </button>
              </div>
              <pre><code>{seg.content}</code></pre>
            </div>
          ) : (
            <span key={i} className="cc-msg-text">{seg.content}</span>
          ),
        )}
      </div>
    );
  };

  const messageActions = (m: UiMessage) => {
    const persisted = messages.find((msg) => msg.id === m.key);
    const actions: { label: string; title: string; onClick: () => void; active?: boolean; icon?: 'thumbUp' | 'thumbDown' }[] = [];
    if (m.role === 'assistant' && m.content) {
      actions.push({ label: 'Regenerate', title: 'Generate a new response', onClick: regenerate });
      if (persisted) {
        actions.push({
          label: 'Useful',
          title: 'Useful',
          onClick: () => void toggleFeedback(persisted.id, '👍'),
          active: myReactions.get(persisted.id)?.has('👍'),
          icon: 'thumbUp',
        });
        actions.push({
          label: 'Not useful',
          title: 'Not useful',
          onClick: () => void toggleFeedback(persisted.id, '👎'),
          active: myReactions.get(persisted.id)?.has('👎'),
          icon: 'thumbDown',
        });
      }
      actions.push({ label: 'Share', title: 'Share or invite', onClick: () => setShareOpen(true) });
    }
    if (m.role === 'user') {
      if (persisted) {
        actions.push({
          label: 'Edit',
          title: 'Edit and resend (creates a new turn)',
          onClick: () => setEditState({ key: m.key, content: m.content }),
        });
      }
      actions.push({ label: 'Retry', title: 'Send again', onClick: regenerate });
    }
    if (actions.length > 0) {
      actions.unshift({ label: 'Copy', title: 'Copy message text', onClick: () => void copyMessage(m.content) });
    } else if (m.content) {
      actions.push({ label: 'Copy', title: 'Copy message text', onClick: () => void copyMessage(m.content) });
    }
    return actions.map((a) => (
      <button
        key={a.label}
        className={`cc-btn cc-btn--ghost cc-btn--sm ${a.active ? 'cc-btn--primary' : ''}`}
        title={a.title}
        aria-label={a.title}
        onClick={a.onClick}
        style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        {a.icon && <Icon name={a.icon} size={13} />}
        {a.label}
      </button>
    ));
  };

  const onAttachFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (!projectId) {
      toast('Select a project first — attachments are uploaded into a project', 'error');
      return;
    }
    const incoming = Array.from(list);
    const room = MAX_ATTACHMENTS - attachItems.length;
    if (incoming.length > room) {
      toast(`You can attach up to ${MAX_ATTACHMENTS} files total.`, 'error');
      incoming.length = room;
    }
    for (const file of incoming) {
      if (file.size > MAX_FILE_BYTES) {
        toast(`"${file.name}" exceeds the 100 MB upload limit.`, 'error');
        continue;
      }
      if (attachItems.some((a) => a.name === file.name && a.sizeBytes === file.size)) continue;
      const id = `at:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const thumb = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (thumb) objectUrlsRef.current.push(thumb);
      setAttachItems((prev) => [
        ...prev,
        { id, file, name: file.name, sizeBytes: file.size, type: file.type, state: 'uploading', progress: 0, thumb },
      ]);
      void uploadFileWithProgress(file, { projectId }, (fraction) => {
        setAttachItems((prev) => prev.map((a) => (a.id === id ? { ...a, progress: fraction } : a)));
      })
        .then((row) => {
          setAttachItems((prev) =>
            prev.map((a) => (a.id === id ? { ...a, fileId: row.id, state: 'ready' as const, progress: 1 } : a)),
          );
        })
        .catch((err: unknown) => {
          setAttachItems((prev) => prev.map((a) => (a.id === id ? { ...a, state: 'failed' as const } : a)));
          toast(err instanceof Error ? err.message : 'upload failed', 'error');
        });
    }
    if (attachRef.current) attachRef.current.value = '';
    setAttachOpen(false);
  };

  const removeAttach = (id: string) => {
    setAttachItems((prev) => prev.filter((a) => a.id !== id));
  };

  const formatSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const handleRename = async (id: string, title: string) => {
    try {
      await api(`/api/v1/conversations/${id}`, { method: 'PATCH', body: { title } });
      refreshConvs();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'rename failed', 'error');
    }
  };

  const handleTogglePin = (c: Conversation) => {
    void api(`/api/v1/conversations/${c.id}`, { method: 'PATCH', body: { favorite: !c.favorite } })
      .then(() => refreshConvs())
      .catch((err) => toast(err instanceof Error ? err.message : 'pin failed', 'error'));
  };

  const handleArchive = (id: string) => {
    void api(`/api/v1/conversations/${id}/archive`, { method: 'POST' })
      .then(() => refreshConvs())
      .catch((err) => toast(err instanceof Error ? err.message : 'archive failed', 'error'));
  };

  const handleUnarchive = (id: string) => {
    void api(`/api/v1/conversations/${id}/unarchive`, { method: 'POST' })
      .then(() => refreshConvs())
      .catch((err) => toast(err instanceof Error ? err.message : 'unarchive failed', 'error'));
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this conversation? It moves to Trash (30-day retention) and can be restored.')) return;
    void api(`/api/v1/conversations/${id}`, { method: 'DELETE' })
      .then(() => {
        if (convId === id) {
          setConvId(null);
          setMessages([]);
          setUi([]);
        }
        refreshConvs();
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'delete failed', 'error'));
  };

  const resumeSession = () => {
    if (convs.length === 0) return;
    const candidate = convs.find((c) => !c.archived) ?? convs[0]!;
    setConvId(candidate.id);
    saveState(STATE_KEYS.conversation, { conversationId: candidate.id });
  };

  const focusModel = () => {
    document.getElementById('cc-model-picker')?.focus();
  };

  const clearDraft = () => {
    setInput('');
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
    markSeen(id);
    saveState(STATE_KEYS.conversation, { conversationId: id });
  };

  const selectProject = (id: string | null) => {
    setProjectId(id);
    setConvId(null);
    setUi([]);
    setMessages([]);
    setAttachItems([]);
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
        clearDraft();
        await captureIdea(idea);
        return true;
      }
      return false;
    }
    if (trimmed === '/new') {
      clearDraft();
      await createConv();
      return true;
    }
    if (trimmed === '/cowork') {
      clearDraft();
      changeMode('COWORK');
      return true;
    }
    if (trimmed === '/agent') {
      clearDraft();
      changeMode('AGENT');
      return true;
    }
    if (trimmed === '/chat') {
      clearDraft();
      changeMode('CHAT');
      return true;
    }
    return false;
  };

  const onComposerKey = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (editState) {
        setEditState(null);
        return;
      }
      if (streaming && abortRef.current) {
        stop();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim().startsWith('/')) {
        const consumed = await runSlash(input);
        if (consumed) return;
      }
      send();
    }
  };

  const showSlash = input.trim().startsWith('/');

  return (
    <div className="cc-page" style={{ minHeight: 0 }}>
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
            <button
              className={mode === 'AGENT' ? 'on' : ''}
              onClick={() => changeMode('AGENT')}
              aria-pressed={mode === 'AGENT'}
              title="The selected model can run commands / open the browser / work files on this laptop via the Local Agent"
            >
              Agent
            </button>
          </div>
          {/* Companion presence: mirrors the real stream lifecycle, never
              decorates. Textual status stays in the status pill. */}
          <AICompanion state={companion} />
          {convId && (
            <>
              <button className="cc-btn cc-btn--sm" onClick={() => setShareOpen((o) => !o)}>
                Share &amp; Invite
              </button>
            </>
          )}
        </div>
      </div>
      <div className="cc-grid cc-chat-layout" style={{ gridTemplateColumns: '240px 1fr', flex: 1, minHeight: 0 }}>
        <div className="cc-card" style={{ overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ChatSidebar
            conversations={convs}
            activeId={convId}
            lastSeen={lastSeen}
            onSelect={selectConversation}
            onNew={() => void createConv()}
            onTogglePin={handleTogglePin}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onDelete={handleDelete}
            onRename={handleRename}
          />
        </div>
        <div className="cc-card cc-chat" style={{ minHeight: 0, position: 'relative' }}>
          {shareOpen && convId && (
            <div style={{ position: 'absolute', right: 12, top: 56, zIndex: 30 }}>
              <ShareInvitePopover conversationId={convId} onClose={() => setShareOpen(false)} toast={toast} />
            </div>
          )}
          {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
          <div ref={listRef} className="cc-chat__messages" onScroll={onScrollSave}>
            {ui.length === 0 && !streaming ? (
              <div className="cc-empty" style={{ flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center' }}>
                <BrandLogo variant="lockup" height={56} />
                <p>Start a conversation.</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <button className="cc-btn cc-btn--sm" onClick={() => changeMode('COWORK')}>
                    Start Cowork
                  </button>
                  <button className="cc-btn cc-btn--sm" onClick={() => attachRef.current?.click()}>
                    Add Files
                  </button>
                  <button className="cc-btn cc-btn--sm" onClick={focusModel}>
                    Choose Model
                  </button>
                  {convs.length > 0 && (
                    <button className="cc-btn cc-btn--sm" onClick={resumeSession}>
                      Resume Session
                    </button>
                  )}
                  <button className="cc-btn cc-btn--sm" onClick={() => void createConv()}>
                    New Chat
                  </button>
                  <button className="cc-btn cc-btn--sm" onClick={() => navigate('/automation')}>
                    Schedule Task
                  </button>
                </div>
              </div>
            ) : (
              ui.map((m) =>
                m.role === 'user' ? (
                  <div key={m.key} className="cc-msg cc-msg--user">
                    {isEditing(m.key) ? (
                      <textarea
                        className="cc-textarea"
                        defaultValue={editState?.content}
                        autoFocus
                        aria-label="Edit message"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void commitEdit(m.key, (e.target as HTMLTextAreaElement).value);
                          }
                          if (e.key === 'Escape') setEditState(null);
                        }}
                      />
                    ) : (
                      <span className="cc-msg-text">{m.content}</span>
                    )}
                    {m.pending && <span className="cc-hint cc-hint--pending">queued locally — will sync on reconnect</span>}
                    <div className="cc-msg-actions">{messageActions(m)}</div>
                  </div>
                ) : m.role === 'system' ? (
                  <div key={m.key} className="cc-msg cc-msg--system">
                    <span className="cc-msg-text">{m.content}</span>
                    <div className="cc-msg-actions">{messageActions(m)}</div>
                  </div>
                ) : (
                  <div key={m.key} className="cc-msg cc-msg--assistant">
                    {renderContent(m)}
                    {m.content && (
                      <div className="cc-msg-actions">{messageActions(m)}</div>
                    )}
                  </div>
                ),
              )
            )}
            {statusLabel && <div className="cc-status-pill" aria-live="polite">{statusLabel}</div>}
            {streaming && <ThinkingMoon active streaming={phase === 'streaming'} />}
          </div>
          <div className="cc-chat__composer">
            <div className="cc-quickbar">
              <VoiceControl
                context={voice.context}
                isListening={voice.isListening}
                start={voice.start}
                stop={voice.stop}
                transcript={voice.transcript}
              />
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => attachRef.current?.click()} aria-label="Add file" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="paperclip" size={14} />
                <span className="cc-sidebar__label">Attach</span>
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={focusModel} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="spark" size={14} />
                <span className="cc-sidebar__label">Model</span>
              </button>
              {mode === 'CHAT' && (
                <button
                  className={`cc-btn cc-btn--ghost cc-btn--sm ${imageMode ? 'cc-btn--primary' : ''}`}
                  onClick={() => setImageMode((v) => !v)}
                  aria-pressed={imageMode}
                  title={imageMode ? 'Image mode is on — the prompt generates an image' : 'Switch the composer to Image mode'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                >
                  <Icon name="spark" size={14} />
                  <span className="cc-sidebar__label">{'Image'}</span>
                  {imageMode && <span className="cc-hint">on</span>}
                </button>
              )}
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => navigate('/automation')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="clock" size={14} />
                <span className="cc-sidebar__label">Schedule</span>
              </button>
              {streaming ? (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={stop} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="stop" size={14} />
                  <span className="cc-sidebar__label">Stop</span>
                </button>
              ) : (
                ui.some((m) => m.role === 'user') && (
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={regenerate}>
                    Continue
                  </button>
                )
              )}
              {pendingCount > 0 && (
                <button
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  onClick={() => void flushPending()}
                  title={`${pendingCount} message${pendingCount === 1 ? '' : 's'} queued offline — sync now`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                >
                  <Icon name="refresh" size={14} />
                  <span className="cc-sidebar__label">Sync {pendingCount} pending</span>
                </button>
              )}
            </div>
            {attachItems.length > 0 && (
              <div className="cc-attach-row">
                {attachItems.map((a) => (
                  <div key={a.id} className="cc-pill cc-attach-chip">
                    {a.thumb && <img src={a.thumb} alt="" className="cc-attach-thumb" />}
                    <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>
                      {a.name}
                    </span>
                    <span className="cc-hint">· {a.type || 'file'} · {formatSize(a.sizeBytes)}</span>
                    {a.state === 'uploading' && <span className="cc-hint">· {Math.round(a.progress * 100)}%</span>}
                    {a.state === 'failed' && <span className="cc-hint cc-hint--danger">· failed</span>}
                    <button
                    className="cc-btn cc-btn--ghost cc-btn--sm"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => removeAttach(a.id)}
                  >
                    <Icon name="close" size={13} />
                  </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ position: 'relative' }}>
              <input
                ref={attachRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => onAttachFiles(e.target.files)}
              />
            </div>
            {/* position:relative anchors the slash popover above the composer.
                Without it the absolute menu anchors to .cc-card (position:
                relative) and renders above the whole chat card — invisible. */}
            <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
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
                rows={1}
                aria-label={imageMode ? 'Image prompt' : mode === 'CHAT' ? 'Message CodeConClave' : 'Coworker brief'}
                value={input}
                placeholder={
                  imageMode
                    ? 'Describe the image to generate…'
                    : mode === 'CHAT'
                      ? 'Message CodeConClave… (/idea, /new, /cowork, /chat)'
                      : 'Brief a coworker (task auto-created)…'
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => void onComposerKey(e)}
              />
            </div>
            <div id="cc-model-picker" tabIndex={-1}>
              <ModelPicker value={modelId} onChange={changeModel} />
            </div>
            <button
              className="cc-btn cc-btn--primary"
              disabled={streaming || !input.trim() || attachItems.some((a) => a.state === 'uploading')}
              onClick={send}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Icon name="send" size={14} />
              {streaming ? 'Streaming…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
      {freeLimit && (
        <FreeLimitMoon
          name={user?.displayName}
          earlyAccess={earlyAccess}
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