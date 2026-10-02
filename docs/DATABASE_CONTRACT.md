# CodeConClave Pro — DATABASE CONTRACT

> FROZEN. This document is the authoritative database contract. Migrations in
> `database/migrations/` implement it exactly. Any change requires a new
> migration and an updated contract entry — never an ad-hoc DDL edit.

## Conventions

- **IDs**: text, app-generated, prefixed (`usr_…`, `ses_…`, `prj_…`, `con_…`,
  `msg_…`, `mem_…`, `dna_…`, `tsk_…`, `atp_…`, `app_…`, `crw_…`, `pay_…`,
  `ent_…`, `plg_…`, `fil_…`, `out_…`, `aud_…`). No server-generated UUIDs in
  user-facing tables (enables offline/idempotent client IDs). `uuid` only where
  required by external providers.
- **Timestamps**: `timestamptz`, `created_at` and `updated_at` on every
  mutable table. `updated_at` maintained by `set_updated_at()` trigger.
- **Soft delete**: `deleted_at timestamptz NULL` where retention matters.
  Hard delete only for ephemeral data (queues, counters) and rows younger
  than retention window.
- **Money**: `numeric(12,2)` (INR) / `numeric(16,6)` (USD estimates). Never float.
- **JSON**: `jsonb` only for genuinely flexible payloads (tool inputs/outputs,
  evidence, plugin payloads). Business concepts get their own columns — the
  application state is **not** stored inside a single JSONB document.
- **Tenant isolation**: every tenant-scoped table carries `owner_id text NOT
  NULL REFERENCES users(id)` (personal scope) or `team_id text REFERENCES
  teams(id)` (team scope). Row-Level Security is enabled on all tenant tables
  and keyed on `app.uid()` (see `0014_rls.sql`). The backend sets
  `app.current_user_id` per request; client-supplied `owner_id` is never
  trusted.
- **State machines**: encoded with `CHECK` constraints on allowed states +
  code-level transition tables (see modules). Transitions are audited.
- **Audit**: `audit_logs` for every security-relevant action; `payment_audit`
  for payment lifecycle; `outbox_events` for reliable side-effect delivery
  (idempotent, retried).
- **Retention**:
  - sessions: purge expired rows older than 90 days.
  - audit_logs: 2 years.
  - payment_events/audit: 7 years (tax).
  - task_attempts/steps: 1 year after task completion.
  - messages: kept (product memory) unless user requests deletion.
- **Idempotency**: unique constraint on natural keys
  (e.g. `payment_sessions(provider_payment_id)`, `usage_counters(owner_id,name,bucket)`,
  `reactions(message_id,user_id,emoji)`). Consumers of `outbox_events` must be
  idempotent — every handler is keyed on `event_id`.
- **Naming**: `snake_case`, plural tables, `fk_` prefix for foreign keys in
  constraints, `idx_` for indexes, `uq_` for unique constraints, `chk_` for
  checks, `trg_` for triggers.

---

## 1. Identity

### users
- Purpose: authentication + identity + plan/entitlement carrier for the tenant.
- `id text PK`
- `email text NOT NULL` — `UNIQUE` via `uq_users_email` on `lower(email)`
- `email_verified bool NOT NULL DEFAULT false`
- `password_hash text NULL` (NULL when Google-only account)
- `display_name text NULL`
- `avatar_url text NULL`
- `google_sub text NULL UNIQUE` — Google OAuth subject
- `mfa_enabled bool NOT NULL DEFAULT false`
- `mfa_secret_encrypted text NULL` — server-side encrypted TOTP secret
- `recovery_codes_hash text NULL` — scrypt hash of recovery codes blob (10 codes)
- `rbac_role text NOT NULL DEFAULT 'member' CHECK (IN ('owner','admin','member'))`
- `plan_id text NOT NULL DEFAULT 'free' CHECK (IN ('free','pro'))`
- `entitlement_state text NOT NULL DEFAULT 'FREE' CHECK (IN ('FREE','PRO_PENDING','PRO_VERIFIED','PRO_EXPIRED','PRO_REFUNDED'))`
- `created_at`, `updated_at`, `deleted_at NULL`
- Indexes: `idx_users_email_lower(lower(email))`; `idx_users_google_sub`
- RLS: row visible to self only (`id = app.uid()`).

