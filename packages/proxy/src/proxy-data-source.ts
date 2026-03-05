import type { DataSource, Connection } from "espalier-jdbc";
import { detectEnvironment, getEnvironmentDefaults, isColdStart } from "./environment.js";
import type { ServerlessEnvironment, EnvironmentDefaults } from "./environment.js";

/**
 * Configuration for ProxyDataSource.
 */
export interface ProxyDataSourceOptions {
  /** Maximum number of idle connections to keep. Default: auto-detected from environment. */
  maxConnections?: number;
  /** Maximum time (ms) a connection can stay idle before being closed. Default: auto-detected. */
  maxIdleTimeMs?: number;
  /** Whether to validate connections before reuse. Default: true. */
  validateOnBorrow?: boolean;
  /** SQL query used to validate connections. Default: "SELECT 1". */
  validationQuery?: string;
  /** Timeout (ms) for validation query. Default: 3000. */
  validationTimeoutMs?: number;
  /** Override environment detection. */
  environment?: ServerlessEnvironment;
  /** Callback when a connection is evicted due to idle timeout or validation failure. */
  onEvict?: (reason: "idle" | "validation-failed" | "closed") => void;
}

interface PooledConnection {
  connection: Connection;
  lastUsed: number;
  createdAt: number;
}

/**
 * ProxyDataSource wraps an existing DataSource with connection reuse logic
 * optimized for serverless environments. Connections are maintained in a
 * local pool and reused across function invocations in the same process.
 *
 * On cold starts, new connections are created. On warm starts, existing
 * idle connections are validated and reused.
 */
export class ProxyDataSource implements DataSource {
  private readonly inner: DataSource;
  private readonly maxConnections: number;
  private readonly maxIdleTimeMs: number;
  private readonly validateOnBorrow: boolean;
  private readonly validationQuery: string;
  private readonly validationTimeoutMs: number;
  private readonly onEvict?: (reason: "idle" | "validation-failed" | "closed") => void;
  private readonly pool: PooledConnection[] = [];
  private readonly environment: ServerlessEnvironment;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _closed = false;
  private _coldStart: boolean;
  private _shutdownCleanup: (() => void) | null = null;

  constructor(inner: DataSource, options?: ProxyDataSourceOptions) {
    this.inner = inner;
    this.environment = options?.environment ?? detectEnvironment();
    this._coldStart = isColdStart();

    const defaults = getEnvironmentDefaults(this.environment);
    this.maxConnections = options?.maxConnections ?? defaults.maxConnections;
    this.maxIdleTimeMs = options?.maxIdleTimeMs ?? defaults.maxIdleTimeMs;
    this.validateOnBorrow = options?.validateOnBorrow ?? defaults.validateOnBorrow;
    const query = options?.validationQuery ?? "SELECT 1";
    if (!/^\s*SELECT\s/i.test(query)) {
      throw new Error("validationQuery must be a SELECT statement.");
    }
    this.validationQuery = query;
    this.validationTimeoutMs = options?.validationTimeoutMs ?? 3000;
    this.onEvict = options?.onEvict;

    this.startCleanupLoop();
    this.registerShutdownHooks();
  }

  /**
   * Get a connection from the pool, or create a new one if no idle
   * connections are available. Validates before returning if configured.
   */
  async getConnection(): Promise<Connection> {
    if (this._closed) {
      throw new Error("ProxyDataSource is closed.");
    }

    // Try to reuse an existing idle connection
    while (this.pool.length > 0) {
      const pooled = this.pool.pop()!;

      if (pooled.connection.isClosed()) {
        this.onEvict?.("closed");
        continue;
      }

      // Check idle timeout
      const idleTime = Date.now() - pooled.lastUsed;
      if (idleTime > this.maxIdleTimeMs) {
        await pooled.connection.close().catch(() => {});
        this.onEvict?.("idle");
        continue;
      }

      // Validate connection
      if (this.validateOnBorrow) {
        const valid = await this.validate(pooled.connection);
        if (!valid) {
          await pooled.connection.close().catch(() => {});
          this.onEvict?.("validation-failed");
          continue;
        }
      }

      // Wrap to intercept close() — return to pool instead
      return this.wrapConnection(pooled);
    }

    // No reusable connection — create new from inner DataSource
    const conn = await this.inner.getConnection();
    const pooled: PooledConnection = {
      connection: conn,
      lastUsed: Date.now(),
      createdAt: Date.now(),
    };
    return this.wrapConnection(pooled);
  }

