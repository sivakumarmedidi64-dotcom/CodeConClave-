/**
 * CodeConClave — MCP (Model Context Protocol) client, Streamable HTTP.
 *
 * Article 8 of the CodeConClave constitution (borrowed from Claude Code,
 * Codex, Gemini CLI, Cline, Zed and OpenHands, which all speak MCP).
 *
 * One short session per operation: initialize → notifications/initialized →
 * the request (tools/list or tools/call) → best-effort session DELETE. JSON-RPC
 * 2.0 over HTTP POST; the server may answer with application/json or with a
 * text/event-stream, and both are handled.
 *
 * Safety (the server is reached from OUR backend, so it is an SSRF surface):
 *   - the resolved IP is checked at CONNECT time (custom DNS lookup), so a
 *     hostname that resolves to a private, loopback, link-local or metadata
 *     address is refused — no check-then-use gap for DNS rebinding
 *   - production requires https; redirects are never followed
 *   - every request has a timeout and a response-size cap
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { env } from '../../config/env.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLIENT_INFO = { name: 'CodeConClave', version: '1.0.0' };

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: 'blocked_address' | 'bad_url' | 'http_error' | 'timeout' | 'protocol' | 'rpc_error' | 'too_large',
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

// ---------------------------------------------------------------- network guard

/** True for addresses our backend must never connect to on a user's behalf. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(v)) {
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd)/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
  }
  return true; // not an IP at all: refuse
}

export function privateNetworkAllowed(): boolean {
  const flag = env.MCP_ALLOW_PRIVATE_NETWORK;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV !== 'production';
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup that refuses private addresses unless allowed (used at connect time). */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCb): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : []) as dns.LookupAddress[];
      if (list.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }));
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(Object.assign(new Error(`blocked private address for ${hostname}`), { code: 'EMCPBLOCKED' }));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** Validate a server URL before saving or calling it. */
export function validateServerUrl(raw: string, allowPrivate = privateNetworkAllowed()): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new McpError('That is not a valid URL.', 'bad_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new McpError('MCP servers must use https.', 'bad_url');
  if (url.protocol === 'http:' && !allowPrivate) throw new McpError('MCP servers must use https.', 'bad_url');
  if (url.username || url.password) throw new McpError('Put credentials in the auth header, not in the URL.', 'bad_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (net.isIP(host) ? isPrivateAddress(host) : /^(localhost|.*\.local|.*\.internal|metadata\..*)$/i.test(host))) {
    throw new McpError('Private and local network addresses are not allowed for MCP servers.', 'blocked_address');
  }
  return url;
}

// ---------------------------------------------------------------- transport

interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function post(url: URL, headers: Record<string, string>, body: string | null, method: 'POST' | 'DELETE' = 'POST'): Promise<HttpReply> {
  const allowPrivate = privateNetworkAllowed();
  const lib = url.protocol === 'https:' ? https : http;
  const pendingId = body ? ((JSON.parse(body) as { id?: number | string }).id ?? null) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: { ...headers, ...(body !== null ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}) },
        lookup: guardedLookup(allowPrivate) as unknown as net.LookupFunction,
        timeout: env.MCP_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new McpError('The MCP server sent too much data.', 'too_large'));
            return;
          }
          chunks.push(c);
          // A streamed JSON-RPC answer can complete before the server closes the stream.
          if (String(res.headers['content-type'] ?? '').includes('text/event-stream') && pendingId !== null) {
            const text = Buffer.concat(chunks).toString('utf8');
            if (findSseResponse(text, pendingId)) {
              res.destroy();
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new McpError('The MCP server did not answer in time.', 'timeout')));
    // A hard total deadline too: the socket timeout alone resets on every chunk.
    const deadline = setTimeout(() => req.destroy(new McpError('The MCP server did not answer in time.', 'timeout')), env.MCP_REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof McpError) return reject(err);
      if (err.code === 'EMCPBLOCKED') return reject(new McpError('That server resolves to a private network address, which is blocked.', 'blocked_address'));
      reject(new McpError(`Could not reach the MCP server: ${err.message}`, 'http_error'));
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

