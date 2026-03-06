import type { Connection } from "espalier-jdbc";
import type { DomainEvent, OutboxEntry, OutboxOptions } from "../types.js";

// Access Web Crypto API available in Node 19+, Bun, Deno, and browsers
const _crypto = (globalThis as Record<string, unknown>)["crypto"] as {
  randomUUID(): string;
};

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function validateIdentifier(name: string, label: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid ${label}: "${name}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
  }
}

export class OutboxStore {
  private readonly tableName: string;
  private readonly schemaName?: string;

  constructor(options?: OutboxOptions) {
    this.tableName = options?.tableName ?? "outbox";
    this.schemaName = options?.schemaName;
    validateIdentifier(this.tableName, "tableName");
    if (this.schemaName !== undefined) {
      validateIdentifier(this.schemaName, "schemaName");
    }
  }

  private get qualifiedTable(): string {
    return this.schemaName
      ? `${escapeIdent(this.schemaName)}.${escapeIdent(this.tableName)}`
      : escapeIdent(this.tableName);
  }

  /**
   * Write events to the outbox table in the same transaction as entity changes.
   * This is the key to the transactional outbox pattern — events are written
   * atomically with the business data.
   */
  async writeEvents(connection: Connection, events: DomainEvent[]): Promise<OutboxEntry[]> {
    if (events.length === 0) {
      return [];
    }

    const entries: OutboxEntry[] = [];
    const paramValues: Array<string | null> = [];
    const rowPlaceholders: string[] = [];
    let paramIndex = 1;

    for (const event of events) {
      const id = _crypto.randomUUID();
      const now = new Date();

      rowPlaceholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`,
      );

      paramValues.push(
        id,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        now.toISOString(),
      );

      paramIndex += 6;

      entries.push({
        id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: now,
        publishedAt: null,
      });
    }

    const sql = `INSERT INTO ${this.qualifiedTable} ("id", "aggregate_type", "aggregate_id", "event_type", "payload", "created_at") VALUES ${rowPlaceholders.join(", ")}`;

    const stmt = connection.prepareStatement(sql);
    try {
      for (let i = 0; i < paramValues.length; i++) {
        stmt.setParameter(i + 1, paramValues[i]);
      }
      await stmt.executeUpdate();
    } finally {
      await stmt.close();
    }

    return entries;
  }

  /**
   * Fetch unpublished outbox entries, ordered by creation time.
   * Used by the polling publisher.
   */
  async fetchUnpublished(connection: Connection, batchSize: number): Promise<OutboxEntry[]> {
    const sql = `SELECT "id", "aggregate_type", "aggregate_id", "event_type", "payload", "created_at", "published_at" FROM ${this.qualifiedTable} WHERE "published_at" IS NULL ORDER BY "created_at" ASC LIMIT $1`;

    const stmt = connection.prepareStatement(sql);
    try {
      stmt.setParameter(1, batchSize);
      const rs = await stmt.executeQuery();
      try {
        const results: OutboxEntry[] = [];
        while (await rs.next()) {
          const row = rs.getRow();
          results.push({
            id: row.id as string,
            aggregateType: row.aggregate_type as string,
            aggregateId: row.aggregate_id as string,
            eventType: row.event_type as string,
            payload:
              typeof row.payload === "string"
                ? (Object.assign(Object.create(null), JSON.parse(row.payload)) as Record<string, unknown>)
                : (row.payload as Record<string, unknown>),
            createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
            publishedAt: row.published_at
              ? row.published_at instanceof Date
                ? row.published_at
                : new Date(row.published_at as string)
              : null,
          });
        }
        return results;
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }
  }

  /**
   * Mark entries as published.
   */
  async markPublished(connection: Connection, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }

    const BATCH_SIZE = 1000;
    const now = new Date().toISOString();

    for (let offset = 0; offset < entryIds.length; offset += BATCH_SIZE) {
      const chunk = entryIds.slice(offset, offset + BATCH_SIZE);
      const placeholders = chunk.map((_, i) => `$${i + 2}`).join(", ");
      const sql = `UPDATE ${this.qualifiedTable} SET "published_at" = $1 WHERE "id" IN (${placeholders})`;

      const stmt = connection.prepareStatement(sql);
      try {
        stmt.setParameter(1, now);
        for (let i = 0; i < chunk.length; i++) {
          stmt.setParameter(i + 2, chunk[i]);
        }
        await stmt.executeUpdate();
      } finally {
        await stmt.close();
      }
    }
  }

  /**
   * Delete old published entries (cleanup).
   * Returns the count of deleted rows.
   */
  async deletePublished(connection: Connection, olderThan: Date): Promise<number> {
    const sql = `DELETE FROM ${this.qualifiedTable} WHERE "published_at" IS NOT NULL AND "published_at" < $1`;

    const stmt = connection.prepareStatement(sql);
    try {
      stmt.setParameter(1, olderThan.toISOString());
      return await stmt.executeUpdate();
    } finally {
      await stmt.close();
    }
  }

  /**
   * Generate DDL for creating the outbox table.
   */
  generateCreateTableDdl(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
  "id" TEXT NOT NULL PRIMARY KEY,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "published_at" TIMESTAMPTZ
)`;
  }

  /**
   * Generate DDL for indexes on the outbox table.
   */
  generateIndexesDdl(): string[] {
    const safeName = this.tableName.replace(/[^a-zA-Z0-9_]/g, "_");
    return [
      `CREATE INDEX IF NOT EXISTS "idx_${safeName}_unpublished" ON ${this.qualifiedTable} ("created_at") WHERE "published_at" IS NULL`,
      `CREATE INDEX IF NOT EXISTS "idx_${safeName}_created_at" ON ${this.qualifiedTable} ("created_at")`,
    ];
  }
}
