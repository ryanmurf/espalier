import type { Connection, DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode, getGlobalLogger } from "espalier-jdbc";
import type { DenoPgClient } from "./deno-pg-statement.js";
import { DenoPgConnection } from "./deno-pg-connection.js";

export interface DenoPgDataSourceConfig {
  /** PostgreSQL connection URL (e.g., "postgres://user:pass@host:port/db"). */
  url?: string;
  /** Hostname for the PostgreSQL server. */
  hostname?: string;
  /** Port for the PostgreSQL server. Defaults to 5432. */
  port?: number;
  /** Database name. */
  database?: string;
  /** Username for authentication. */
  username?: string;
  /** Password for authentication. */
  password?: string;
  /** Maximum number of connections in the pool. */
  max?: number;
  /** Type converter registry for custom type handling. */
  typeConverters?: TypeConverterRegistry;
}

/**
 * Minimal interface for deno-postgres Pool.
 */
interface DenoPool {
  connect(): Promise<DenoPgClient>;
  end(): Promise<void>;
}

/**
 * PostgreSQL DataSource for Deno runtime.
 *
 * Uses `deno-postgres` (https://deno.land/x/postgres) natively.
 * Falls back to `pg` via Deno's npm compatibility if deno-postgres is not available.
 *
 * Handles reconnection gracefully for Deno Deploy (no persistent connections).
 */
export class DenoPgDataSource implements DataSource {
  private pool: DenoPool | undefined;
  private readonly config: DenoPgDataSourceConfig;
  private readonly typeConverters?: TypeConverterRegistry;
  private closed = false;
  private initPromise: Promise<void> | undefined;

  constructor(config: DenoPgDataSourceConfig) {
    this.config = config;
    this.typeConverters = config.typeConverters;
  }

  private async ensurePool(): Promise<DenoPool> {
    if (this.pool) return this.pool;

    if (!this.initPromise) {
      this.initPromise = this.initializePool().catch((err) => {
        this.initPromise = undefined;
        throw err;
      });
    }
    await this.initPromise;
    return this.pool!;
  }

  private async initializePool(): Promise<void> {
    const logger = getGlobalLogger().child("deno-pg-datasource");

    // Try deno-postgres first (Deno URL import — use variable to avoid TS module resolution)
    const denoPostgresUrl = "https://deno.land/x/postgres/mod.ts";
    try {
      const denoPostgres = await import(/* @vite-ignore */ denoPostgresUrl);
      if (denoPostgres) {
        const { Pool } = denoPostgres;
        const connectionString = this.config.url ??
          this.buildConnectionString();

        this.pool = new Pool(connectionString, this.config.max ?? 10) as DenoPool;
        logger.info("using deno-postgres driver");
        return;
      }
    } catch {
      // deno-postgres not available, fall through
    }

    // Fall back to pg via npm compat
    try {
      const pg = await import("pg");
      const Pool = (pg as any).Pool ?? (pg as any).default?.Pool;

      if (!Pool) {
        throw new Error("Could not find Pool class in pg module");
      }

      const poolConfig: Record<string, unknown> = {};
      if (this.config.url) {
        poolConfig.connectionString = this.config.url;
      } else {
        if (this.config.hostname) poolConfig.host = this.config.hostname;
        if (this.config.port) poolConfig.port = this.config.port;
        if (this.config.database) poolConfig.database = this.config.database;
        if (this.config.username) poolConfig.user = this.config.username;
        if (this.config.password) poolConfig.password = this.config.password;
      }
      poolConfig.max = this.config.max ?? 10;

      const pool = new Pool(poolConfig);

      // Wrap pg Pool to conform to DenoPool interface
      this.pool = {
        async connect(): Promise<DenoPgClient> {
          const client = await pool.connect();
          return {
            async queryObject(sql: string, args?: unknown[]) {
              const result = args
                ? await client.query(sql, args)
                : await client.query(sql);
              return {
                rows: result.rows as Record<string, unknown>[],
                rowCount: result.rowCount,
                columns: result.fields?.map((f: { name: string }) => f.name),
              };
            },
            release() {
              client.release();
            },
          };
        },
        async end(): Promise<void> {
          await pool.end();
        },
      };

      logger.info("using pg driver via npm compat");
    } catch (err) {
      const message = ((err as Error).message ?? "").replace(
        /password[=:]\s*\S+/gi,
        "password=***",
      );
      throw new ConnectionError(
        `Failed to initialize PostgreSQL pool for Deno: ${message}. ` +
        `Install either deno-postgres or pg (via npm:pg).`,
        err as Error,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }
  }

  private buildConnectionString(): string {
    const host = this.config.hostname ?? "localhost";
    const port = this.config.port ?? 5432;
    const db = this.config.database ?? "";
    const user = this.config.username ?? "";
    const pass = this.config.password ?? "";
    const auth = user ? (pass ? `${user}:${pass}@` : `${user}@`) : "";
    return `postgres://${auth}${host}:${port}/${db}`;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }

    const pool = await this.ensurePool();

    try {
      const client = await pool.connect();
      return new DenoPgConnection(client, this.typeConverters);
    } catch (err) {
      // Handle Deno Deploy reconnection: pool may have become stale
      if (!this.closed) {
        const logger = getGlobalLogger().child("deno-pg-datasource");
        logger.warn("connection failed, attempting pool re-initialization", {
          error: (err as Error).message,
        });
        this.pool = undefined;
        this.initPromise = undefined;

        try {
          const freshPool = await this.ensurePool();
          const client = await freshPool.connect();
          return new DenoPgConnection(client, this.typeConverters);
        } catch (retryErr) {
          throw new ConnectionError(
            `Failed to get connection after retry: ${(retryErr as Error).message}`,
            retryErr as Error,
            DatabaseErrorCode.CONNECTION_FAILED,
          );
        }
      }

      throw new ConnectionError(
        `Failed to get connection: ${(err as Error).message}`,
        err as Error,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const logger = getGlobalLogger().child("deno-pg-datasource");
    logger.info("datasource closing");
    if (this.pool) {
      await this.pool.end();
    }
    logger.info("datasource closed");
  }
}