### sessions
- Purpose: server-side session store (stateless cookie carries only `session_id`; token hash lives here).
- `id text PK`, `user_id text NOT NULL FK users.id`
- `token_hash text NOT NULL UNIQUE` (SHA-256 of random 32B token)
- `device_id text NULL FK devices.id`, `ip text NULL`, `user_agent text NULL`
- `state text NOT NULL DEFAULT 'ACTIVE' CHECK (IN ('ACTIVE','REVOKED','EXPIRED'))`
- `expires_at timestamptz NOT NULL`, `last_seen_at timestamptz NOT NULL`
- `created_at`, `revoked_at NULL`
- Indexes: `idx_sessions_user_state(user_id, state)`; `idx_sessions_expires(expires_at)`
- RLS: user sees own sessions.

### devices
- Purpose: device management + secure pairing for Local Agent / Remote Control.
- `id text PK`, `user_id text NOT NULL FK users.id`, `name text NOT NULL`
- `pairing_code_hash text NULL UNIQUE` — single-use pairing code hash
- `state text NOT NULL DEFAULT 'PENDING_PAIRING' CHECK (IN ('PENDING_PAIRING','PAIRED','REVOKED'))`
- `paired_at NULL`, `last_seen_at NULL`, `created_at`
- RLS: user-scoped. Pairing code hash must be unguessable (≥ 16 random chars) and single-use.

### recovery_codes
- Purpose: per-code MFA recovery credentials (10 codes per user).
- `id text PK`, `user_id text NOT NULL FK users.id`
- `code_hash text NOT NULL UNIQUE` — scrypt per code
- `purpose text NOT NULL DEFAULT 'LOGIN'`
- `used_at timestamptz NULL`, `created_at`
- Check: codes are 10 chars `A-Z0-9`. One-time use enforced in code.
- RLS: user-scoped.

## 2. Collaboration

### teams
- `id text PK`, `owner_id text NOT NULL FK users.id`, `name text NOT NULL`
- `created_at`, `updated_at`
- RLS: member-visible via team_members.

### team_members
- `id text PK`, `team_id text NOT NULL FK teams.id`, `user_id text NOT NULL FK users.id`
- `role text NOT NULL DEFAULT 'member' CHECK (IN ('owner','admin','member'))`
- `created_at`; `UNIQUE (team_id, user_id)`
- RLS: visible to members of the team.

### projects
- `id text PK`, `owner_id text NOT NULL FK users.id`
- `team_id text NULL FK teams.id`
- `name text NOT NULL`, `description text NULL`, `repo_url text NULL`
- `workspace_root text NULL` — local path known only when Local Agent reports it
- `status text NOT NULL DEFAULT 'ACTIVE' CHECK (IN ('ACTIVE','ARCHIVED'))`
- `created_at`, `updated_at`
- Indexes: `idx_projects_owner(owner_id)`, `idx_projects_team(team_id)`
- RLS: owner + project_members.

### project_members
- `id text PK`, `project_id text NOT NULL FK projects.id`, `user_id text NOT NULL FK users.id`
- `role text NOT NULL DEFAULT 'member' CHECK (IN ('owner','admin','member'))`
- `created_at`, `UNIQUE (project_id, user_id)`

## 3. Conversations

### conversations
- `id text PK`, `project_id text NULL FK projects.id`, `owner_id text NOT NULL FK users.id`
- `title text NOT NULL DEFAULT 'New conversation'`
- `mode text NOT NULL CHECK (IN ('CHAT','COWORK'))`
- `created_at`, `updated_at`; index `(owner_id, updated_at DESC)`

### messages
- `id text PK`, `conversation_id text NOT NULL FK conversations.id`
- `sender text NOT NULL CHECK (IN ('USER','AI','SYSTEM','COWORKER'))`
- `coworker_type text NULL` (one of the 9 coworker types)
- `role text NOT NULL CHECK (IN ('user','assistant','system'))`
- `content text NOT NULL`
- `model_id text NULL`, `provider_id text NULL`
- `input_tokens int NULL`, `output_tokens int NULL`, `latency_ms int NULL`
- `status text NOT NULL DEFAULT 'PENDING' CHECK (IN ('PENDING','STREAMING','COMPLETED','FAILED'))`
- `error_code text NULL`
- `created_at`; index `(conversation_id, created_at)`
- RLS: conversation-scoped.

