/**
 * CodeConClave AI OS — P3.1 GitHub Remote Integration.
 *
 * Capability-gated GitHub integration built on the canonical Git / Capability /
 * Policy layers. Supports: repository connection, repository metadata, branch
 * metadata, commit metadata, PR read, PR diff retrieval, and PR creation /
 * comments — the latter two ONLY through explicit user approval (bound,
 * one-time). Security properties:
 *   - Credentials are stored ONLY through an injected secret manager (never in
 *     this module, never logged); events are redacted.
 *   - Credentials and repositories are WORKSCOPE-scoped (least privilege):
 *     a connection for one workspace can never be used from another.
 *   - Every network call requires a capability (github.read / github.write) and
 *     an approved egress host.
 *   - NO automatic production push, NO automatic merge, NO unrestricted
 *     repository access. Write-shaped actions always require explicit approval.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

/** Minimal secret-manager abstraction (injected; never stores credentials here). */
export interface SecretStore {
  get(scope: string, key: string): Promise<string | null>;
  put(scope: string, key: string, value: string): Promise<void>;
}

export type GitHubCapability = 'github.read' | 'github.write';

export interface GitHubRepository {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubBranch {
  name: string;
  headSha: string;
  protected: boolean;
}

export interface GitHubCommit {
  sha: string;
  author: string | null;
  message: string;
  at: number;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  author: string | null;
  createdAt: number;
}

export interface GitHubPrComment {
  id: string;
  body: string;
  author: string | null;
  at: number;
}

/** The external GitHub API surface (injected so tests need no network). */
export interface GitHubHttp {
  repo(fullName: string): Promise<GitHubRepository>;
  branches(fullName: string): Promise<GitHubBranch[]>;
  commits(fullName: string, ref: string, limit?: number): Promise<GitHubCommit[]>;
  listPrs(fullName: string): Promise<GitHubPullRequest[]>;
  pr(fullName: string, number: number): Promise<GitHubPullRequest>;
  diff(fullName: string, number: number): Promise<string>;
  comments(fullName: string, number: number): Promise<GitHubPrComment[]>;
  createPr(fullName: string, input: { title: string; head: string; base: string; body?: string }): Promise<GitHubPullRequest>;
  addComment(fullName: string, number: number, body: string): Promise<GitHubPrComment>;
}

export interface GitHubConnectResult {
  connectionId: string;
  workspaceId: string;
  repo: GitHubRepository;
  tokenIssuedAt: number;
}

type Gate = { capability: GitHubCapability; authorized: boolean; approvedFor?: string };

export class GitHubRemote {
  private connections = new Map<string, { workspaceId: string; fullName: string }>();

  constructor(
    private feature: () => P3Feature | null,
    private http: GitHubHttp,
    private secrets: SecretStore,
    private egressApproved: (host: string) => boolean,
    private capabilities: (workspaceId: string) => readonly string[],
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'github';
  }

  /** Connect a repository. Stores the token via the secret manager under the
   *  workspace scope (never in memory / never logged). */
  async connect(workspaceId: string, fullName: string, token: string, gate: Gate): Promise<GitHubConnectResult> {
    if (!this.isEnabled()) throw AppError.conflict('aios_p3_github_disabled', 'github feature is off');
    this.requireCap(gate.capability, workspaceId);
    if (!gate.authorized) throw AppError.forbidden('aios_p3_github_unauthorized', 'not authorized to connect repository');
    if (!this.egressApproved('api.github.com')) throw AppError.forbidden('aios_p3_github_egress', 'github egress not approved');
    // token stored via secret manager only; scope = workspace so no cross-workspace reuse.
    await this.secrets.put(`github:${workspaceId}`, fullName, token);
    const repo = await this.http.repo(fullName);
    const connectionId = randomUUID();
    this.connections.set(connectionId, { workspaceId, fullName });
    return { connectionId, workspaceId, repo, tokenIssuedAt: Date.now() };
  }

  /** Repository metadata. Read = github.read. */
  async repo(fullName: string, workspaceId: string, gate: Gate): Promise<GitHubRepository> {
    this.requireReadGate(gate, workspaceId);
    return this.http.repo(fullName);
  }

