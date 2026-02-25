import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { PgDataSource } from "../../pg-data-source.js";
import {
  createTestDataSource,
  isPostgresAvailable,
  dropTestTable,
  testTableDDL,
} from "./setup.js";

const TABLE = "e2e_pool_test";
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)(
  "E2E: Connection pool behavior",
  { timeout: 15000 },
  () => {
    let ds: PgDataSource;

    beforeAll(async () => {
      ds = createTestDataSource();
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(dropTestTable(TABLE));
      await stmt.executeUpdate(testTableDDL(TABLE));
      await conn.close();
    });

    afterAll(async () => {
      if (ds) {
        const conn = await ds.getConnection();
        const stmt = conn.createStatement();
        await stmt.executeUpdate(dropTestTable(TABLE));
        await conn.close();
        await ds.close();
      }
    });

    it("acquires and releases multiple connections", async () => {
      const conn1 = await ds.getConnection();
      const conn2 = await ds.getConnection();
      const conn3 = await ds.getConnection();

      expect(conn1.isClosed()).toBe(false);
      expect(conn2.isClosed()).toBe(false);
      expect(conn3.isClosed()).toBe(false);

      await conn1.close();
      await conn2.close();
      await conn3.close();

      expect(conn1.isClosed()).toBe(true);
      expect(conn2.isClosed()).toBe(true);
      expect(conn3.isClosed()).toBe(true);
    });

    it("connections are independent - work on one does not affect another", async () => {
      const conn1 = await ds.getConnection();
      const conn2 = await ds.getConnection();

      const ps1 = conn1.prepareStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
      );
      ps1.setParameter(1, "PoolUser1");
      ps1.setParameter(2, "pool1@example.com");
      ps1.setParameter(3, 10);
      await ps1.executeUpdate();

      const ps2 = conn2.prepareStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
      );
      ps2.setParameter(1, "PoolUser2");
      ps2.setParameter(2, "pool2@example.com");
      ps2.setParameter(3, 20);
      await ps2.executeUpdate();

      // Both should be visible since no transaction isolation
      const stmt = conn1.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE name IN ('PoolUser1', 'PoolUser2')`,
      );
      await rs.next();
      expect(rs.getNumber("cnt")).toBe(2);

      await conn1.close();
      await conn2.close();
    });

    it("pool stats reflect active connections", async () => {
      const statsBefore = ds.getPoolStats();
      expect(statsBefore.total).toBeGreaterThanOrEqual(0);
      expect(statsBefore.idle).toBeGreaterThanOrEqual(0);

      const conn = await ds.getConnection();
      const statsAfter = ds.getPoolStats();
      expect(statsAfter.total).toBeGreaterThanOrEqual(1);

      await conn.close();
    });

    it("parallel queries on separate connections", async () => {
      const connections: Connection[] = [];
      for (let i = 0; i < 5; i++) {
        connections.push(await ds.getConnection());
      }

      const results = await Promise.all(
        connections.map(async (c, i) => {
          const stmt = c.createStatement();
          const rs = await stmt.executeQuery(`SELECT ${i} AS val`);
          await rs.next();
          return rs.getNumber("val");
        }),
      );

      expect(results).toEqual([0, 1, 2, 3, 4]);

      for (const c of connections) {
        await c.close();
      }
    });

    it("connection returned to pool can be reacquired", async () => {
      const conn1 = await ds.getConnection();
      const stmt1 = conn1.createStatement();
      const rs1 = await stmt1.executeQuery("SELECT 42 AS val");
      await rs1.next();
      expect(rs1.getNumber("val")).toBe(42);
      await conn1.close();

      // Reacquire - may get the same underlying client
      const conn2 = await ds.getConnection();
      const stmt2 = conn2.createStatement();
      const rs2 = await stmt2.executeQuery("SELECT 84 AS val");
      await rs2.next();
      expect(rs2.getNumber("val")).toBe(84);
      await conn2.close();
    });

    it("transaction on one connection does not affect another", async () => {
      const conn1 = await ds.getConnection();
      const conn2 = await ds.getConnection();

      const tx = await conn1.beginTransaction();
      const ps = conn1.prepareStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
      );
      ps.setParameter(1, "TxIsolated");
      ps.setParameter(2, "txiso@example.com");
      ps.setParameter(3, 50);
      await ps.executeUpdate();

      // conn2 should not see uncommitted data (default READ COMMITTED)
      const stmt2 = conn2.createStatement();
      const rs2 = await stmt2.executeQuery(
        `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE name = 'TxIsolated'`,
      );
      await rs2.next();
      expect(rs2.getNumber("cnt")).toBe(0);

      await tx.rollback();
      await conn1.close();
      await conn2.close();
    });
  },
);
