import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { streamChat, type ChatStreamEvent, type PipelineStage } from '../lib/sse';
import { api, csrfToken } from '../lib/api';
import { armResponseSound, playResponseReadySound, loadResponseSoundEnabled } from '../lib/responseSound';
import { newClientId } from '../lib/continuity';
import { parseAppAction, runAppAction } from '../lib/appActions';
import { useAuth } from '../auth/AuthProvider';
import { ModelChoice } from './ModelChoice';
import { EffortChip, useEffort } from './EffortChip';
import { ThinkingMoon } from './ThinkingMoon';
import { ChatMarkdown } from './ChatMarkdown';
import { BotTeam } from './BotTeam';
import { UsageChip } from './UsageChip';
import { notifyUsageChanged } from '../lib/usage';
import { TeamPicker } from './TeamPicker';
import { Icon } from './Icon';
import { IncognitoBanner, IncognitoToggle } from './Incognito';
import { CopyButton } from './CopyButton';
import { PipelineTrace, ReceiptChip, asReceipt, type PipelineReceipt } from './PipelineReceipt';
import { PastedChip, UserMessageContent } from './PastedChip';
import { PipelineBots } from './PipelineBots';
import { CapabilityGrid, MistakesNote } from './CapabilityGrid';
import { SetupWizard, isSetupCommand } from './SetupWizard';
import { CHAT_MODE, COWORK_MODE, ModeSwitch } from './ModeSwitch';
import { PlanApprovalCard, asPlanSummary, type PlanSummary } from './PlanApproval';
import { ToolApprovalCard, type ToolApproval } from './ToolApprovalCard';
import { UsageNearLimit, reportLimitError } from './UsageLimitDialog';
import { detectFocus } from '../lib/focus';
import { detectPaste, serializePasted, shouldChip, type PastedItem } from '../lib/paste';
import { useIncognito } from '../lib/incognito';

const MODEL_KEY = 'cc:home:model';
const MODE_KEY = 'cc:home:chatmode';
// A UI preference only (the Cowork review-steps toggle), never billing or access state.
const REVIEW_STEPS_KEY = 'cc:home:review-steps-first';
const TOOLS_KEY = 'cc:home:mcp-tools';
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
  role: 'user' | 'assistant' | 'system' | 'team' | 'plan' | 'tool';
  /** role 'tool': an MCP tool call waiting for the user's approval. */
  toolCall?: ToolApproval;
  /** role 'plan': the approval that starts this Cowork task, and its plan. */
  approvalId?: string;
  plan?: PlanSummary;
  content: string;
  thinking?: boolean;
  decisionRecorded?: { id: string; title: string; status: string } | null;
  /** role 'team': the Cowork task whose bot team is shown live. */
  taskId?: string;
  /** Pipeline v3: live stages while building, then the sealed receipt. */
  stages?: PipelineStage[];
  receipt?: PipelineReceipt;
  /** A generated image (stored in a project; shown inline). */
  image?: { fileId: string; mimeType: string; projectId: string };
}

/** "draw / generate / create an image of…" → image generation, no toggle needed. */
/** The latest live project, or a new one with this name (images, Cowork tasks need a project). */
async function ensureProject(name: string, description: string): Promise<string | undefined> {
  const res = await api<{ projects?: { id: string; name?: string; updated_at?: string; deleted_at?: string | null; status?: string }[] }>('/api/v1/projects');
  const projects = (res?.projects ?? []).filter((p) => !p.deleted_at && p.status !== 'ARCHIVED');
  const latest = [...projects].sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''))[0];
  if (latest) return latest.id;
  const created = await api<{ project?: { id: string } }>('/api/v1/projects', { method: 'POST', body: { name, description } });
  return created?.project?.id;
}

const ensureImageProject = () => ensureProject('Images', 'Images generated on Home');

export function looksLikeImageRequest(text: string): boolean {
  return /^(please )?(draw|generate|create|make|design|paint|render)\b[^.?!\n]{0,40}\b(image|picture|photo|illustration|logo|icon|poster|wallpaper|banner|drawing|art(work)?)\b/i.test(text.trim());
}

