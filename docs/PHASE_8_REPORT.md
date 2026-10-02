# PHASE 8 — Files + Storage + Global Search + Artifact Center + Data Centre + Trash Recovery (Report)

## Status
COMPLETE. The real persistent file subsystem now covers: multipart upload with
new-file and overwrite-versioning (SHA-256 verified, version chain with parent
references), path security (traversal, control chars, protected resources,
blocked executables/MIME), honest at-rest encryption (AES-256-GCM on upload,
decrypt + hash verify on read), honest preview/OCR metadata (never faked),
versions + rollback with hash verification and `restore-v1` references,
file→entity references (memory/dna/message/task/artifact/conversation),
read/write/delete grants, nested folder tree, favorites, recent, project-scoped
search, a tenant-scoped global search across files/projects/conversations/
memories/tasks/artifacts, an Artifact Center (task + coworker artifacts merged,
SHA-256 verified downloads, artifact→file references), a Data Centre report
(persisted counts, project allocation, activity timeline, cleanup candidates,
storage_meta provider snapshot, honest provider status), and a 30-day trash
lifecycle (soft delete, restore, bulk restore/purge, per-file permanent delete,
expired-purge sweeps in the watchdog). Files/Data/Artifact Center pages and the
Topbar global search are wired to the real API. Migration 0030 is static-only
(PostgreSQL runtime unavailable). Nothing is claimed as production-ready; see
PostgreSQL runtime + External blockers.

## Files created
- `backend/src/modules/files/service.ts` — files service: `normalizePath`
  (backslashes/leading slashes/dot segments collapsed; `..` invalidates the
  path), `uploadFile` (security checks in order: control chars → protected
  resources → blocked types → size limit; new-file insert + version 1; overwrite
  insert + `parent_version` reference + sha/size update; encryption when
  `storageEncryptionEnabled()`), `getFile`/`getFileContent` (owner/member/grant
  access, decrypt + hash verify, FILE_READ audit), `listFiles`, `fileTree`,
  `favoriteFiles`/`recentFiles`/`trashFiles` (tenant-scoped
  `(f.owner_id = $1 OR f.project_id IN (SELECT project_id FROM project_members
  WHERE user_id = $1))`), `fileVersions` (parent_version + rollback_reference),
  `restoreFileVersion` (verify CURRENT hash, verify TARGET hash, write target
  bytes, new version with `restore-v1` reason + `version:N` reference — never
  restores unverifiable content), `setFileTags`/`setFileCategory`/`toggleFavorite`
  (audited), `addFileReference` (ON CONFLICT DO NOTHING), `setFilePermission`
  (grant/revoke + FILE_PERMISSION_GRANTED/REVOKED audits),
  `softDeleteFile`/`restoreFile` (usage delta restored only if previously
  trashed), `restoreFilesBulk`/`softDeleteFilesBulk` (ANY($1::text[]) + rowCount),
  `permanentDeleteFile`/`purgeFilesBulk` (storage delete, version + permission
  rows, never file_references), `purgeExpiredTrash` (30-day window, tenant or
  SYSTEM scope), `searchProjectFiles`, `listFileReferences`, `listFileActivity`,
  `recordFileActivity`.
- `backend/src/modules/files/routes.ts` — multer in-memory upload
  (`upload.array('files', 20)`), all frontend-consumed paths: `GET /` `/search`
  `/tree` `/recent` `/favorites` `/trash`, `POST /upload` `/restore-bulk`
  `/purge-bulk` `/purge-expired` `/trash/soft-delete`, `GET /:id` `/:id/content`
  `/:id/versions` `/:id/references` `/:id/activity`, `POST /:id/restore-version`
  `/:id/favorite` `/:id/tags` `/:id/category` `/:id/references` `/:id/permissions`
  `/:id/trash` `/:id/restore`, `PATCH /:id`, `DELETE /:id` and `DELETE
  /:id/permanent`. Responses are serialized to the snake_case FileRef wire shape
  the frontend consumes.