  /**
   * Close the proxy and all pooled connections.
   */
  async close(): Promise<void> {
    this._closed = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.removeShutdownHooks();

    const closePromises = this.pool.map((p) =>
      p.connection.close().catch(() => {}),
    );
    this.pool.length = 0;
    await Promise.all(closePromises);

    await this.inner.close();
  }

  /**
   * Whether this proxy instance was created on a cold start.
   */
  get wasColdStart(): boolean {
    return this._coldStart;
  }

  /**
   * The detected serverless environment.
   */
  get detectedEnvironment(): ServerlessEnvironment {
    return this.environment;
  }

  /**
   * Number of currently idle connections in the pool.
   */
  get idleCount(): number {
    return this.pool.length;
  }

  private wrapConnection(pooled: PooledConnection): Connection {
    const proxy = this;
    const conn = pooled.connection;

    return {
      createStatement() {
        return conn.createStatement();
      },
      prepareStatement(sql: string) {
        return conn.prepareStatement(sql);
      },
      beginTransaction(isolation?: any) {
        return conn.beginTransaction(isolation);
      },
      async close() {
        // Return to pool instead of closing
        if (proxy._closed || conn.isClosed()) {
          if (!conn.isClosed()) {
            await conn.close();
          }
          return;
        }

        // If pool is full, actually close
        if (proxy.pool.length >= proxy.maxConnections) {
          await conn.close();
          return;
        }

        // Final isClosed() check immediately before pool return
        if (conn.isClosed()) {
          return;
        }

        pooled.lastUsed = Date.now();
        proxy.pool.push(pooled);
      },
      isClosed() {
        return conn.isClosed();
      },
    };
  }

  private async validate(conn: Connection): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stmt = conn.prepareStatement(this.validationQuery);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Validation timeout")), this.validationTimeoutMs);
      });
      const rs = await Promise.race([stmt.executeQuery(), timeoutPromise]);
      await rs.close().catch(() => {});
      await stmt.close().catch(() => {});
      return true;
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private startCleanupLoop(): void {
    // Run cleanup every maxIdleTimeMs / 2 to catch stale connections
    const interval = Math.max(this.maxIdleTimeMs / 2, 5000);
    this.cleanupTimer = setInterval(() => {
      this.evictIdle();
    }, interval);

    // Don't prevent process from exiting
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  private evictIdle(): void {
    const now = Date.now();
    let i = 0;
    while (i < this.pool.length) {
      const pooled = this.pool[i];
      const idle = now - pooled.lastUsed;

      if (idle > this.maxIdleTimeMs || pooled.connection.isClosed()) {
        this.pool.splice(i, 1);
        if (!pooled.connection.isClosed()) {
          pooled.connection.close().catch(() => {});
          this.onEvict?.("idle");
        } else {
          this.onEvict?.("closed");
        }
      } else {
        i++;
      }
    }
  }

  private registerShutdownHooks(): void {
    if (typeof process !== "undefined" && process.on) {
      const cleanup = () => {
        this.close().catch(() => {});
      };

      process.on("beforeExit", cleanup);
      // SIGTERM is sent by Lambda when the execution environment is being shut down
      process.on("SIGTERM", cleanup);

      this._shutdownCleanup = cleanup;
    }
  }

  private removeShutdownHooks(): void {
    if (this._shutdownCleanup && typeof process !== "undefined" && process.removeListener) {
      process.removeListener("beforeExit", this._shutdownCleanup);
      process.removeListener("SIGTERM", this._shutdownCleanup);
      this._shutdownCleanup = null;
    }
  }
}
