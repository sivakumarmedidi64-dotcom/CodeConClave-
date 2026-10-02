-- ---------------------------------------------------------------------------
-- 0074_control_plane_rls_guc_correction.sql
-- Realises the tenant-isolation intent of migrations 0048-0051.
--
-- The 24 RLS policies introduced by 0048-0051 read
--   current_setting('app.user_id', true)
-- but the backend sets its RLS key via withTenant() as
--   app.current_user_id   (backend/src/shared/db.ts, function app.uid()
--                          defined in 0001_extensions.sql).
-- 'app.user_id' is never set, so every one of these policies was inert:
-- under non-owner roles they deny all rows, and the current app role
-- (table owner) bypasses RLS entirely. This migration re-creates each
-- policy against the GUC the application actually populates.
--
-- Corrective + additive only. No schema change, no behaviour change while
-- RLS remains owner-bypassed; it makes the applied policies correct for any
-- role that has RLS enforced (FORCE / non-owner), matching the documented
-- intent in FINAL_BLOCKER_REMEDIATION_REPORT.md.
-- ---------------------------------------------------------------------------

-- 0048 automation ------------------------------------------------------------
DROP POLICY IF EXISTS automation_rules_owner ON automation_rules;
CREATE POLICY automation_rules_owner ON automation_rules
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS automation_runs_owner ON automation_runs;
CREATE POLICY automation_runs_owner ON automation_runs
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS event_log_owner ON event_log;
CREATE POLICY event_log_owner ON event_log
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS workflow_recipes_read ON workflow_recipes;
CREATE POLICY workflow_recipes_read ON workflow_recipes
  USING (owner_id = current_setting('app.current_user_id', true)::text OR (system = true AND owner_id = 'system'));

DROP POLICY IF EXISTS webhook_secrets_owner ON webhook_secrets;
CREATE POLICY webhook_secrets_owner ON webhook_secrets
  USING (owner_id = current_setting('app.current_user_id', true)::text);

-- 0049 recovery --------------------------------------------------------------
DROP POLICY IF EXISTS task_checkpoints_owner ON task_checkpoints;
CREATE POLICY task_checkpoints_owner ON task_checkpoints
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS task_branches_owner ON task_branches;
CREATE POLICY task_branches_owner ON task_branches
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS failure_autopsies_owner ON failure_autopsies;
CREATE POLICY failure_autopsies_owner ON failure_autopsies
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS recovery_history_owner ON recovery_history;
CREATE POLICY recovery_history_owner ON recovery_history
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS irreversible_actions_owner ON irreversible_actions;
CREATE POLICY irreversible_actions_owner ON irreversible_actions
  USING (owner_id = current_setting('app.current_user_id', true)::text);

-- 0050 engineering -----------------------------------------------------------
DROP POLICY IF EXISTS review_swarms_owner ON review_swarms;
CREATE POLICY review_swarms_owner ON review_swarms
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS review_findings_owner ON review_findings;
CREATE POLICY review_findings_owner ON review_findings
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS dependency_upgrades_owner ON dependency_upgrades;
CREATE POLICY dependency_upgrades_owner ON dependency_upgrades
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS flake_records_owner ON flake_records;
CREATE POLICY flake_records_owner ON flake_records
  USING (owner_id = current_setting('app.current_user_id', true)::text);

DROP POLICY IF EXISTS ci_runs_owner ON ci_runs;
CREATE POLICY ci_runs_owner ON ci_runs
  USING (owner_id = current_setting('app.current_user_id', true)::text);

-- 0051 control plane ---------------------------------------------------------
DROP POLICY IF EXISTS preview_comments_owner ON preview_comments;
CREATE POLICY preview_comments_owner ON preview_comments
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS preview_snapshots_owner ON preview_snapshots;
CREATE POLICY preview_snapshots_owner ON preview_snapshots
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS proof_of_work_reports_owner ON proof_of_work_reports;
CREATE POLICY proof_of_work_reports_owner ON proof_of_work_reports
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS plugin_sandbox_runs_owner ON plugin_sandbox_runs;
CREATE POLICY plugin_sandbox_runs_owner ON plugin_sandbox_runs
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS control_policies_owner ON control_policies;
CREATE POLICY control_policies_owner ON control_policies
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS kill_switch_owner ON kill_switch;
CREATE POLICY kill_switch_owner ON kill_switch
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS undo_log_owner ON undo_log;
CREATE POLICY undo_log_owner ON undo_log
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS secret_guard_scans_owner ON secret_guard_scans;
CREATE POLICY secret_guard_scans_owner ON secret_guard_scans
  USING (owner_id = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS usage_rollups_owner ON usage_rollups;
CREATE POLICY usage_rollups_owner ON usage_rollups
  USING (owner_id = current_setting('app.current_user_id', true));