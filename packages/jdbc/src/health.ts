import type { DataSource, PoolStats, MonitoredPooledDataSource } from "./index.js";

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

  register(check: HealthCheck): void {
    this.checks.set(check.name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  async checkAll(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const check of this.checks.values()) {
      results.push(await check.check());
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
    return check.check();
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
      results.push(await c.check());
    }

    let worstStatus: HealthStatus = "UP";
    for (const r of results) {
      if (r.status === "DOWN") { worstStatus = "DOWN"; break; }
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

      return {
        status,
        name: this.name,
        details: {
          total: stats.total,
          idle: stats.idle,
          waiting: stats.waiting,
          maxConnections: this.maxConnections,
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

  constructor(name: string, dataSource: DataSource, options?: { timeoutMs?: number; query?: string }) {
    this.name = name;
    this.dataSource = dataSource;
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.query = options?.query ?? "SELECT 1";
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await Promise.race([
        this.executeProbe(),
        this.timeout(),
      ]);

      if (result === "timeout") {
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

  private async executeProbe(): Promise<"ok"> {
    const conn = await this.dataSource.getConnection();
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
