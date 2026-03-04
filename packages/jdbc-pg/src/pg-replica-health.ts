import type { DataSource, HealthCheck, HealthCheckResult, HealthStatus } from "espalier-jdbc";
import type { Connection } from "espalier-jdbc";

export interface ReplicaLagConfig {
  /** Lag threshold for DEGRADED status (seconds). Default: 10. */
  degradedLagSeconds?: number;
  /** Lag threshold for DOWN status (seconds). Default: 30. */
  maxLagSeconds?: number;
}

/**
 * Health check that detects replication lag on a PostgreSQL read replica.
 */
export class ReplicaLagHealthCheck implements HealthCheck {
  readonly name: string;
  private readonly dataSource: DataSource;
  private readonly degradedLag: number;
  private readonly maxLag: number;

  constructor(name: string, dataSource: DataSource, config?: ReplicaLagConfig) {
    this.name = name;
    this.dataSource = dataSource;
    this.degradedLag = config?.degradedLagSeconds ?? 10;
    this.maxLag = config?.maxLagSeconds ?? 30;
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    let conn: Connection | undefined;
    try {
      conn = await this.dataSource.getConnection();

      // Check if this is a replica
      const recoveryStmt = conn.createStatement();
      let isReplica = false;
      try {
        const rs = await recoveryStmt.executeQuery("SELECT pg_is_in_recovery() AS is_replica");
        if (await rs.next()) {
          isReplica = Object.values(rs.getRow())[0] === true;
        }
      } finally {
        await recoveryStmt.close();
      }

      if (!isReplica) {
        return {
          status: "UP",
          name: this.name,
          details: { isReplica: false, note: "primary" },
          checkedAt: new Date(),
          durationMs: Date.now() - start,
        };
      }

      // Query replication lag
      const lagStmt = conn.createStatement();
      let lagSeconds = 0;
      try {
        const rs = await lagStmt.executeQuery(
          "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float AS lag_seconds",
        );
        if (await rs.next()) {
          const val = Object.values(rs.getRow())[0];
          lagSeconds = typeof val === "number" ? val : 0;
        }
      } finally {
        await lagStmt.close();
      }

      let status: HealthStatus = "UP";
      if (lagSeconds >= this.maxLag) {
        status = "DOWN";
      } else if (lagSeconds >= this.degradedLag) {
        status = "DEGRADED";
      }

      return {
        status,
        name: this.name,
        details: {
          isReplica: true,
          lagSeconds,
          degradedThreshold: this.degradedLag,
          maxThreshold: this.maxLag,
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
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  }
}

/**
 * Health check that validates expected tenant schemas exist.
 */
export class TenantSchemaHealthCheck implements HealthCheck {
  readonly name: string;
  private readonly dataSource: DataSource;
  private readonly expectedTenantIds: string[];
  private readonly schemaResolver: (tenantId: string) => string;

  constructor(
    name: string,
    dataSource: DataSource,
    expectedTenantIds: string[],
    schemaResolver?: (tenantId: string) => string,
  ) {
    this.name = name;
    this.dataSource = dataSource;
    this.expectedTenantIds = expectedTenantIds;
    this.schemaResolver = schemaResolver ?? ((id) => id);
  }

  async check(): Promise<HealthCheckResult> {
    const start = Date.now();
    let conn: Connection | undefined;
    try {
      conn = await this.dataSource.getConnection();
      const stmt = conn.createStatement();
      let existingSchemas: Set<string>;
      try {
        const rs = await stmt.executeQuery(
          "SELECT schema_name FROM information_schema.schemata",
        );
        existingSchemas = new Set<string>();
        while (await rs.next()) {
          const val = Object.values(rs.getRow())[0];
          if (typeof val === "string") existingSchemas.add(val);
        }
      } finally {
        await stmt.close();
      }

      const present: string[] = [];
      const missing: string[] = [];
      for (const tenantId of this.expectedTenantIds) {
        const schema = this.schemaResolver(tenantId);
        if (existingSchemas.has(schema)) {
          present.push(schema);
        } else {
          missing.push(schema);
        }
      }

      let status: HealthStatus = "UP";
      if (missing.length === this.expectedTenantIds.length) {
        status = "DOWN";
      } else if (missing.length > 0) {
        status = "DEGRADED";
      }

      return {
        status,
        name: this.name,
        details: {
          presentSchemas: present,
          missingSchemas: missing,
          expectedCount: this.expectedTenantIds.length,
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
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  }
}
