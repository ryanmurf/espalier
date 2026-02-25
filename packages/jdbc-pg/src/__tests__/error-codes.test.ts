import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { PgConnection } from "../pg-connection.js";
import { PgStatement, PgPreparedStatement } from "../pg-statement.js";
import {
  DatabaseErrorCode,
  ConnectionError,
  TransactionError,
  QueryError,
} from "espalier-jdbc";

function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], fields: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("PgConnection error codes", () => {
  it("ensureOpen throws ConnectionError with CONNECTION_CLOSED code", async () => {
    const client = createMockClient();
    const conn = new PgConnection(client);
    await conn.close();
    try {
      conn.createStatement();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).code).toBe(
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }
  });

  it("beginTransaction wraps error with TX_BEGIN_FAILED code", async () => {
    const client = createMockClient();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("pg error"),
    );
    const conn = new PgConnection(client);
    try {
      await conn.beginTransaction();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(
        DatabaseErrorCode.TX_BEGIN_FAILED,
      );
    }
  });

  it("commit wraps error with TX_COMMIT_FAILED code", async () => {
    const client = createMockClient();
    const conn = new PgConnection(client);
    const tx = await conn.beginTransaction();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("commit failed"),
    );
    try {
      await tx.commit();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(
        DatabaseErrorCode.TX_COMMIT_FAILED,
      );
    }
  });

  it("rollback wraps error with TX_ROLLBACK_FAILED code", async () => {
    const client = createMockClient();
    const conn = new PgConnection(client);
    const tx = await conn.beginTransaction();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("rollback failed"),
    );
    try {
      await tx.rollback();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(
        DatabaseErrorCode.TX_ROLLBACK_FAILED,
      );
    }
  });

  it("setSavepoint wraps error with TX_SAVEPOINT_FAILED code", async () => {
    const client = createMockClient();
    const conn = new PgConnection(client);
    const tx = await conn.beginTransaction();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("savepoint failed"),
    );
    try {
      await tx.setSavepoint("sp");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(
        DatabaseErrorCode.TX_SAVEPOINT_FAILED,
      );
    }
  });

  it("rollbackTo wraps error with TX_ROLLBACK_FAILED code", async () => {
    const client = createMockClient();
    const conn = new PgConnection(client);
    const tx = await conn.beginTransaction();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("rollback to failed"),
    );
    try {
      await tx.rollbackTo("sp");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(
        DatabaseErrorCode.TX_ROLLBACK_FAILED,
      );
    }
  });
});

describe("PgStatement error code mapping", () => {
  it("maps pg unique_violation (23505) to QUERY_CONSTRAINT", async () => {
    const client = createMockClient();
    const pgError = Object.assign(new Error("unique violation"), {
      code: "23505",
    });
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(pgError);
    const stmt = new PgStatement(client);
    try {
      await stmt.executeQuery("INSERT INTO t VALUES (1)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps pg syntax_error (42601) to QUERY_SYNTAX", async () => {
    const client = createMockClient();
    const pgError = Object.assign(new Error("syntax error"), {
      code: "42601",
    });
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(pgError);
    const stmt = new PgStatement(client);
    try {
      await stmt.executeUpdate("SELECTT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("maps pg undefined_table (42P01) to QUERY_SYNTAX", async () => {
    const client = createMockClient();
    const pgError = Object.assign(new Error("undefined table"), {
      code: "42P01",
    });
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(pgError);
    const stmt = new PgStatement(client);
    try {
      await stmt.executeQuery("SELECT * FROM nonexistent");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_SYNTAX);
    }
  });

  it("maps unknown pg error codes to QUERY_FAILED", async () => {
    const client = createMockClient();
    const pgError = Object.assign(new Error("some error"), {
      code: "99999",
    });
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(pgError);
    const stmt = new PgStatement(client);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_FAILED);
    }
  });

  it("maps errors without pg code to QUERY_FAILED", async () => {
    const client = createMockClient();
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("generic error"),
    );
    const stmt = new PgStatement(client);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_FAILED);
    }
  });
});

describe("PgPreparedStatement error code mapping", () => {
  it("maps pg constraint error to QUERY_CONSTRAINT for prepared queries", async () => {
    const client = createMockClient();
    const pgError = Object.assign(new Error("foreign key violation"), {
      code: "23503",
    });
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(pgError);
    const ps = new PgPreparedStatement(client, "INSERT INTO t VALUES ($1)");
    ps.setParameter(1, "test");
    try {
      await ps.executeQuery();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    }
  });

  it("maps pg constraint error to QUERY_CONSTRAINT for prepared updates", async () => {
    const client = createMockClient();
    const pgError = Object.assign(new Error("not null violation"), {
      code: "23502",
    });
    (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(pgError);
    const ps = new PgPreparedStatement(client, "UPDATE t SET a = $1");
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
