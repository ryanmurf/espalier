import Database from "better-sqlite3";
import type { Connection, DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode } from "espalier-jdbc";
import { SqliteConnection } from "./sqlite-connection.js";

export interface SqliteDataSourceConfig {
  filename: string;
  options?: Database.Options;
  typeConverters?: TypeConverterRegistry;
}

export class SqliteDataSource implements DataSource {
  private readonly db: Database.Database;
  private readonly typeConverters?: TypeConverterRegistry;
  private closed = false;

  constructor(config: SqliteDataSourceConfig) {
    this.typeConverters = config.typeConverters;
    try {
      this.db = new Database(config.filename, config.options);
      // Enable WAL mode for better concurrent read performance
      this.db.pragma("journal_mode = WAL");
      // Enable foreign key enforcement
      this.db.pragma("foreign_keys = ON");
    } catch (err) {
      throw new ConnectionError(
        `Failed to open SQLite database: ${(err as Error).message}`,
        err as Error,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }
    return new SqliteConnection(this.db, this.typeConverters);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Access the underlying better-sqlite3 Database instance. */
  getDatabase(): Database.Database {
    return this.db;
  }
}
