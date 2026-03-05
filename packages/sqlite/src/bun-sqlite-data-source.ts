import type { Connection, DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode, getGlobalLogger } from "espalier-jdbc";
import type { BunSqliteDatabase } from "./bun-sqlite-statement.js";
import { BunSqliteConnection } from "./bun-sqlite-connection.js";

export interface BunSqliteDataSourceConfig {
  /** Path to the SQLite database file, or ":memory:" for in-memory database. */
  filename: string;
  /** Whether to create the database if it does not exist. Defaults to true. */
  create?: boolean;
  /** Whether to open the database in read-only mode. Defaults to false. */
  readonly?: boolean;
  /** Type converter registry for custom type handling. */
  typeConverters?: TypeConverterRegistry;
  /** Allow absolute file paths. Defaults to false. */
  allowAbsolutePaths?: boolean;
  /** Allow SQLite URI filenames (e.g. "file:..."). Defaults to false. */
  allowUri?: boolean;
}

function validateFilename(filename: string, allowAbsolute?: boolean, allowUri?: boolean): void {
  // Always allow in-memory databases
  if (filename === ":memory:") return;

  // Reject URI filenames unless explicitly allowed
  if (filename.startsWith("file:") && !allowUri) {
    throw new ConnectionError(
      "SQLite URI filenames are not allowed unless allowUri is set to true",
      undefined,
      DatabaseErrorCode.CONNECTION_FAILED,
    );
  }

  // Reject path traversal segments
  const segments = filename.split(/[/\\]/);
  if (segments.includes("..")) {
    throw new ConnectionError(
      "Path traversal ('..') is not allowed in SQLite database filenames",
      undefined,
      DatabaseErrorCode.CONNECTION_FAILED,
    );
  }

  // Reject absolute paths unless explicitly allowed
  if (!allowAbsolute && (filename.startsWith("/") || /^[A-Za-z]:/.test(filename))) {
    throw new ConnectionError(
      "Absolute paths are not allowed unless allowAbsolutePaths is set to true",
      undefined,
      DatabaseErrorCode.CONNECTION_FAILED,
    );
  }
}

export class BunSqliteDataSource implements DataSource {
  private readonly db: BunSqliteDatabase;
  private readonly typeConverters?: TypeConverterRegistry;
  private closed = false;

  constructor(config: BunSqliteDataSourceConfig) {
    this.typeConverters = config.typeConverters;

    // Validate filename to prevent path traversal and URI injection
    validateFilename(config.filename, config.allowAbsolutePaths, config.allowUri);

    // Dynamic import of bun:sqlite is not needed — we use the global Bun API
    // bun:sqlite Database constructor: new Database(filename, options?)
    const BunDatabase = (globalThis as any).Bun
      ? require("bun:sqlite").Database
      : undefined;

    if (!BunDatabase) {
      throw new ConnectionError(
        "bun:sqlite is not available. BunSqliteDataSource requires the Bun runtime.",
        undefined,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }

    let db: BunSqliteDatabase | undefined;
    try {
      db = new BunDatabase(config.filename, {
        create: config.create ?? true,
        readonly: config.readonly ?? false,
      }) as BunSqliteDatabase;

      // Enable WAL mode for better concurrent read performance
      db.exec("PRAGMA journal_mode = WAL");
      // Enable foreign key enforcement
      db.exec("PRAGMA foreign_keys = ON");
    } catch (err) {
      // Close the DB handle if it was opened but PRAGMA setup failed
      if (db) {
        try { db.close(); } catch { /* best effort */ }
      }
      if (err instanceof ConnectionError) throw err;
      throw new ConnectionError(
        `Failed to open Bun SQLite database: ${(err as Error).message}`,
        err as Error,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }

    this.db = db;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }
    return new BunSqliteConnection(this.db, this.typeConverters);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const logger = getGlobalLogger().child("bun-sqlite-datasource");
    logger.info("datasource closing");
    this.db.close();
    logger.info("datasource closed");
  }

  /** Access the underlying bun:sqlite Database instance. */
  getDatabase(): BunSqliteDatabase {
    return this.db;
  }
}
