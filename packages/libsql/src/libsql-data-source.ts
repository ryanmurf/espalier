import type { Connection, DataSource } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode, getGlobalLogger } from "espalier-jdbc";
import type { LibSqlClient, LibSqlConfig } from "./libsql-types.js";
import { LibSqlConnection } from "./libsql-connection.js";

export interface LibSqlDataSourceConfig {
  /** LibSQL connection URL (e.g., "libsql://your-db.turso.io" or "file:local.db"). */
  url: string;
  /** Auth token for remote Turso databases. Not needed for local files. */
  authToken?: string;
}

/**
 * DataSource implementation for LibSQL/Turso.
 *
 * Supports both local SQLite files and remote Turso databases.
 * The underlying client is created lazily on first getConnection().
 */
export class LibSqlDataSource implements DataSource {
  private client: LibSqlClient | null = null;
  private closed = false;
  private readonly config: LibSqlDataSourceConfig;

  constructor(config: LibSqlDataSourceConfig) {
    this.config = config;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }

    if (!this.client) {
      this.client = await this.createClient();
    }

    return new LibSqlConnection(this.client);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    const logger = getGlobalLogger().child("libsql-datasource");
    logger.info("datasource closed");
  }

  private async createClient(): Promise<LibSqlClient> {
    try {
      const mod = await import("@libsql/client");
      const createClientFn = (mod as Record<string, unknown>).createClient as
        | ((config: LibSqlConfig) => LibSqlClient)
        | undefined;

      if (!createClientFn) {
        throw new Error("@libsql/client does not export createClient");
      }

      return createClientFn({
        url: this.config.url,
        authToken: this.config.authToken,
      });
    } catch (err) {
      if ((err as Error).message?.includes("Cannot find")) {
        throw new ConnectionError(
          "Cannot load @libsql/client. Install it: pnpm add @libsql/client",
          undefined,
          DatabaseErrorCode.CONNECTION_FAILED,
        );
      }
      throw new ConnectionError(
        `Failed to create LibSQL client: ${(err as Error).message}`,
        undefined,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }
  }
}

/**
 * Create a LibSQL DataSource.
 *
 * @example
 * ```ts
 * // Local SQLite file
 * const ds = createLibSqlDataSource({ url: "file:./mydb.db" });
 *
 * // Remote Turso database
 * const ds = createLibSqlDataSource({
 *   url: "libsql://your-db.turso.io",
 *   authToken: "your-auth-token",
 * });
 * ```
 */
export function createLibSqlDataSource(config: LibSqlDataSourceConfig): DataSource {
  return new LibSqlDataSource(config);
}
