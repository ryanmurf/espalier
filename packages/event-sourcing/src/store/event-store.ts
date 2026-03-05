import type { Connection } from "espalier-jdbc";
import type { DomainEvent, StoredEvent, EventStoreOptions } from "../types.js";
import { ConcurrencyError } from "./concurrency-error.js";

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

export class EventStore {
  private readonly tableName: string;
  private readonly schemaName?: string;

  constructor(options?: EventStoreOptions) {
    this.tableName = options?.tableName ?? "event_store";
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
   * Append events to the store for a given aggregate.
   * Uses optimistic concurrency control — if the current version does not
   * match `expectedVersion`, a {@link ConcurrencyError} is thrown.
   */
  async append(
    connection: Connection,
    aggregateId: string,
    aggregateType: string,
    events: DomainEvent[],
    expectedVersion: number,
  ): Promise<StoredEvent[]> {
    if (events.length === 0) {
      return [];
    }

    // ---- optimistic concurrency check ----
    const currentVersion = await this.getCurrentVersion(connection, aggregateId);
    if (currentVersion !== expectedVersion) {
      throw new ConcurrencyError(aggregateId, expectedVersion, currentVersion);
    }

    // ---- build multi-row INSERT ----
    const storedEvents: StoredEvent[] = [];
    const paramValues: Array<string | number | Date | null> = [];
    const rowPlaceholders: string[] = [];
    let paramIndex = 1;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const eventId = _crypto.randomUUID();
      const version = expectedVersion + i + 1;
      const timestamp = event.timestamp ?? new Date();
      const metadata = event.metadata ?? null;

      rowPlaceholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`,
      );

      paramValues.push(
        eventId,
        aggregateId,
        aggregateType,
        event.eventType,
        JSON.stringify(event.payload),
        version,
        timestamp as unknown as string, // driver handles Date conversion
        metadata ? JSON.stringify(metadata) : null,
      );

      paramIndex += 8;

      storedEvents.push({
        eventId,
        aggregateId,
        aggregateType,
        eventType: event.eventType,
        payload: event.payload,
        version,
        timestamp,
        metadata: event.metadata,
        sequence: 0, // will be filled from RETURNING
      });
    }

    const sql = `INSERT INTO ${this.qualifiedTable} ("event_id", "aggregate_id", "aggregate_type", "event_type", "payload", "version", "timestamp", "metadata") VALUES ${rowPlaceholders.join(", ")} RETURNING "sequence"`;

    const stmt = connection.prepareStatement(sql);
    try {
      for (let i = 0; i < paramValues.length; i++) {
        stmt.setParameter(i + 1, paramValues[i] as string | number | null);
      }

      let rs;
      try {
        rs = await stmt.executeQuery();
      } catch (err: unknown) {
        // Defense-in-depth: catch unique constraint violations (PG error code 23505)
        const pgCode = (err as { code?: string })?.code;
        if (pgCode === "23505") {
          const actual = await this.getCurrentVersion(connection, aggregateId);
          throw new ConcurrencyError(aggregateId, expectedVersion, actual);
        }
        throw err;
      }
      try {
        let idx = 0;
        while (await rs.next()) {
          const seq = rs.getNumber("sequence");
          if (seq !== null && idx < storedEvents.length) {
            // Rebuild with correct sequence
            (storedEvents[idx] as { sequence: number }).sequence = seq;
          }
          idx++;
        }
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }

    return storedEvents;
  }

  /**
   * Load all events for an aggregate, optionally filtered by type and
   * starting from a specific version.
   */
  async loadEvents(
    connection: Connection,
    aggregateId: string,
    aggregateType?: string,
    fromVersion?: number,
  ): Promise<StoredEvent[]> {
    const conditions: string[] = ['"aggregate_id" = $1'];
    const params: Array<string | number> = [aggregateId];
    let paramIdx = 2;

    if (aggregateType !== undefined) {
      conditions.push(`"aggregate_type" = $${paramIdx}`);
      params.push(aggregateType);
      paramIdx++;
    }

    if (fromVersion !== undefined) {
      conditions.push(`"version" >= $${paramIdx}`);
      params.push(fromVersion);
      paramIdx++;
    }

    const sql = `SELECT "event_id", "aggregate_id", "aggregate_type", "event_type", "payload", "version", "sequence", "timestamp", "metadata" FROM ${this.qualifiedTable} WHERE ${conditions.join(" AND ")} ORDER BY "version" ASC`;

    return this.executeEventQuery(connection, sql, params);
  }

  /**
   * Load events for an aggregate up to (and including) a specific version.
   */
  async loadEventsUpTo(
    connection: Connection,
    aggregateId: string,
    version: number,
  ): Promise<StoredEvent[]> {
    const sql = `SELECT "event_id", "aggregate_id", "aggregate_type", "event_type", "payload", "version", "sequence", "timestamp", "metadata" FROM ${this.qualifiedTable} WHERE "aggregate_id" = $1 AND "version" <= $2 ORDER BY "version" ASC`;

    return this.executeEventQuery(connection, sql, [aggregateId, version]);
  }

  /**
   * Get the current (maximum) version number for an aggregate.
   * Returns 0 if no events exist for the aggregate.
   */
  async getCurrentVersion(
    connection: Connection,
    aggregateId: string,
  ): Promise<number> {
    const sql = `SELECT MAX("version") AS "max_version" FROM ${this.qualifiedTable} WHERE "aggregate_id" = $1`;

    const stmt = connection.prepareStatement(sql);
    try {
      stmt.setParameter(1, aggregateId);
      const rs = await stmt.executeQuery();
      try {
        if (await rs.next()) {
          const maxVersion = rs.getNumber("max_version");
          return maxVersion ?? 0;
        }
        return 0;
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }
  }

  /**
   * Generate DDL for creating the event store table.
   */
  generateCreateTableDdl(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
  "event_id" TEXT NOT NULL PRIMARY KEY,
  "aggregate_id" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "version" INTEGER NOT NULL,
  "sequence" BIGSERIAL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "metadata" JSONB,
  UNIQUE("aggregate_id", "version")
)`;
  }

  /**
   * Generate DDL for indexes on the event store table.
   */
  generateIndexesDdl(): string[] {
    const safeName = this.tableName.replace(/[^a-zA-Z0-9_]/g, "_");
    return [
      `CREATE INDEX IF NOT EXISTS "idx_${safeName}_aggregate_id" ON ${this.qualifiedTable} ("aggregate_id")`,
      `CREATE INDEX IF NOT EXISTS "idx_${safeName}_aggregate_type" ON ${this.qualifiedTable} ("aggregate_type")`,
      `CREATE INDEX IF NOT EXISTS "idx_${safeName}_sequence" ON ${this.qualifiedTable} ("sequence")`,
    ];
  }

  /**
   * Load events across all aggregates with optional filtering.
   * Results are ordered by sequence (global ordering).
   */
  async loadAllEvents(
    connection: Connection,
    options?: {
      aggregateTypes?: string[];
      eventTypes?: string[];
      fromSequence?: number;
      fromTimestamp?: Date;
      toTimestamp?: Date;
      fromVersion?: number;
      limit?: number;
    },
  ): Promise<StoredEvent[]> {
    const conditions: string[] = [];
    const params: Array<string | number | Date> = [];
    let paramIdx = 1;

    if (options?.aggregateTypes && options.aggregateTypes.length > 0) {
      const placeholders = options.aggregateTypes.map((_, i) => `$${paramIdx + i}`);
      conditions.push(`"aggregate_type" IN (${placeholders.join(", ")})`);
      params.push(...options.aggregateTypes);
      paramIdx += options.aggregateTypes.length;
    }

    if (options?.eventTypes && options.eventTypes.length > 0) {
      const placeholders = options.eventTypes.map((_, i) => `$${paramIdx + i}`);
      conditions.push(`"event_type" IN (${placeholders.join(", ")})`);
      params.push(...options.eventTypes);
      paramIdx += options.eventTypes.length;
    }

    if (options?.fromSequence !== undefined) {
      conditions.push(`"sequence" > $${paramIdx}`);
      params.push(options.fromSequence);
      paramIdx++;
    }

    if (options?.fromTimestamp !== undefined) {
      conditions.push(`"timestamp" >= $${paramIdx}`);
      params.push(options.fromTimestamp as unknown as string as unknown as number);
      paramIdx++;
    }

    if (options?.toTimestamp !== undefined) {
      conditions.push(`"timestamp" <= $${paramIdx}`);
      params.push(options.toTimestamp as unknown as string as unknown as number);
      paramIdx++;
    }

    if (options?.fromVersion !== undefined) {
      conditions.push(`"version" >= $${paramIdx}`);
      params.push(options.fromVersion);
      paramIdx++;
    }

    const whereClause = conditions.length > 0
      ? ` WHERE ${conditions.join(" AND ")}`
      : "";

    const limitClause = options?.limit !== undefined
      ? ` LIMIT $${paramIdx}`
      : "";

    if (options?.limit !== undefined) {
      params.push(options.limit);
    }

    const sql = `SELECT "event_id", "aggregate_id", "aggregate_type", "event_type", "payload", "version", "sequence", "timestamp", "metadata" FROM ${this.qualifiedTable}${whereClause} ORDER BY "sequence" ASC${limitClause}`;

    return this.executeEventQuery(connection, sql, params as Array<string | number>);
  }

  // ---- private helpers ----

  private async executeEventQuery(
    connection: Connection,
    sql: string,
    params: Array<string | number>,
  ): Promise<StoredEvent[]> {
    const stmt = connection.prepareStatement(sql);
    try {
      for (let i = 0; i < params.length; i++) {
        stmt.setParameter(i + 1, params[i]);
      }

      const rs = await stmt.executeQuery();
      try {
        const results: StoredEvent[] = [];
        while (await rs.next()) {
          const row = rs.getRow();
          results.push({
            eventId: row.event_id as string,
            aggregateId: row.aggregate_id as string,
            aggregateType: row.aggregate_type as string,
            eventType: row.event_type as string,
            payload: typeof row.payload === "string"
              ? (Object.assign(Object.create(null), JSON.parse(row.payload)) as Record<string, unknown>)
              : (row.payload as Record<string, unknown>),
            version: row.version as number,
            sequence: row.sequence as number,
            timestamp: row.timestamp instanceof Date
              ? row.timestamp
              : new Date(row.timestamp as string),
            metadata: row.metadata
              ? typeof row.metadata === "string"
                ? (Object.assign(Object.create(null), JSON.parse(row.metadata)) as Record<string, unknown>)
                : (row.metadata as Record<string, unknown>)
              : undefined,
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
}
