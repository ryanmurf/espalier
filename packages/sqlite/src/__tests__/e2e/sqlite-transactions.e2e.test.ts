import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { SqliteDataSource } from "../../sqlite-data-source.js";
import { createTestDataSource, testTableDDL, dropTestTable, isSqliteAvailable } from "./setup.js";

const TABLE = "e2e_tx_test";

describe.skipIf(!isSqliteAvailable)("E2E: SQLite transactions", () => {
  let ds: SqliteDataSource;
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
      await conn.close();
    }
    if (ds) {
      await ds.close();
    }
  });

  it("commits a transaction", async () => {
    const tx = await conn.beginTransaction();
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
    );
    ps.setParameter(1, "TxCommit");
    ps.setParameter(2, "commit@test.com");
    ps.setParameter(3, 25);
    await ps.executeUpdate();
    await tx.commit();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT * FROM ${TABLE} WHERE name = 'TxCommit'`,
    );
    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("TxCommit");
  });

  it("rolls back a transaction", async () => {
    const tx = await conn.beginTransaction();
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
    );
    ps.setParameter(1, "TxRollback");
    ps.setParameter(2, "rollback@test.com");
    ps.setParameter(3, 30);
    await ps.executeUpdate();
    await tx.rollback();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT * FROM ${TABLE} WHERE name = 'TxRollback'`,
    );
    expect(await rs.next()).toBe(false);
  });

  it("supports savepoints", async () => {
    const tx = await conn.beginTransaction();

    const ps1 = conn.prepareStatement(
      `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
    );
    ps1.setParameter(1, "BeforeSP");
    ps1.setParameter(2, "before@test.com");
    ps1.setParameter(3, 20);
    await ps1.executeUpdate();

    await tx.setSavepoint("sp1");

    const ps2 = conn.prepareStatement(
      `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
    );
    ps2.setParameter(1, "AfterSP");
    ps2.setParameter(2, "after@test.com");
    ps2.setParameter(3, 21);
    await ps2.executeUpdate();

    await tx.rollbackTo("sp1");
    await tx.commit();

    const stmt = conn.createStatement();
    const rs1 = await stmt.executeQuery(
      `SELECT * FROM ${TABLE} WHERE name = 'BeforeSP'`,
    );
    expect(await rs1.next()).toBe(true);

    const rs2 = await stmt.executeQuery(
      `SELECT * FROM ${TABLE} WHERE name = 'AfterSP'`,
    );
    expect(await rs2.next()).toBe(false);
  });

  it("begins transaction with default DEFERRED mode", async () => {
    // DEFERRED is the default and should work
    const tx = await conn.beginTransaction();
    const stmt = conn.createStatement();
    await stmt.executeQuery(`SELECT * FROM ${TABLE} LIMIT 1`);
    await tx.commit();
  });
});
