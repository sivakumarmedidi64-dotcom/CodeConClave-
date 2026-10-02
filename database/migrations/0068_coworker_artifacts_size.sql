-- 0068: coworker_artifacts gains size_bytes (fixes artifact-center 500)
-- listArtifacts() selects ca.size_bytes which did not exist on this table.
-- Add the column (mirroring `artifacts.size_bytes`) and backfill from content.

ALTER TABLE coworker_artifacts
  ADD COLUMN size_bytes bigint NOT NULL DEFAULT 0;

UPDATE coworker_artifacts
  SET size_bytes = octet_length(content)
  WHERE content IS NOT NULL;