- `backend/src/modules/search/service.ts` — `globalSearch(userId, filters)`
  (`invalid_type`/`owner_scope` guards, escapeLike, LIMIT inlined literal,
  tenant clause on files/projects/tasks/artifacts, conversations/memories by
  owner, SEARCH_PERFORMED audit with `{entity, q, filters}`).
- `backend/src/modules/search/routes.ts` — `GET /api/v1/search` (q/type/
  projectId/dateFrom/dateTo/ownerId/tag/limit).
- `backend/src/modules/artifacts/service.ts` — `createTaskArtifact` (task auth
  owner or owner/editor/member role; kind validation; content inline or
  storage-backed with SHA-256 + verification; ARTIFACT_CREATED audit),
  `listArtifacts` (merged task + coworker artifacts, tenant-scoped, newest
  first), `downloadArtifact` (hash-verified content or base64 storage read,
  ARTIFACT_DOWNLOADED audit), `artifactReferences`.
- `backend/src/modules/artifacts/routes.ts` — `POST /` `GET /` `GET /:id/download`
  `GET /:id/references` under `/api/v1/artifacts`.
- `backend/src/modules/datacentre/service.ts` — `getDataCentre(userId)`:
  quota by plan (free 2GB / pro 100GB, over-limit flag), persisted counts
  (files, trashed, versions, folders via `btrim(split_part(path,'/',1))`,
  memories, tasks, artifacts incl. coworker artifacts), project allocation,
  activity timeline (from file_activity), 30-day cleanup candidates,
  storage_meta upsert (provider snapshot), DATA_CENTRE_VIEWED audit, honest
  provider status (LOCAL_STORAGE / R2_NOT_CONFIGURED).
- `backend/src/modules/datacentre/routes.ts` — `GET /api/v1/data-centre`.
- `backend/src/foundation/files-8.test.ts` (23 tests), `trash-8.test.ts` (11),
  `search-8.test.ts` (12), `artifacts-8.test.ts` (11), `datacentre-8.test.ts`
  (7) — Phase 8 contract suite (64 tests).
- `docs/PHASE_8_REPORT.md` — this report.

## Files modified
- `shared/src/constants.ts` — added `FILE_PERMISSION_REVOKED:
  'file.permission_revoked'` (all other Phase 8 constants — ProPlan, FileLifecycle,
  PreviewKind, PreviewStatus, OcrStatus, SearchEntity, FileRetention,
  ArtifactKind, StorageProviderStatus, and the Phase 8 AuditAction codes —
  already existed and are unchanged).
- `backend/src/modules/execution/tools.ts` — aligned `file_read`/`file_list`
  adapters to the real files service contract (`mimeType`, `sizeBytes`).
- `backend/src/workers/watchdog.ts` — added the `purgeExpiredTrash` sweep
  (expired trash purge) alongside the existing payment/plugin sweeps.
- `backend/src/app.ts` — the four Phase 8 route factories were already
  registered (`/api/v1/files`, `/api/v1/search`, `/api/v1/artifacts`,
  `/api/v1/data-centre`); they now resolve.
- `frontend/src/components/Topbar.tsx` — global search input with debounced
  `/api/v1/search` results dropdown, per-entity navigation (files/projects/
  conversations/memory/tasks/artifacts). Sidebar unchanged (frozen 18-item spec).

## Storage
- Provider-agnostic adapter (`backend/src/integrations/storage.ts`): `memory`
  (dev default), `s3`, `r2` (deferred — no credentials). `storageMode()`,
  `storageEncryptionEnabled()` and `storageHealth()` are real and honest:
  `LOCAL_STORAGE` when memory/S3, `R2_NOT_CONFIGURED` when R2 is not wired —
  the Data Centre test asserts R2 is never claimed as active.
- Upload keys are namespaced (`codeconclave/projects/<projectId>/<fileId>`,
  `codeconclave/artifacts/<projectId>/<taskId>/<id>`); blobs are put into the
  live adapter and fetched back on read; files without a storage key are
  reported as `content_missing` rather than invented.

## Files
- Path policy: `normalizePath` collapses backslashes, duplicate slashes,
  leading slashes, `.` segments; any `..` makes the path invalid
  (`path_invalid`); control characters rejected.
