import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { SqliteDataSource } from "../../sqlite-data-source.js";
import { createTestDataSource, dropTestTable, isSqliteAvailable } from "./setup.js";

const TABLE = "e2e_data_types";

describe.skipIf(!isSqliteAvailable)("E2E: SQLite data types", () => {
  let ds: SqliteDataSource;
  let conn: Connection;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        int_col INTEGER,
        real_col REAL,
        text_col TEXT,
        blob_col BLOB
      )
    `);
  });

  afterAll(async () => {
    if (conn && !conn.isClosed()) {
      await conn.close();
    }
    if (ds) {
      await ds.close();
    }
  });

  it("handles INTEGER values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (int_col) VALUES ($1)`,
    );
    ps.setParameter(1, 42);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT int_col FROM ${TABLE} WHERE int_col = 42`,
    );
    await rs.next();
    expect(rs.getNumber("int_col")).toBe(42);
  });

  it("handles REAL values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (real_col) VALUES ($1)`,
    );
    ps.setParameter(1, 3.14159);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT real_col FROM ${TABLE} WHERE real_col > 3.14`,
    );
    await rs.next();
    expect(rs.getNumber("real_col")).toBeCloseTo(3.14159, 4);
  });

  it("handles TEXT values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (text_col) VALUES ($1)`,
    );
    ps.setParameter(1, "hello world");
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT text_col FROM ${TABLE} WHERE text_col = 'hello world'`,
    );
    await rs.next();
    expect(rs.getString("text_col")).toBe("hello world");
  });

  it("handles large TEXT values", async () => {
    const longText = "a".repeat(10000);
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (text_col) VALUES ($1)`,
    );
    ps.setParameter(1, longText);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT text_col FROM ${TABLE} WHERE LENGTH(text_col) = 10000`,
    );
    await rs.next();
    expect(rs.getString("text_col")).toBe(longText);
  });

  it("handles NULL values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (int_col, real_col, text_col) VALUES ($1, $2, $3)`,
    );
    ps.setParameter(1, null);
    ps.setParameter(2, null);
    ps.setParameter(3, null);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT * FROM ${TABLE} WHERE int_col IS NULL AND real_col IS NULL AND text_col IS NULL ORDER BY id DESC LIMIT 1`,
    );
    await rs.next();
    expect(rs.getNumber("int_col")).toBeNull();
    expect(rs.getNumber("real_col")).toBeNull();
    expect(rs.getString("text_col")).toBeNull();
  });

  it("demonstrates SQLite type affinity (dynamic typing)", async () => {
    // SQLite allows storing text in INTEGER column
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (int_col) VALUES ($1)`,
    );
    ps.setParameter(1, "not_a_number" as unknown as number);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT int_col FROM ${TABLE} WHERE typeof(int_col) = 'text' LIMIT 1`,
    );
    await rs.next();
    expect(rs.getString("int_col")).toBe("not_a_number");
  });
});
