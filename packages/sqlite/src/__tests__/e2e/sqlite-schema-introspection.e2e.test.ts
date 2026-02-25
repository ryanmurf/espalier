import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { SqliteDataSource } from "../../sqlite-data-source.js";
import { SqliteSchemaIntrospector } from "../../sqlite-schema-introspector.js";
import { createTestDataSource, dropTestTable } from "./setup.js";

const TABLE = "e2e_introspect_test";

describe("E2E: SQLite schema introspection", () => {
  let ds: SqliteDataSource;
  let conn: Connection;
  let introspector: SqliteSchemaIntrospector;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        age INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    introspector = new SqliteSchemaIntrospector(conn);
  });

  afterAll(async () => {
    if (conn && !conn.isClosed()) {
      await conn.close();
    }
    if (ds) {
      await ds.close();
    }
  });

  it("getTables returns the test table", async () => {
    const tables = await introspector.getTables();
    const tableNames = tables.map((t) => t.tableName);
    expect(tableNames).toContain(TABLE);
  });

  it("getTables does not return sqlite internal tables", async () => {
    const tables = await introspector.getTables();
    const tableNames = tables.map((t) => t.tableName);
    for (const name of tableNames) {
      expect(name).not.toMatch(/^sqlite_/);
    }
  });

  it("getColumns returns columns with correct metadata", async () => {
    const columns = await introspector.getColumns(TABLE);

    expect(columns.length).toBe(5);

    const id = columns.find((c) => c.columnName === "id")!;
    expect(id).toBeDefined();
    expect(id.primaryKey).toBe(true);

    const name = columns.find((c) => c.columnName === "name")!;
    expect(name).toBeDefined();
    expect(name.nullable).toBe(false);
    expect(name.dataType).toBe("TEXT");

    const email = columns.find((c) => c.columnName === "email")!;
    expect(email).toBeDefined();
    expect(email.nullable).toBe(true);
    expect(email.unique).toBe(true);

    const age = columns.find((c) => c.columnName === "age")!;
    expect(age).toBeDefined();
    expect(age.nullable).toBe(true);
    expect(age.dataType).toBe("INTEGER");
  });

  it("getPrimaryKeys returns the id column", async () => {
    const keys = await introspector.getPrimaryKeys(TABLE);
    expect(keys).toEqual(["id"]);
  });

  it("tableExists returns true for existing table", async () => {
    const exists = await introspector.tableExists(TABLE);
    expect(exists).toBe(true);
  });

  it("tableExists returns false for non-existing table", async () => {
    const exists = await introspector.tableExists("nonexistent_xyz");
    expect(exists).toBe(false);
  });
});