- Protected resources: `.env` (+ `.env.*`), `.netrc`, `.htpasswd`, `.pgpass`,
  `.npmrc`, `.pypirc`, `secrets.json`, `credentials.json`, `id_rsa/dsa/ecdsa/
  ed25519/ed448`, and extensions `pem/key/p12/pfx/ppk/p8` are rejected
  (`protected_path`); executable extensions and MIME types (`exe/dll/bat/cmd/
  com/scr/pif/msi/msix/appx/jar/class/apk/dmg/deb/rpm/ps1/vbs/ocx/sys`,
  `application/x-msdownload` family) are rejected (`blocked_type`); files over
  `MAX_UPLOAD_MB` (50) rejected (`file_too_large`).
- Metadata: tags (trim/dedupe/cap 40 chars/20 tags), category, description,
  favorite — each mutation audited and activity-logged; preview kind/status and
  OCR status are honest defaults (`UNAVAILABLE` — never faked).
- At-rest encryption: when enabled, uploads are encrypted with AES-256-GCM
  (`encryptBuffer`) before storage and `encrypted=true` is persisted; reads
  decrypt and verify the SHA-256; any mismatch → `hash_mismatch` 409.
- Access control: owner, or project_members role (owner/editor/member), or an
  explicit `file_permissions` grant (read/write/delete) may access; others get
  `file_access_denied` 403.
- Versions: every upload writes a numbered version with `content_sha256`,
  size, reason (`upload`/`restore-v1`), `created_by`, `parent_version` and
  `rollback_reference`; rollback verifies both the current blob and the target
  version blob before writing target bytes and appending a new version.
- References: `file_references` rows (ref_type memory/dna/message/task/
  artifact/conversation, created_by) dedupe on (ref_type, ref_id, file_id) and
  survive file purges by design.

## Versions
- Upload of a new path → version 1; upload of an existing path → new version
  with `parent_version` = current max, plus live sha256/size_bytes update and
  storage overwrite. `fileVersions` returns the full chain newest-first with
  parent + rollback references. `restoreFileVersion` refuses `hash_mismatch`
  on either the current or target content, writes `restore-v1` with
  `rollback_reference = version:N`, adjusts usage by the byte delta and audits
  `file.version_restored`.

## Search
- Project-scoped: `GET /api/v1/files/search?projectId=&q=` (path ILIKE,
  escaped, live files only, access-checked).
- Global: `GET /api/v1/search?q=&type=&projectId=&dateFrom=&dateTo=&ownerId=&tag=&limit=`
  — tenant-scoped across files (path ILIKE + project/created/tag filters),
  projects, conversations, memories, tasks and artifacts; `limit` default 20
  (max 50, min 1); each search audited `search.performed` with the entity, query
  and applied filters. The Topbar search box drives it from the frontend.

## Artifacts
- `POST /api/v1/artifacts` creates a task artifact (owner or owner/editor/
  member), content inline or storage-backed with SHA-256 + verification
  (`PASS`/`FAIL`/`SKIPPED`), attempt reference, created_by; `GET /api/v1/artifacts`
  merges task artifacts and coworker-run artifacts (run_id, coworker_type,
  task_title) newest-first; `GET /:id/download` returns verified content
  (`utf8`) or base64 storage blob; `GET /:id/references` lists the file
  references pointing at the artifact. WorkPage's embedded Artifact Center
  (unchanged) consumes exactly this contract.

## Data Centre
- `GET /api/v1/data-centre` returns only persisted numbers: quota (plan,
  limit/used bytes, MB + percent, over-limit), file/trashed/version/folder
  counts (folders from distinct top-level path segments), memories, tasks,
  artifacts (task + coworker), per-project allocation, the last 10 file-activity
  events, files past the 30-day retention window, `retentionDays`,
  `provider.{mode, encryptionAtRest, healthy, lastHealthCheckAt}` and the
  storage_meta upsert of the same snapshot. Every visit is audited with the real
  used/file/trashed numbers. Nothing is invented.