### threads
- `id text PK`, `conversation_id FK`, `parent_message_id text NULL FK messages.id`
- `title text NOT NULL`, `created_at`

### reactions
- `id text PK`, `message_id text NOT NULL FK messages.id`, `user_id text NOT NULL FK users.id`
- `emoji text NOT NULL`, `created_at`; `UNIQUE (message_id, user_id, emoji)`

### mentions
- `id text PK`, `message_id text NOT NULL FK messages.id`, `user_id text NOT NULL FK users.id`
- `created_at`; index `(user_id)` for notifications.

## 4. Memory

### memories
- `id text PK`, `project_id text NULL FK projects.id`, `team_id text NULL FK teams.id`
- `owner_id text NOT NULL FK users.id`
- `type text NOT NULL CHECK (IN ('EPISODIC','SEMANTIC','PROCEDURAL','PROJECT','TEAM'))`
- `source text NOT NULL CHECK (IN ('OBSERVED','USER_STATED','AI_INFERRED','RECOMMENDATION'))`
- `content text NOT NULL`, `structured jsonb NULL`
- `confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1)`
- `provenance text NULL` — where the memory came from (file, message, task, agent)
- `contradiction_state text NOT NULL DEFAULT 'NONE' CHECK (IN ('NONE','CANDIDATE','CONFIRMED','RESOLVED'))`
- `superseded_by_id text NULL FK memories.id`
- `deleted_at NULL`, `created_at`, `updated_at`
- `embedding vector(1536) NULL` (pgvector; optional until embedding pipeline configured)
- Indexes: `(owner_id, project_id, type)`, `(project_id)`; ivfflat/HNSW index deferred until embeddings active
- Rules: AI_INFERRED memory is never presented as fact; OBSERVED from files/tasks; USER_STATED has highest base confidence.
- RLS: owner + project_members.

### memory_sources
- Purpose: granular provenance per memory (a memory may aggregate several sources).
- `id text PK`, `memory_id text NOT NULL FK memories.id`
- `source_label text NOT NULL` (OBSERVED / USER_STATED / AI_INFERRED / RECOMMENDATION)
- `source_ref text NULL` (e.g. `file://…`, `task://…`, `message://…`)
- `captured_at timestamptz NOT NULL`, `confidence numeric(4,3) NULL`
- `created_at`; index `(memory_id)`

### memory_relationships
- `id text PK`, `source_memory_id text NOT NULL FK memories.id`
- `target_memory_id text NOT NULL FK memories.id`
- `relation text NOT NULL` (e.g. `supports`, `contradicts`, `extends`, `caused_by`)
- `weight numeric(4,3) NOT NULL DEFAULT 0.5`, `created_at`
- `CHECK (source_memory_id <> target_memory_id)`

## 5. DNA

### dna
- `id text PK`, `project_id text NOT NULL FK projects.id`, `owner_id text NOT NULL FK users.id`
- `kind text NOT NULL CHECK (IN ('DECISION','UNRESOLVED_WORK','NEXT_ACTIONS','DISCOVERY','BLOCKER','PROJECT_CONTEXT','RELEVANT_FILES','ENVIRONMENT_STATE','VERIFICATION_RESULT'))`
- `scope text NOT NULL DEFAULT 'MAIN' CHECK (IN ('MAIN','BRANCH'))`
- `title text NOT NULL`, `content text NOT NULL`
- `version int NOT NULL DEFAULT 1`
- `parent_version_id text NULL FK dna.id`
- `conflict_state text NOT NULL DEFAULT 'NONE' CHECK (IN ('NONE','CONFLICT','RESOLVED'))`
- `deleted_at NULL`, `created_at`, `updated_at`
- Indexes: `(project_id, scope, updated_at DESC)`, `(project_id, kind)`
- Team DNA: MAIN + BRANCH + MERGE; never silently overwrite conflicting branches.

