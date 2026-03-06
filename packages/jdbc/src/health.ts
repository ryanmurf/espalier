import type { DataSource, MonitoredPooledDataSource, PoolStats } from "./index.js";

/**
 * Health status of a component.
 */
export type HealthStatus = "UP" | "DOWN" | "DEGRADED";

/**
 * Result of a health check.
 */
export interface HealthCheckResult {
  status: HealthStatus;
  name: string;
  details: Record<string, unknown>;
  checkedAt: Date;
  durationMs: number;
}

/**
 * A named health check.
 */
export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult>;
}

/**
 * Registry for managing and executing health checks.
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private readonly minIntervalMs: number;
  private readonly lastCheckTime = new Map<string, number>();

  constructor(options?: { minIntervalMs?: number }) {
    this.minIntervalMs = options?.minIntervalMs ?? 0;
  }

  register(check: HealthCheck): void {
    this.checks.set(check.name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
    this.lastCheckTime.delete(name);
  }

  private isRateLimited(name: string): boolean {
    if (this.minIntervalMs <= 0) return false;
    const last = this.lastCheckTime.get(name);
    return last !== undefined && Date.now() - last < this.minIntervalMs;
  }

  private recordCheck(name: string): void {
    if (this.minIntervalMs > 0) {
      this.lastCheckTime.set(name, Date.now());
    }
  }

  async checkAll(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const check of this.checks.values()) {
      if (this.isRateLimited(check.name)) {
        results.push({
          status: "UP",
          name: check.name,
          details: { rateLimited: true },
          checkedAt: new Date(),
          durationMs: 0,
        });
        continue;
      }
      try {
        this.recordCheck(check.name);
        results.push(await check.check());
      } catch (err) {
        results.push({
          status: "DOWN",
          name: check.name,
          details: { error: err instanceof Error ? err.message : String(err) },
          checkedAt: new Date(),
          durationMs: 0,
        });
      }
    }
    return results;
  }

  async checkOne(name: string): Promise<HealthCheckResult> {
    const check = this.checks.get(name);
    if (!check) {
      return {
        status: "DOWN",
        name,
        details: { error: `Health check "${name}" not found` },
        checkedAt: new Date(),
        durationMs: 0,
      };
    }
    if (this.isRateLimited(name)) {
      return {
        status: "UP",
        name,
        details: { rateLimited: true },
        checkedAt: new Date(),
        durationMs: 0,
      };
    }
    try {
      this.recordCheck(name);
      return await check.check();
    } catch (err) {
      return {
        status: "DOWN",
        name,
        details: { error: err instanceof Error ? err.message : String(err) },
        checkedAt: new Date(),
        durationMs: 0,
      };
    }
  }
}

/**
 * Aggregates multiple health checks, returning the worst status.
 */
export class CompositeHealthCheck implements HealthCheck {
  readonly name: string;
  private readonly checks: HealthCheck[];

