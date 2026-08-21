/**
 * CodeConClave — Phase 8 shared contracts.
 * Files + storage + search + artifact center constants must be frozen and
 * match the values the backend migration and services rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  FileLifecycle,
  PreviewKind,
  PreviewStatus,
  OcrStatus,
  StorageProviderStatus,
  SearchEntity,
  FileRetention,
  ArtifactKind,
  AuditAction,
  ProPlan,
} from './constants.js';

describe('Phase 8 — file lifecycle', () => {
  it('file lifecycle covers ACTIVE, TRASHED and RESTORED', () => {
    expect(FileLifecycle.ACTIVE).toBe('ACTIVE');
    expect(FileLifecycle.TRASHED).toBe('TRASHED');
    expect(FileLifecycle.RESTORED).toBe('RESTORED');
  });

  it('preview kinds cover text, code, json, markdown, image, pdf and unknown', () => {
    expect(PreviewKind.TEXT).toBe('TEXT');
    expect(PreviewKind.CODE).toBe('CODE');
    expect(PreviewKind.JSON).toBe('JSON');
    expect(PreviewKind.MARKDOWN).toBe('MARKDOWN');
    expect(PreviewKind.IMAGE).toBe('IMAGE');
    expect(PreviewKind.PDF).toBe('PDF');
    expect(PreviewKind.UNKNOWN).toBe('UNKNOWN');
  });

  it('preview status is honest: AVAILABLE or UNAVAILABLE', () => {
    expect(PreviewStatus.AVAILABLE).toBe('AVAILABLE');
    expect(PreviewStatus.UNAVAILABLE).toBe('UNAVAILABLE');
  });

  it('OCR is never faked: the only status is UNAVAILABLE', () => {
    expect(OcrStatus.UNAVAILABLE).toBe('UNAVAILABLE');
  });

  it('storage provider status distinguishes LOCAL, S3-COMPATIBLE and R2_NOT_CONFIGURED', () => {
    expect(StorageProviderStatus.LOCAL_STORAGE).toBe('LOCAL_STORAGE');
    expect(StorageProviderStatus.S3_COMPATIBLE).toBe('S3_COMPATIBLE');
    expect(StorageProviderStatus.R2_NOT_CONFIGURED).toBe('R2_NOT_CONFIGURED');
  });
});

describe('Phase 8 — search, retention and artifacts', () => {
  it('search entities cover files, projects, conversations, memories, tasks and artifacts', () => {
    const entities = [
      SearchEntity.FILE,
      SearchEntity.PROJECT,
      SearchEntity.CONVERSATION,
      SearchEntity.MEMORY,
      SearchEntity.TASK,
      SearchEntity.ARTIFACT,
    ];
    expect(entities).toEqual(['file', 'project', 'conversation', 'memory', 'task', 'artifact']);
  });

  it('trash retention window is 30 days', () => {
    expect(FileRetention.TRASH_RETENTION_DAYS).toBe(30);
  });

  it('artifact kinds are the supported Artifact Center kinds', () => {
    expect(ArtifactKind.DIFF).toBe('diff');
    expect(ArtifactKind.TEST_REPORT).toBe('test_report');
    expect(ArtifactKind.LOG).toBe('log');
    expect(ArtifactKind.RESEARCH).toBe('research');
    expect(ArtifactKind.VERIFICATION_REPORT).toBe('verification_report');
    expect(ArtifactKind.SCREENSHOT).toBe('screenshot');
    expect(ArtifactKind.DEPLOYMENT_OUTPUT).toBe('deployment_output');
    expect(ArtifactKind.FILE).toBe('file');
  });

  it('Phase 8 audit action codes exist', () => {
    expect(AuditAction.FILE_UPLOADED).toBe('file.uploaded');
    expect(AuditAction.FILE_VERSION_RESTORED).toBe('file.version_restored');
    expect(AuditAction.FILE_TRASHED).toBe('file.trashed');
    expect(AuditAction.FILE_RESTORED).toBe('file.restored');
    expect(AuditAction.FILE_FAVORITED).toBe('file.favorited');
    expect(AuditAction.FILE_DELETED_PERMANENT).toBe('file.deleted_permanent');
    expect(AuditAction.FILE_DOWNLOADED).toBe('file.downloaded');
    expect(AuditAction.SEARCH_PERFORMED).toBe('search.performed');
    expect(AuditAction.ARTIFACT_CREATED).toBe('artifact.created');
    expect(AuditAction.ARTIFACT_DOWNLOADED).toBe('artifact.downloaded');
    expect(AuditAction.TRASH_PURGED).toBe('trash.purged');
  });

  it('pro plan exposes the storage quota used by quota calculations', () => {
    expect(ProPlan.STORAGE_GB).toBe(100);
  });
});