### dna_versions
- Purpose: immutable snapshots for compare/restore/recovery.
- `id text PK`, `dna_id text NOT NULL FK dna.id`, `version int NOT NULL`
- `content_snapshot text NOT NULL`, `created_by text NULL FK users.id`, `created_at`
- `UNIQUE (dna_id, version)`

### dna_conflicts
- `id text PK`, `branch_dna_id text NOT NULL FK dna.id`, `base_dna_id text NOT NULL FK dna.id`
- `state text NOT NULL DEFAULT 'CONFLICT' CHECK (IN ('CONFLICT','RESOLVED'))`
- `resolution text NULL`, `resolved_at NULL`, `resolved_by text NULL FK users.id`
- `created_at`; `UNIQUE (branch_dna_id, base_dna_id)`

## 6. Files

### files
- `id text PK`, `project_id text NOT NULL FK projects.id`, `owner_id text NOT NULL FK users.id`
- `path text NOT NULL` (POSIX-style, project-relative; validated — no `..`, no absolute)
- `size_bytes bigint NOT NULL DEFAULT 0`
- `sha256 text NOT NULL` (content hash — verification gate for writes)
- `storage_key text NULL` (object-store key; NULL for directories)
- `storage_provider text NULL CHECK (IN ('memory','s3','r2'))`
- `mime_type text NULL`, `is_directory bool NOT NULL DEFAULT false`
- `created_at`, `updated_at`; `UNIQUE (project_id, path)` (soft-deleted rows excluded via partial index on `deleted_at IS NULL` — table also has `deleted_at NULL`)

### file_versions
- Purpose: history for diff / rollback / audit of every change.
- `id text PK`, `file_id text NOT NULL FK files.id`, `version int NOT NULL`
- `content_sha256 text NOT NULL`, `size_bytes bigint NOT NULL`
- `storage_key text NULL`, `change_reason text NULL`, `created_by text NULL FK users.id`
- `created_at`; `UNIQUE (file_id, version)`

### file_permissions
- `id text PK`, `file_id text NOT NULL FK files.id`
- `grantee_user_id text NULL FK users.id`, `grantee_team_id text NULL FK teams.id`
- `permission text NOT NULL CHECK (IN ('read','write','delete'))`
- `created_at`; `CHECK (grantee_user_id IS NOT NULL OR grantee_team_id IS NOT NULL)`
- Default: project membership governs; explicit grants only extend.

### file_references
- Purpose: link files to memories / DNA / messages / tasks (provenance).
- `id text PK`, `file_id text NOT NULL FK files.id`, `project_id text NOT NULL FK projects.id`
- `ref_path text NULL`, `ref_type text NOT NULL CHECK (IN ('memory','dna','message','task'))`
- `ref_id text NOT NULL`, `created_at`; index `(file_id)`, `(ref_type, ref_id)`

## 7. Execution

### tasks
- `id text PK`, `project_id text NOT NULL FK projects.id`, `conversation_id text NULL FK conversations.id`
- `owner_id text NOT NULL FK users.id`
- `title text NOT NULL`, `description text NULL`, `plan text NULL`
- `status text NOT NULL DEFAULT 'CREATED' CHECK (IN ('CREATED','PLANNED','WAITING_APPROVAL','RUNNING','TESTING','VERIFIED','COMPLETED','FAILED','TIMED_OUT','CANCELLED','BLOCKED','WAITING_FOR_LOCAL_AGENT','REQUIRES_REVIEW'))`
- `risk_level text NOT NULL DEFAULT 'MEDIUM' CHECK (IN ('LOW','MEDIUM','HIGH','CRITICAL'))`
- `required_approval bool NOT NULL DEFAULT false`, `approval_id text NULL FK approvals.id`
- `coworker_pipeline jsonb NULL` (array of coworker types)
- `execution_mode text NOT NULL DEFAULT 'CLOUD' CHECK (IN ('CLOUD','LOCAL','HYBRID'))`
- `timeout_ms int NOT NULL DEFAULT 600000`, `started_at NULL`, `completed_at NULL`, `failed_at NULL`
- `error_code text NULL`, `error_detail text NULL`
- `attempt_count int NOT NULL DEFAULT 0`, `max_attempts int NOT NULL DEFAULT 3`
- `last_heartbeat_at NULL`, `watchdog_checked_at NULL`
- `created_at`, `updated_at`
- Indexes: `(owner_id, status)`, `(project_id)`, `(updated_at)` (watchdog sweep), `(status, updated_at)`
- Invariant: no task may stay RUNNING forever — watchdog transitions to TIMED_OUT/FAILED; heartbeat must renew within `TASK_HEARTBEAT_MS`.