  constructor(name: string, checks: HealthCheck[]) {
    this.name = name;
    this.checks = checks;
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    const results: HealthCheckResult[] = [];
    for (const c of this.checks) {
      try {
        results.push(await c.check());
      } catch (err) {
        results.push({
          status: "DOWN",
          name: c.name,
          details: { error: err instanceof Error ? err.message : String(err) },
          checkedAt: new Date(),
          durationMs: Date.now() - start,
        });
      }
    }

    let worstStatus: HealthStatus = "UP";
    for (const r of results) {
      if (r.status === "DOWN") {
        worstStatus = "DOWN";
        break;
      }
      if (r.status === "DEGRADED") worstStatus = "DEGRADED";
    }

    return {
      status: worstStatus,
      name: this.name,
      details: { checks: results },
      checkedAt: new Date(),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Health check for a connection pool.
 *
 * @since 1.0.1 - Breaking change: `details` shape changed from
 * `{ total: number; idle: number }` to `{ utilizationPercent: number; hasWaiters: boolean }`.
 */
export class PoolHealthCheck implements HealthCheck {
  readonly name: string;
  private readonly dataSource: MonitoredPooledDataSource;
  private readonly maxConnections: number;

  constructor(name: string, dataSource: MonitoredPooledDataSource, maxConnections = 20) {
    this.name = name;
    this.dataSource = dataSource;
    this.maxConnections = maxConnections;
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const stats: PoolStats = this.dataSource.getPoolStats();
      let status: HealthStatus = "UP";

      if (stats.total >= this.maxConnections && stats.idle === 0) {
        status = "DOWN";
      } else if (stats.waiting > 0) {
        status = "DEGRADED";
      }

      const utilization = this.maxConnections > 0 ? Math.round((stats.total / this.maxConnections) * 100) : 0;

      return {
        status,
        name: this.name,
        details: {
          utilizationPercent: utilization,
          hasWaiters: stats.waiting > 0,
        },
        checkedAt: new Date(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "DOWN",
        name: this.name,
        details: { error: err instanceof Error ? err.message : String(err) },
        checkedAt: new Date(),
        durationMs: Date.now() - start,
      };
    }
  }
}

/**
 * Health check that verifies database connectivity with a simple query.
 */
export class ConnectivityHealthCheck implements HealthCheck {
  readonly name: string;
  private readonly dataSource: DataSource;
  private readonly timeoutMs: number;
  private readonly query: string;

  private static readonly ALLOWED_QUERIES = new Set([
    "SELECT 1",
    "SELECT 1 AS health",
    "SELECT current_timestamp",
    "SELECT version()",
  ]);

  constructor(name: string, dataSource: DataSource, options?: { timeoutMs?: number; query?: string }) {
    this.name = name;
    this.dataSource = dataSource;
    this.timeoutMs = options?.timeoutMs ?? 5000;
    const q = options?.query ?? "SELECT 1";
    if (!ConnectivityHealthCheck.ALLOWED_QUERIES.has(q.trim().replace(/\s+/g, " "))) {
      throw new Error(`Health check query must be one of: ${[...ConnectivityHealthCheck.ALLOWED_QUERIES].join(", ")}`);
    }
    this.query = q;
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    const abort = { aborted: false };
    let pendingConn: { close(): Promise<void> } | undefined;

    try {
      const result = await Promise.race([
        this.executeProbe(abort, (c) => {
          pendingConn = c;
        }),
        this.timeout(),
      ]);

      if (result === "timeout") {
        abort.aborted = true;
        // Release the connection if it was acquired before timeout
        if (pendingConn) {
          pendingConn.close().catch(() => {});
        }
        return {
          status: "DOWN",
          name: this.name,
          details: { error: "Connection timed out", timeoutMs: this.timeoutMs },
          checkedAt: new Date(),
          durationMs: Date.now() - start,
        };
      }

      return {
        status: "UP",
        name: this.name,
        details: { responseTimeMs: Date.now() - start },
        checkedAt: new Date(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "DOWN",
        name: this.name,
        details: { error: err instanceof Error ? err.message : String(err) },
        checkedAt: new Date(),
        durationMs: Date.now() - start,
      };
    }
  }

  private async executeProbe(
    abort: { aborted: boolean },
    onConnection: (conn: { close(): Promise<void> }) => void,
  ): Promise<"ok"> {
    const conn = await this.dataSource.getConnection();
    onConnection(conn);
    if (abort.aborted) {
      await conn.close();
      return "ok";
    }
    try {
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery(this.query);
      } finally {
        await stmt.close();
      }
    } finally {
      await conn.close();
    }
    return "ok";
  }

  private timeout(): Promise<"timeout"> {
    const ms = this.timeoutMs;
    return new Promise<"timeout">((resolve) => {
      (globalThis as any).setTimeout(() => resolve("timeout"), ms);
    });
  }
}
