import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connection, PreparedStatement, ResultSet, Statement } from "espalier-jdbc";
import { MysqlSchemaIntrospector } from "../mysql-schema-introspector.js";

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

function createMockStatement(rs?: ResultSet): Statement {
  return {
    executeQuery: vi.fn(async () => rs ?? createMockResultSet([])),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  } as unknown as Statement;
}

function createMockConnection(opts: {
  psFactory?: () => PreparedStatement;
  statement?: Statement;
}): Connection {
  return {
    prepareStatement: vi.fn((_sql: string) =>
      opts.psFactory ? opts.psFactory() : createMockPreparedStatement(createMockResultSet([])),
    ),
    createStatement: vi.fn(() =>
      opts.statement ?? createMockStatement(),
    ),
    beginTransaction: vi.fn(),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  } as unknown as Connection;
}

describe("MysqlSchemaIntrospector", () => {
  describe("getTables()", () => {
    it("returns tables for the given schema", async () => {
      const rs = createMockResultSet([
        { table_name: "users", table_schema: "espalier_test" },
        { table_name: "orders", table_schema: "espalier_test" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const tables = await introspector.getTables("espalier_test");

      expect(tables).toEqual([
        { tableName: "users", schema: "espalier_test" },
        { tableName: "orders", schema: "espalier_test" },
      ]);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "espalier_test");
    });

    it("uses current database when no schema specified", async () => {
      // First call: SELECT DATABASE() for currentDatabase()
      const dbRs = createMockResultSet([{ db: "test_db" }]);
      const dbStmt = createMockStatement(dbRs);

      // Second call: getTables query
      const tablesRs = createMockResultSet([
        { table_name: "items", table_schema: "test_db" },
      ]);
      const tablesPs = createMockPreparedStatement(tablesRs);

      const conn = createMockConnection({
        psFactory: () => tablesPs,
        statement: dbStmt,
      });
      const introspector = new MysqlSchemaIntrospector(conn);

      const tables = await introspector.getTables();

      expect(tables).toEqual([
        { tableName: "items", schema: "test_db" },
      ]);
      expect(tablesPs.setParameter).toHaveBeenCalledWith(1, "test_db");
    });

    it("returns empty array when no tables found", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const tables = await introspector.getTables("empty_db");
      expect(tables).toEqual([]);
    });

    it("queries information_schema.tables with correct SQL", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      await introspector.getTables("test");

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

    function setupMultiQueryConn(
      resultSets: ResultSet[],
      dbRs?: ResultSet,
    ): Connection {
      const statements = resultSets.map((rs) => createMockPreparedStatement(rs));
      psList = statements;
      const dbStmt = createMockStatement(dbRs);
      return {
        prepareStatement: vi.fn((_sql: string) => {
          const ps = statements[callCount];
          callCount++;
          return ps;
        }),
        createStatement: vi.fn(() => dbStmt),
        beginTransaction: vi.fn(),
        close: vi.fn(async () => {}),
        isClosed: vi.fn(() => false),
      } as unknown as Connection;
    }

    it("returns columns with metadata including pk and unique info", async () => {
      // Call order: getPrimaryKeys, getUniqueColumns, getColumns
      const pkRs = createMockResultSet([{ column_name: "id" }]);
      const uniqueRs = createMockResultSet([{ column_name: "email" }]);
      const colRs = createMockResultSet([
        {
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          character_maximum_length: null,
        },
        {
          column_name: "name",
          data_type: "varchar",
          is_nullable: "NO",
          column_default: null,
          character_maximum_length: 255,
        },
        {
          column_name: "email",
          data_type: "varchar",
          is_nullable: "YES",
          column_default: null,
          character_maximum_length: 255,
        },
      ]);

      const conn = setupMultiQueryConn([pkRs, uniqueRs, colRs]);
      const introspector = new MysqlSchemaIntrospector(conn);

      const columns = await introspector.getColumns("users", "test_db");

      expect(columns).toEqual([
        {
          columnName: "id",
          dataType: "int",
          nullable: false,
          defaultValue: null,
          primaryKey: true,
          unique: false,
          maxLength: null,
        },
        {
          columnName: "name",
          dataType: "varchar",
          nullable: false,
          defaultValue: null,
          primaryKey: false,
          unique: false,
          maxLength: 255,
        },
        {
          columnName: "email",
          dataType: "varchar",
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
      const introspector = new MysqlSchemaIntrospector(conn);

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
      const introspector = new MysqlSchemaIntrospector(conn);

      const columns = await introspector.getColumns("nonexistent", "test_db");
      expect(columns).toEqual([]);
    });
  });

  describe("getPrimaryKeys()", () => {
    it("returns primary key column names", async () => {
      const rs = createMockResultSet([{ column_name: "id" }]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const keys = await introspector.getPrimaryKeys("users", "test_db");

      expect(keys).toEqual(["id"]);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "users");
      expect(ps.setParameter).toHaveBeenCalledWith(2, "test_db");
    });

    it("returns multiple keys for composite primary key", async () => {
      const rs = createMockResultSet([
        { column_name: "user_id" },
        { column_name: "role_id" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const keys = await introspector.getPrimaryKeys("user_roles", "test_db");
      expect(keys).toEqual(["user_id", "role_id"]);
    });

    it("returns empty array when no primary key", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const keys = await introspector.getPrimaryKeys("no_pk_table", "test_db");
      expect(keys).toEqual([]);
    });

    it("queries table_constraints joined with key_column_usage", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      await introspector.getPrimaryKeys("users", "test_db");

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
      const rs = createMockResultSet([{ "1": 1 }]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const exists = await introspector.tableExists("users", "test_db");

      expect(exists).toBe(true);
      expect(ps.setParameter).toHaveBeenCalledWith(1, "users");
      expect(ps.setParameter).toHaveBeenCalledWith(2, "test_db");
    });

    it("returns false when table does not exist", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      const exists = await introspector.tableExists("nonexistent", "test_db");
      expect(exists).toBe(false);
    });

    it("queries information_schema.tables", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ psFactory: () => ps });
      const introspector = new MysqlSchemaIntrospector(conn);

      await introspector.tableExists("users", "test_db");

      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("information_schema.tables"),
      );
    });
  });
});
