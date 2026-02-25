import { describe, it, expect, afterAll } from "vitest";
import type { PooledDataSource } from "espalier-jdbc";
import type { MysqlDataSource } from "../../mysql-data-source.js";
import { createTestDataSource, isMysqlAvailable } from "./setup.js";

const canConnect = await isMysqlAvailable();

describe.skipIf(!canConnect)("E2E: MySQL pool management", { timeout: 10000 }, () => {
  let ds: MysqlDataSource;

  afterAll(async () => {
    if (ds) {
      await ds.close();
    }
  });

  it("returns pool stats", () => {
    ds = createTestDataSource();
    const stats = (ds as PooledDataSource).getPoolStats();
    expect(stats).toHaveProperty("total");
    expect(stats).toHaveProperty("idle");
    expect(stats).toHaveProperty("waiting");
    expect(typeof stats.total).toBe("number");
    expect(typeof stats.idle).toBe("number");
    expect(typeof stats.waiting).toBe("number");
  });

  it("supports concurrent connections", async () => {
    ds = createTestDataSource();
    const connections = await Promise.all([
      ds.getConnection(),
      ds.getConnection(),
      ds.getConnection(),
    ]);

    for (const conn of connections) {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery("SELECT 1 AS val");
      await rs.next();
      expect(rs.getNumber("val")).toBe(1);
    }

    for (const conn of connections) {
      await conn.close();
    }
  });

  it("recycles connections back to pool after close", async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT 1");
    await conn.close();

    // Should be able to get another connection after closing
    const conn2 = await ds.getConnection();
    const stmt2 = conn2.createStatement();
    const rs = await stmt2.executeQuery("SELECT 2 AS val");
    await rs.next();
    expect(rs.getNumber("val")).toBe(2);
    await conn2.close();
  });
});
