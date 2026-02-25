import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connection, PreparedStatement, ResultSet } from "espalier-jdbc";
import { PgSchemaIntrospector } from "../pg-schema-introspector.js";

function createMockResultSet(rows: Record<string, unknown>[]): ResultSet {
  let index = -1;
  return {
    async next() {
      index++;
      return index < rows.length;
    },
    getString(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val == null ? null : String(val);
    },
    getNumber(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val == null ? null : Number(val);
    },
    getBoolean(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val == null ? null : Boolean(val);
    },
    getDate() {
      return null;
    },
    getRow() {
      return rows[index] ?? {};
    },
    getMetadata() {
      return [];
    },
    async close() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          index++;
          if (index < rows.length) {
            return { value: rows[index], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function createMockPreparedStatement(
  rs: ResultSet,
): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  } as unknown as PreparedStatement;
}

function createMockConnection(psFactory: () => PreparedStatement): Connection {
  return {
    prepareStatement: vi.fn((_sql: string) => psFactory()),
    createStatement: vi.fn(),
    beginTransaction: vi.fn(),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  } as unknown as Connection;
}

describe("PgSchemaIntrospector", () => {
  describe("getTables()", () => {
    it("returns tables from the public schema by default", async () => {
      const rs = createMockResultSet([
        { table_name: "users", table_schema: "public" },
        { table_name: "orders", table_schema: "public" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const tables = await introspector.getTables();

      expect(tables).toEqual([
        { tableName: "users", schema: "public" },
        { tableName: "orders", schema: "public" },
      ]);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "public");
    });

    it("accepts a custom schema", async () => {
      const rs = createMockResultSet([
        { table_name: "items", table_schema: "inventory" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const tables = await introspector.getTables("inventory");

      expect(tables).toEqual([
        { tableName: "items", schema: "inventory" },
      ]);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "inventory");
    });

    it("returns empty array when no tables found", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const tables = await introspector.getTables();
      expect(tables).toEqual([]);
    });

    it("queries information_schema.tables with correct SQL", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      await introspector.getTables();

      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("information_schema.tables"),
      );
      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("BASE TABLE"),
      );
    });
  });

  describe("getColumns()", () => {
    let callCount: number;
    let psList: PreparedStatement[];

    beforeEach(() => {
      callCount = 0;
      psList = [];
    });

    function setupMultiQueryConn(resultSets: ResultSet[]): Connection {
      const statements = resultSets.map((rs) => createMockPreparedStatement(rs));
      psList = statements;
      return createMockConnection(() => {
        const ps = statements[callCount];
        callCount++;
        return ps;
      });
    }

    it("returns columns with metadata including pk and unique info", async () => {
      // Call order: getPrimaryKeys, getUniqueColumns, getColumns
      const pkRs = createMockResultSet([{ column_name: "id" }]);
      const uniqueRs = createMockResultSet([{ column_name: "email" }]);
      const colRs = createMockResultSet([
        {
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "nextval('users_id_seq'::regclass)",
          character_maximum_length: null,
        },
        {
          column_name: "name",
          data_type: "character varying",
          is_nullable: "NO",
          column_default: null,
          character_maximum_length: 255,
        },
        {
          column_name: "email",
          data_type: "character varying",
          is_nullable: "YES",
          column_default: null,
          character_maximum_length: 255,
        },
      ]);

      const conn = setupMultiQueryConn([pkRs, uniqueRs, colRs]);
      const introspector = new PgSchemaIntrospector(conn);

      const columns = await introspector.getColumns("users");

      expect(columns).toEqual([
        {
          columnName: "id",
          dataType: "integer",
          nullable: false,
          defaultValue: "nextval('users_id_seq'::regclass)",
          primaryKey: true,
          unique: false,
          maxLength: null,
        },
        {
          columnName: "name",
          dataType: "character varying",
          nullable: false,
          defaultValue: null,
          primaryKey: false,
          unique: false,
          maxLength: 255,
        },
        {
          columnName: "email",
          dataType: "character varying",
          nullable: true,
          defaultValue: null,
          primaryKey: false,
          unique: true,
          maxLength: 255,
        },
      ]);
    });

    it("uses parameterized queries for table name and schema", async () => {
      const pkRs = createMockResultSet([]);
      const uniqueRs = createMockResultSet([]);
      const colRs = createMockResultSet([]);

      const conn = setupMultiQueryConn([pkRs, uniqueRs, colRs]);
      const introspector = new PgSchemaIntrospector(conn);

      await introspector.getColumns("users", "myschema");

      // All 3 prepared statements should set tableName and schema via params
      for (const ps of psList) {
        expect(ps.setParameter).toHaveBeenCalledWith(1, "users");
        expect(ps.setParameter).toHaveBeenCalledWith(2, "myschema");
      }
    });

    it("returns empty array for non-existent table", async () => {
      const pkRs = createMockResultSet([]);
      const uniqueRs = createMockResultSet([]);
      const colRs = createMockResultSet([]);

      const conn = setupMultiQueryConn([pkRs, uniqueRs, colRs]);
      const introspector = new PgSchemaIntrospector(conn);

      const columns = await introspector.getColumns("nonexistent");
      expect(columns).toEqual([]);
    });
  });

  describe("getPrimaryKeys()", () => {
    it("returns primary key column names", async () => {
      const rs = createMockResultSet([
        { column_name: "id" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const keys = await introspector.getPrimaryKeys("users");

      expect(keys).toEqual(["id"]);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "users");
      expect(ps.setParameter).toHaveBeenCalledWith(2, "public");
    });

    it("returns multiple keys for composite primary key", async () => {
      const rs = createMockResultSet([
        { column_name: "user_id" },
        { column_name: "role_id" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const keys = await introspector.getPrimaryKeys("user_roles");
      expect(keys).toEqual(["user_id", "role_id"]);
    });

    it("returns empty array when no primary key", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const keys = await introspector.getPrimaryKeys("no_pk_table");
      expect(keys).toEqual([]);
    });

    it("queries table_constraints joined with key_column_usage", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      await introspector.getPrimaryKeys("users");

      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("table_constraints"),
      );
      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("key_column_usage"),
      );
      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("PRIMARY KEY"),
      );
    });
  });

  describe("tableExists()", () => {
    it("returns true when table exists", async () => {
      const rs = createMockResultSet([{ "?column?": 1 }]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const exists = await introspector.tableExists("users");

      expect(exists).toBe(true);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "users");
      expect(ps.setParameter).toHaveBeenCalledWith(2, "public");
    });

    it("returns false when table does not exist", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      const exists = await introspector.tableExists("nonexistent");
      expect(exists).toBe(false);
    });

    it("accepts a custom schema", async () => {
      const rs = createMockResultSet([{ "?column?": 1 }]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      await introspector.tableExists("items", "inventory");

      expect(ps.setParameter).toHaveBeenCalledWith(1, "items");
      expect(ps.setParameter).toHaveBeenCalledWith(2, "inventory");
    });

    it("queries information_schema.tables", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => ps);
      const introspector = new PgSchemaIntrospector(conn);

      await introspector.tableExists("users");

      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("information_schema.tables"),
      );
    });
  });
});
