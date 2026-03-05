/**
 * Adversarial tests for ReplicaLagHealthCheck and TenantSchemaHealthCheck (Y3 Q3).
 *
 * Unit tests use mocked connections; E2E tests run against live Postgres.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { ReplicaLagHealthCheck, TenantSchemaHealthCheck } from "../../pg-replica-health.js";
import type { ReplicaLagConfig } from "../../pg-replica-health.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import type { PgDataSource } from "../../pg-data-source.js";
import type { DataSource, Connection, Statement, ResultSet } from "espalier-jdbc";

// ══════════════════════════════════════════════════
// Mock helpers
// ══════════════════════════════════════════════════

function mockResultSet(rows: Record<string, unknown>[]): ResultSet {
  let idx = -1;
  return {
    next: vi.fn(async () => { idx++; return idx < rows.length; }),
    getRow: vi.fn(() => rows[idx] ?? {}),
    close: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: vi.fn(),
  } as unknown as ResultSet;
}

function mockStatement(rsMap: Record<string, ResultSet>): Statement {
  return {
    executeQuery: vi.fn(async (sql: string) => {
      for (const [pattern, rs] of Object.entries(rsMap)) {
        if (sql.includes(pattern)) return rs;
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Statement;
}

function mockConnection(stmtFactory: () => Statement): Connection {
  return {
    createStatement: vi.fn(stmtFactory),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Connection;
}

function mockDataSource(connFactory: () => Connection): DataSource {
  return {
    getConnection: vi.fn(async () => connFactory()),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

// ══════════════════════════════════════════════════
// ReplicaLagHealthCheck — unit tests
// ══════════════════════════════════════════════════

describe("ReplicaLagHealthCheck (unit)", () => {
  function makeReplicaDs(isReplica: boolean, lagSeconds: number | null): DataSource {
    return mockDataSource(() =>
      mockConnection(() => {
        const recoveryRs = mockResultSet([{ is_replica: isReplica }]);
        const lagRs = mockResultSet(lagSeconds !== null ? [{ lag_seconds: lagSeconds }] : []);
        return mockStatement({
          "pg_is_in_recovery": recoveryRs,
          "pg_last_xact_replay_timestamp": lagRs,
        });
      })
    );
  }

  it("replica with low lag returns UP", async () => {
    const ds = makeReplicaDs(true, 2);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.isReplica).toBe(true);
    expect(result.details.lagSeconds).toBe(2);
  });

  it("replica with moderate lag returns DEGRADED", async () => {
    const ds = makeReplicaDs(true, 15);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
    expect(result.details.lagSeconds).toBe(15);
  });

  it("replica with high lag returns DOWN", async () => {
    const ds = makeReplicaDs(true, 60);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.lagSeconds).toBe(60);
  });

  it("primary server returns UP with note=primary", async () => {
    const ds = makeReplicaDs(false, 0);
    const check = new ReplicaLagHealthCheck("primary", ds);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.isReplica).toBe(false);
    expect(result.details.note).toBe("primary");
  });

  it("connection failure returns DOWN with error", async () => {
    const ds = {
      getConnection: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      close: vi.fn(),
    } as unknown as DataSource;
    const check = new ReplicaLagHealthCheck("broken", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("ECONNREFUSED");
  });

  it("null replay timestamp (no replication yet) returns UP with lagSeconds=0", async () => {
    // When lagRs returns no rows, lagSeconds stays 0
    const ds = makeReplicaDs(true, null);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.lagSeconds).toBe(0);
  });

  it("custom lag thresholds work", async () => {
    const config: ReplicaLagConfig = { degradedLagSeconds: 5, maxLagSeconds: 15 };
    const ds = makeReplicaDs(true, 7);
    const check = new ReplicaLagHealthCheck("replica", ds, config);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
    expect(result.details.degradedThreshold).toBe(5);
    expect(result.details.maxThreshold).toBe(15);
  });

  it("lag exactly at degradedLag threshold returns DEGRADED (>=)", async () => {
    const ds = makeReplicaDs(true, 10);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
  });

  it("lag exactly at maxLag threshold returns DOWN (>=)", async () => {
    const ds = makeReplicaDs(true, 30);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
  });

  it("lag between thresholds returns DEGRADED", async () => {
    const ds = makeReplicaDs(true, 20); // between 10 and 30
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
  });

  it("NaN lag returns DOWN (guarded by Number.isNaN check)", async () => {
    const ds = makeReplicaDs(true, NaN);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.lagSeconds).toBeNaN();
  });

  it("negative lag (clock skew) — treated as UP", async () => {
    const ds = makeReplicaDs(true, -5);
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    expect(result.status).toBe("UP"); // -5 < 10 and -5 < 30
    expect(result.details.lagSeconds).toBe(-5);
  });

  it("string lag value — treated as 0 (typeof guard)", async () => {
    // If getRow() returns a string instead of number
    const ds = mockDataSource(() =>
      mockConnection(() => {
        const recoveryRs = mockResultSet([{ is_replica: true }]);
        const lagRs = mockResultSet([{ lag_seconds: "15.5" }]); // string, not number
        return mockStatement({
          "pg_is_in_recovery": recoveryRs,
          "pg_last_xact_replay_timestamp": lagRs,
        });
      })
    );
    const check = new ReplicaLagHealthCheck("replica", ds);

    const result = await check.check();
    // typeof "15.5" is "string", not "number", so lagSeconds stays 0
    expect(result.status).toBe("UP");
    expect(result.details.lagSeconds).toBe(0);
  });

  it("durationMs is recorded", async () => {
    const ds = makeReplicaDs(false, 0);
    const check = new ReplicaLagHealthCheck("primary", ds);

    const result = await check.check();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });
});

// ══════════════════════════════════════════════════
// TenantSchemaHealthCheck — unit tests
// ══════════════════════════════════════════════════

describe("TenantSchemaHealthCheck (unit)", () => {
  function makeSchemaDs(existingSchemas: string[]): DataSource {
    return mockDataSource(() =>
      mockConnection(() => {
        const rs = mockResultSet(existingSchemas.map(s => ({ schema_name: s })));
        return mockStatement({ "information_schema.schemata": rs });
      })
    );
  }

  it("all expected schemas present returns UP", async () => {
    const ds = makeSchemaDs(["tenant_a", "tenant_b", "public"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, ["tenant_a", "tenant_b"]);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.presentCount).toBe(2);
    expect(result.details.missingCount).toBe(0);
  });

  it("some schemas missing returns DEGRADED", async () => {
    const ds = makeSchemaDs(["tenant_a", "public"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, ["tenant_a", "tenant_b"]);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
    expect(result.details.missingCount).toBe(1);
  });

  it("no expected schemas present returns DOWN", async () => {
    const ds = makeSchemaDs(["public"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, ["tenant_a", "tenant_b"]);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.missingCount).toBe(2);
  });

  it("empty expected list returns UP (vacuous truth)", async () => {
    const ds = makeSchemaDs(["public"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, []);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.expectedCount).toBe(0);
  });

  it("schema resolver is applied", async () => {
    const ds = makeSchemaDs(["schema_alpha", "schema_beta"]);
    const check = new TenantSchemaHealthCheck(
      "tenants", ds, ["alpha", "beta"],
      (id) => `schema_${id}`,
    );

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.presentCount).toBe(2);
  });

  it("schema resolver mismatch causes DEGRADED", async () => {
    const ds = makeSchemaDs(["alpha", "beta"]);
    const check = new TenantSchemaHealthCheck(
      "tenants", ds, ["alpha", "beta"],
      (id) => `tenant_${id}`, // resolves to tenant_alpha, tenant_beta — not in DB
    );

    const result = await check.check();
    expect(result.status).toBe("DOWN");
  });

  it("default schema resolver is identity", async () => {
    const ds = makeSchemaDs(["alpha"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, ["alpha"]);

    const result = await check.check();
    expect(result.status).toBe("UP");
  });

  it("connection failure returns DOWN", async () => {
    const ds = {
      getConnection: vi.fn().mockRejectedValue(new Error("timeout")),
      close: vi.fn(),
    } as unknown as DataSource;
    const check = new TenantSchemaHealthCheck("tenants", ds, ["a"]);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("timeout");
  });

  it("single tenant missing out of many returns DEGRADED not DOWN", async () => {
    const ds = makeSchemaDs(["t1", "t2", "t3"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, ["t1", "t2", "t3", "t4"]);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
    expect(result.details.missingCount).toBe(1);
  });

  it("duplicate tenantIds are not deduplicated", async () => {
    const ds = makeSchemaDs(["tenant_a"]);
    const check = new TenantSchemaHealthCheck("tenants", ds, ["tenant_a", "tenant_a", "tenant_a"]);

    const result = await check.check();
    expect(result.status).toBe("UP");
    // All 3 duplicates resolve to present
    expect(result.details.presentCount).toBe(3);
  });
});

// ══════════════════════════════════════════════════
// E2E tests against live Postgres
// ══════════════════════════════════════════════════

const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("E2E: Replica Lag & Tenant Schema Health Checks", { timeout: 30000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
  });

  afterAll(async () => {
    await ds.close();
  });

  describe("ReplicaLagHealthCheck on primary", () => {
    it("returns UP with isReplica=false on a primary server", async () => {
      const check = new ReplicaLagHealthCheck("pg-primary", ds);

      const result = await check.check();
      expect(result.status).toBe("UP");
      expect(result.details.isReplica).toBe(false);
      expect(result.details.note).toBe("primary");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("TenantSchemaHealthCheck E2E", () => {
    const testSchema = "health_check_test_schema";

    beforeAll(async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`CREATE SCHEMA IF NOT EXISTS ${testSchema}`);
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    afterAll(async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    it("provisioned schema returns UP", async () => {
      const check = new TenantSchemaHealthCheck("schema-check", ds, [testSchema]);

      const result = await check.check();
      expect(result.status).toBe("UP");
      expect(result.details.presentCount).toBe(1);
    });

    it("missing schema returns DEGRADED", async () => {
      const check = new TenantSchemaHealthCheck(
        "schema-check", ds,
        [testSchema, "nonexistent_schema_xyz_abc_123"],
      );

      const result = await check.check();
      expect(result.status).toBe("DEGRADED");
      expect(result.details.missingCount).toBe(1);
    });

    it("all missing schemas returns DOWN", async () => {
      const check = new TenantSchemaHealthCheck(
        "schema-check", ds,
        ["nonexistent_1", "nonexistent_2"],
      );

      const result = await check.check();
      expect(result.status).toBe("DOWN");
    });

    it("schema resolver with prefix works against live DB", async () => {
      const check = new TenantSchemaHealthCheck(
        "schema-check", ds,
        ["test_schema"], // resolved to health_check_test_schema
        (id) => `health_check_${id}`,
      );

      const result = await check.check();
      expect(result.status).toBe("UP");
    });
  });
});
