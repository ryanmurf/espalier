/**
 * Y4 Q4 Seam Tests — DevQueryLogger + multi-tenant DataSource + Seeder
 *
 * Adversarial tests targeting:
 * 1. DevQueryLogger + TenantAwareDataSource (does logger work with tenant context?)
 * 2. SeedRunner + existing database state (migration tracking coexistence)
 * 3. Seeder dependency ordering and circular dependency detection
 * 4. Seeder environment filtering
 */

import { Column, Id, Table, TenantAwareDataSource, TenantContext } from "espalier-data";
import { createDevLogger, DevQueryLogger } from "espalier-data/observability";
import { LogLevel } from "espalier-jdbc";
import { PgDataSource } from "espalier-jdbc-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSeedRegistry, defineSeed, getRegisteredSeeds, SeedRunner } from "../index.js";

// =============================================================================
// Connectivity check
// =============================================================================

const PG_CONFIG = {
  host: "localhost",
  port: 55432,
  user: "nesify",
  password: "nesify",
  database: "nesify",
};

let canConnect = false;
try {
  const probe = new PgDataSource(PG_CONFIG);
  const conn = await probe.getConnection();
  await conn.createStatement().executeQuery("SELECT 1");
  await conn.close();
  await probe.close();
  canConnect = true;
} catch {
  canConnect = false;
}

// =============================================================================
// Test entity
// =============================================================================

@Table("qa_seam_products")
class SeamProduct {
  @Id
  @Column({ type: "UUID" })
  id!: string;

  @Column({ type: "VARCHAR(255)" })
  name!: string;

  @Column({ type: "DECIMAL(10,2)" })
  price!: number;
}
new SeamProduct();

// =============================================================================
// Seam 5: DevQueryLogger + TenantAwareDataSource (unit-level)
// =============================================================================