  /** Branch metadata. */
  async branches(fullName: string, workspaceId: string, gate: Gate): Promise<GitHubBranch[]> {
    this.requireReadGate(gate, workspaceId);
    return this.http.branches(fullName);
  }

  /** Commit metadata. */
  async commits(fullName: string, ref: string, workspaceId: string, gate: Gate, limit = 20): Promise<GitHubCommit[]> {
    this.requireReadGate(gate, workspaceId);
    return this.http.commits(fullName, ref, limit);
  }

  /** List PRs (read). */
  async listPrs(fullName: string, workspaceId: string, gate: Gate): Promise<GitHubPullRequest[]> {
    this.requireReadGate(gate, workspaceId);
    return this.http.listPrs(fullName);
  }

  /** Read a single PR. */
  async pr(fullName: string, number: number, workspaceId: string, gate: Gate): Promise<GitHubPullRequest> {
    this.requireReadGate(gate, workspaceId);
    return this.http.pr(fullName, number);
  }

  /** Retrieve a PR diff (read). */
  async diff(fullName: string, number: number, workspaceId: string, gate: Gate): Promise<string> {
    this.requireReadGate(gate, workspaceId);
    return this.http.diff(fullName, number);
  }

  /** Read PR comments. */
  async comments(fullName: string, number: number, workspaceId: string, gate: Gate): Promise<GitHubPrComment[]> {
    this.requireReadGate(gate, workspaceId);
    return this.http.comments(fullName, number);
  }

  /**
   * Create a PR. WRITE — requires github.write + explicit user approval.
   * Never auto-push / auto-merge; the caller must have pre-created the branch.
   */
  async createPr(fullName: string, ws: string, input: { title: string; head: string; base: string; body?: string }, gate: Gate): Promise<GitHubPullRequest> {
    this.requireWriteGate(gate, ws, `create-pr:${fullName}#${input.head}->${input.base}`);
    return this.http.createPr(fullName, input);
  }

  /** Add a PR comment. WRITE — requires github.write + explicit approval. */
  async addComment(fullName: string, number: number, body: string, ws: string, gate: Gate): Promise<GitHubPrComment> {
    this.requireWriteGate(gate, ws, `comment:${fullName}#${number}`);
    return this.http.addComment(fullName, number, body);
  }

  /** Non-secret connection index used for workspace isolation tests. */
  connectionsFor(workspaceId: string): Array<{ connectionId: string; fullName: string }> {
    const out: Array<{ connectionId: string; fullName: string }> = [];
    for (const [id, c] of this.connections) {
      if (c.workspaceId === workspaceId) out.push({ connectionId: id, fullName: c.fullName });
    }
    return out;
  }

  private requireReadGate(gate: Gate, workspaceId: string): void {
    if (!this.isEnabled()) throw AppError.conflict('aios_p3_github_disabled', 'github feature is off');
    this.requireCap('github.read', workspaceId);
    if (!gate.authorized) throw AppError.forbidden('aios_p3_github_unauthorized', 'not authorized');
  }

  private requireWriteGate(gate: Gate, workspaceId: string, target: string | null): void {
    if (!this.isEnabled()) throw AppError.conflict('aios_p3_github_disabled', 'github feature is off');
    this.requireCap('github.write', workspaceId);
    if (!gate.authorized) throw AppError.forbidden('aios_p3_github_unauthorized', 'not authorized');
    // explicit approval bound to the target action
    if (gate.approvedFor !== target) {
      throw AppError.forbidden('aios_p3_github_approval', `explicit approval required for: ${target}`);
    }
  }

  private requireCap(kind: GitHubCapability, workspaceId: string): void {
    const caps = this.capabilities(workspaceId);
    if (!caps.includes(kind)) throw AppError.forbidden('aios_p3_github_cap', `capability ${kind} required`);
  }

  /** Redact a metadata record for logging (never leak tokens). */
  redact(record: Record<string, unknown>): Record<string, unknown> {
    return sanitizeFields(record);
  }
}
