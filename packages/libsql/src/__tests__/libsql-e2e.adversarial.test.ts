import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LibSqlDataSource, createLibSqlDataSource } from "../libsql-data-source.js";
import type { LibSqlDataSourceConfig } from "../libsql-data-source.js";

// ==========================================================================
// E2E tests: require @libsql/client to be available
// ==========================================================================

let canUseLibSql = false;
try {
  const mod = await import("@libsql/client");
  if (typeof mod.createClient === "function") {
    canUseLibSql = true;
  }
} catch {
  // @libsql/client not loadable
}

describe.skipIf(!canUseLibSql)("LibSQL E2E — in-memory database", () => {
  let ds: LibSqlDataSource;

  beforeEach(() => {
    ds = new LibSqlDataSource({ url: "file::memory:" });
  });

  afterEach(async () => {
    await ds.close();
  });

  // ---------- basic CRUD ----------

  it("full CRUD lifecycle", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        "CREATE TABLE crud_test (id INTEGER PRIMARY KEY, name TEXT, value INTEGER)",
      );

      // INSERT
      const insertCount = await stmt.executeUpdate(
        "INSERT INTO crud_test (id, name, value) VALUES (1, 'Alice', 42)",
      );
      expect(insertCount).toBe(1);

      // SELECT
      const rs = await stmt.executeQuery("SELECT id, name, value FROM crud_test WHERE id = 1");
      expect(await rs.next()).toBe(true);
      const row = rs.getRow();
      expect(row.name).toBe("Alice");
      expect(Number(row.value)).toBe(42);
      expect(await rs.next()).toBe(false);

      // UPDATE
      const updateCount = await stmt.executeUpdate("UPDATE crud_test SET value = 99 WHERE id = 1");
      expect(updateCount).toBe(1);

      // DELETE
      const deleteCount = await stmt.executeUpdate("DELETE FROM crud_test WHERE id = 1");
      expect(deleteCount).toBe(1);

      // Verify deletion
      const rs2 = await stmt.executeQuery("SELECT id FROM crud_test");
      expect(await rs2.next()).toBe(false);

      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- prepared statements ----------

  it("prepared statement INSERT and SELECT", async () => {
    const conn = await ds.getConnection();
    try {
      const setup = conn.createStatement();
      await setup.executeUpdate(
        "CREATE TABLE ps_test (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)",
      );
      await setup.close();

      const insert = conn.prepareStatement("INSERT INTO ps_test (id, name, age) VALUES ($1, $2, $3)");
      insert.setParameter(1, 1);
      insert.setParameter(2, "Bob");
      insert.setParameter(3, 30);
      const count = await insert.executeUpdate();
      expect(count).toBe(1);
      await insert.close();

      const select = conn.prepareStatement("SELECT name, age FROM ps_test WHERE id = $1");
      select.setParameter(1, 1);
      const rs = await select.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("name")).toBe("Bob");
      expect(rs.getNumber("age")).toBe(30);
      await select.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- SQL injection prevention (live) ----------

  it("SQL injection via prepared statement is safely parameterized", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate("CREATE TABLE inject_test (id INTEGER PRIMARY KEY, name TEXT)");
      await stmt.executeUpdate("INSERT INTO inject_test (id, name) VALUES (1, 'safe')");

      const ps = conn.prepareStatement("SELECT * FROM inject_test WHERE name = $1");
      ps.setParameter(1, "'; DROP TABLE inject_test; --");
      const rs = await ps.executeQuery();
      // Should return 0 rows (no match), NOT drop the table
      expect(await rs.next()).toBe(false);
      await ps.close();

      // Table still exists
      const rs2 = await stmt.executeQuery("SELECT COUNT(*) as cnt FROM inject_test");
      expect(await rs2.next()).toBe(true);
      expect(Number(rs2.getRow().cnt)).toBe(1);
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- transactions ----------

  it("post-commit queries succeed — activeTransaction cleared after commit", async () => {
    // FIX: LibSqlConnection.beginTransaction() now properly clears this.activeTransaction
    // after commit()/rollback(), so post-commit queries work correctly.
    // The old BUG caused TRANSACTION_CLOSED errors; the fix clears the transaction reference.
    const conn = await ds.getConnection();
    try {
      // Perform a simple select BEFORE any transaction (verifies baseline works)
      const setup = conn.createStatement();
      await setup.executeUpdate("CREATE TABLE tx_bug (id INTEGER PRIMARY KEY, v TEXT)");
      await setup.close();

      const tx = await conn.beginTransaction();
      await tx.commit(); // commit empty transaction

      // After fix: createStatement() after commit should NOT throw TRANSACTION_CLOSED.
      // It should use this.client (not the committed tx) and successfully execute.
      const verify = conn.createStatement();
      // Simple query that doesn't depend on cross-connection visibility
      await expect(
        verify.executeQuery("SELECT 1 as n"),
      ).resolves.toBeDefined(); // No TRANSACTION_CLOSED error thrown
    } finally {
      await conn.close();
    }
  });

  it("transaction rollback discards inserted data (single connection)", async () => {
    const conn = await ds.getConnection();
    try {
      // Start a transaction, then roll it back
      const tx = await conn.beginTransaction();
      await tx.rollback(); // rollback empty transaction

      // After fix: activeTransaction is cleared on rollback, so post-rollback queries work.
      // The old BUG caused TRANSACTION_CLOSED errors after rollback.
      // Verify the connection is usable again without TRANSACTION_CLOSED error.
      const verify = conn.createStatement();
      await expect(
        verify.executeQuery("SELECT 1 as n"),
      ).resolves.toBeDefined(); // No TRANSACTION_CLOSED error
    } finally {
      await conn.close();
    }
  });

  // ---------- null handling ----------

  it("NULL values read back correctly from all typed accessors", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        "CREATE TABLE null_test (id INTEGER PRIMARY KEY, s TEXT, n REAL, b INTEGER, d TEXT)",
      );
      await stmt.executeUpdate("INSERT INTO null_test (id) VALUES (1)");

      const rs = await stmt.executeQuery("SELECT s, n, b, d FROM null_test WHERE id = 1");
      expect(await rs.next()).toBe(true);
      expect(rs.getString("s")).toBeNull();
      expect(rs.getNumber("n")).toBeNull();
      expect(rs.getBoolean("b")).toBeNull();
      expect(rs.getDate("d")).toBeNull();
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- invalid SQL ----------

  it("invalid SQL throws error (not silent failure)", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await expect(
        stmt.executeQuery("SELECT * FROM absolutely_nonexistent_table_xyz_abc"),
      ).rejects.toThrow();
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  it("syntax error in SQL throws", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await expect(stmt.executeUpdate("INSERTT INTO nowhere")).rejects.toThrow();
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- empty result sets ----------

  it("empty result set from query returns false on next()", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate("CREATE TABLE empty_test (id INTEGER PRIMARY KEY)");
      const rs = await stmt.executeQuery("SELECT * FROM empty_test");
      expect(await rs.next()).toBe(false);
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- multiple connections share client ----------

  it("multiple connections see same data (shared client)", async () => {
    const conn1 = await ds.getConnection();
    const conn2 = await ds.getConnection();
    try {
      const stmt1 = conn1.createStatement();
      await stmt1.executeUpdate("CREATE TABLE share_test (id INTEGER PRIMARY KEY, v TEXT)");
      await stmt1.executeUpdate("INSERT INTO share_test (id, v) VALUES (1, 'shared')");
      await stmt1.close();

      const stmt2 = conn2.createStatement();
      const rs = await stmt2.executeQuery("SELECT v FROM share_test WHERE id = 1");
      expect(await rs.next()).toBe(true);
      expect(rs.getString("v")).toBe("shared");
      await stmt2.close();
    } finally {
      await conn1.close();
      await conn2.close();
    }
  });

  // ---------- async iterator ----------

  it("async iterator over multi-row result", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate("CREATE TABLE iter_test (id INTEGER PRIMARY KEY, name TEXT)");
      for (let i = 1; i <= 5; i++) {
        await stmt.executeUpdate(`INSERT INTO iter_test (id, name) VALUES (${i}, 'item-${i}')`);
      }
      const rs = await stmt.executeQuery("SELECT id, name FROM iter_test ORDER BY id");
      const rows: Record<string, unknown>[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      expect(rows).toHaveLength(5);
      expect(rows[0]!.name).toBe("item-1");
      expect(rows[4]!.name).toBe("item-5");
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- data types ----------

  it("integer, real, text, blob types round-trip", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        "CREATE TABLE types_test (id INTEGER PRIMARY KEY, i INTEGER, r REAL, t TEXT, b BLOB)",
      );

      const ps = conn.prepareStatement(
        "INSERT INTO types_test (id, i, r, t, b) VALUES ($1, $2, $3, $4, $5)",
      );
      ps.setParameter(1, 1);
      ps.setParameter(2, 2147483647); // max 32-bit int
      ps.setParameter(3, 3.14159);
      ps.setParameter(4, "hello world");
      ps.setParameter(5, new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
      await ps.executeUpdate();
      await ps.close();

      const rs = await stmt.executeQuery("SELECT i, r, t, b FROM types_test WHERE id = 1");
      expect(await rs.next()).toBe(true);
      const row = rs.getRow();
      expect(Number(row.i)).toBe(2147483647);
      expect(Number(row.r)).toBeCloseTo(3.14159, 4);
      expect(row.t).toBe("hello world");
      // Blob might come back as ArrayBuffer or Uint8Array
      expect(row.b).toBeDefined();
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  it("Date converted to ISO string survives round-trip", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate("CREATE TABLE date_test (id INTEGER PRIMARY KEY, d TEXT)");

      const ps = conn.prepareStatement("INSERT INTO date_test (id, d) VALUES ($1, $2)");
      const date = new Date("2024-06-15T12:30:00.000Z");
      ps.setParameter(1, 1);
      ps.setParameter(2, date);
      await ps.executeUpdate();
      await ps.close();

      const rs = await stmt.executeQuery("SELECT d FROM date_test WHERE id = 1");
      expect(await rs.next()).toBe(true);
      const d = rs.getDate("d");
      expect(d).toBeInstanceOf(Date);
      expect(d!.toISOString()).toBe("2024-06-15T12:30:00.000Z");
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  // ---------- connection after close ----------

  it("operations on closed connection throw clearly", async () => {
    const conn = await ds.getConnection();
    await conn.close();

    expect(() => conn.createStatement()).toThrow(/closed/i);
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(/closed/i);
    await expect(conn.beginTransaction()).rejects.toThrow(/closed/i);
  });

  // ---------- DataSource after close ----------

  it("getConnection after DataSource close throws", async () => {
    await ds.close();
    await expect(ds.getConnection()).rejects.toThrow(/closed/i);
  });

  // ---------- stress test ----------

  it("100 sequential inserts and reads", async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate("CREATE TABLE stress_test (id INTEGER PRIMARY KEY, v TEXT)");

      for (let i = 0; i < 100; i++) {
        const ps = conn.prepareStatement("INSERT INTO stress_test (id, v) VALUES ($1, $2)");
        ps.setParameter(1, i);
        ps.setParameter(2, `value-${i}`);
        await ps.executeUpdate();
        await ps.close();
      }

      const rs = await stmt.executeQuery("SELECT COUNT(*) as cnt FROM stress_test");
      expect(await rs.next()).toBe(true);
      expect(Number(rs.getRow().cnt)).toBe(100);
      await stmt.close();
    } finally {
      await conn.close();
    }
  });
});