describe("Seam 5: DevQueryLogger + multi-tenant DataSource — unit level", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("DevQueryLogger logs SET search_path query (tenant context SQL)", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: false });
    logger.debug("query", {
      sql: "SET search_path TO tenant_acme, public",
      durationMs: 0.1,
    });
    const output = String(consoleSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("SET search_path TO tenant_acme");
  });

  it("DevQueryLogger filter suppresses search_path noise from TenantAwareDataSource", () => {
    const logger = new DevQueryLogger({
      colorize: false,
      filter: (sql) => !sql.toLowerCase().includes("search_path"),
    });

    // Tenant context management query — should be suppressed
    logger.debug("query", {
      sql: "SET search_path TO schema_tenant1, public",
      durationMs: 0,
    });
    expect(consoleSpy).not.toHaveBeenCalled();

    // Real business query — should pass through
    logger.debug("query", {
      sql: "SELECT * FROM qa_seam_products WHERE name = $1",
      durationMs: 5,
      params: ["Widget"],
    });
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("DevQueryLogger.child() creates tenant-scoped sub-logger", () => {
    const root = new DevQueryLogger({ colorize: false, level: LogLevel.DEBUG, name: "app" });
    const tenantLogger = root.child("tenant:acme-corp");
    tenantLogger.info("querying tenant database");
    const output = String(consoleSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("app.tenant:acme-corp");
    expect(output).toContain("querying tenant database");
  });

  it("DevQueryLogger with minDurationMs filter ignores fast search_path queries", () => {
    const logger = new DevQueryLogger({ colorize: false, minDurationMs: 5 });

    // Fast tenant setup query (0.5ms) — should be suppressed
    logger.debug("query", { sql: "SET search_path TO schema_t1, public", durationMs: 0.5 });
    expect(consoleSpy).not.toHaveBeenCalled();

    // Slow business query (10ms) — should be logged
    logger.debug("query", { sql: "SELECT * FROM qa_seam_products", durationMs: 10 });
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("TenantAwareDataSource rejects getConnection when no tenant and no default", () => {
    const mockDs = {
      getConnection: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
    };
    const tenantDs = new TenantAwareDataSource({
      dataSource: mockDs as any,
      schemaResolver: (id) => `schema_${id}`,
      // no defaultSchema
    });

    return expect(tenantDs.getConnection()).rejects.toThrow();
  });

  it("TenantAwareDataSource uses defaultSchema fallback when no tenant set", async () => {
    const setPathCalls: string[] = [];
    const mockConn = {
      createStatement: vi.fn(() => ({
        executeUpdate: vi.fn(async (sql: string) => {
          setPathCalls.push(sql);
          return 0;
        }),
        executeQuery: vi.fn(),
        close: vi.fn(),
      })),
      prepareStatement: vi.fn(),
      beginTransaction: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const mockDs = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
      close: vi.fn(),
    };

    const tenantDs = new TenantAwareDataSource({
      dataSource: mockDs as any,
      schemaResolver: (id) => `schema_${id}`,
      defaultSchema: "public",
      resetOnRelease: false,
    });

    const conn = await tenantDs.getConnection();
    expect(conn).toBeDefined();
    expect(setPathCalls.some((s) => s.includes("search_path") && s.includes("public"))).toBe(true);
  });

  it("TenantAwareDataSource sets schema for active tenant context", async () => {
    const setPathCalls: string[] = [];
    const mockConn = {
      createStatement: vi.fn(() => ({
        executeUpdate: vi.fn(async (sql: string) => {
          setPathCalls.push(sql);
          return 0;
        }),
        executeQuery: vi.fn(),
        close: vi.fn(),
      })),
      prepareStatement: vi.fn(),
      beginTransaction: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const mockDs = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
      close: vi.fn(),
    };

    const tenantDs = new TenantAwareDataSource({
      dataSource: mockDs as any,
      schemaResolver: (id) => `schema_${id}`,
      resetOnRelease: false,
    });

    await TenantContext.run("acme", async () => {
      const conn = await tenantDs.getConnection();
      expect(conn).toBeDefined();
    });

    expect(setPathCalls.some((s) => s.includes("schema_acme"))).toBe(true);
  });

  it("createDevLogger factory returns valid Logger with all methods", () => {
    const logger = createDevLogger({ colorize: false });
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.child).toBe("function");
    expect(typeof logger.isEnabled).toBe("function");
  });
});

// =============================================================================
// Seam 8: SeedRunner + existing database state
// =============================================================================

describe.skipIf(!canConnect)("Seam 8: SeedRunner + existing migration state", { timeout: 30000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = new PgDataSource(PG_CONFIG);
    // Ensure a fresh state
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate("DROP TABLE IF EXISTS _espalier_seeds CASCADE");
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate("DROP TABLE IF EXISTS _espalier_seeds CASCADE");
    await conn.close();
    await ds.close();
  });

  beforeEach(() => {
    clearSeedRegistry();
  });

  it("SeedRunner.ensureTable creates tracking table idempotently", async () => {
    const runner = new SeedRunner(ds, "test");
    const conn = await ds.getConnection();
    try {
      await runner.ensureTable(conn); // first call
      await runner.ensureTable(conn); // second call — must not throw
    } finally {
      await conn.close();
    }
  });

  it("seeds run on first call and are marked as already-run on second call", async () => {
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-first-run", {
      run: async (_ctx) => {
        // no-op seed
      },
    });

    const first = await runner.run(getRegisteredSeeds());
    expect(first.executed).toContain("qa-seed-first-run");
    expect(first.alreadyRun).not.toContain("qa-seed-first-run");

    const second = await runner.run(getRegisteredSeeds());
    expect(second.alreadyRun).toContain("qa-seed-first-run");
    expect(second.executed).not.toContain("qa-seed-first-run");
  });

  it("seeds respect environment filter — dev-only seeds skipped in production", async () => {
    const runner = new SeedRunner(ds, "production");

    defineSeed("qa-seed-dev-only", {
      environments: ["development"],
      run: async () => {},
    });
    defineSeed("qa-seed-all-envs", {
      // no environments = runs everywhere
      run: async () => {},
    });

    const result = await runner.run(getRegisteredSeeds());
    expect(result.skipped).toContain("qa-seed-dev-only");
    expect(result.executed).toContain("qa-seed-all-envs");
  });

  it("SeedRunner.reset drops the tracking table completely", async () => {
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-to-reset", { run: async () => {} });
    await runner.run(getRegisteredSeeds()); // run once

    await runner.reset(); // drop the tracking table

    // Clear registry and re-register
    clearSeedRegistry();
    defineSeed("qa-seed-fresh-after-reset", { run: async () => {} });

    // Should execute again since tracking was dropped
    const afterReset = await runner.run(getRegisteredSeeds());
    expect(afterReset.executed).toContain("qa-seed-fresh-after-reset");

    // Cleanup
    await runner.reset();
  });

  it("seeds run in dependency order", async () => {
    const order: string[] = [];
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-b-depends-on-a", {
      dependsOn: ["qa-seed-a-base"],
      run: async () => {
        order.push("B");
      },
    });
    defineSeed("qa-seed-a-base", {
      run: async () => {
        order.push("A");
      },
    });

    await runner.run(getRegisteredSeeds());

    const aIdx = order.indexOf("A");
    const bIdx = order.indexOf("B");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(bIdx); // A must run before B

    await runner.reset();
  });

  it("SeedRunner detects circular dependencies and throws", async () => {
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-circular-x", {
      dependsOn: ["qa-seed-circular-y"],
      run: async () => {},
    });
    defineSeed("qa-seed-circular-y", {
      dependsOn: ["qa-seed-circular-x"],
      run: async () => {},
    });

    const conn = await ds.getConnection();
    try {
      await runner.ensureTable(conn);
    } finally {
      await conn.close();
    }

    await expect(runner.run(getRegisteredSeeds())).rejects.toThrow(/circular/i);

    await runner.reset();
  });

  it("seed with unknown dependency throws descriptive error", async () => {
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-orphan", {
      dependsOn: ["this-seed-does-not-exist"],
      run: async () => {},
    });

    const conn = await ds.getConnection();
    try {
      await runner.ensureTable(conn);
    } finally {
      await conn.close();
    }

    await expect(runner.run(getRegisteredSeeds())).rejects.toThrow(/Unknown seed dependency/i);

    await runner.reset();
  });

  it("seed can use factory to build entities without persisting", async () => {
    // SEAM CHECK: seed context provides factory() — does it work?
    let factoryUsed = false;
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-with-factory", {
      run: async (ctx) => {
        const factory = ctx.factory(SeamProduct);
        const product = factory.build({ name: "SeededProduct" });
        expect(product.id).toBeTruthy();
        expect(product.name).toBe("SeededProduct");
        factoryUsed = true;
      },
    });

    await runner.run(getRegisteredSeeds());
    expect(factoryUsed).toBe(true);

    await runner.reset();
  });

  it("SeedRunner.status() correctly reports pending vs executed seeds", async () => {
    const runner = new SeedRunner(ds, "test");

    defineSeed("qa-seed-status-a", { run: async () => {} });
    defineSeed("qa-seed-status-b", { run: async () => {} });

    // Only run A
    const singleSeed = new Map(Array.from(getRegisteredSeeds().entries()).filter(([k]) => k === "qa-seed-status-a"));
    await runner.run(singleSeed);

    const status = await runner.status(getRegisteredSeeds());
    const aStatus = status.find((s) => s.name === "qa-seed-status-a");
    const bStatus = status.find((s) => s.name === "qa-seed-status-b");

    expect(aStatus?.status).toBe("executed");
    expect(bStatus?.status).toBe("pending");

    await runner.reset();
  });
});