## Trash / Recovery
- Soft delete sets `deleted_at` (recovery window 30 days); `GET /files/trash`
  lists recoverable files; `POST /:id/restore` and `POST /restore-bulk` restore
  (usage re-added only when previously trashed); `DELETE /:id/permanent`,
  `POST /purge-bulk` and `POST /purge-expired` permanently purge (storage blob +
  versions + permissions deleted; references kept; audits `file.deleted_permanent`
  and `trash.purged`). The watchdog `purgeExpiredTrash` sweep removes files past
  retention system-wide each cycle.

## Frontend
- FilesPage (upload, tree, search, versions/rollback, references, activity,
  favorite/tags/category, delete) and DataPage (full report render) already
  existed and are now driven by the real Phase 8 endpoints — routes were written
  to the exact wire shape those pages consume (snake_case rows, multipart field
  `files`, query/body contracts verified against the pages). WorkPage's Artifact
  Center hits the real artifact endpoints. The Topbar gains a debounced global
  search with per-entity navigation. The 18-item sidebar is unchanged.

## Database migrations
- `0030_phase8_files_storage.sql` (static): `files` += `tags text[]`, `category`,
  `description`, `is_favorite`, `preview_kind` (CHECK TEXT/CODE/JSON/MARKDOWN/
  IMAGE/PDF/UNKNOWN), `preview_status` (CHECK AVAILABLE/UNAVAILABLE),
  `ocr_status` (CHECK UNAVAILABLE), `encrypted`; `file_activity`,
  `storage_meta` (unique owner_id+key), `file_versions` += `parent_version` +
  `rollback_reference`, `file_references` CHECK extended with artifact/
  conversation types, `created_by`/`granted_by` columns.
- IMPORTANT: PostgreSQL runtime is NOT available in this environment. The
  migration is validated for SQL syntax only and was never applied. Do not
  claim runtime migration success.

## Tests
- `files-8.test.ts` (23): normalizePath (backslashes/leading slashes/dot
  segments, `..` rejection), protected resources, blocked executables + MIME,
  upload size limit, invalid paths, new-file insert (17-column order, preview/
  OCR honesty, storage put, version 1, audits), overwrite versioning with
  parent reference, encryption round-trip + hash-mismatch rejection, version
  restore (rollback reference, hash-mismatch refusals), versions list with
  parent/rollback, tags/category/favorite metadata, access control (owner,
  grants, denied), reference types, folder tree, tenant-scoped favorites/
  recent, listFiles access + trash exclusion, not-found.
- `trash-8.test.ts` (11): soft delete + restore, tenant-scoped trash list,
  bulk restore/purge (rowCount semantics), permanent delete (`not_trashed`
  conflict, storage/version/permission cleanup, reference survival), expired
  purge (user-scoped + system-wide).
- `search-8.test.ts` (12): query construction per entity (exact tenant clause
  and filter params), invalid type, owner-scope guard, empty-query early return,
  LIMIT inlining (20/50), audit shape.
- `artifacts-8.test.ts` (11): content + buffer artifacts (storage key prefix,
  verification, param order), access denial + editor allowance, missing task,
  merged listing with coworker aliases, filters, downloads (utf8/base64),
  references.
- `datacentre-8.test.ts` (7): free/pro quota, over-limit, counts/allocations/
  activity/cleanup, storage_meta snapshot, R2 honesty, audit detail.

## Validation
- shared: build PASS, 56/56 tests (46 pre-existing + 10 Phase 8 contracts).
- local-agent: 49/49 tests, build PASS.
- backend: typecheck PASS, build PASS, 542/542 tests (478 pre-existing + 64 new).
- frontend: typecheck PASS, build PASS, 62/62 tests.
- Total: 709/709.

## Blockers
- PostgreSQL runtime unavailable — migration 0030 was static-validated only;
  runtime migration, the files/file_versions/file_activity/storage_meta DDL,
  and RLS behavior are unverified.
- No real storage provider credentials — the S3-compatible adapter is
  capability-ready and the R2 path reports `R2_NOT_CONFIGURED` honestly; only
  the in-memory adapter is exercised by tests.
- No lint scripts configured in any workspace — typecheck + build are the
  enforced gates.
- Encryption keys derive from the existing SESSION_SECRET; in a real deployment
  key rotation and KMS integration would be required (documented as a
  production concern, not implemented).