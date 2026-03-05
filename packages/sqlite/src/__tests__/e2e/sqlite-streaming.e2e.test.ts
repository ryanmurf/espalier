import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { SqliteDataSource } from "../../sqlite-data-source.js";
import type { SqliteStatement } from "../../sqlite-statement.js";
import { createTestDataSource, dropTestTable, isSqliteAvailable } from "./setup.js";

const TABLE = "e2e_streaming_test";

describe.skipIf(!isSqliteAvailable)("E2E: SQLite streaming/cursor result set", () => {
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
        value TEXT NOT NULL
      )
    `);

    // Insert test rows
    for (let i = 1; i <= 100; i++) {
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (value) VALUES ($1)`,
      );
      ps.setParameter(1, `row_${i}`);
      await ps.executeUpdate();
    }
  });

  afterAll(async () => {
    if (conn && !conn.isClosed()) {
      await conn.close();
    }
    if (ds) {
      await ds.close();
    }
  });

  it("streams all rows via iterate()", async () => {
    const stmt = conn.createStatement() as SqliteStatement;
    const rs = await stmt.executeStreamingQuery(
      `SELECT * FROM ${TABLE} ORDER BY id`,
    );

    const rows: Record<string, unknown>[] = [];
    while (await rs.next()) {
      rows.push(rs.getRow());
    }

    expect(rows).toHaveLength(100);
    expect(rows[0]).toHaveProperty("id");
    expect(rows[0]).toHaveProperty("value");
    expect(rs.getString("value")).toBeNull(); // past end
  });

  it("supports async iteration over streaming result set", async () => {
    const stmt = conn.createStatement() as SqliteStatement;
    const rs = await stmt.executeStreamingQuery(
      `SELECT * FROM ${TABLE} ORDER BY id LIMIT 10`,
    );

    const rows: Record<string, unknown>[] = [];
    for await (const row of rs) {
      rows.push(row);
    }

    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveProperty("value", "row_1");
  });

  it("returns metadata from streaming result set", async () => {
    const stmt = conn.createStatement() as SqliteStatement;
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE}`);

    const meta = rs.getMetadata();
    expect(meta.length).toBe(2);
    const names = meta.map((m) => m.name);
    expect(names).toContain("id");
    expect(names).toContain("value");
    await rs.close();
  });

  it("close() stops iteration", async () => {
    const stmt = conn.createStatement() as SqliteStatement;
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE}`);

    // Read a few rows
    await rs.next();
    await rs.next();
    await rs.close();

    // After close, next returns false
    expect(await rs.next()).toBe(false);
  });

  it("setCursorSize can be set", async () => {
    const stmt = conn.createStatement() as SqliteStatement;
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE}`);
    rs.setCursorSize(10);
    // Just verify it doesn't throw
    await rs.close();
  });
});
