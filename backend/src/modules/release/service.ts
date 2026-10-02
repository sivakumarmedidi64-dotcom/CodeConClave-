/**
 * CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence — service.
 * Orchestrates immutable deployment records, verification evidence, release diff,
 * failure correlation, provider capability, and the controlled rollback engine.
 * Secrets are never accepted or returned.
 */
import { createDeployment, listDeployments, getDeployment, getCurrentDeployment, getLatestVerified, updateDeployment } from './records.js';
import { computeVerification, deriveStatus, isRollbackEligible } from './verification.js';
import { listProviderCapabilities, providerCapability } from './provider.js';
import { buildReleaseDiff, type DiffEvidence } from './diff.js';
import { correlateFailure } from './failure.js';
import { createRollbackEngine, type RollbackEngine, type RollbackEngineDeps } from './rollback.js';
import type {
  DeploymentRecord,
  DeploymentStatus,
  GateResult,
  ProviderId,
  ReleaseDiff,
  RollbackRun,
} from './types.js';

export interface ApplyGateInput {
  projectId: string;
  deploymentId: string;
  gate: 'build' | 'test' | 'health' | 'smoke';
  pass: boolean;
  skippable?: boolean;
  name?: string;
  message?: string;
  evidence?: string;
  responseTimeMs?: number;
}

export interface ReleaseService {
  start(userId: string, input: Parameters<typeof createDeployment>[1]): Promise<DeploymentRecord>;
  applyGate(userId: string, input: ApplyGateInput): Promise<DeploymentRecord>;
  finish(userId: string, projectId: string, deploymentId: string, opts: { durationMs?: number; manualVerify?: boolean }): Promise<DeploymentRecord>;
  history(userId: string, projectId: string, q?: { environment?: string; status?: string; service?: string; limit?: number }): Promise<DeploymentRecord[]>;
  detail(userId: string, projectId: string, deploymentId: string): Promise<DeploymentRecord>;
  current(userId: string, projectId: string, environment?: string): Promise<DeploymentRecord | null>;
  diff(userId: string, projectId: string, deploymentId: string, evidence?: DiffEvidence): Promise<ReleaseDiff>;
  failure(userId: string, projectId: string, deploymentId: string): Promise<ReturnType<typeof correlateFailure>>;
  providers(userId: string): ReturnType<typeof listProviderCapabilities>;
  providerCapabilityOf(userId: string, provider: string): ReturnType<typeof providerCapability>;
  rollback(userId: string, projectId: string, input: Parameters<RollbackEngine['requestRollback']>[2]): Promise<RollbackRun>;
  rollbackStatus(userId: string, projectId: string, runId: string): Promise<RollbackRun>;
  rollbackHistory(userId: string, projectId: string, limit?: number): Promise<RollbackRun[]>;
}

export function createReleaseService(deps: RollbackEngineDeps = {} as RollbackEngineDeps): ReleaseService {
  const engine = createRollbackEngine(deps);

  return {
    async start(userId, input) {
      return createDeployment(userId, input);
    },

    async applyGate(userId, input) {
      const record = await getDeployment(userId, input.projectId, input.deploymentId);
      const gate: GateResult = {
        id: `${record.id}:${input.gate}`,
        stage: input.gate,
        name: input.name ?? input.gate,
        outcome: input.pass ? 'PASS' : input.skippable ? 'SKIP' : 'FAIL',
        message: input.message ?? (input.pass ? `${input.gate} gate passed` : `${input.gate} gate failed`),
        evidence: input.evidence,
        responseTimeMs: input.responseTimeMs,
      };

      const build: DeploymentRecord['buildResult'] = input.gate === 'build' ? gate : record.buildResult;
      const test: DeploymentRecord['testResult'] = input.gate === 'test' ? gate : record.testResult;
      const health: DeploymentRecord['healthResult'] = input.gate === 'health' ? gate : record.healthResult;
      const smoke: DeploymentRecord['smokeResult'] = input.gate === 'smoke' ? gate : record.smokeResult;

      const { verification, allPass } = computeVerification({ build, test, health, smoke });
      const anyFail = [build, test, health, smoke].some((g) => g?.outcome === 'FAIL');

      const status: DeploymentStatus = deriveStatus(record.status, {
        anyGateFail: anyFail,
        gatesAllPass: allPass,
        manualVerify: false,
      });

      return updateDeployment(userId, input.projectId, record.id, {
        buildResult: build,
        testResult: test,
        healthResult: health,
        smokeResult: smoke,
        verification,
        status,
        rollbackAvailable: allPass,
        failureReason: anyFail ? `${input.gate} gate failed` : null,
      });
    },

    async finish(userId, projectId, deploymentId, opts) {
      const record = await getDeployment(userId, projectId, deploymentId);
      const { verification, allPass } = computeVerification({
        build: record.buildResult,
        test: record.testResult,
        health: record.healthResult,
        smoke: record.smokeResult,
      });
      const anyFail = [record.buildResult, record.testResult, record.healthResult, record.smokeResult].some((g) => g?.outcome === 'FAIL');
      const status: DeploymentStatus = deriveStatus(record.status, {
        anyGateFail: anyFail,
        gatesAllPass: allPass,
        manualVerify: opts.manualVerify === true,
      });
      return updateDeployment(userId, projectId, deploymentId, {
        status,
        verification,
        completedAt: new Date().toISOString(),
        durationMs: opts.durationMs ?? null,
        rollbackAvailable: isRollbackEligible({ status, verification }),
      });
    },

    async history(userId, projectId, q = {}) {
      return listDeployments(userId, projectId, {
        environment: q.environment as never,
        status: q.status as DeploymentStatus,
        service: q.service,
        limit: q.limit,
      });
    },

    async detail(userId, projectId, deploymentId) {
      return getDeployment(userId, projectId, deploymentId);
    },

    async current(userId, projectId, environment) {
      return getCurrentDeployment(userId, projectId, (environment ?? 'development') as 'development' | 'staging' | 'production');
    },

    async diff(userId, projectId, deploymentId, evidence = {}) {
      const record = await getDeployment(userId, projectId, deploymentId);
      return buildReleaseDiff(record, evidence);
    },

    async failure(userId, projectId, deploymentId) {
      const record = await getDeployment(userId, projectId, deploymentId);
      return correlateFailure(record);
    },

    providers() {
      return listProviderCapabilities();
    },

    providerCapabilityOf(_userId, provider) {
      return providerCapability(provider as ProviderId);
    },

    async rollback(userId, projectId, input) {
      return engine.requestRollback(userId, projectId, input);
    },

    async rollbackStatus(userId, projectId, runId) {
      return engine.getRun(userId, projectId, runId);
    },

    async rollbackHistory(userId, projectId, limit) {
      return engine.listRuns(userId, projectId, limit);
    },
  };
}

export const releaseService = createReleaseService();
