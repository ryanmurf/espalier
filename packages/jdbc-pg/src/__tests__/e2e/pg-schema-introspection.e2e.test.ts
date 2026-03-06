import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { PgSchemaIntrospector } from "../../pg-schema-introspector.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("PgSchemaIntrospector E2E", () => {
  let ds: PgDataSource;
  let conn: Connection;
  let introspector: PgSchemaIntrospector;

  const TABLE_BASIC = "test_introspect_basic";
  const TABLE_COMPOSITE_PK = "test_introspect_composite_pk";
  const TABLE_UNIQUE = "test_introspect_unique";
  const TABLE_EMPTY = "test_introspect_empty";
  const CUSTOM_SCHEMA = "test_introspect_schema";
  const TABLE_IN_SCHEMA = "test_introspect_in_schema";

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    introspector = new PgSchemaIntrospector(conn);

    const stmt = conn.createStatement();

    // Drop in reverse dependency order
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${CUSTOM_SCHEMA}.${TABLE_IN_SCHEMA} CASCADE`);
    await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${CUSTOM_SCHEMA} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_EMPTY} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_UNIQUE} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_COMPOSITE_PK} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_BASIC} CASCADE`);

    // Table with various column types
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_BASIC} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email VARCHAR(255),
        age INT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Table with composite primary key
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_COMPOSITE_PK} (
        tenant_id INT NOT NULL,
        user_id INT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      )
    `);

    // Table with unique constraints
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_UNIQUE} (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        display_name TEXT
      )
    `);

    // Empty table (no rows, but has columns)
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_EMPTY} (
        id SERIAL PRIMARY KEY,
        data TEXT
      )
    `);

    // Custom schema with a table
    await stmt.executeUpdate(`CREATE SCHEMA IF NOT EXISTS ${CUSTOM_SCHEMA}`);
    await stmt.executeUpdate(`
      CREATE TABLE ${CUSTOM_SCHEMA}.${TABLE_IN_SCHEMA} (
        id SERIAL PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${CUSTOM_SCHEMA}.${TABLE_IN_SCHEMA} CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${CUSTOM_SCHEMA} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_EMPTY} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_UNIQUE} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_COMPOSITE_PK} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_BASIC} CASCADE`);
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  describe("getTables", () => {
    it("should return known test tables in the public schema", async () => {
      const tables = await introspector.getTables();
      const tableNames = tables.map((t) => t.tableName);

      expect(tableNames).toContain(TABLE_BASIC);
      expect(tableNames).toContain(TABLE_COMPOSITE_PK);
      expect(tableNames).toContain(TABLE_UNIQUE);
      expect(tableNames).toContain(TABLE_EMPTY);

      // All should be in the public schema
      for (const table of tables) {
        expect(table.schema).toBe("public");
      }
    });

    it("should not return tables from other schemas in default query", async () => {
      const tables = await introspector.getTables();
      const tableNames = tables.map((t) => t.tableName);
      expect(tableNames).not.toContain(TABLE_IN_SCHEMA);
    });

    it("should return tables from a custom schema when specified", async () => {
      const tables = await introspector.getTables(CUSTOM_SCHEMA);
      const tableNames = tables.map((t) => t.tableName);

      expect(tableNames).toContain(TABLE_IN_SCHEMA);
      expect(tables.length).toBeGreaterThanOrEqual(1);

      const schemaTable = tables.find((t) => t.tableName === TABLE_IN_SCHEMA);
      expect(schemaTable?.schema).toBe(CUSTOM_SCHEMA);
    });
  });

  describe("getColumns", () => {
    it("should return correct column metadata for basic table", async () => {
      const columns = await introspector.getColumns(TABLE_BASIC);

      expect(columns).toHaveLength(6);

      const id = columns.find((c) => c.columnName === "id")!;
      expect(id.dataType).toBe("integer");
      expect(id.nullable).toBe(false);
      expect(id.primaryKey).toBe(true);
      expect(id.defaultValue).toMatch(/nextval/);

      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.dataType).toBe("text");
      expect(name.nullable).toBe(false);
      expect(name.primaryKey).toBe(false);

      const email = columns.find((c) => c.columnName === "email")!;
      expect(email.dataType).toBe("character varying");
      expect(email.nullable).toBe(true);
      expect(email.maxLength).toBe(255);

      const age = columns.find((c) => c.columnName === "age")!;
      expect(age.dataType).toBe("integer");
      expect(age.nullable).toBe(true);
      expect(age.defaultValue).toBeNull();

      const isActive = columns.find((c) => c.columnName === "is_active")!;
      expect(isActive.dataType).toBe("boolean");
      expect(isActive.nullable).toBe(true);
      expect(isActive.defaultValue).toBe("true");

      const createdAt = columns.find((c) => c.columnName === "created_at")!;
      expect(createdAt.dataType).toBe("timestamp with time zone");
      expect(createdAt.nullable).toBe(true);
      expect(createdAt.defaultValue).toMatch(/now/i);
    });

    it("should return columns in ordinal position order", async () => {
      const columns = await introspector.getColumns(TABLE_BASIC);
      const names = columns.map((c) => c.columnName);
      expect(names).toEqual(["id", "name", "email", "age", "is_active", "created_at"]);
    });

    it("should correctly report nullable vs NOT NULL columns", async () => {
      const columns = await introspector.getColumns(TABLE_BASIC);

      const notNullColumns = columns.filter((c) => !c.nullable).map((c) => c.columnName);
      const nullableColumns = columns.filter((c) => c.nullable).map((c) => c.columnName);

      expect(notNullColumns).toContain("id");
      expect(notNullColumns).toContain("name");
      expect(nullableColumns).toContain("email");
      expect(nullableColumns).toContain("age");
      expect(nullableColumns).toContain("is_active");
      expect(nullableColumns).toContain("created_at");
    });

    it("should return full column metadata for empty table", async () => {
      const columns = await introspector.getColumns(TABLE_EMPTY);

      expect(columns).toHaveLength(2);

      const id = columns.find((c) => c.columnName === "id")!;
      expect(id).toBeDefined();
      expect(id.dataType).toBe("integer");
      expect(id.primaryKey).toBe(true);

      const data = columns.find((c) => c.columnName === "data")!;
      expect(data).toBeDefined();
      expect(data.dataType).toBe("text");
      expect(data.nullable).toBe(true);
    });

    it("should return columns for a table in a custom schema", async () => {
      const columns = await introspector.getColumns(TABLE_IN_SCHEMA, CUSTOM_SCHEMA);

      expect(columns).toHaveLength(2);

      const id = columns.find((c) => c.columnName === "id")!;
      expect(id.primaryKey).toBe(true);

      const value = columns.find((c) => c.columnName === "value")!;
      expect(value.dataType).toBe("text");
      expect(value.nullable).toBe(false);
    });
  });

  describe("getPrimaryKeys", () => {
    it("should return single primary key column", async () => {
      const keys = await introspector.getPrimaryKeys(TABLE_BASIC);
      expect(keys).toEqual(["id"]);
    });

    it("should return composite primary key columns in order", async () => {
      const keys = await introspector.getPrimaryKeys(TABLE_COMPOSITE_PK);
      expect(keys).toHaveLength(2);
      expect(keys).toContain("tenant_id");
      expect(keys).toContain("user_id");
    });

    it("should return empty array for table with no primary key", async () => {
      // Create a temporary table with no PK
      const noPkTable = "test_introspect_no_pk";
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${noPkTable} CASCADE`);
      await stmt.executeUpdate(`CREATE TABLE ${noPkTable} (data TEXT, value INT)`);

      try {
        const keys = await introspector.getPrimaryKeys(noPkTable);
        expect(keys).toEqual([]);
      } finally {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${noPkTable} CASCADE`);
      }
    });
  });

  describe("unique constraints", () => {
    it("should correctly report unique columns", async () => {
      const columns = await introspector.getColumns(TABLE_UNIQUE);

      const username = columns.find((c) => c.columnName === "username")!;
      expect(username.unique).toBe(true);

      const email = columns.find((c) => c.columnName === "email")!;
      expect(email.unique).toBe(true);

      const displayName = columns.find((c) => c.columnName === "display_name")!;
      expect(displayName.unique).toBe(false);
    });

    it("should not flag non-unique columns as unique", async () => {
      const columns = await introspector.getColumns(TABLE_BASIC);

      // name is NOT NULL but not UNIQUE
      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.unique).toBe(false);

      // age is nullable and not unique
      const age = columns.find((c) => c.columnName === "age")!;
      expect(age.unique).toBe(false);
    });
  });

  describe("tableExists", () => {
    it("should return true for an existing table", async () => {
      const exists = await introspector.tableExists(TABLE_BASIC);
      expect(exists).toBe(true);
    });

    it("should return false for a non-existent table", async () => {
      const exists = await introspector.tableExists("this_table_does_not_exist_xyz");
      expect(exists).toBe(false);
    });

    it("should respect the schema parameter", async () => {
      // Table exists in custom schema
      const existsInCustom = await introspector.tableExists(TABLE_IN_SCHEMA, CUSTOM_SCHEMA);
      expect(existsInCustom).toBe(true);

      // Same table name does NOT exist in public
      const existsInPublic = await introspector.tableExists(TABLE_IN_SCHEMA);
      expect(existsInPublic).toBe(false);
    });
  });
});