### task_attempts
- `id text PK`, `task_id text NOT NULL FK tasks.id`, `attempt_number int NOT NULL`
- `started_at timestamptz NOT NULL`, `finished_at NULL`
- `result text NULL CHECK (IN ('SUCCESS','FAILURE','TIMEOUT','CANCELLED'))`
- `error_code text NULL`, `output_summary text NULL`, `created_at`
- `UNIQUE (task_id, attempt_number)`

### task_steps
- `id text PK`, `task_id text NOT NULL FK tasks.id`, `attempt_id text NULL FK task_attempts.id`
- `kind text NOT NULL` (plan / execute / verify / artifact / review)
- `title text NOT NULL`, `status text NOT NULL CHECK (IN ('PENDING','RUNNING','COMPLETED','FAILED','SKIPPED'))`
- `detail jsonb NULL`, `output text NULL`, `error_code text NULL`
- `started_at NULL`, `completed_at NULL`, `created_at`; index `(task_id)`

### tool_calls
- Purpose: the complete ledger of every tool invocation — the boundary where LLM output meets execution.
- `id text PK`, `task_id text NULL FK tasks.id`, `step_id text NULL FK task_steps.id`
- `tool_name text NOT NULL` (typed schema, registry-validated — no free-form shell)
- `input jsonb NOT NULL`, `output jsonb NULL`
- `risk_level text NOT NULL CHECK (IN ('LOW','MEDIUM','HIGH','CRITICAL'))`
- `status text NOT NULL CHECK (IN ('PROPOSED','APPROVED','EXECUTED','DENIED','FAILED','ROLLED_BACK'))`
- `approval_id text NULL FK approvals.id`
- `started_at NULL`, `completed_at NULL`, `created_at`
- Indexes: `(task_id)`, `(status)`
- Invariant: `status` reaches `EXECUTED` only via policy engine + (approval if risk demands).

### approvals
- `id text PK`, `task_id text NULL FK tasks.id`, `owner_id text NOT NULL FK users.id`
- `detail jsonb NOT NULL DEFAULT '{}'::jsonb`
- `risk_level text NOT NULL CHECK (IN ('LOW','MEDIUM','HIGH','CRITICAL'))`
- `status text NOT NULL DEFAULT 'PENDING' CHECK (IN ('PENDING','APPROVED','REJECTED','EXPIRED','REVOKED'))`
- `decision text NULL CHECK (IN ('APPROVE','REJECT'))`
- `decided_by text NULL FK users.id`, `decided_at NULL`
- `expires_at timestamptz NOT NULL`, `created_at`
- Indexes: `(owner_id, status)`, `(status, expires_at)`
- Invariant: HIGH/CRITICAL always require approval; approvals expire (TTL by risk level).

### artifacts
- `id text PK`, `task_id text NULL FK tasks.id`, `coworker_run_id text NULL FK coworker_runs.id`
- `name text NOT NULL`, `kind text NOT NULL` (file / report / patch / test-result / log)
- `storage_key text NULL`, `sha256 text NOT NULL`, `size_bytes bigint NOT NULL DEFAULT 0`
- `created_at`; index `(task_id)`, `(coworker_run_id)`
- Invariant: every artifact carries a content hash — verification is not cosmetic.

## 8. Coworkers