interface RpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Find the JSON-RPC response with this id inside an SSE body (pure; exported for tests). */
export function findSseResponse(sse: string, id: number | string): RpcResponse | null {
  for (const event of sse.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as RpcResponse | RpcResponse[];
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (msg && msg.id === id && ('result' in msg || 'error' in msg)) return msg;
      }
    } catch {
      /* partial or non-JSON event */
    }
  }
  return null;
}

// ---------------------------------------------------------------- session

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpCallResult {
  content: { type: string; text?: string; mimeType?: string; data?: string; resource?: { uri?: string; text?: string; mimeType?: string }; uri?: string; name?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpConnection {
  url: string;
  /** Extra header (e.g. Authorization: Bearer …), already decrypted. */
  authHeader?: { name: string; value: string } | null;
}

class Session {
  private nextId = 1;
  private sessionId: string | null = null;
  protocolVersion: string = MCP_PROTOCOL_VERSION;
  serverInfo: unknown = null;

  constructor(private readonly url: URL, private readonly auth: McpConnection['authHeader']) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.auth?.name && this.auth.value) h[this.auth.name] = this.auth.value;
    return h;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const reply = await post(this.url, this.headers(), JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (reply.status === 401 || reply.status === 403) throw new McpError(`The MCP server refused access (HTTP ${reply.status}). Check the auth header.`, 'http_error');
    if (reply.status >= 300 && reply.status < 400) throw new McpError('The MCP server tried to redirect; redirects are not followed.', 'http_error');
    if (reply.status < 200 || reply.status >= 300) throw new McpError(`The MCP server answered HTTP ${reply.status}.`, 'http_error');
    const sid = reply.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) this.sessionId = sid;
    const type = String(reply.headers['content-type'] ?? '');
    let msg: RpcResponse | null = null;
    if (type.includes('text/event-stream')) msg = findSseResponse(reply.body, id);
    else {
      try {
        const parsed = JSON.parse(reply.body) as RpcResponse | RpcResponse[];
        msg = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => m && m.id === id) ?? null;
      } catch {
        throw new McpError('The MCP server sent a reply that is not JSON.', 'protocol');
      }
    }
    if (!msg) throw new McpError('The MCP server did not answer the request.', 'protocol');
    if (msg.error) throw new McpError(`MCP error ${msg.error.code}: ${String(msg.error.message).slice(0, 300)}`, 'rpc_error', msg.error.code);
    return msg.result;
  }

  async notify(method: string): Promise<void> {
    await post(this.url, this.headers(), JSON.stringify({ jsonrpc: '2.0', method })).catch(() => undefined);
  }

  async open(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { protocolVersion?: string; serverInfo?: unknown; capabilities?: { tools?: unknown } } | undefined;
    const version = String(result?.protocolVersion ?? '');
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      throw new McpError(`The MCP server speaks protocol "${version || 'unknown'}", which CodeConClave does not support.`, 'protocol');
    }
    this.protocolVersion = version;
    this.serverInfo = result?.serverInfo ?? null;
    await this.notify('notifications/initialized');
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await post(this.url, this.headers(), null, 'DELETE').catch(() => undefined);
  }
}

async function withSession<T>(conn: McpConnection, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = new Session(validateServerUrl(conn.url), conn.authHeader ?? null);
  await session.open();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** Connect and list every tool (follows pagination; capped at 200 tools). */
export async function listTools(conn: McpConnection): Promise<{ tools: McpTool[]; serverInfo: unknown; protocolVersion: string }> {
  return withSession(conn, async (s) => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = (await s.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string } | undefined;
      for (const t of result?.tools ?? []) {
        // MCP tool names: letters, digits, _ - . (1–128 chars). Anything else is skipped.
        if (t && typeof t.name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(t.name)) tools.push(t);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || tools.length >= 200) break;
    }
    return { tools: tools.slice(0, 200), serverInfo: s.serverInfo, protocolVersion: s.protocolVersion };
  });
}

/** Connect and call one tool. */
export async function callTool(conn: McpConnection, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  return withSession(conn, async (s) => {
    const result = (await s.request('tools/call', { name, arguments: args })) as McpCallResult | undefined;
    return { content: Array.isArray(result?.content) ? result!.content : [], structuredContent: result?.structuredContent, isError: result?.isError === true };
  });
}
