-- 0070: Model Routing observability columns.
-- Extends model_usage_logs (the existing usage/audit rail) so every inference
-- can record the canonical task-intent taxonomy and routing preference used to
-- select the model. Purely additive; nullable columns; RLS and tenant isolation
-- are untouched. No rows are modified or deleted.

ALTER TABLE model_usage_logs
  ADD COLUMN task_type text,
  ADD COLUMN routing_preference text;

COMMENT ON COLUMN model_usage_logs.task_type IS
  'Canonical task-intent category from the Model Routing taxonomy (e.g. CODING, DEBUGGING, MULTIMODAL_ANALYSIS).';
COMMENT ON COLUMN model_usage_logs.routing_preference IS
  'Routing preference used for the selection: AUTO / QUALITY / BALANCED / FAST / COST_SAVER.';