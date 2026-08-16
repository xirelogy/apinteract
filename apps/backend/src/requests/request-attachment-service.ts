import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import type { LocalBlobStore } from "../blobs/local-blob-store.js";
import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";

export const MAX_REQUEST_ATTACHMENT_BYTES = 786_432;

/** Raised when upload metadata or bytes violate the public attachment contract. */
export class RequestAttachmentValidationError extends Error {}

/** Public immutable metadata stored inside multipart request definitions. */
export interface RequestAttachmentView {
  readonly attachmentId: EntityId;
  readonly workspaceId: EntityId;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface MaterializedRequestAttachment extends RequestAttachmentView {
  readonly bytes: Buffer;
}

/**
 * Owns authenticated request-file uploads and exact provider-byte retrieval.
 *
 * Attachments belong to a workspace rather than one draft because immutable
 * revisions and duplicated requests may retain the same uploaded object.
 */
export class RequestAttachmentService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #blobs: LocalBlobStore;
  readonly #audit: AuditService | null;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    blobs: LocalBlobStore,
    audit: AuditService | null = null,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#blobs = blobs;
    this.#audit = audit;
  }

  /** Persists one bounded immutable upload after workspace edit authorization. */
  async upload(
    userId: EntityId,
    workspaceId: EntityId,
    fileName: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<RequestAttachmentView> {
    const normalizedFileName = validateFileName(fileName);
    const normalizedContentType = validateContentType(contentType);
    if (bytes.byteLength > MAX_REQUEST_ATTACHMENT_BYTES) {
      throw new RequestAttachmentValidationError(
        "Request attachment is too large",
      );
    }
    await this.#workspaces.requireCanEdit(this.#database, userId, workspaceId);
    const writer = this.#blobs.createWriter();
    let storageKey: string | undefined;
    try {
      await writer.write(bytes);
      const blob = await writer.commit();
      storageKey = blob.storageKey;
      const createdAt = Date.now();
      await this.#database.transaction().execute(async (transaction) => {
        // Authorization is repeated at commit so a membership change during
        // upload cannot publish a new workspace-owned attachment.
        await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
        await transaction
          .insertInto("request_attachments")
          .values({
            id: idToBytes(blob.id),
            workspace_id: idToBytes(workspaceId),
            provider_id: "local",
            storage_key: blob.storageKey,
            state: "available",
            file_name: normalizedFileName,
            content_type: normalizedContentType,
            byte_length: blob.byteLength,
            sha256: blob.sha256,
            created_by: idToBytes(userId),
            created_at: createdAt,
          })
          .execute();
        if (this.#audit !== null) {
          await this.#audit.record(transaction, {
            type: "request.attachment_uploaded",
            actorUserId: userId,
            workspaceId,
            data: {
              attachmentId: blob.id,
              byteLength: blob.byteLength,
            },
          });
        }
      });
      return {
        attachmentId: blob.id,
        workspaceId,
        fileName: normalizedFileName,
        contentType: normalizedContentType,
        byteLength: blob.byteLength,
        sha256: blob.sha256,
      };
    } catch (cause) {
      if (storageKey === undefined) {
        await writer.abort().catch(() => undefined);
      } else {
        await this.#blobs.remove(storageKey).catch(() => undefined);
      }
      throw cause;
    }
  }

  /** Reads one exact attachment only through its expected workspace owner. */
  async materialize(
    workspaceId: EntityId,
    attachmentId: EntityId,
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema> = this
      .#database,
  ): Promise<MaterializedRequestAttachment> {
    const row = await executor
      .selectFrom("request_attachments")
      .select([
        "id",
        "workspace_id",
        "storage_key",
        "state",
        "file_name",
        "content_type",
        "byte_length",
        "sha256",
      ])
      .where("id", "=", idToBytes(attachmentId))
      .where("workspace_id", "=", idToBytes(workspaceId))
      .executeTakeFirst();
    if (row === undefined || row.state !== "available") {
      throw new Error("Request attachment is unavailable");
    }
    const bytes = await this.#blobs.readWithinLimit(
      row.storage_key,
      row.byte_length,
      MAX_REQUEST_ATTACHMENT_BYTES,
    );
    if (bytes === undefined) {
      throw new Error("Request attachment is too large");
    }
    return {
      attachmentId: bytesToId(row.id),
      workspaceId: bytesToId(row.workspace_id),
      fileName: row.file_name,
      contentType: row.content_type,
      byteLength: row.byte_length,
      sha256: row.sha256,
      bytes,
    };
  }
}

/** Normalizes a display/header filename without accepting path syntax. */
function validateFileName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    /[\0\r\n/\\]/u.test(normalized)
  ) {
    throw new RequestAttachmentValidationError(
      "Request attachment filename is invalid",
    );
  }
  return normalized;
}

/** Normalizes the MIME type emitted for one multipart file part. */
function validateContentType(value: string): string {
  const normalized = value.trim() || "application/octet-stream";
  if (
    normalized.length > 255 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new RequestAttachmentValidationError(
      "Request attachment content type is invalid",
    );
  }
  return normalized;
}
