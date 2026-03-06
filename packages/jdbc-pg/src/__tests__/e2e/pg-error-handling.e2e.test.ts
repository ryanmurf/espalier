import type { Connection } from "espalier-jdbc";
import { DatabaseErrorCode } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, dropTestTable, isPostgresAvailable } from "./setup.js";

const TABLE = "e2e_error_handling";
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("E2E: Error handling", { timeout: 10000 }, () => {
  let ds: PgDataSource;
  let conn: Connection;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          age INT CHECK (age >= 0)
        )
      `);
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

  it("throws QueryError with QUERY_SYNTAX for invalid SQL", async () => {
    const stmt = conn.createStatement();
    try {
      await stmt.executeQuery("SELEKT * FROM nonexistent");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const qe = err as { code: string; sql: string; name: string };
      expect(qe.name).toBe("QueryError");
      expect(qe.code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("throws QueryError with QUERY_SYNTAX for undefined table", async () => {
    const stmt = conn.createStatement();
    try {
      await stmt.executeQuery("SELECT * FROM table_that_does_not_exist");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const qe = err as { code: string; name: string };
      expect(qe.name).toBe("QueryError");
      expect(qe.code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("throws QueryError with QUERY_CONSTRAINT for NOT NULL violation", async () => {
    const ps = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email) VALUES ($1, $2)`);
    ps.setParameter(1, null as unknown as string);
    ps.setParameter(2, "test@example.com");
    try {
      await ps.executeUpdate();
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const qe = err as { code: string; name: string };
      expect(qe.name).toBe("QueryError");
      expect(qe.code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("throws QueryError with QUERY_CONSTRAINT for UNIQUE violation", async () => {
    const ps1 = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email) VALUES ($1, $2)`);
    ps1.setParameter(1, "UniqueUser");
    ps1.setParameter(2, "unique@example.com");
    await ps1.executeUpdate();

    const ps2 = conn.prepareStatement(`INSERT INTO ${TABLE} (name, email) VALUES ($1, $2)`);
    ps2.setParameter(1, "AnotherUser");
    ps2.setParameter(2, "unique@example.com");
    try {
      await ps2.executeUpdate();
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const qe = err as { code: string; name: string };
      expect(qe.name).toBe("QueryError");
      expect(qe.code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("throws QueryError with QUERY_CONSTRAINT for CHECK violation", async () => {
    const ps = conn.prepareStatement(`INSERT INTO ${TABLE} (name, age) VALUES ($1, $2)`);
    ps.setParameter(1, "NegativeAge");
    ps.setParameter(2, -1);
    try {
      await ps.executeUpdate();
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const qe = err as { code: string; name: string };
      expect(qe.name).toBe("QueryError");
      expect(qe.code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("returns empty ResultSet for query with no matches", async () => {
    const ps = conn.prepareStatement(`SELECT * FROM ${TABLE} WHERE name = $1`);
    ps.setParameter(1, "NobodyHasThisName_xyz");
    const rs = await ps.executeQuery();
    expect(await rs.next()).toBe(false);
  });

  it("returns 0 rowCount for update affecting no rows", async () => {
    const ps = conn.prepareStatement(`UPDATE ${TABLE} SET age = $1 WHERE name = $2`);
    ps.setParameter(1, 100);
    ps.setParameter(2, "NobodyHasThisName_xyz");
    const count = await ps.executeUpdate();
    expect(count).toBe(0);
  });

  it("returns 0 rowCount for delete affecting no rows", async () => {
    const ps = conn.prepareStatement(`DELETE FROM ${TABLE} WHERE name = $1`);
    ps.setParameter(1, "NobodyHasThisName_xyz");
    const count = await ps.executeUpdate();
    expect(count).toBe(0);
  });

  it("preserves connection after query error", async () => {
    const stmt = conn.createStatement();
    try {
      await stmt.executeQuery("INVALID SQL QUERY");
    } catch {
      // expected
    }
    // Connection should still work
    const rs = await stmt.executeQuery("SELECT 1 AS val");
    expect(await rs.next()).toBe(true);
    expect(rs.getNumber("val")).toBe(1);
  });
});
