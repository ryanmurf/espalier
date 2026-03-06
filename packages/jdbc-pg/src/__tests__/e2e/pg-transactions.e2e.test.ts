import type { Connection } from "espalier-jdbc";
import { IsolationLevel } from "espalier-jdbc";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, dropTestTable, isPostgresAvailable, testTableDDL } from "./setup.js";

const TABLE = "e2e_tx_users";
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("E2E: Transactions", { timeout: 10000 }, () => {
  let ds: PgDataSource;
  let conn: Connection;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(testTableDDL(TABLE));
  });

  beforeEach(async () => {
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DELETE FROM ${TABLE}`);
  });

  afterAll(async () => {
    if (conn && !conn.isClosed()) {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(dropTestTable(TABLE));
      await conn.close();
    }
    if (ds) {
      await ds.close();
    }
  });

  it("commit persists inserted data", async () => {
    const tx = await conn.beginTransaction();
    const ps = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps.setParameter(1, "TxAlice");
    ps.setParameter(2, "tx@example.com");
    ps.setParameter(3, 25);
    await ps.executeUpdate();
    await tx.commit();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'TxAlice'`);
    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("TxAlice");
  });

  it("rollback discards inserted data", async () => {
    const tx = await conn.beginTransaction();
    const ps = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps.setParameter(1, "TxBob");
    ps.setParameter(2, "bob@example.com");
    ps.setParameter(3, 40);
    await ps.executeUpdate();
    await tx.rollback();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'TxBob'`);
    expect(await rs.next()).toBe(false);
  });

  it("begins transaction with SERIALIZABLE isolation level", async () => {
    const tx = await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery("SHOW transaction_isolation");
    await rs.next();
    expect(rs.getString("transaction_isolation")).toBe("serializable");
    await tx.rollback();
  });

  it("savepoint: rollbackTo undoes work after savepoint", async () => {
    const tx = await conn.beginTransaction();

    const ps1 = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps1.setParameter(1, "First");
    ps1.setParameter(2, "first@example.com");
    ps1.setParameter(3, 1);
    await ps1.executeUpdate();

    await tx.setSavepoint("sp1");

    const ps2 = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps2.setParameter(1, "Second");
    ps2.setParameter(2, "second@example.com");
    ps2.setParameter(3, 2);
    await ps2.executeUpdate();

    await tx.rollbackTo("sp1");
    await tx.commit();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE} ORDER BY name`);
    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("First");
    expect(await rs.next()).toBe(false);
  });

  describe("connection lifecycle", () => {
    it("isClosed() is false before close, true after", async () => {
      const conn2 = await ds.getConnection();
      expect(conn2.isClosed()).toBe(false);
      await conn2.close();
      expect(conn2.isClosed()).toBe(true);
    });

    it("operations throw after connection.close()", async () => {
      const conn2 = await ds.getConnection();
      await conn2.close();
      expect(() => conn2.createStatement()).toThrow("Connection is closed");
      expect(() => conn2.prepareStatement("SELECT 1")).toThrow("Connection is closed");
      await expect(conn2.beginTransaction()).rejects.toThrow("Connection is closed");
    });
  });
});
