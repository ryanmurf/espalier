import type { Connection } from "espalier-jdbc";
import { IsolationLevel } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MysqlDataSource } from "../../mysql-data-source.js";
import { createTestDataSource, dropTestTable, isMysqlAvailable, testTableDDL } from "./setup.js";

const TABLE = "e2e_tx_test";
const canConnect = await isMysqlAvailable();

describe.skipIf(!canConnect)("E2E: MySQL transactions", { timeout: 10000 }, () => {
  let ds: MysqlDataSource;
  let conn: Connection;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(testTableDDL(TABLE));
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

  it("commits a transaction", async () => {
    const tx = await conn.beginTransaction();
    const ps = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps.setParameter(1, "TxCommit");
    ps.setParameter(2, "commit@test.com");
    ps.setParameter(3, 25);
    await ps.executeUpdate();
    await tx.commit();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'TxCommit'`);
    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("TxCommit");
  });

  it("rolls back a transaction", async () => {
    const tx = await conn.beginTransaction();
    const ps = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps.setParameter(1, "TxRollback");
    ps.setParameter(2, "rollback@test.com");
    ps.setParameter(3, 30);
    await ps.executeUpdate();
    await tx.rollback();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'TxRollback'`);
    expect(await rs.next()).toBe(false);
  });

  it("supports savepoints", async () => {
    const tx = await conn.beginTransaction();

    const ps1 = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps1.setParameter(1, "BeforeSavepoint");
    ps1.setParameter(2, "before@test.com");
    ps1.setParameter(3, 20);
    await ps1.executeUpdate();

    await tx.setSavepoint("sp1");

    const ps2 = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);
    ps2.setParameter(1, "AfterSavepoint");
    ps2.setParameter(2, "after@test.com");
    ps2.setParameter(3, 21);
    await ps2.executeUpdate();

    await tx.rollbackTo("sp1");
    await tx.commit();

    const stmt = conn.createStatement();
    const rs1 = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'BeforeSavepoint'`);
    expect(await rs1.next()).toBe(true);

    const rs2 = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'AfterSavepoint'`);
    expect(await rs2.next()).toBe(false);
  });

  it("begins transaction with REPEATABLE READ isolation", async () => {
    const tx = await conn.beginTransaction(IsolationLevel.REPEATABLE_READ);
    const stmt = conn.createStatement();
    await stmt.executeQuery(`SELECT * FROM ${TABLE} LIMIT 1`);
    await tx.commit();
  });

  it("begins transaction with READ COMMITTED isolation", async () => {
    const tx = await conn.beginTransaction(IsolationLevel.READ_COMMITTED);
    const stmt = conn.createStatement();
    await stmt.executeQuery(`SELECT * FROM ${TABLE} LIMIT 1`);
    await tx.commit();
  });
});
