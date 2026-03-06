import { ConnectionError, DatabaseErrorCode, QueryError, TransactionError } from "espalier-jdbc";
import type { PoolConnection as MysqlPoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlConnection } from "../mysql-connection.js";
import { MysqlPreparedStatement, MysqlStatement } from "../mysql-statement.js";

function createMockConnection(): MysqlPoolConnection {
  return {
    execute: vi.fn().mockResolvedValue([[], []]),
    query: vi.fn().mockResolvedValue([[], []]),
    release: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  } as unknown as MysqlPoolConnection;
}

describe("MysqlConnection error codes", () => {
  it("ensureOpen throws ConnectionError with CONNECTION_CLOSED code", async () => {
    const conn = new MysqlConnection(createMockConnection());
    await conn.close();
    try {
      conn.createStatement();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("beginTransaction wraps error with TX_BEGIN_FAILED code", async () => {
    const mockConn = createMockConnection();
    (mockConn.beginTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("mysql error"));
    const conn = new MysqlConnection(mockConn);
    try {
      await conn.beginTransaction();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_BEGIN_FAILED);
    }
  });

  it("commit wraps error with TX_COMMIT_FAILED code", async () => {
    const mockConn = createMockConnection();
    const conn = new MysqlConnection(mockConn);
    const tx = await conn.beginTransaction();
    (mockConn.commit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("commit failed"));
    try {
      await tx.commit();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
    }
  });

  it("rollback wraps error with TX_ROLLBACK_FAILED code", async () => {
    const mockConn = createMockConnection();
    const conn = new MysqlConnection(mockConn);
    const tx = await conn.beginTransaction();
    (mockConn.rollback as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rollback failed"));
    try {
      await tx.rollback();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });

  it("setSavepoint wraps error with TX_SAVEPOINT_FAILED code", async () => {
    const mockConn = createMockConnection();
    const conn = new MysqlConnection(mockConn);
    const tx = await conn.beginTransaction();
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("savepoint failed"));
    try {
      await tx.setSavepoint("sp");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
    }
  });

  it("rollbackTo wraps error with TX_ROLLBACK_FAILED code", async () => {
    const mockConn = createMockConnection();
    const conn = new MysqlConnection(mockConn);
    const tx = await conn.beginTransaction();
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rollback to failed"));
    try {
      await tx.rollbackTo("sp");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });
});

describe("MysqlStatement error code mapping", () => {
  it("maps ER_DUP_ENTRY to QUERY_CONSTRAINT", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("INSERT INTO t VALUES (1)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps ER_PARSE_ERROR to QUERY_SYNTAX", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("syntax error"), {
      code: "ER_PARSE_ERROR",
      errno: 1064,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeUpdate("SELECTT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("maps ER_NO_SUCH_TABLE to QUERY_SYNTAX", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("table not found"), {
      code: "ER_NO_SUCH_TABLE",
      errno: 1146,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("SELECT * FROM nonexistent");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("maps ER_BAD_FIELD_ERROR to QUERY_SYNTAX", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("unknown column"), {
      code: "ER_BAD_FIELD_ERROR",
      errno: 1054,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("SELECT bad_col FROM t");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("maps ER_BAD_NULL_ERROR to QUERY_CONSTRAINT", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("column cannot be null"), {
      code: "ER_BAD_NULL_ERROR",
      errno: 1048,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeUpdate("INSERT INTO t (not_null_col) VALUES (NULL)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps ER_NO_REFERENCED_ROW_2 to QUERY_CONSTRAINT", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("FK violation"), {
      code: "ER_NO_REFERENCED_ROW_2",
      errno: 1452,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeUpdate("INSERT INTO child VALUES (999)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps ER_TABLE_EXISTS_ERROR to QUERY_SYNTAX", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("table exists"), {
      code: "ER_TABLE_EXISTS_ERROR",
      errno: 1050,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeUpdate("CREATE TABLE t (id INT)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("maps ECONNREFUSED to CONNECTION_FAILED", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("refused"), {
      code: "ECONNREFUSED",
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
    }
  });

  it("maps PROTOCOL_CONNECTION_LOST to CONNECTION_CLOSED", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("connection lost"), {
      code: "PROTOCOL_CONNECTION_LOST",
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("falls back to errno-based mapping when code is missing", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("duplicate"), {
      errno: 1062,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("INSERT INTO t VALUES (1)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps unknown mysql error codes to QUERY_FAILED", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("some error"), {
      code: "ER_UNKNOWN_SOMETHING",
      errno: 99999,
    });
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_FAILED);
    }
  });

  it("maps errors without code or errno to QUERY_FAILED", async () => {
    const mockConn = createMockConnection();
    (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("generic error"));
    const stmt = new MysqlStatement(mockConn);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_FAILED);
    }
  });
});

describe("MysqlPreparedStatement error code mapping", () => {
  it("maps mysql constraint error for prepared queries", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("FK violation"), {
      code: "ER_ROW_IS_REFERENCED_2",
      errno: 1451,
    });
    (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const ps = new MysqlPreparedStatement(mockConn, "INSERT INTO t VALUES ($1)");
    ps.setParameter(1, "test");
    try {
      await ps.executeQuery();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps mysql constraint error for prepared updates", async () => {
    const mockConn = createMockConnection();
    const mysqlError = Object.assign(new Error("not null violation"), {
      code: "ER_BAD_NULL_ERROR",
      errno: 1048,
    });
    (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(mysqlError);
    const ps = new MysqlPreparedStatement(mockConn, "UPDATE t SET a = $1");
    ps.setParameter(1, null);
    try {
      await ps.executeUpdate();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });
});
