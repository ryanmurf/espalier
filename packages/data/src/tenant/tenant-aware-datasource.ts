import type { Connection, DataSource } from "espalier-jdbc";
import { validateIdentifier } from "espalier-jdbc";
import { TenantContext } from "./tenant-context.js";
import { NoTenantException } from "./tenant-context.js";

/**
 * Options for creating a TenantAwareDataSource.
 */
export interface TenantAwareDataSourceOptions {
  /** The underlying DataSource to wrap. */
  dataSource: DataSource;

  /**
   * Resolves a tenant ID to a PostgreSQL schema name.
   * The returned value is validated as a safe SQL identifier.
   */
  schemaResolver: (tenantId: string) => string;

  /**
   * Schema to use when no tenant is set in context.
   * If not provided, getConnection() throws when no tenant is set.
   */
  defaultSchema?: string;

  /**
   * Whether to reset search_path when the connection is released.
   * Defaults to `true`.
   */
  resetOnRelease?: boolean;
}

/**
 * A DataSource wrapper that sets `SET search_path TO <schema>, public`
 * on every connection checkout based on the current tenant from TenantContext.
 *
 * This implements schema-per-tenant isolation: each tenant's data lives in
 * its own PostgreSQL schema, and the search_path is set transparently.
 */
export class TenantAwareDataSource implements DataSource {
  private readonly inner: DataSource;
  private readonly schemaResolver: (tenantId: string) => string;
  private readonly defaultSchema: string | undefined;
  private readonly resetOnRelease: boolean;

  constructor(options: TenantAwareDataSourceOptions) {
    this.inner = options.dataSource;
    this.schemaResolver = options.schemaResolver;
    this.defaultSchema = options.defaultSchema;
    this.resetOnRelease = options.resetOnRelease ?? true;
  }

  async getConnection(): Promise<Connection> {
    const tenantId = TenantContext.current();
    let schema: string;

    if (tenantId !== undefined) {
      schema = this.schemaResolver(tenantId);
    } else if (this.defaultSchema !== undefined) {
      schema = this.defaultSchema;
    } else {
      throw new NoTenantException();
    }

    // Validate schema name to prevent SQL injection
    validateIdentifier(schema, "schema");

    const connection = await this.inner.getConnection();

    try {
      const stmt = connection.createStatement();
      try {
        await stmt.executeUpdate(`SET search_path TO "${schema}", public`);
      } finally {
        await stmt.close();
      }
    } catch (err) {
      // If SET fails, release the connection and rethrow
      await connection.close();
      throw new SchemaSetupError(schema, tenantId, err);
    }

    if (!this.resetOnRelease) {
      return connection;
    }

    // Wrap close() to reset search_path before releasing
    return this.wrapConnectionClose(connection);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private wrapConnectionClose(connection: Connection): Connection {
    const originalClose = connection.close.bind(connection);
    const wrapped: Connection = Object.create(connection);
    wrapped.close = async () => {
      let resetFailed = false;
      try {
        const stmt = connection.createStatement();
        try {
          await stmt.executeUpdate('SET search_path TO "public"');
        } finally {
          await stmt.close();
        }
      } catch {
        resetFailed = true;
        // search_path reset failed — attempt DISCARD ALL to prevent
        // returning a contaminated connection to the pool
        try {
          const discardStmt = connection.createStatement();
          try {
            await discardStmt.executeUpdate("DISCARD ALL");
          } finally {
            await discardStmt.close();
          }
        } catch {
          // DISCARD ALL also failed — connection is likely broken.
          // Release it anyway; broken connections are typically
          // detected and evicted by pool health checks.
        }
      } finally {
        await originalClose();
      }
      if (resetFailed) {
        throw new Error(
          "Failed to reset search_path on connection release. " +
          "A DISCARD ALL was attempted as a fallback.",
        );
      }
    };
    return wrapped;
  }
}

/**
 * Error thrown when setting the search_path for a tenant schema fails.
 */
export class SchemaSetupError extends Error {
  readonly schema: string;
  readonly tenantId: string | undefined;

  constructor(schema: string, tenantId: string | undefined, cause: unknown) {
    const msg = tenantId !== undefined
      ? `Failed to set search_path to schema "${schema}" for tenant "${tenantId}". The schema may not exist.`
      : `Failed to set search_path to schema "${schema}". The schema may not exist.`;
    super(msg, { cause });
    this.name = "SchemaSetupError";
    this.schema = schema;
    this.tenantId = tenantId;
  }
}
