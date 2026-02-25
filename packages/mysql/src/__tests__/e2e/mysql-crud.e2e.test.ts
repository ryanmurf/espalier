import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { MysqlDataSource } from "../../mysql-data-source.js";
import {
  createTestDataSource,
  isMysqlAvailable,
  testTableDDL,
  dropTestTable,
} from "./setup.js";

const TABLE = "e2e_crud_users";
const canConnect = await isMysqlAvailable();

describe.skipIf(!canConnect)("E2E: MySQL CRUD operations", { timeout: 10000 }, () => {
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

  it("inserts a row with PreparedStatement and returns rowCount", async () => {
    const ps = conn.prepareStatement(
      `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
    );
    ps.setParameter(1, "Alice");
    ps.setParameter(2, "alice@example.com");
    ps.setParameter(3, 30);
    const count = await ps.executeUpdate();
    expect(count).toBe(1);
  });

  it("selects all rows with Statement", async () => {
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE}`);

    const hasRow = await rs.next();
    expect(hasRow).toBe(true);
    expect(rs.getString("name")).toBe("Alice");
    expect(rs.getString("email")).toBe("alice@example.com");
    expect(rs.getNumber("age")).toBe(30);
    expect(rs.getDate("created_at")).toBeInstanceOf(Date);
  });

  it("selects with parameterized PreparedStatement", async () => {
    const ps = conn.prepareStatement(
      `SELECT * FROM ${TABLE} WHERE name = $1`,
    );
    ps.setParameter(1, "Alice");
    const rs = await ps.executeQuery();

    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("Alice");
    expect(await rs.next()).toBe(false);
  });

  it("updates a row and verifies the change", async () => {
    const ps = conn.prepareStatement(
      `UPDATE ${TABLE} SET age = $1 WHERE name = $2`,
    );
    ps.setParameter(1, 31);
    ps.setParameter(2, "Alice");
    const count = await ps.executeUpdate();
    expect(count).toBe(1);

    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT age FROM ${TABLE} WHERE name = 'Alice'`,
    );
    await rs.next();
    expect(rs.getNumber("age")).toBe(31);
  });

  it("deletes a row and verifies absence", async () => {
    const insertPs = conn.prepareStatement(
      `INSERT INTO ${TABLE} (name, email, age) VALUES ($1, $2, $3)`,
    );
    insertPs.setParameter(1, "ToDelete");
    insertPs.setParameter(2, "delete@example.com");
    insertPs.setParameter(3, 99);
    await insertPs.executeUpdate();

    const deletePs = conn.prepareStatement(
      `DELETE FROM ${TABLE} WHERE name = $1`,
    );
    deletePs.setParameter(1, "ToDelete");
    const count = await deletePs.executeUpdate();
    expect(count).toBe(1);

    const checkPs = conn.prepareStatement(
      `SELECT * FROM ${TABLE} WHERE name = $1`,
    );
    checkPs.setParameter(1, "ToDelete");
    const rs = await checkPs.executeQuery();
    expect(await rs.next()).toBe(false);
  });

  it("returns ResultSet metadata for the test table", async () => {
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} LIMIT 1`);
    const meta = rs.getMetadata();

    expect(meta.length).toBeGreaterThanOrEqual(5);
    const names = meta.map((m) => m.name);
    expect(names).toContain("id");
    expect(names).toContain("name");
    expect(names).toContain("email");
    expect(names).toContain("age");
    expect(names).toContain("created_at");
  });

  it("supports async iteration over ResultSet", async () => {
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE}`);

    const rows: Record<string, unknown>[] = [];
    for await (const row of rs) {
      rows.push(row);
    }
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty("name");
  });

  it("returns getRow() for the current row", async () => {
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT name, age FROM ${TABLE} LIMIT 1`,
    );
    await rs.next();
    const row = rs.getRow();
    expect(row).toHaveProperty("name");
    expect(row).toHaveProperty("age");
  });

  it("getString by column index works", async () => {
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT name FROM ${TABLE} LIMIT 1`,
    );
    await rs.next();
    expect(rs.getString(0)).toBe("Alice");
  });
});
