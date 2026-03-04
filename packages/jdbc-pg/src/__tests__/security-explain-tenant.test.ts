/**
 * Adversarial tests for security fixes #59 and #51 (Y3 Q4).
 *
 * #59: EXPLAIN ANALYZE blocks destructive queries
 * #51: TenantSchemaHealthCheck does not expose raw schema names
 */
import { describe, it, expect, vi } from "vitest";
import { PgQueryPlanAnalyzer } from "../pg-query-plan.js";
import { TenantSchemaHealthCheck } from "../pg-replica-health.js";
import type { Connection, DataSource, Statement, ResultSet, PreparedStatement } from "espalier-jdbc";

// ══════════════════════════════════════════════════
// Mock factories
// ══════════════════════════════════════════════════

function mockConnection(): Connection {
  return {
    createStatement: vi.fn().mockReturnValue({
      executeQuery: vi.fn().mockResolvedValue({
        next: vi.fn().mockResolvedValue(false),
        getRow: vi.fn().mockReturnValue({}),
        close: vi.fn(),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    prepareStatement: vi.fn().mockReturnValue({
      setParameter: vi.fn(),
      executeQuery: vi.fn().mockResolvedValue({
        next: vi.fn().mockResolvedValue(false),
        getRow: vi.fn().mockReturnValue({}),
        close: vi.fn(),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Connection;
}

function mockDataSourceWithSchemas(schemaNames: string[]): DataSource {
  const rs = {
    _idx: -1,
    _rows: schemaNames.map(s => ({ schema_name: s })),
    next: vi.fn().mockImplementation(async function(this: any) {
      this._idx++;
      return this._idx < this._rows.length;
    }),
    getRow: vi.fn().mockImplementation(function(this: any) {
      return this._rows[this._idx];
    }),
    close: vi.fn(),
  };

  return {
    getConnection: vi.fn().mockResolvedValue({
      createStatement: vi.fn().mockReturnValue({
        executeQuery: vi.fn().mockResolvedValue(rs),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn(),
  } as unknown as DataSource;
}

// ══════════════════════════════════════════════════
// #59: EXPLAIN ANALYZE guards against destructive queries
// ══════════════════════════════════════════════════

describe("#59: EXPLAIN ANALYZE blocks destructive queries", () => {
  const analyzer = new PgQueryPlanAnalyzer();
  const conn = mockConnection();

  it("blocks DELETE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "DELETE FROM users WHERE id = 1", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("blocks INSERT with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "INSERT INTO users (name) VALUES ('test')", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("blocks UPDATE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "UPDATE users SET active = false", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("blocks TRUNCATE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "TRUNCATE users", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("blocks DROP TABLE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "DROP TABLE users", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("blocks CREATE TABLE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "CREATE TABLE evil (id int)", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("blocks ALTER TABLE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "ALTER TABLE users ADD COLUMN pwned boolean", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("allows DELETE without ANALYZE (EXPLAIN only)", async () => {
    // EXPLAIN without ANALYZE does NOT execute the query — just plans it
    // Should NOT throw — the guard only applies when analyze: true
    // Will fail at parsing level since mock returns no data, but should not throw the guard error
    await expect(
      analyzer.explain(conn, "DELETE FROM users WHERE id = 1"),
    ).rejects.toThrow("Failed to parse EXPLAIN output");
  });

  it("allows SELECT with ANALYZE", async () => {
    // Should not throw the guard error — will fail at parsing since mock returns no data
    await expect(
      analyzer.explain(conn, "SELECT * FROM users", [], { analyze: true }),
    ).rejects.toThrow("Failed to parse EXPLAIN output");
  });

  it("allows WITH (CTE) with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "WITH x AS (SELECT 1) SELECT * FROM x", [], { analyze: true }),
    ).rejects.toThrow("Failed to parse EXPLAIN output");
  });

  it("case-insensitive: blocks delete (lowercase) with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "delete from users", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("leading whitespace: blocks spaced DELETE with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "   DELETE FROM users", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });

  it("leading newline: blocks newline-prefixed INSERT with ANALYZE", async () => {
    await expect(
      analyzer.explain(conn, "\n\nINSERT INTO users (name) VALUES ('test')", [], { analyze: true }),
    ).rejects.toThrow(/SELECT|WITH|side effect/i);
  });
});

// ══════════════════════════════════════════════════
// #51: TenantSchemaHealthCheck does not expose schema names
// ══════════════════════════════════════════════════

describe("#51: TenantSchemaHealthCheck does not expose raw schema names", () => {
  it("details contain counts, not schema names", async () => {
    const ds = mockDataSourceWithSchemas(["tenant_acme", "tenant_globex", "public"]);
    const check = new TenantSchemaHealthCheck(
      "tenant-schemas",
      ds,
      ["acme", "globex", "missing_co"],
      (id) => `tenant_${id}`,
    );

    const result = await check.check();

    // Should have counts
    expect(result.details).toHaveProperty("presentCount");
    expect(result.details).toHaveProperty("missingCount");
    expect(result.details).toHaveProperty("expectedCount");

    // Should NOT have raw schema names
    const detailsJson = JSON.stringify(result.details);
    expect(detailsJson).not.toContain("tenant_acme");
    expect(detailsJson).not.toContain("tenant_globex");
    expect(detailsJson).not.toContain("missing_co");
    expect(detailsJson).not.toContain("acme");
    expect(detailsJson).not.toContain("globex");
  });

  it("DEGRADED when some schemas missing, no names leaked", async () => {
    const ds = mockDataSourceWithSchemas(["tenant_a"]);
    const check = new TenantSchemaHealthCheck(
      "schemas",
      ds,
      ["a", "b"],
      (id) => `tenant_${id}`,
    );

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
    expect(result.details.presentCount).toBe(1);
    expect(result.details.missingCount).toBe(1);

    const detailsJson = JSON.stringify(result.details);
    expect(detailsJson).not.toContain("tenant_a");
    expect(detailsJson).not.toContain("tenant_b");
  });

  it("DOWN when all schemas missing, no names leaked", async () => {
    const ds = mockDataSourceWithSchemas(["public", "pg_catalog"]);
    const check = new TenantSchemaHealthCheck(
      "schemas",
      ds,
      ["secret_tenant_1", "secret_tenant_2"],
    );

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.missingCount).toBe(2);

    const detailsJson = JSON.stringify(result.details);
    expect(detailsJson).not.toContain("secret_tenant");
  });

  it("UP when all schemas present, no names leaked", async () => {
    const ds = mockDataSourceWithSchemas(["a", "b", "c"]);
    const check = new TenantSchemaHealthCheck("schemas", ds, ["a", "b", "c"]);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.presentCount).toBe(3);
    expect(result.details.missingCount).toBe(0);

    // Even in UP status, no names should leak
    const detailsJson = JSON.stringify(result.details);
    expect(detailsJson).not.toMatch(/"[abc]"/);
  });

  it("empty tenant list returns UP", async () => {
    const ds = mockDataSourceWithSchemas(["public"]);
    const check = new TenantSchemaHealthCheck("schemas", ds, []);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.expectedCount).toBe(0);
  });

  it("error in check does not leak schema names", async () => {
    const ds = {
      getConnection: vi.fn().mockRejectedValue(new Error("connection refused")),
      close: vi.fn(),
    } as unknown as DataSource;

    const check = new TenantSchemaHealthCheck(
      "schemas",
      ds,
      ["secret_schema"],
    );

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("connection refused");

    const detailsJson = JSON.stringify(result.details);
    expect(detailsJson).not.toContain("secret_schema");
  });
});