### coworker_runs
- `id text PK`, `task_id text NOT NULL FK tasks.id`, `coworker_type text NOT NULL`
- `order_index int NOT NULL`
- `state text NOT NULL DEFAULT 'QUEUED' CHECK (IN ('QUEUED','PLANNING','RUNNING','VERIFYING','COMPLETED','FAILED','TIMED_OUT','CANCELLED','BLOCKED'))`
- `input jsonb NULL`, `output jsonb NULL`
- `verification_result text NULL CHECK (IN ('PASS','FAIL','SKIPPED'))`
- `error_code text NULL`, `timeout_ms int NOT NULL DEFAULT 1800000`
- `started_at NULL`, `completed_at NULL`, `created_at`, `updated_at`
- `UNIQUE (task_id, coworker_type, order_index)` — guards duplicate pipeline entries

### coworker_handoffs
- `id text PK`, `from_run_id text NOT NULL FK coworker_runs.id`, `to_run_id text NOT NULL FK coworker_runs.id`
- `handoff_summary text NOT NULL`, `created_at`

### coworker_artifacts
- `id text PK`, `run_id text NOT NULL FK coworker_runs.id`
- `name text NOT NULL`, `kind text NOT NULL`, `content text NULL`, `storage_key text NULL`, `sha256 text NOT NULL`
- `created_at`; index `(run_id)`

## 9. AI

### ai_model_registry
- Purpose: configuration-driven model catalogue; server is authoritative for what the client may use.
- `model_id text PK`
- `provider_id text NOT NULL CHECK (IN ('anthropic','openai','google','mistral'))`
- `display_name text NOT NULL`
- `tier text NOT NULL CHECK (IN ('PREMIUM','CAPABLE','EFFICIENT'))`
- `compute_class text NOT NULL CHECK (IN ('A','B','C'))`
- `context_window int NOT NULL`, `supports_vision bool NOT NULL DEFAULT false`
- `supports_tools bool NOT NULL DEFAULT false`, `supports_function_calling bool NOT NULL DEFAULT false`
- `input_cost_per_m numeric(16,6) NOT NULL DEFAULT 0`, `output_cost_per_m numeric(16,6) NOT NULL DEFAULT 0` (USD per 1M tokens)
- `entitlement text NOT NULL DEFAULT 'FREE' CHECK (IN ('FREE','PRO'))`
- `privacy_class text NOT NULL DEFAULT 'STANDARD' CHECK (IN ('PUBLIC','STANDARD','STRICT'))`
- `target_latency_ms int NOT NULL DEFAULT 5000`
- `health text NOT NULL DEFAULT 'UNKNOWN' CHECK (IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN'))`
- `priority int NOT NULL DEFAULT 100`
- `fallback_list jsonb NOT NULL DEFAULT '[]'::jsonb`
- `enabled bool NOT NULL DEFAULT true`
- `effective_date date NOT NULL DEFAULT CURRENT_DATE`, `deprecation_date date NULL`

### model_usage_logs
- Purpose: cost governance — every inference, one row.
- `id text PK`, `user_id text NOT NULL FK users.id`
- `task_id text NULL`, `session_id text NOT NULL`, `conversation_id text NULL`
- `provider_id text NOT NULL`, `model_id text NOT NULL`
- `plan_id text NOT NULL`, `compute_class text NOT NULL`
- `input_tokens int NOT NULL`, `output_tokens int NOT NULL`
- `estimated_cost_usd numeric(16,6) NOT NULL`, `actual_cost_usd numeric(16,6) NULL`
- `duration_ms int NULL`, `used_fallback bool NOT NULL DEFAULT false`
- `created_at`; indexes `(user_id, created_at)`, `(provider_id, created_at)`

### provider_health
- `provider_id text PK CHECK (IN ('anthropic','openai','google','mistral'))`
- `state text NOT NULL DEFAULT 'UNKNOWN' CHECK (IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN'))`
- `last_check_at NULL`, `last_error text NULL`
- `consecutive_failures int NOT NULL DEFAULT 0`, `success_count bigint NOT NULL DEFAULT 0`, `failure_count bigint NOT NULL DEFAULT 0`
- `avg_latency_ms numeric(10,2) NULL`, `updated_at`

## 10. Payments

### payment_sessions
- Purpose: one row per checkout attempt; **state transitions are frozen**:
  `PENDING → VERIFIED | FAILED | EXPIRED | CANCELLED`, `VERIFIED → REFUNDED`.
  `PENDING → VERIFIED` requires **independent provider evidence** (signed webhook
  or authenticated API status query). Never from user claim, browser redirect,
  screenshot, localStorage, URL parameter, or AI inference.
