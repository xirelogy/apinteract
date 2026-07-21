import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Kysely, Transaction } from "kysely";

import { createEntityId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";

type WriteDatabase = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface AuditEventInput {
  readonly type: string;
  readonly actorUserId: EntityId | null;
  readonly workspaceId: EntityId | null;
  readonly data: Readonly<Record<string, unknown>>;
}

interface PersistedAuditEvent extends AuditEventInput {
  readonly id: EntityId;
  readonly occurredAt: string;
}

/**
 * Captures audit events transactionally and publishes them to JSONL segments.
 *
 * Domain operations write to the database outbox using their own transaction.
 * Publication happens later so an unavailable audit filesystem cannot make the
 * originating domain transaction partially succeed.
 */
export class AuditService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #rootPath: string;

  constructor(database: Kysely<DatabaseSchema>, rootPath: string) {
    this.#database = database;
    this.#rootPath = rootPath;
  }

  /** Adds an audit event to the caller's database transaction. */
  async record(database: WriteDatabase, input: AuditEventInput): Promise<void> {
    const id = createEntityId();
    const now = Date.now();
    const event: PersistedAuditEvent = {
      id,
      type: input.type,
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      occurredAt: new Date(now).toISOString(),
      data: input.data,
    };
    // Callers pass their active transaction when the audit record must commit
    // atomically with the domain state change.
    await database
      .insertInto("audit_outbox")
      .values({
        id: idToBytes(id),
        event_json: JSON.stringify(event),
        occurred_at: now,
        published_at: null,
      })
      .execute();
  }

  /** Publishes one bounded outbox batch to the active JSONL segment. */
  async publishPending(): Promise<number> {
    // Bounded batches prevent audit catch-up from monopolizing the process.
    const events = await this.#database
      .selectFrom("audit_outbox")
      .selectAll()
      .where("published_at", "is", null)
      .orderBy("occurred_at")
      .orderBy("id")
      .limit(100)
      .execute();
    if (events.length === 0) {
      return 0;
    }

    await mkdir(this.#rootPath, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const storagePath = join(this.#rootPath, `${day}.jsonl`);
    let segment = await this.#database
      .selectFrom("audit_segments")
      .selectAll()
      .where("storage_path", "=", storagePath)
      .executeTakeFirst();
    if (segment === undefined) {
      const segmentId = createEntityId();
      await this.#database
        .insertInto("audit_segments")
        .values({
          id: idToBytes(segmentId),
          storage_path: storagePath,
          state: "open",
          byte_length: 0,
          created_at: Date.now(),
          closed_at: null,
        })
        .execute();
      segment = await this.#database
        .selectFrom("audit_segments")
        .selectAll()
        .where("id", "=", idToBytes(segmentId))
        .executeTakeFirstOrThrow();
    }

    for (const eventRow of events) {
      const event = JSON.parse(eventRow.event_json) as PersistedAuditEvent;
      const line = `${eventRow.event_json}\n`;
      // The durable JSONL append must happen before publication is acknowledged
      // in the database. A crash between those operations can duplicate a line
      // on retry, so event IDs are the deduplication key for consumers.
      await appendFile(storagePath, line, { encoding: "utf8", mode: 0o600 });
      await this.#database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("audit_event_index")
          .values({
            event_id: eventRow.id,
            event_type: event.type,
            actor_user_id:
              event.actorUserId === null ? null : idToBytes(event.actorUserId),
            workspace_id:
              event.workspaceId === null ? null : idToBytes(event.workspaceId),
            segment_id: segment.id,
            occurred_at: eventRow.occurred_at,
          })
          .onConflict((conflict) => conflict.column("event_id").doNothing())
          .execute();
        await transaction
          .updateTable("audit_outbox")
          .set({ published_at: Date.now() })
          .where("id", "=", eventRow.id)
          .execute();
        await transaction
          .updateTable("audit_segments")
          .set((expression) => ({
            byte_length: expression(
              "byte_length",
              "+",
              Buffer.byteLength(line),
            ),
          }))
          .where("id", "=", segment.id)
          .execute();
      });
    }
    return events.length;
  }

  /** Counts audit events that have not yet been acknowledged as published. */
  async pendingCount(): Promise<number> {
    const result = await this.#database
      .selectFrom("audit_outbox")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("published_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }
}
