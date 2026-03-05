import type { Connection } from "espalier-jdbc";

export interface AggregateSnapshot {
  aggregateId: string;
  aggregateType: string;
  version: number;
  state: string;
  timestamp: Date;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function validateIdentifier(name: string, label: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid ${label}: "${name}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
  }
}

export class SnapshotStore {
  private readonly tableName: string;
  private readonly schemaName?: string;

  constructor(options?: { tableName?: string; schemaName?: string }) {
    this.tableName = options?.tableName ?? "aggregate_snapshots";
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

  async save(
    connection: Connection,
    snapshot: AggregateSnapshot,
  ): Promise<void> {
    const sql = `INSERT INTO ${this.qualifiedTable} ("aggregate_id", "aggregate_type", "version", "state", "timestamp")
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT ("aggregate_id", "aggregate_type")
DO UPDATE SET "version" = $3, "state" = $4, "timestamp" = $5`;

    const stmt = connection.prepareStatement(sql);
    try {
      stmt.setParameter(1, snapshot.aggregateId);
      stmt.setParameter(2, snapshot.aggregateType);
      stmt.setParameter(3, snapshot.version);
      stmt.setParameter(4, snapshot.state);
      stmt.setParameter(5, snapshot.timestamp instanceof Date ? snapshot.timestamp.toISOString() : String(snapshot.timestamp));
      await stmt.executeUpdate();
    } finally {
      await stmt.close();
    }
  }

  async load(
    connection: Connection,
    aggregateId: string,
    aggregateType: string,
  ): Promise<AggregateSnapshot | null> {
    const sql = `SELECT "aggregate_id", "aggregate_type", "version", "state", "timestamp" FROM ${this.qualifiedTable} WHERE "aggregate_id" = $1 AND "aggregate_type" = $2`;

    const stmt = connection.prepareStatement(sql);
    try {
      stmt.setParameter(1, aggregateId);
      stmt.setParameter(2, aggregateType);
      const rs = await stmt.executeQuery();
      try {
        if (await rs.next()) {
          const row = rs.getRow();
          return {
            aggregateId: row.aggregate_id as string,
            aggregateType: row.aggregate_type as string,
            version: row.version as number,
            state: row.state as string,
            timestamp: row.timestamp instanceof Date
              ? row.timestamp
              : new Date(row.timestamp as string),
          };
        }
        return null;
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }
  }

  async delete(
    connection: Connection,
    aggregateId: string,
    aggregateType: string,
  ): Promise<void> {
    const sql = `DELETE FROM ${this.qualifiedTable} WHERE "aggregate_id" = $1 AND "aggregate_type" = $2`;

    const stmt = connection.prepareStatement(sql);
    try {
      stmt.setParameter(1, aggregateId);
      stmt.setParameter(2, aggregateType);
      await stmt.executeUpdate();
    } finally {
      await stmt.close();
    }
  }

  generateDdl(options?: { ifNotExists?: boolean; schema?: string }): string[] {
    const ifNotExists = options?.ifNotExists !== false;
    const ine = ifNotExists ? "IF NOT EXISTS " : "";

    let tableName: string;
    if (options?.schema) {
      validateIdentifier(options.schema, "schema");
      tableName = `${escapeIdent(options.schema)}.${escapeIdent(this.tableName)}`;
    } else {
      tableName = this.qualifiedTable;
    }

    const safeName = this.tableName.replace(/[^a-zA-Z0-9_]/g, "_");

    return [
      `CREATE TABLE ${ine}${tableName} (
  "aggregate_id" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "state" JSONB NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("aggregate_id", "aggregate_type")
)`,
      `CREATE INDEX ${ine}"idx_${safeName}_type" ON ${tableName} ("aggregate_type")`,
    ];
  }
}
