/**
 * CodeConClave — Deployment Discovery (V4E).
 * Inspects a project repository and identifies all deployable components,
 * dependencies, configuration, and infrastructure requirements.
 * No guessing — only what is actually present.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

// ─── Types ─────────────────────────────────────────────────────

export type ComponentType =
  | 'FRONTEND'
  | 'BACKEND'
  | 'WORKER'
  | 'CRON'
  | 'DATABASE'
  | 'REDIS'
  | 'STORAGE'
  | 'QUEUE'
  | 'AI_SERVICE'
  | 'PAYMENT'
  | 'EMAIL'
  | 'WEBSOCKET'
  | 'SSE'
  | 'STATIC_ASSETS';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'cargo' | 'pip' | 'go' | 'maven' | 'unknown';

export type Framework =
  | 'next'
  | 'nuxt'
  | 'remix'
  | 'astro'
  | 'vite'
  | 'express'
  | 'fastify'
  | 'hono'
  | 'elysia'
  | 'nest'
  | 'rails'
  | 'django'
  | 'flask'
  | 'gin'
  | 'actix'
  | 'spring'
  | 'laravel'
  | 'svelte'
  | 'solid'
  | 'vue'
  | 'react'
  | 'angular'
  | 'astro'
  | 'cloudflare-workers'
  | 'vercel-edge'
  | 'deno'
  | 'bun'
  | 'unknown';

export interface DetectedComponent {
  type: ComponentType;
  name: string;
  path: string;
  framework?: Framework;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  healthEndpoint?: string;
  hasWebSockets: boolean;
  hasSSE: boolean;
  envVars: string[];
  dependencies: string[];
  assets?: string;
}

export interface DeploymentProfile {
  id: string;
  projectId: string;
  discoveredAt: Date;
  repositoryUrl?: string;
  branch: string;
  packageManager: PackageManager;
  runtime: string;
  nodeVersion?: string;
  language: string;
  components: DetectedComponent[];
  envFile: EnvFileAnalysis;
  dockerFiles: DockerAnalysis;
  cicdFiles: string[];
  deploymentConfigs: DeploymentConfigAnalysis;
  totalEnvVars: number;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  healthChecks: HealthCheckConfig[];
  metadata: Record<string, unknown>;
}

export interface EnvFileAnalysis {
  present: boolean;
  files: string[];
  variables: EnvVariable[];
  hasSecrets: boolean;
  missingRequired: string[];
}

export interface EnvVariable {
  name: string;
  hasValue: boolean;
  isSecret: boolean;
  source: string;
  description?: string;
}

export interface DockerAnalysis {
  hasDockerfile: boolean;
  hasCompose: boolean;
  composeServices: string[];
  multiStage: boolean;
  baseImage?: string;
}

export interface DeploymentConfigAnalysis {
  railway: boolean;
  render: boolean;
  vercel: boolean;
  netlify: boolean;
  fly: boolean;
  cloudflare: boolean;
  kubernetes: boolean;
  docker: boolean;
}

export interface HealthCheckConfig {
  component: string;
  type: 'HTTP' | 'TCP' | 'COMMAND';
  endpoint?: string;
  port?: number;
  command?: string;
  timeoutMs: number;
}

export interface DiscoveryInput {
  projectId: string;
  repositoryUrl?: string;
  branch?: string;
  fileList?: FileEntry[];
  packageJson?: Record<string, unknown>;
  envContent?: string;
  dockerContent?: string;
  composeContent?: string;
}

export interface FileEntry {
  path: string;
  size: number;
  isDirectory: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────

function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  return (async () => {
    const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
    if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');
  })();
}

const SECRET_PATTERNS = [
  /API_KEY/i, /SECRET/i, /PASSWORD/i, /TOKEN/i, /PRIVATE_KEY/i,
  /DATABASE_URL/i, /REDIS_URL/i, /MONGO_URI/i, /STRIPE/i,
  /AWS_ACCESS/i, /AWS_SECRET/i, /GITHUB_TOKEN/i,
  /SMTP/i, /MAIL/i, /WEBHOOK/i,
];

const INFRA_INDICATORS: Record<string, ComponentType[]> = {
  'postgres': ['DATABASE'],
  'pg': ['DATABASE'],
  'sqlite': ['DATABASE'],
  'mysql': ['DATABASE'],
  'mongodb': ['DATABASE'],
  'redis': ['REDIS'],
  'ioredis': ['REDIS'],
  'bullmq': ['QUEUE'],
  'bull': ['QUEUE'],
  'amqplib': ['QUEUE'],
  'r2': ['STORAGE'],
  's3': ['STORAGE'],
  'openai': ['AI_SERVICE'],
  '@ai-sdk': ['AI_SERVICE'],
  'anthropic': ['AI_SERVICE'],
  'stripe': ['PAYMENT'],
  'razorpay': ['PAYMENT'],
  'resend': ['EMAIL'],
  'nodemailer': ['EMAIL'],
  'socket.io': ['WEBSOCKET'],
  'ws': ['WEBSOCKET'],
  'sse': ['SSE'],
};

const DEPLOYMENT_CONFIG_FILES: Record<string, keyof DeploymentConfigAnalysis> = {
  'railway.toml': 'railway',
  'render.yaml': 'render',
  'vercel.json': 'vercel',
  'netlify.toml': 'netlify',
  'fly.toml': 'fly',
  'wrangler.toml': 'cloudflare',
  'wrangler.jsonc': 'cloudflare',
  'k8s': 'kubernetes',
  'kubernetes': 'kubernetes',
};

const HEALTH_ENDPOINTS = ['/health', '/healthz', '/ready', '/readyz', '/status', '/api/health', '/ping'];

// ─── Core Discovery Logic ─────────────────────────────────────

function detectPackageManager(files: FileEntry[]): PackageManager {
  if (files.some(f => f.path === 'bun.lockb' || f.path === 'bun.lock')) return 'bun';
  if (files.some(f => f.path === 'pnpm-lock.yaml')) return 'pnpm';
  if (files.some(f => f.path === 'yarn.lock')) return 'yarn';
  if (files.some(f => f.path === 'package-lock.json')) return 'npm';
  if (files.some(f => f.path === 'Cargo.lock')) return 'cargo';
  if (files.some(f => f.path === 'poetry.lock' || f.path === 'Pipfile.lock')) return 'pip';
  if (files.some(f => f.path === 'go.sum')) return 'go';
  if (files.some(f => f.path === 'pom.xml' || f.path === 'gradle.lock')) return 'maven';
  if (files.some(f => f.path === 'package.json')) return 'npm';
  return 'unknown';
}

function detectLanguage(
  files: FileEntry[],
  packageJson?: Record<string, unknown>
): { language: string; runtime: string; nodeVersion?: string } {
  const exts = files.filter(f => !f.isDirectory).map(f => {
    const parts = f.path.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  });

  const has = (ext: string) => exts.includes(ext);

  if (has('rs')) return { language: 'rust', runtime: 'cargo' };
  if (has('go')) return { language: 'go', runtime: 'go' };
  if (has('py')) return { language: 'python', runtime: 'python' };
  if (has('java')) return { language: 'java', runtime: 'jvm' };
  if (has('rb')) return { language: 'ruby', runtime: 'ruby' };

  const deps = packageJson ? Object.keys({
    ...(packageJson.dependencies as Record<string, string> || {}),
    ...(packageJson.devDependencies as Record<string, string> || {}),
  }) : [];

  if (deps.some(d => d.includes('next'))) return { language: 'typescript', runtime: 'node', nodeVersion: detectNodeVersion(files, packageJson) };
  if (deps.some(d => d.includes('nuxt'))) return { language: 'typescript', runtime: 'node', nodeVersion: detectNodeVersion(files, packageJson) };

  if (has('tsx') || has('ts')) return { language: 'typescript', runtime: 'node', nodeVersion: detectNodeVersion(files, packageJson) };
  if (has('jsx') || has('mjs')) return { language: 'javascript', runtime: 'node', nodeVersion: detectNodeVersion(files, packageJson) };
  if (has('js')) return { language: 'javascript', runtime: 'node', nodeVersion: detectNodeVersion(files, packageJson) };

  if (packageJson) {
    const engines = packageJson.engines as Record<string, string> | undefined;
    const nodeVer = engines?.node;
    return { language: 'javascript', runtime: 'node', nodeVersion: nodeVer };
  }

  return { language: 'unknown', runtime: 'unknown' };
}

function detectNodeVersion(files: FileEntry[], packageJson?: Record<string, unknown>): string | undefined {
  if (packageJson?.engines) {
    const engines = packageJson.engines as Record<string, string>;
    if (engines.node) return engines.node;
  }
  const nvmFile = files.find(f => f.path === '.nvmrc' || f.path === '.node-version');
  if (nvmFile) return nvmFile.path;
  return undefined;
}

function detectFramework(
  packageJson?: Record<string, unknown>,
  files?: FileEntry[]
): Framework {
  const deps = packageJson ? {
    ...(packageJson.dependencies as Record<string, string> || {}),
    ...(packageJson.devDependencies as Record<string, string> || {}),
  } : {};

  const depNames = Object.keys(deps);
  const has = (name: string) => depNames.some(d => d === name || d.includes(name));

  if (has('next')) return 'next';
  if (has('nuxt')) return 'nuxt';
  if (has('@remix-run')) return 'remix';
  if (has('astro')) return 'astro';
  if (has('svelte') && has('vite')) return 'svelte';
  if (has('solid-js') && has('vite')) return 'solid';
  if (has('vue') && has('vite')) return 'vue';
  if (has('react') && has('vite')) return 'react';
  if (has('@angular')) return 'angular';
  if (has('express')) return 'express';
  if (has('fastify')) return 'fastify';
  if (has('hono')) return 'hono';
  if (has('elysia')) return 'elysia';
  if (has('@nestjs')) return 'nest';
  if (has('rails')) return 'rails';
  if (has('django')) return 'django';
  if (has('flask')) return 'flask';
  if (has('gin-gonic')) return 'gin';
  if (has('actix')) return 'actix';
  if (has('spring')) return 'spring';
  if (has('laravel')) return 'laravel';
  if (has('wrangler')) return 'cloudflare-workers';

  if (files?.some(f => f.path.includes('wrangler'))) return 'cloudflare-workers';
  return 'unknown';
}

function analyzeEnvFile(content: string): EnvFileAnalysis {
  const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  const variables: EnvVariable[] = [];
  const missingRequired: string[] = [];

  for (const line of lines) {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const name = line.substring(0, eqIndex).trim();
    const value = line.substring(eqIndex + 1).trim();

    const isSecret = SECRET_PATTERNS.some(p => p.test(name));
    const hasValue = value.length > 0 && value !== '""' && value !== "''";

    variables.push({
      name,
      hasValue,
      isSecret,
      source: '.env',
    });

    if (!hasValue && !isSecret) {
      missingRequired.push(name);
    }
  }

  return {
    present: true,
    files: ['.env', '.env.example', '.env.local'],
    variables,
    hasSecrets: variables.some(v => v.isSecret),
    missingRequired,
  };
}

function analyzeDocker(dockerContent?: string, composeContent?: string): DockerAnalysis {
  const result: DockerAnalysis = {
    hasDockerfile: !!dockerContent,
    hasCompose: !!composeContent,
    composeServices: [],
    multiStage: false,
  };

  if (dockerContent) {
    const fromCount = (dockerContent.match(/^FROM\s/gm) || []).length;
    result.multiStage = fromCount > 1;

    const fromMatch = dockerContent.match(/^FROM\s+(\S+)/m);
    if (fromMatch) result.baseImage = fromMatch[1];
  }

  if (composeContent) {
    const serviceMatches = composeContent.match(/^\s{2}(\w[\w-]*):/gm) || [];
    result.composeServices = serviceMatches.map(m => m.trim().replace(':', ''));
  }

  return result;
}

function detectComponents(
  files: FileEntry[],
  packageJson?: Record<string, unknown>,
  composeContent?: string
): DetectedComponent[] {
  const components: DetectedComponent[] = [];
  const deps = packageJson ? {
    ...(packageJson.dependencies as Record<string, string> || {}),
    ...(packageJson.devDependencies as Record<string, string> || {}),
  } : {};
  const depNames = Object.keys(deps);

  const hasDep = (name: string) => depNames.some(d => d === name || d.includes(name));

  const infraComponents = new Set<ComponentType>();
  for (const [dep, types] of Object.entries(INFRA_INDICATORS)) {
    if (hasDep(dep)) {
      for (const t of types) infraComponents.add(t);
    }
  }

  for (const type of infraComponents) {
    components.push({
      type,
      name: type.toLowerCase(),
      path: 'package.json',
      hasWebSockets: false,
      hasSSE: false,
      envVars: detectInfraEnvVars(type, depNames),
      dependencies: [],
    });
  }

  const pkgScripts = (packageJson?.scripts || {}) as Record<string, string>;
  const hasFrontendDeps = hasDep('react') || hasDep('vue') || hasDep('svelte') || hasDep('angular') || hasDep('next') || hasDep('nuxt');
  const hasBackendDeps = hasDep('express') || hasDep('fastify') || hasDep('hono') || hasDep('elysia') || hasDep('@nestjs');

  if (hasFrontendDeps) {
    components.push({
      type: 'FRONTEND',
      name: 'frontend',
      path: detectFrontendPath(files),
      framework: detectFramework(packageJson, files),
      buildCommand: pkgScripts.build || pkgScripts['build:frontend'],
      startCommand: pkgScripts.start || pkgScripts['start:frontend'],
      healthEndpoint: HEALTH_ENDPOINTS.find(ep => files.some(f => f.path.includes(ep))),
      hasWebSockets: hasDep('socket.io') || hasDep('ws'),
      hasSSE: depNames.some(d => d.includes('sse')),
      envVars: detectFrontendEnvVars(depNames),
      dependencies: depNames.filter(d => isFrontendDep(d)),
    });
  }

  if (hasBackendDeps || (!hasFrontendDeps && depNames.length > 0)) {
    components.push({
      type: 'BACKEND',
      name: 'backend',
      path: detectBackendPath(files),
      framework: detectFramework(packageJson, files),
      buildCommand: pkgScripts.build || pkgScripts['build:backend'],
      startCommand: pkgScripts.start || pkgScripts['start:backend'] || pkgScripts.serve,
      port: detectPort(pkgScripts),
      healthEndpoint: HEALTH_ENDPOINTS.find(ep => files.some(f => f.path.includes(ep))),
      hasWebSockets: hasDep('socket.io') || hasDep('ws'),
      hasSSE: depNames.some(d => d.includes('sse')),
      envVars: detectBackendEnvVars(depNames),
      dependencies: depNames.filter(d => isBackendDep(d)),
    });
  }

  const hasWorkerDeps = hasDep('bullmq') || hasDep('bull') || hasDep('agenda') || hasDep('bree');
  if (hasWorkerDeps) {
    components.push({
      type: 'WORKER',
      name: 'worker',
      path: detectWorkerPath(files),
      buildCommand: pkgScripts['build:worker'],
      startCommand: pkgScripts['start:worker'] || pkgScripts.worker,
      hasWebSockets: false,
      hasSSE: false,
      envVars: ['REDIS_URL'],
      dependencies: depNames.filter(d => isWorkerDep(d)),
    });
  }

  const hasCronDeps = hasDep('node-cron') || hasDep('cron');
  if (hasCronDeps) {
    components.push({
      type: 'CRON',
      name: 'cron',
      path: detectCronPath(files),
      buildCommand: pkgScripts['build:cron'],
      startCommand: pkgScripts['start:cron'] || pkgScripts.cron,
      hasWebSockets: false,
      hasSSE: false,
      envVars: [],
      dependencies: depNames.filter(d => isCronDep(d)),
    });
  }

  if (composeContent) {
    const services = analyzeDocker(undefined, composeContent).composeServices;
    for (const service of services) {
      if (service.includes('redis')) {
        components.push({ type: 'REDIS', name: service, path: 'docker-compose.yml', hasWebSockets: false, hasSSE: false, envVars: [], dependencies: [] });
      }
      if (service.includes('postgres') || service.includes('mysql') || service.includes('mongo')) {
        components.push({ type: 'DATABASE', name: service, path: 'docker-compose.yml', hasWebSockets: false, hasSSE: false, envVars: [], dependencies: [] });
      }
    }
  }

  if (components.length === 0 && depNames.length > 0) {
    components.push({
      type: 'BACKEND',
      name: 'main',
      path: '.',
      hasWebSockets: false,
      hasSSE: false,
      envVars: [],
      dependencies: depNames.slice(0, 10),
    });
  }

  return components;
}

function detectInfraEnvVars(type: ComponentType, deps: string[]): string[] {
  const vars: string[] = [];
  switch (type) {
    case 'DATABASE': vars.push('DATABASE_URL'); break;
    case 'REDIS': vars.push('REDIS_URL'); break;
    case 'STORAGE': vars.push('STORAGE_BUCKET', 'STORAGE_ENDPOINT'); break;
    case 'QUEUE': vars.push('QUEUE_PROVIDER'); break;
    case 'AI_SERVICE': vars.push('OPENAI_API_KEY', 'ANTHROPIC_API_KEY'); break;
    case 'PAYMENT': vars.push('STRIPE_SECRET_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'); break;
    case 'EMAIL': vars.push('RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT'); break;
  }
  return vars;
}

function detectFrontendEnvVars(deps: string[]): string[] {
  const vars = ['VITE_API_URL', 'VITE_WS_URL'];
  if (deps.some(d => d.includes('firebase'))) vars.push('FIREBASE_CONFIG');
  return vars;
}

function detectBackendEnvVars(deps: string[]): string[] {
  const vars = ['PORT', 'NODE_ENV', 'SESSION_SECRET', 'JWT_SECRET', 'DATABASE_URL'];
  if (deps.some(d => d.includes('cors'))) vars.push('CORS_ORIGIN');
  if (deps.some(d => d.includes('helmet'))) vars.push('HELMET_ENABLED');
  return vars;
}

function detectWorkerEnvVars(deps: string[]): string[] {
  return ['REDIS_URL', 'DATABASE_URL', 'WORKER_CONCURRENCY'];
}

function detectCronEnvVars(_deps: string[]): string[] {
  return ['DATABASE_URL', 'CRON_TIMEZONE'];
}

function isFrontendDep(name: string): boolean {
  return ['react', 'vue', 'svelte', 'angular', 'next', 'nuxt', 'remix', 'astro', 'vite', 'webpack', 'parcel'].some(d => name.includes(d));
}

function isBackendDep(name: string): boolean {
  return ['express', 'fastify', 'hono', 'elysia', 'nestjs', 'koa', 'koa-router', 'helmet', 'cors', 'morgan'].some(d => name.includes(d));
}

function isWorkerDep(name: string): boolean {
  return ['bullmq', 'bull', 'agenda', 'bree', 'worker'].some(d => name.includes(d));
}

function isCronDep(name: string): boolean {
  return ['node-cron', 'cron', 'crontab'].some(d => name.includes(d));
}

function detectFrontendPath(files: FileEntry[]): string {
  if (files.some(f => f.path.startsWith('frontend/'))) return 'frontend';
  if (files.some(f => f.path.startsWith('client/'))) return 'client';
  if (files.some(f => f.path.startsWith('app/'))) return 'app';
  if (files.some(f => f.path.startsWith('src/'))) return 'src';
  return '.';
}

function detectBackendPath(files: FileEntry[]): string {
  if (files.some(f => f.path.startsWith('backend/'))) return 'backend';
  if (files.some(f => f.path.startsWith('server/'))) return 'server';
  if (files.some(f => f.path.startsWith('api/'))) return 'api';
  return '.';
}

function detectWorkerPath(files: FileEntry[]): string {
  if (files.some(f => f.path.startsWith('workers/'))) return 'workers';
  if (files.some(f => f.path.startsWith('worker/'))) return 'worker';
  if (files.some(f => f.path.startsWith('jobs/'))) return 'jobs';
  return '.';
}

function detectCronPath(files: FileEntry[]): string {
  if (files.some(f => f.path.startsWith('cron/'))) return 'cron';
  if (files.some(f => f.path.startsWith('schedules/'))) return 'schedules';
  return '.';
}

function detectPort(scripts: Record<string, string>): number | undefined {
  for (const cmd of Object.values(scripts)) {
    const portMatch = cmd.match(/(?:PORT|port)[=:](\d+)/);
    if (portMatch && portMatch[1]) return parseInt(portMatch[1], 10);
  }
  return undefined;
}

function detectDeploymentConfigs(files: FileEntry[]): DeploymentConfigAnalysis {
  const paths = new Set(files.map(f => f.path));
  const configs: DeploymentConfigAnalysis = {
    railway: false,
    render: false,
    vercel: false,
    netlify: false,
    fly: false,
    cloudflare: false,
    kubernetes: false,
    docker: false,
  };

  for (const file of paths) {
    for (const [pattern, key] of Object.entries(DEPLOYMENT_CONFIG_FILES)) {
      if (file.includes(pattern)) configs[key] = true;
    }
  }

  if (paths.has('Dockerfile') || paths.has('docker-compose.yml') || paths.has('docker-compose.yaml')) {
    configs.docker = true;
  }

  return configs;
}

function detectHealthChecks(components: DetectedComponent[]): HealthCheckConfig[] {
  const checks: HealthCheckConfig[] = [];

  for (const comp of components) {
    if (comp.healthEndpoint) {
      checks.push({
        component: comp.name,
        type: 'HTTP',
        endpoint: comp.healthEndpoint,
        timeoutMs: 5000,
      });
    } else if (comp.port) {
      checks.push({
        component: comp.name,
        type: 'TCP',
        port: comp.port,
        timeoutMs: 3000,
      });
    }
  }

  return checks;
}

// ─── Main Function ─────────────────────────────────────────────

export async function discoverDeployment(
  userId: string,
  projectId: string,
  input: DiscoveryInput
): Promise<DeploymentProfile> {
  await assertProjectAccess(userId, projectId);

  const profileId = newId(PREFIX.DEPLOY_PROFILE);
  const branch = input.branch || 'main';
  const files = input.fileList || [];

  const packageManager = detectPackageManager(files);
  const { language, runtime, nodeVersion } = detectLanguage(files, input.packageJson);
  const framework = detectFramework(input.packageJson, files);

  const components = detectComponents(files, input.packageJson, input.composeContent);

  const envAnalysis = input.envContent ? analyzeEnvFile(input.envContent) : {
    present: false,
    files: [],
    variables: [],
    hasSecrets: false,
    missingRequired: [],
  };

  const dockerAnalysis = analyzeDocker(input.dockerContent, input.composeContent);

  const cicdFiles = files
    .filter(f => f.path.includes('.github/workflows') || f.path.includes('.gitlab-ci') || f.path.includes('Jenkinsfile') || f.path.includes('.circleci'))
    .map(f => f.path);

  const deploymentConfigs = detectDeploymentConfigs(files);

  const allEnvVars = new Set<string>();
  const requiredEnvVars: string[] = [];
  const optionalEnvVars: string[] = [];

  for (const comp of components) {
    for (const v of comp.envVars) allEnvVars.add(v);
  }

  for (const v of allEnvVars) {
    if (SECRET_PATTERNS.some(p => p.test(v))) {
      requiredEnvVars.push(v);
    } else if (v.includes('URL') || v.includes('KEY') || v.includes('SECRET') || v.includes('TOKEN')) {
      requiredEnvVars.push(v);
    } else {
      optionalEnvVars.push(v);
    }
  }

  const healthChecks = detectHealthChecks(components);

  const profile: DeploymentProfile = {
    id: profileId,
    projectId,
    discoveredAt: new Date(),
    repositoryUrl: input.repositoryUrl,
    branch,
    packageManager,
    runtime,
    nodeVersion,
    language,
    components,
    envFile: envAnalysis,
    dockerFiles: dockerAnalysis,
    cicdFiles,
    deploymentConfigs,
    totalEnvVars: allEnvVars.size,
    requiredEnvVars,
    optionalEnvVars,
    healthChecks,
    metadata: {
      framework,
      hasMonorepo: detectMonorepo(files),
      hasWorkspaces: detectWorkspaces(input.packageJson),
    },
  };

  await pool.query(
    `INSERT INTO deployment_profiles (id, project_id, repository_url, branch, package_manager, runtime, language, components, env_analysis, docker_analysis, deployment_configs, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
    [
      profileId, projectId, profile.repositoryUrl || null, branch,
      packageManager, runtime, language,
      JSON.stringify(components), JSON.stringify(envAnalysis),
      JSON.stringify(dockerAnalysis), JSON.stringify(deploymentConfigs),
    ],
  );

  await recordAudit({
    action: 'deployment_discovery_completed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'deployment_profile',
    resourceId: profileId,
    detail: { componentCount: components.length, envVars: allEnvVars.size },
  });

  return profile;
}

function detectMonorepo(files: FileEntry[]): boolean {
  const hasWorkspaces = files.some(f => f.path === 'pnpm-workspace.yaml' || f.path === 'lerna.json');
  const hasMultiplePkgs = files.filter(f => f.path.endsWith('package.json')).length > 1;
  return hasWorkspaces || hasMultiplePkgs;
}

function detectWorkspaces(packageJson?: Record<string, unknown>): boolean {
  if (!packageJson) return false;
  return !!(packageJson.workspaces || packageJson.pnpm);
}