export function HomeChat({ hero = true }: { hero?: boolean } = {}) {
  let authUser: { displayName?: string | null } | null = null;
  try {
    authUser = useAuth().user;
  } catch {
    authUser = null;
  }
  const firstName = (authUser?.displayName ?? '').trim().split(/\s+/)[0] ?? '';
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
  // Focus Morph: the composer adapts to what you are typing (deterministic, local).
  const focus = useMemo(() => detectFocus(input), [input]);
  const [homeProjectId, setHomeProjectId] = useState<string | undefined>();
  // Image generation on Home (Chat mode): toggle, or just ask "draw an image of…".
  const [imageMode, setImageMode] = useState(false);
  const [team, setTeam] = useState<string[]>([]);
  // Cowork "Plan first": the team writes a plan and waits for your approval.
  const [planFirst, setPlanFirst] = useState<boolean>(() => {
    try {
      return localStorage.getItem(REVIEW_STEPS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const togglePlanFirst = () =>
    setPlanFirst((v) => {
      try {
        localStorage.setItem(REVIEW_STEPS_KEY, v ? '0' : '1');
      } catch {
        /* private mode: still works for this session */
      }
      return !v;
    });
  const effort = useEffort();
  // MCP tools (Chat): the chip shows only when a connected, switched-on server offers tools.
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const [toolsOn, setToolsOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TOOLS_KEY) !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    api<{ servers?: { enabled: boolean; status: string; tools?: unknown[] }[] }>('/api/v1/mcp/servers')
      .then((res) => {
        const n = (res?.servers ?? []).filter((s) => s.enabled && s.status === 'CONNECTED').reduce((acc, s) => acc + (s.tools?.length ?? 0), 0);
        setMcpToolCount(n);
      })
      .catch(() => setMcpToolCount(0));
  }, []);
  const toggleTools = () =>
    setToolsOn((v) => {
      try {
        localStorage.setItem(TOOLS_KEY, v ? '0' : '1');
      } catch {
        /* still works for this session */
      }
      return !v;
    });
  useEffect(() => {
    api<{ projects: { id: string; deleted_at?: string | null; status?: string; updated_at?: string }[] }>('/api/v1/projects')
      .then((res) => {
        const live = (res?.projects ?? []).filter((p) => !p.deleted_at && p.status !== 'ARCHIVED');
        live.sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''));
        setHomeProjectId(live[0]?.id);
      })
      .catch(() => undefined);
  }, []);
  const [residentReady, setResidentReady] = useState(false);
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
  // Big pastes become labelled chips (Claude-style) instead of flooding the box.
  const [pasted, setPasted] = useState<PastedItem[]>([]);
  // `/setup` opens the guided setup (role → plugins → tools → try a skill);
  // Settings → Customize → Guided setup links here with ?setup=1.
  const [setupOpen, setSetupOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    if (new URLSearchParams(location.search).get('setup') === '1') setSetupOpen(true);
  }, [location.search]);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => voiceRecognizerCtor() !== null);
  const navigate = useNavigate();
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<VoiceRecognizer | null>(null);
  // Chat follow-ups continue the same conversation (so the AI keeps context);
  // switching mode or incognito starts a fresh one.
  const convRef = useRef<string | null>(null);
  // The project the current image request is stored in (for the inline <img>).
  const imageProjectRef = useRef<string | null>(null);
  const [incognito, setIncognito] = useIncognito();

  const autogrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  const selectModel = (id: string) => {
    setModelId(id);
    if (id) localStorage.setItem(MODEL_KEY, id);
    else localStorage.removeItem(MODEL_KEY);
  };
  const handleRouting = useCallback((r: { provider?: string; model?: string; reason?: string } | null) => {
    setRouting(r);
  }, []);

  const selectMode = (next: 'CHAT' | 'COWORK') => {
    if (next !== chatMode) convRef.current = null;
    setChatMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  // Plain words, never internal ids: which model answers is on the receipt.
  const autoRouted = !modelId || modelId === 'codeconclave-ai';
  const contextLine = autoRouted && residentReady
    ? 'CodeConClave AI · your own tuned models answer coding, review and planning first'
    : autoRouted
      ? 'CodeConClave AI picks the best engine for each task'
      : 'CodeConClave AI';

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
      case 'stage': {
        const st = ev.data;
        // A repair attempt restarts the answer: clear what was streamed so far.
        setRows((prev) =>
          prev.map((m) => (m.key === asstKey ? { ...m, stages: [...(m.stages ?? []), st], ...(st.reset ? { content: '' } : {}) } : m)),
        );
        break;
      }
      case 'error':
        state.receivedTerminal = true;
        // Limit Guard: a full usage window (or no plan) opens the Claude-style pop-up.
        reportLimitError(ev.data.code, ev.data.message, ev.data.details);
        setRows((prev) => [
          // An answer that never started leaves no empty bubble behind.
          ...prev
            .filter((m) => !(m.key === asstKey && !m.content && !m.image))
            .map((m) => (m.key === asstKey ? { ...m, thinking: false } : m)),
          { key: `s:${Date.now()}`, role: 'system', content: ev.data.message },
        ]);
        break;
      case 'tool_approval': {
        // An MCP tool call waits for approval: show the card under the answer.
        const call = ev.data;
        setRows((prev) => [...prev, { key: `tool:${call.approvalId}`, role: 'tool', content: '', toolCall: call }]);
        break;
      }
      case 'image': {
        const img = ev.data;
        setRows((prev) => prev.map((m) => (m.key === asstKey ? { ...m, thinking: false, image: { fileId: img.fileId, mimeType: img.mimeType, projectId: imageProjectRef.current ?? '' } } : m)));
        break;
      }
      case 'limit_reached':
        state.receivedTerminal = true;
        setRows((prev) => [
          ...prev.map((m) => (m.key === asstKey ? { ...m, thinking: false } : m)),
          { key: `s:${Date.now()}`, role: 'system', content: 'Usage limit reached for this rolling window.' },
        ]);
        break;
      case 'done': {
        state.receivedTerminal = true;
        playResponseReadySound();
        notifyUsageChanged();
        if (typeof ev.data.conversationId === 'string') convRef.current = ev.data.conversationId;
        const taskId = typeof ev.data.taskId === 'string' ? ev.data.taskId : undefined;
        const approvalId = typeof ev.data.approvalId === 'string' ? ev.data.approvalId : undefined;
        const plan = approvalId ? asPlanSummary(ev.data.plan) : null;
        setRows((prev) => {
          const next = prev
            .map((m) => {
              if (m.key !== asstKey) return { ...m, thinking: false };
              const receipt = asReceipt(ev.data.pipeline);
              return {
                ...m,
                thinking: false,
                ...(ev.data.decisionRecorded ? { decisionRecorded: ev.data.decisionRecorded } : {}),
                ...(receipt ? { receipt } : {}),
              };
            })
            // Drop empty text bubbles only; card rows (bot team, plan, tool
            // approval) have no text and must stay.
            .filter((m) => m.content.length > 0 || Boolean(m.image) || m.role === 'team' || m.role === 'plan' || m.role === 'tool');
          // Plan first: show the plan; the bots appear once it is approved.
          if (taskId && approvalId && plan) return [...next, { key: `p:${taskId}`, role: 'plan' as const, content: '', taskId, approvalId, plan }];
          // Cowork deep work: the specialist bots are born for this task.
          return taskId ? [...next, { key: `t:${taskId}`, role: 'team' as const, content: '', taskId }] : next;
        });
        break;
      }
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
    if ((!content && attachments.length === 0 && pasted.length === 0) || streaming) return;
    if (isSetupCommand(content) && pasted.length === 0) {
      setInput('');
      setSetupOpen(true);
      return;
    }
    if (pasted.length > 0) {
      const block = serializePasted(pasted);
      content = content ? `${content}\n\n${block}` : block;
      setPasted([]);
    }
    // CodeConClave acting inside CodeConClave: a recognised app command runs
    // for real through the app's own API, then is confirmed here.
    const appAction = attachments.length === 0 && !content.includes('pasted kind=') ? parseAppAction(content) : null;
    if (appAction) {
      setInput('');
      setRows((prev) => [...prev, { key: `u:${Date.now()}`, role: 'user', content }]);
      try {
        const result = await runAppAction(appAction);
        setRows((prev) => [...prev, { key: `a:${Date.now()}`, role: 'assistant', content: result.message }]);
        if (appAction.kind === 'create_project') {
          const created = await api<{ projects: { id: string; updated_at?: string }[] }>('/api/v1/projects').catch(() => null);
          const newest = created?.projects?.sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''))[0];
          if (newest) setHomeProjectId(newest.id);
        }
        if (result.navigateTo) navigate(result.navigateTo);
      } catch (err) {
        pushSystem(err instanceof Error ? `Couldn't do that: ${err.message}` : "Couldn't do that.");
      }
      return;
    }
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
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.style.height = 'auto';
    });
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
    // Images are saved in a project: use the current/latest one, or make "Images".
    const wantsImage = effectiveMode === 'CHAT' && (imageMode || looksLikeImageRequest(content));
    let imageProjectId: string | undefined;
    if (wantsImage) {
      imageProjectId = homeProjectId ?? (await ensureImageProject().catch(() => undefined));
      if (!imageProjectId) {
        setStreaming(false);
        setRows((prev) => [...prev.filter((m) => m.key !== asstKey), { key: `s:${Date.now()}`, role: 'system', content: 'Could not find or create a project to save the image in.' }]);
        return;
      }
      imageProjectRef.current = imageProjectId;
      if (imageMode) setImageMode(false);
    }
    // Cowork tasks live in a project. If Home hasn't loaded one yet (slow
    // network) or the account has none, use the latest or start "My work"
    // instead of failing with "go pick a project".
    let coworkProjectId = homeProjectId;
    if (effectiveMode === 'COWORK' && !coworkProjectId) {
      coworkProjectId = await ensureProject('My work', 'Cowork tasks started on Home').catch(() => undefined);
      if (coworkProjectId) setHomeProjectId(coworkProjectId);
    }
    // 'codeconclave-ai' is the frontend resident label — the server registry
    // doesn't carry it yet, so send AUTO and let the router decide. Full
    // weight-serving lands with the LOCAL_DRIVER_URLS hook (no arc change).
    const outModelId = modelId === 'codeconclave-ai' ? undefined : modelId;
    try {
      await streamChat(
        {
          content,
          mode: effectiveMode,
          modelId: outModelId,
          clientId: newClientId(),
          effort,
          ...(effectiveMode === 'CHAT' && convRef.current && !wantsImage ? { conversationId: convRef.current } : {}),
          ...(wantsImage ? { imageRequest: true, projectId: imageProjectId } : {}),
          ...(effectiveMode === 'CHAT' && !convRef.current && incognito ? { incognito: true } : {}),
          ...(effectiveMode === 'COWORK' && coworkProjectId ? { projectId: coworkProjectId } : {}),
          ...(effectiveMode === 'COWORK' && team.length > 0 ? { coworkers: team } : {}),
          ...(effectiveMode === 'COWORK' && planFirst ? { planFirst: true } : {}),
          ...(effectiveMode === 'CHAT' && toolsOn && mcpToolCount > 0 && !wantsImage && !incognito ? { mcpTools: true } : {}),
        },
        onEvent(asstKey, state),
        controller.signal,
      );
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

  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const speak = useCallback(async (key: string, text: string) => {
    if (speakingKey) return;
    const slice = text.trim().slice(0, 2000);
    if (!slice) return;
    setSpeakingKey(key);
    try {
      const res = await fetch('/api/v1/voice/speak', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ text: slice }),
      });
      if (!res.ok) {
        pushSystem(res.status === 400 ? 'Voice is not configured on the server yet.' : 'Voice synthesis failed.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        await new Audio(url).play();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      pushSystem('Voice playback failed.');
    } finally {
      setSpeakingKey(null);
    }
  }, [pushSystem, speakingKey]);

  return (
    <div className={`cc-homechat cc-homechat--normal${rows.length === 0 ? ' cc-homechat--empty' : ''}`}>
      {hero && rows.length === 0 && (
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
          {rows.map((row) => row.role === 'tool' && row.toolCall ? (
            <div key={row.key} className="cc-homechat__row cc-homechat__row--tool">
              <ToolApprovalCard call={row.toolCall} />
            </div>
          ) : row.role === 'plan' && row.approvalId && row.plan && row.taskId ? (
            <div key={row.key} className="cc-homechat__row cc-homechat__row--plan">
              <PlanApprovalCard
                approvalId={row.approvalId}
                plan={row.plan}
                onApproved={() =>
                  setRows((prev) =>
                    prev.some((m) => m.key === `t:${row.taskId}`) ? prev : [...prev, { key: `t:${row.taskId}`, role: 'team', content: '', taskId: row.taskId }],
                  )
                }
              />
            </div>
          ) : row.role === 'team' && row.taskId ? (
            <div key={row.key} className="cc-homechat__row cc-homechat__row--team">
              <BotTeam
                taskId={row.taskId}
                onFinal={(text) => {
                  // The final answer is a fresh, user-facing result: chime once.
                  armResponseSound();
                  playResponseReadySound();
                  setRows((prev) => [...prev, { key: `f:${row.taskId}`, role: 'assistant', content: text }]);
                }}
              />
            </div>
          ) : (
            <div key={row.key} className={`cc-homechat__row cc-homechat__row--${row.role}`}>
              {row.role === 'assistant' && row.thinking ? (
                <div className="cc-homechat__bubble cc-homechat__bubble--assistant cc-homechat__thinking">
                  <span className="cc-think-dots">
                    <i /><i /><i />
                  </span>
                  <span>CodeConClave is thinking&hellip;</span>
                  {row.stages && <PipelineBots stages={row.stages} />}
                  {row.stages && <PipelineTrace stages={row.stages} />}
                </div>
              ) : (
                <div className={`cc-homechat__bubble cc-homechat__bubble--${row.role}`}>
                  {row.role === 'assistant' && !row.receipt && row.stages && <PipelineBots stages={row.stages} />}
                  {row.role === 'assistant' && !row.receipt && row.stages && <PipelineTrace stages={row.stages} />}
                  {row.image && (
                    <figure className="cc-genimage">
                      <img src={`/api/v1/files/${row.image.fileId}/content?projectId=${encodeURIComponent(row.image.projectId)}`} alt="Generated image" loading="lazy" />
                      <figcaption>
                        <a href={`/api/v1/files/${row.image.fileId}/content?projectId=${encodeURIComponent(row.image.projectId)}`} download>
                          Download image
                        </a>
                      </figcaption>
                    </figure>
                  )}
                  {row.role === 'assistant' ? <ChatMarkdown text={row.content} /> : row.role === 'user' ? <UserMessageContent content={row.content} /> : row.content}
                  {row.role === 'assistant' && row.receipt && <ReceiptChip receipt={row.receipt} />}
                  {row.content.trim().length > 0 && row.role !== 'user' && (
                    <CopyButton text={row.content} label={row.role === 'system' ? 'Copy message' : 'Copy answer'} size={13} />
                  )}
                  {row.role === 'assistant' && row.content.trim().length > 0 && (
                    <button
                      type="button"
                      className="cc-icon-btn"
                      aria-label="Listen to this answer"
                      title="Listen with ElevenLabs voice"
                      disabled={speakingKey !== null}
                      onClick={() => void speak(row.key, row.content)}
                    >
                      <Icon name="radio" size={13} />
                    </button>
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
      {streaming && chatMode === 'COWORK' && (
        <p className="cc-hint" data-testid="homechat-status">
          Assembling your specialist team — <Link to="/work">Tasks</Link> keeps the full record.
        </p>
      )}

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

      {pasted.length > 0 && (
        <div className="cc-homechat__pasted" data-testid="homechat-pasted">
          {pasted.map((p) => (
            <PastedChip key={p.id} info={p} text={p.text} onRemove={() => setPasted((prev) => prev.filter((x) => x.id !== p.id))} />
          ))}
        </div>
      )}
      <ModeSwitch<'CHAT' | 'COWORK'>
        label="Home chat mode"
        testId="homechat-mode"
        value={chatMode}
        options={[CHAT_MODE, COWORK_MODE]}
        onChange={selectMode}
        showHint={rows.length === 0}
      />
      <UsageNearLimit />
      {focus && (
        <div className={`cc-focus cc-focus--${focus.id}`} data-testid="focus-morph" aria-live="polite">
          <span className="cc-focus__label">
            <Icon name={focus.icon} size={13} />
            {focus.label}
          </span>
          {focus.actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className="cc-chipbtn"
              onClick={() => {
                setInput((v) => `${a.insert}${v}`);
                requestAnimationFrame(() => {
                  inputRef.current?.focus();
                  autogrow();
                });
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {incognito && chatMode === 'CHAT' && <IncognitoBanner />}
      <div
        className={`cc-home__command cc-homechat__bar cc-homechat__bar--normal${incognito && chatMode === 'CHAT' ? ' is-incognito' : ''}`}
        data-focus={focus?.id}
      >
        <Icon name="spark" size={16} className="cc-homechat__icon" />        <textarea
          ref={inputRef}
          rows={1}
          className="cc-homechat__input cc-homechat__input--normal"
          style={{ maxHeight: 140, overflowY: 'auto' }}
          aria-label="Message CodeConClave"
          value={input}
          onChange={(e) => { setInput(e.target.value); autogrow(); }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (!shouldChip(text)) return;
            e.preventDefault();
            setPasted((prev) => [...prev, { id: `p${Date.now()}${prev.length}`, text, ...detectPaste(text) }]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
              requestAnimationFrame(autogrow);
            }
          }}
          placeholder={PLACEHOLDER}
        />
        <ModelChoice value={modelId} onChange={selectModel} onRouting={handleRouting} onResidentStatus={setResidentReady} residentOnly />
        <EffortChip />
        {chatMode === 'CHAT' && (
          <button
            type="button"
            className={`cc-chipbtn${imageMode ? ' is-on' : ''}`}
            aria-pressed={imageMode}
            title={imageMode ? 'Image mode: your next message generates an image' : 'Generate an image'}
            onClick={() => setImageMode((v) => !v)}
          >
            <Icon name="image" size={14} />
            <span>Image</span>
          </button>
        )}
        {chatMode === 'CHAT' && mcpToolCount > 0 && (
          <button
            type="button"
            className={`cc-chipbtn${toolsOn ? ' is-on' : ''}`}
            aria-pressed={toolsOn}
            title={toolsOn ? `Tools on: CodeConClave AI may use your ${mcpToolCount} MCP tool${mcpToolCount === 1 ? '' : 's'}` : 'Let CodeConClave AI use your MCP tools'}
            onClick={toggleTools}
          >
            <Icon name="plug" size={14} />
            <span>Tools</span>
          </button>
        )}
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
            disabled={!input.trim() && attachments.length === 0 && pasted.length === 0}
            onClick={() => void send()}
          >
            <Icon name="send" size={13} />
            Send
          </button>
        )}
      </div>

      {chatMode === 'COWORK' && (
        <div className="cc-homechat__coworkopts">
          <TeamPicker value={team} onChange={setTeam} />
          <button
            type="button"
            className={`cc-chipbtn${planFirst ? ' is-on' : ''}`}
            aria-pressed={planFirst}
            title={planFirst ? 'Plan first is on: the team shows its plan and waits for your approval' : 'Have the team show its plan and wait for your approval'}
            onClick={togglePlanFirst}
          >
            <Icon name="map" size={14} />
            <span>Plan first</span>
          </button>
        </div>
      )}
      <div className="cc-homechat__context cc-hint" data-testid="homechat-context">
        <IncognitoToggle
          on={incognito && chatMode === 'CHAT'}
          disabled={chatMode === 'COWORK'}
          onChange={(on) => {
            convRef.current = null;
            setIncognito(on);
          }}
        />
        {contextLine}
        <UsageChip />
      </div>
      <MistakesNote />
      {rows.length === 0 && (
        <CapabilityGrid
          onPick={(prompt) => {
            setInput(prompt);
            requestAnimationFrame(() => {
              inputRef.current?.focus();
              autogrow();
            });
          }}
        />
      )}
      {setupOpen && (
        <SetupWizard
          onClose={() => {
            setSetupOpen(false);
            if (new URLSearchParams(location.search).has('setup')) navigate('/home', { replace: true });
          }}
          onTry={(prompt) => {
            setInput(prompt);
            requestAnimationFrame(() => {
              inputRef.current?.focus();
              autogrow();
            });
          }}
        />
      )}
      {agentOnline === false && (
        <p className="cc-hint" data-testid="homechat-pair-hint">
          Agent mode needs your laptop paired — <Link to="/remote">pair it on the Remote page</Link>, then the model can
          work your real files and terminal from here.
        </p>
      )}
    </div>
  );
}