- `id text PK`, `user_id text NOT NULL FK users.id`
- `plan_id text NOT NULL`, `amount_inr int NOT NULL`, `currency text NOT NULL DEFAULT 'INR'`
- `mode text NOT NULL CHECK (IN ('PAYMENT_LINK','API','WEBHOOK'))`
- `state text NOT NULL DEFAULT 'PENDING' CHECK (IN ('PENDING','VERIFIED','FAILED','EXPIRED','REFUNDED','CANCELLED'))`
- `reference text NULL` (provider payment-link reference)
- `provider_payment_id text NULL` `UNIQUE` (partial: where not null) — idempotency anchor
- `provider_order_id text NULL`
- `verification_evidence jsonb NULL` (raw signed payload / API response snapshot)
- `expires_at timestamptz NOT NULL` (7 days), `created_at`, `updated_at`
- Indexes: `(user_id, state)`, `(state, expires_at)`

### payments
- `id text PK`, `session_id text NOT NULL FK payment_sessions.id`
- `amount_inr int NOT NULL`, `currency text NOT NULL DEFAULT 'INR'`
- `status text NOT NULL DEFAULT 'PENDING'` (mirrors provider status; independent of session state)
- `provider text NOT NULL DEFAULT 'razorpay'`
- `provider_ref text NULL UNIQUE`
- `paid_at NULL`, `verification_evidence jsonb NULL`
- `created_at`, `updated_at`

### entitlements
- `id text PK`, `user_id text NOT NULL FK users.id`
- `plan_id text NOT NULL`, `state text NOT NULL CHECK (IN ('FREE','PRO_PENDING','PRO_VERIFIED','PRO_EXPIRED','PRO_REFUNDED'))`
- `verified_at NULL`, `expires_at NULL`, `payment_session_id text NULL FK payment_sessions.id`
- `reason text NULL`, `created_at`, `updated_at`
- `UNIQUE (user_id, plan_id)` — one entitlement row per plan per user.

### payment_events
- Purpose: immutable event ledger (webhooks, API polls, admin actions) with signature validity.
- `id text PK`, `session_id text NULL FK payment_sessions.id`, `user_id text NULL`
- `event_type text NOT NULL` (payment.paid, payment.failed, payment_link.created, …)
- `payload jsonb NOT NULL`, `source text NOT NULL CHECK (IN ('WEBHOOK','API','LINK','ADMIN'))`
- `signature_valid bool NULL`, `created_at`
- Index `(session_id, created_at)`; retention 7 years.

### payment_audit
- `id text PK`, `session_id text NOT NULL FK payment_sessions.id`
- `actor_user_id text NULL FK users.id`, `action text NOT NULL`, `detail jsonb NULL`
- `created_at`; retention 7 years.

## 11. Plugins

### plugins (catalogue)
- `plugin_type text PK CHECK (IN ('github','slack','vercel','vscode','webhook'))`
- `name text NOT NULL`, `description text NULL`
- `capabilities jsonb NOT NULL DEFAULT '[]'::jsonb`
- `enabled bool NOT NULL DEFAULT true`, `created_at`

### plugin_connections
- `id text PK`, `owner_id text NOT NULL FK users.id`
- `plugin_type text NOT NULL FK plugins.plugin_type`
- `name text NOT NULL`
- `state text NOT NULL DEFAULT 'DISCONNECTED' CHECK (IN ('DISCONNECTED','CONNECTING','CONNECTED','ERROR','REVOKED'))`
- `scopes jsonb NOT NULL DEFAULT '[]'::jsonb`
- `credential_ref text NULL` — key into encrypted credential vault, never the secret itself
- `last_health_check_at NULL`, `last_error text NULL`
- `created_at`, `updated_at`; `UNIQUE (owner_id, plugin_type)` (one connection per plugin per user)
- Invariant: plugin failure must not crash CodeConClave (circuit breaker per connection).

