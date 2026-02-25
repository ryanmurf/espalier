import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { MysqlDataSource } from "../../mysql-data-source.js";
import { createTestDataSource, isMysqlAvailable, dropTestTable } from "./setup.js";

const TABLE = "e2e_data_types";
const canConnect = await isMysqlAvailable();

describe.skipIf(!canConnect)("E2E: MySQL data types", { timeout: 10000 }, () => {
  let ds: MysqlDataSource;
  let conn: Connection;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        int_col INT,
        bigint_col BIGINT,
        varchar_col VARCHAR(255),
        text_col TEXT,
        datetime_col DATETIME,
        decimal_col DECIMAL(10, 2),
        bool_col TINYINT(1),
        blob_col BLOB,
        json_col JSON
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

  it("handles INT values", async () => {
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

  it("handles VARCHAR values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (varchar_col) VALUES ($1)`,
    );
    ps.setParameter(1, "hello world");
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT varchar_col FROM ${TABLE} WHERE varchar_col = 'hello world'`,
    );
    await rs.next();
    expect(rs.getString("varchar_col")).toBe("hello world");
  });

  it("handles TEXT values", async () => {
    const longText = "a".repeat(1000);
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (text_col) VALUES ($1)`,
    );
    ps.setParameter(1, longText);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT text_col FROM ${TABLE} WHERE LENGTH(text_col) = 1000`,
    );
    await rs.next();
    expect(rs.getString("text_col")).toBe(longText);
  });

  it("handles DATETIME values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (datetime_col) VALUES ($1)`,
    );
    ps.setParameter(1, "2024-06-15 10:30:00");
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT datetime_col FROM ${TABLE} WHERE datetime_col IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    await rs.next();
    const date = rs.getDate("datetime_col");
    expect(date).toBeInstanceOf(Date);
  });

  it("handles DECIMAL values", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (decimal_col) VALUES ($1)`,
    );
    ps.setParameter(1, 99.99);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT decimal_col FROM ${TABLE} WHERE decimal_col = 99.99`,
    );
    await rs.next();
    const val = rs.getNumber("decimal_col");
    expect(val).toBeCloseTo(99.99, 2);
  });

  it("handles TINYINT(1) as BOOLEAN", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (bool_col) VALUES ($1)`,
    );
    ps.setParameter(1, 1);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT bool_col FROM ${TABLE} WHERE bool_col = 1 LIMIT 1`,
    );
    await rs.next();
    expect(rs.getBoolean("bool_col")).toBe(true);
  });

  it("handles JSON values", async () => {
    const jsonValue = JSON.stringify({ key: "value", nested: { a: 1 } });
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (json_col) VALUES ($1)`,
    );
    ps.setParameter(1, jsonValue);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT json_col FROM ${TABLE} WHERE json_col IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    await rs.next();
    const retrieved = rs.getString("json_col");
    expect(retrieved).toBeDefined();
    const parsed = JSON.parse(retrieved!);
    expect(parsed.key).toBe("value");
    expect(parsed.nested.a).toBe(1);
  });

  it("handles NULL values across types", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (int_col, varchar_col, datetime_col, decimal_col, bool_col) VALUES ($1, $2, $3, $4, $5)`,
    );
    ps.setParameter(1, null);
    ps.setParameter(2, null);
    ps.setParameter(3, null);
    ps.setParameter(4, null);
    ps.setParameter(5, null);
    await ps.executeUpdate();

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT * FROM ${TABLE} WHERE int_col IS NULL AND varchar_col IS NULL ORDER BY id DESC LIMIT 1`,
    );
    await rs.next();
    expect(rs.getNumber("int_col")).toBeNull();
    expect(rs.getString("varchar_col")).toBeNull();
    expect(rs.getDate("datetime_col")).toBeNull();
    expect(rs.getNumber("decimal_col")).toBeNull();
    expect(rs.getBoolean("bool_col")).toBeNull();
  });
});
