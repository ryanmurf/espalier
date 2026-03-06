import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgConnection } from "../../pg-connection.js";
import type { PgDataSource } from "../../pg-data-source.js";
import type { PgStatement } from "../../pg-statement.js";
import { createTestDataSource, dropTestTable, isPostgresAvailable } from "./setup.js";

const TABLE = "e2e_streaming";
const ROW_COUNT = 1000;
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("E2E: Streaming/cursor-based ResultSet", { timeout: 30000 }, () => {
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
          value INT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

    // Seed 1000 rows using batch insert
    const batch = conn.prepareBatchStatement(`INSERT INTO ${TABLE} (name, value) VALUES ($1, $2)`);
    for (let i = 0; i < ROW_COUNT; i++) {
      batch.setParameter(1, `Row_${i}`);
      batch.setParameter(2, i);
      batch.addBatch();
    }
    await batch.executeBatch();
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

  function getStreamingStatement(): PgStatement {
    return conn.createStatement() as PgStatement;
  }

  it("streams all 1000 rows via cursor", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE} ORDER BY id`);

    let count = 0;
    while (await rs.next()) {
      count++;
    }
    expect(count).toBe(ROW_COUNT);
    await rs.close();
  });

  it("streams with custom cursor size (small batches)", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE} ORDER BY id`);
    rs.setCursorSize(10);

    let count = 0;
    while (await rs.next()) {
      count++;
    }
    expect(count).toBe(ROW_COUNT);
    await rs.close();
  });

  it("reads data correctly via getString and getNumber", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT name, value FROM ${TABLE} ORDER BY id LIMIT 5`);
    rs.setCursorSize(2);

    const rows: { name: string | null; value: number | null }[] = [];
    while (await rs.next()) {
      rows.push({
        name: rs.getString("name"),
        value: rs.getNumber("value"),
      });
    }
    expect(rows.length).toBe(5);
    expect(rows[0].name).toBe("Row_0");
    expect(rows[0].value).toBe(0);
    expect(rows[4].name).toBe("Row_4");
    expect(rows[4].value).toBe(4);
    await rs.close();
  });

  it("getRow returns current row object", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT name, value FROM ${TABLE} ORDER BY id LIMIT 1`);

    expect(await rs.next()).toBe(true);
    const row = rs.getRow();
    expect(row).toHaveProperty("name", "Row_0");
    expect(row).toHaveProperty("value", 0);
    await rs.close();
  });

  it("getDate reads timestamptz correctly", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT created_at FROM ${TABLE} ORDER BY id LIMIT 1`);

    expect(await rs.next()).toBe(true);
    const date = rs.getDate("created_at");
    expect(date).toBeInstanceOf(Date);
    await rs.close();
  });

  it("getString by column index works", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT name FROM ${TABLE} ORDER BY id LIMIT 1`);

    expect(await rs.next()).toBe(true);
    expect(rs.getString(0)).toBe("Row_0");
    await rs.close();
  });

  it("getMetadata returns column info from buffered row", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT name, value FROM ${TABLE} LIMIT 1`);

    // Need to read at least one row for metadata
    await rs.next();
    const meta = rs.getMetadata();
    expect(meta.length).toBe(2);
    const names = meta.map((m) => m.name);
    expect(names).toContain("name");
    expect(names).toContain("value");
    await rs.close();
  });

  it("async iteration over streaming result set", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT name, value FROM ${TABLE} ORDER BY id LIMIT 50`);
    rs.setCursorSize(10);

    const rows: Record<string, unknown>[] = [];
    for await (const row of rs) {
      rows.push(row);
    }
    expect(rows.length).toBe(50);
    expect(rows[0]).toHaveProperty("name", "Row_0");
    expect(rows[49]).toHaveProperty("name", "Row_49");
    await rs.close();
  });

  it("close cursor mid-stream (early termination)", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE} ORDER BY id`);
    rs.setCursorSize(10);

    // Read only 25 rows then close
    let count = 0;
    while (await rs.next()) {
      count++;
      if (count >= 25) break;
    }
    expect(count).toBe(25);

    // Close should not throw even with unconsumed rows
    await rs.close();
  });

  it("empty result returns false on first next()", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE} WHERE name = 'NONEXISTENT'`);

    expect(await rs.next()).toBe(false);
    await rs.close();
  });

  it("streaming with cursor size 1 (row-by-row)", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT value FROM ${TABLE} ORDER BY id LIMIT 10`);
    rs.setCursorSize(1);

    const values: number[] = [];
    while (await rs.next()) {
      values.push(rs.getNumber("value")!);
    }
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await rs.close();
  });

  it("streaming with large cursor size (larger than result)", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT value FROM ${TABLE} ORDER BY id LIMIT 5`);
    rs.setCursorSize(1000);

    let count = 0;
    while (await rs.next()) {
      count++;
    }
    expect(count).toBe(5);
    await rs.close();
  });

  it("streams 1000 rows with tiny cursor size (memory stability)", async () => {
    const stmt = getStreamingStatement();
    const rs = await stmt.executeStreamingQuery(`SELECT * FROM ${TABLE} ORDER BY id`);
    rs.setCursorSize(5);

    let count = 0;
    let lastValue = -1;
    while (await rs.next()) {
      const val = rs.getNumber("value")!;
      expect(val).toBe(lastValue + 1);
      lastValue = val;
      count++;
    }
    expect(count).toBe(ROW_COUNT);
    await rs.close();
  });
});