### plugin_scopes
- `id text PK`, `connection_id text NOT NULL FK plugin_connections.id`
- `scope text NOT NULL`, `granted_at timestamptz NOT NULL`, `expires_at timestamptz NULL`
- `revoked_at NULL`; index `(connection_id)`

### plugin_events
- `id text PK`, `connection_id text NOT NULL FK plugin_connections.id`
- `event_type text NOT NULL`, `payload jsonb NULL`, `state text NOT NULL`
- `created_at`; index `(connection_id, created_at)`; retention 90 days.

## 12. Workspace

### workspace_state
- `id text PK`, `owner_id text NOT NULL FK users.id`
- `key text NOT NULL`, `value jsonb NOT NULL DEFAULT '{}'::jsonb`, `updated_at`
- `UNIQUE (owner_id, key)` — last_active_project, return_to_work, …

### user_preferences
- `id text PK`, `owner_id text NOT NULL FK users.id UNIQUE`
- `prefs jsonb NOT NULL DEFAULT '{}'::jsonb` (theme, focus mode, auto-approval policy for LOW risk, …)
- `updated_at`

### feature_flags
- `id text PK`, `name text NOT NULL UNIQUE`, `value jsonb NOT NULL`, `updated_at`
- Server-side only; never read from client.

### usage_counters
- `id text PK`, `owner_id text NOT NULL FK users.id`
- `name text NOT NULL` (daily_messages, daily_ai_input_tokens, daily_ai_output_tokens, daily_estimated_cost_usd, storage_bytes_used)
- `bucket text NOT NULL` (e.g. `2026-08-14`)
- `value bigint NOT NULL DEFAULT 0`, `updated_at`
- `UNIQUE (owner_id, name, bucket)` — idempotent increments.
- Free-limit enforcement reads these server-side; never trust client state.

## 13. Audit

### audit_logs
- `id text PK`, `actor_user_id text NULL FK users.id`
- `tenant_scope text NOT NULL CHECK (IN ('USER','TEAM','SYSTEM'))`
- `tenant_id text NULL`, `action text NOT NULL`
- `resource_type text NULL`, `resource_id text NULL`
- `detail jsonb NULL`, `ip text NULL`, `user_agent text NULL`, `trace_id text NULL`
- `created_at`; indexes `(tenant_scope, tenant_id, created_at DESC)`, `(action, created_at DESC)`
- Retention: 2 years. Write-path: async (outbox) to never block the hot path.

### events
- `id text PK`, `topic text NOT NULL`, `payload jsonb NULL`, `occurred_at timestamptz NOT NULL`
- Index `(topic, occurred_at)`; retention 90 days.

### outbox_events
- Purpose: reliable, idempotent side-effect delivery (email, webhooks, notifications).
- `id text PK`, `topic text NOT NULL`, `payload jsonb NOT NULL`
- `status text NOT NULL DEFAULT 'PENDING' CHECK (IN ('PENDING','DELIVERED','FAILED'))`
- `attempts int NOT NULL DEFAULT 0`, `max_attempts int NOT NULL DEFAULT 5`
- `next_attempt_at timestamptz NOT NULL DEFAULT now()`, `delivered_at NULL`
- `created_at`; index `(status, next_attempt_at)`.

---

## RLS policy summary (0014_rls.sql)

- `app.uid()` returns `app.current_user_id` session setting (set by backend per
  request from the authenticated session) — never client-provided.
- Tenant tables: `USING (owner_id = app.uid())` + `WITH CHECK (owner_id = app.uid())`.
- Team tables: membership via `EXISTS (team_members)`.
- Conversation child rows: inherited through parent join.
- Service worker rows (`events`, `provider_health`, `feature_flags`, `plugins`
  catalogue, `ai_model_registry`): RLS off; accessible only via service role —
  never exposed to clients except through read APIs.
- Supabase: the same policies apply under the `authenticated` role; the backend
  additionally sets `app.current_user_id` so local Postgres behaves identically.

## Migration discipline

- One migration per concern, numbered `NNNN_description.sql`, applied in order,
  recorded with SHA-256 in `schema_migrations` (see `backend/src/database/migrate.ts`).
- Migrations are transactional; a failed migration rolls back atomically.
- Schema changes go to `database/migrations/` — never generated by ORMs at runtime.
