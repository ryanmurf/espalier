import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgConnection } from "../../pg-connection.js";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, dropTestTable, isPostgresAvailable } from "./setup.js";

const TABLE = "e2e_batch_ops";
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("E2E: Batch operations", { timeout: 30000 }, () => {
  let ds: PgDataSource;
  let conn: PgConnection;

  beforeAll(async () => {
    ds = createTestDataSource();
    const rawConn = await ds.getConnection();
    conn = rawConn as PgConnection;
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          age INT,
          active BOOLEAN DEFAULT true
        )
      `);
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

  it("batch inserts 100+ rows and verifies count", async () => {
    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);

    const rowCount = 150;
    for (let i = 0; i < rowCount; i++) {
      batch.setParameter(1, `User_${i}`);
      batch.setParameter(2, `user${i}@example.com`);
      batch.setParameter(3, 20 + (i % 50));
      batch.addBatch();
    }

    const results = await batch.executeBatch();
    expect(results.length).toBe(rowCount);

    // Verify all rows were inserted
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT COUNT(*) AS cnt FROM ${TABLE}`);
    await rs.next();
    expect(rs.getNumber("cnt")).toBe(rowCount);
  });

  it("batch inserts small number of rows", async () => {
    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);

    batch.setParameter(1, "Alice");
    batch.setParameter(2, 30);
    batch.addBatch();

    batch.setParameter(1, "Bob");
    batch.setParameter(2, 25);
    batch.addBatch();

    batch.setParameter(1, "Charlie");
    batch.setParameter(2, 35);
    batch.addBatch();

    const results = await batch.executeBatch();
    expect(results.length).toBe(3);

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE} ORDER BY name`);
    const names: string[] = [];
    while (await rs.next()) {
      names.push(rs.getString("name")!);
    }
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("batch update modifies multiple rows individually", async () => {
    // Insert some rows first
    const insert = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);
    insert.setParameter(1, "Alice");
    insert.setParameter(2, 30);
    insert.addBatch();
    insert.setParameter(1, "Bob");
    insert.setParameter(2, 25);
    insert.addBatch();
    insert.setParameter(1, "Charlie");
    insert.setParameter(2, 35);
    insert.addBatch();
    await insert.executeBatch();

    // Batch update
    const update = conn.prepareBatchStatement(`UPDATE ${TABLE} SET age = $1 WHERE name = $2`);
    update.setParameter(1, 31);
    update.setParameter(2, "Alice");
    update.addBatch();
    update.setParameter(1, 26);
    update.setParameter(2, "Bob");
    update.addBatch();

    const results = await update.executeBatch();
    expect(results).toEqual([1, 1]);

    // Verify updates
    const stmt = conn.createStatement();
    const rsAlice = await stmt.executeQuery(`SELECT age FROM ${TABLE} WHERE name = 'Alice'`);
    await rsAlice.next();
    expect(rsAlice.getNumber("age")).toBe(31);

    const rsBob = await stmt.executeQuery(`SELECT age FROM ${TABLE} WHERE name = 'Bob'`);
    await rsBob.next();
    expect(rsBob.getNumber("age")).toBe(26);
  });

  it("batch delete removes multiple rows individually", async () => {
    // Insert rows
    const insert = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);
    for (const name of ["Del1", "Del2", "Del3", "Keep1"]) {
      insert.setParameter(1, name);
      insert.setParameter(2, 20);
      insert.addBatch();
    }
    await insert.executeBatch();

    // Batch delete
    const del = conn.prepareBatchStatement(`DELETE FROM ${TABLE} WHERE name = $1`);
    del.setParameter(1, "Del1");
    del.addBatch();
    del.setParameter(1, "Del2");
    del.addBatch();
    del.setParameter(1, "Del3");
    del.addBatch();

    const results = await del.executeBatch();
    expect(results).toEqual([1, 1, 1]);

    // Verify only Keep1 remains
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
    const names: string[] = [];
    while (await rs.next()) {
      names.push(rs.getString("name")!);
    }
    expect(names).toEqual(["Keep1"]);
  });

  it("batch insert with NULL values", async () => {
    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`);

    batch.setParameter(1, "NullEmail");
    batch.setParameter(2, null);
    batch.setParameter(3, 20);
    batch.addBatch();

    batch.setParameter(1, "NullAge");
    batch.setParameter(2, "test@example.com");
    batch.setParameter(3, null);
    batch.addBatch();

    const results = await batch.executeBatch();
    expect(results.length).toBe(2);

    const stmt = conn.createStatement();
    const rs1 = await stmt.executeQuery(`SELECT email FROM ${TABLE} WHERE name = 'NullEmail'`);
    await rs1.next();
    expect(rs1.getString("email")).toBeNull();

    const rs2 = await stmt.executeQuery(`SELECT age FROM ${TABLE} WHERE name = 'NullAge'`);
    await rs2.next();
    expect(rs2.getNumber("age")).toBeNull();
  });

  it("empty batch returns empty array", async () => {
    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name) VALUES ($1)`);
    const results = await batch.executeBatch();
    expect(results).toEqual([]);
  });

  it("batch insert within a transaction - commit", async () => {
    const tx = await conn.beginTransaction();

    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);
    for (let i = 0; i < 10; i++) {
      batch.setParameter(1, `TxCommit_${i}`);
      batch.setParameter(2, i);
      batch.addBatch();
    }
    await batch.executeBatch();
    await tx.commit();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE name LIKE 'TxCommit_%'`);
    await rs.next();
    expect(rs.getNumber("cnt")).toBe(10);
  });

  it("batch insert within a transaction - rollback", async () => {
    const tx = await conn.beginTransaction();

    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);
    for (let i = 0; i < 10; i++) {
      batch.setParameter(1, `TxRollback_${i}`);
      batch.setParameter(2, i);
      batch.addBatch();
    }
    await batch.executeBatch();
    await tx.rollback();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE name LIKE 'TxRollback_%'`);
    await rs.next();
    expect(rs.getNumber("cnt")).toBe(0);
  });

  it("batch insert with constraint violation throws QueryError", async () => {
    // Create a unique constraint
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_unique_name ON ${TABLE} (name)
      `);

    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);
    batch.setParameter(1, "DuplicateName");
    batch.setParameter(2, 30);
    batch.addBatch();
    batch.setParameter(1, "DuplicateName");
    batch.setParameter(2, 31);
    batch.addBatch();

    try {
      await batch.executeBatch();
      expect.unreachable("should have thrown on duplicate");
    } catch (err: unknown) {
      const qe = err as { name: string };
      expect(qe.name).toBe("QueryError");
    }

    // Clean up the unique index
    await stmt.executeUpdate(`DROP INDEX IF EXISTS idx_batch_unique_name`);
  });

  it("batch update returns 0 for rows not matched", async () => {
    const batch = conn.prepareBatchStatement(`UPDATE ${TABLE} SET age = $1 WHERE name = $2`);
    batch.setParameter(1, 99);
    batch.setParameter(2, "NonExistentUser");
    batch.addBatch();

    const results = await batch.executeBatch();
    expect(results).toEqual([0]);
  });

  it("prepareBatchStatement throws when connection is closed", async () => {
    const conn2 = (await ds.getConnection()) as PgConnection;
    await conn2.close();
    expect(() => conn2.prepareBatchStatement(`INSERT INTO ${TABLE} (name) VALUES ($1)`)).toThrow(
      "Connection is closed",
    );
  });

  it("batch insert with mixed data types", async () => {
    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, email, age, active) VALUES ($1, $2, $3, $4)`);

    batch.setParameter(1, "TypeTest1");
    batch.setParameter(2, "type1@example.com");
    batch.setParameter(3, 25);
    batch.setParameter(4, true);
    batch.addBatch();

    batch.setParameter(1, "TypeTest2");
    batch.setParameter(2, null);
    batch.setParameter(3, 0);
    batch.setParameter(4, false);
    batch.addBatch();

    const results = await batch.executeBatch();
    expect(results.length).toBe(2);

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name LIKE 'TypeTest%' ORDER BY name`);

    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("TypeTest1");
    expect(rs.getBoolean("active")).toBe(true);
    expect(rs.getNumber("age")).toBe(25);

    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("TypeTest2");
    expect(rs.getBoolean("active")).toBe(false);
    expect(rs.getString("email")).toBeNull();
  });
});
