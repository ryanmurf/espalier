import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { MysqlDataSource } from "../../mysql-data-source.js";
import { MysqlSchemaIntrospector } from "../../mysql-schema-introspector.js";
import {
  createTestDataSource,
  isMysqlAvailable,
  dropTestTable,
} from "./setup.js";

const TABLE = "e2e_introspect_test";
const canConnect = await isMysqlAvailable();

describe.skipIf(!canConnect)("E2E: MySQL schema introspection", { timeout: 10000 }, () => {
  let ds: MysqlDataSource;
  let conn: Connection;
  let introspector: MysqlSchemaIntrospector;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable(TABLE));
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        age INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    introspector = new MysqlSchemaIntrospector(conn);
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

  it("getTables returns the test table", async () => {
    const tables = await introspector.getTables();
    const tableNames = tables.map((t) => t.tableName);
    expect(tableNames).toContain(TABLE);
  });

  it("getColumns returns columns with correct metadata", async () => {
    const columns = await introspector.getColumns(TABLE);

    expect(columns.length).toBe(5);

    const id = columns.find((c) => c.columnName === "id")!;
    expect(id).toBeDefined();
    expect(id.primaryKey).toBe(true);
    expect(id.nullable).toBe(false);

    const name = columns.find((c) => c.columnName === "name")!;
    expect(name).toBeDefined();
    expect(name.nullable).toBe(false);
    expect(name.maxLength).toBe(255);

    const email = columns.find((c) => c.columnName === "email")!;
    expect(email).toBeDefined();
    expect(email.nullable).toBe(true);
    expect(email.unique).toBe(true);

    const age = columns.find((c) => c.columnName === "age")!;
    expect(age).toBeDefined();
    expect(age.nullable).toBe(true);
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
    const exists = await introspector.tableExists("nonexistent_table_xyz");
    expect(exists).toBe(false);
  });
});
