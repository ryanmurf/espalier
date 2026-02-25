import { describe, it, expect, vi } from "vitest";
import type { PoolConnection as MysqlPoolConnection } from "mysql2/promise";
import { MysqlConnection } from "../mysql-connection.js";
import { MysqlStatement, MysqlPreparedStatement } from "../mysql-statement.js";
import { MysqlNamedPreparedStatement } from "../mysql-named-statement.js";
import { MysqlBatchStatement } from "../mysql-batch-statement.js";
import {
  IsolationLevel,
  TransactionError,
  ConnectionError,
  DatabaseErrorCode,
} from "espalier-jdbc";

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

describe("MysqlConnection", () => {
  describe("createStatement()", () => {
    it("returns a MysqlStatement", () => {
      const conn = new MysqlConnection(createMockConnection());
      expect(conn.createStatement()).toBeInstanceOf(MysqlStatement);
    });
  });

  describe("prepareStatement()", () => {
    it("returns a MysqlPreparedStatement", () => {
      const conn = new MysqlConnection(createMockConnection());
      expect(conn.prepareStatement("SELECT 1")).toBeInstanceOf(
        MysqlPreparedStatement,
      );
    });
  });

  describe("prepareNamedStatement()", () => {
    it("returns a MysqlNamedPreparedStatement", () => {
      const conn = new MysqlConnection(createMockConnection());
      expect(
        conn.prepareNamedStatement("SELECT * FROM t WHERE id = :id"),
      ).toBeInstanceOf(MysqlNamedPreparedStatement);
    });
  });

  describe("prepareBatchStatement()", () => {
    it("returns a MysqlBatchStatement", () => {
      const conn = new MysqlConnection(createMockConnection());
      expect(
        conn.prepareBatchStatement("INSERT INTO t (x) VALUES ($1)"),
      ).toBeInstanceOf(MysqlBatchStatement);
    });
  });

  describe("beginTransaction()", () => {
    it("calls connection.beginTransaction()", async () => {
      const mockConn = createMockConnection();
      const conn = new MysqlConnection(mockConn);
      await conn.beginTransaction();
      expect(mockConn.beginTransaction).toHaveBeenCalledOnce();
    });

    it("sets isolation level when provided", async () => {
      const mockConn = createMockConnection();
      const conn = new MysqlConnection(mockConn);
      await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
      expect(mockConn.query).toHaveBeenCalledWith(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      );
      expect(mockConn.beginTransaction).toHaveBeenCalledOnce();
    });

    it("wraps errors in TransactionError", async () => {
      const mockConn = createMockConnection();
      (mockConn.beginTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("begin failed"),
      );
      const conn = new MysqlConnection(mockConn);
      await expect(conn.beginTransaction()).rejects.toThrow(TransactionError);
    });

    it("wraps begin errors with TX_BEGIN_FAILED code", async () => {
      const mockConn = createMockConnection();
      (mockConn.beginTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("begin failed"),
      );
      const conn = new MysqlConnection(mockConn);
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

    describe("transaction operations", () => {
      it("commit calls connection.commit()", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        await tx.commit();
        expect(mockConn.commit).toHaveBeenCalledOnce();
      });

      it("rollback calls connection.rollback()", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        await tx.rollback();
        expect(mockConn.rollback).toHaveBeenCalledOnce();
      });

      it("setSavepoint sends SAVEPOINT sql", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        await tx.setSavepoint("sp1");
        expect(mockConn.query).toHaveBeenCalledWith("SAVEPOINT sp1");
      });

      it("rollbackTo sends ROLLBACK TO SAVEPOINT sql", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        await tx.rollbackTo("sp1");
        expect(mockConn.query).toHaveBeenCalledWith(
          "ROLLBACK TO SAVEPOINT sp1",
        );
      });

      it("commit wraps errors in TransactionError with TX_COMMIT_FAILED", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        (mockConn.commit as ReturnType<typeof vi.fn>).mockRejectedValue(
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

      it("rollback wraps errors in TransactionError with TX_ROLLBACK_FAILED", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        (mockConn.rollback as ReturnType<typeof vi.fn>).mockRejectedValue(
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

      it("setSavepoint wraps errors in TransactionError with TX_SAVEPOINT_FAILED", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(
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

      it("rollbackTo wraps errors in TransactionError with TX_ROLLBACK_FAILED", async () => {
        const mockConn = createMockConnection();
        const conn = new MysqlConnection(mockConn);
        const tx = await conn.beginTransaction();
        (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(
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
  });

  describe("close()", () => {
    it("releases the connection and marks as closed", async () => {
      const mockConn = createMockConnection();
      const conn = new MysqlConnection(mockConn);
      expect(conn.isClosed()).toBe(false);

      await conn.close();
      expect(mockConn.release).toHaveBeenCalledOnce();
      expect(conn.isClosed()).toBe(true);
    });

    it("double-close is safe (release called only once)", async () => {
      const mockConn = createMockConnection();
      const conn = new MysqlConnection(mockConn);
      await conn.close();
      await conn.close();
      expect(mockConn.release).toHaveBeenCalledOnce();
    });
  });

  describe("after close", () => {
    it("createStatement throws ConnectionError", async () => {
      const conn = new MysqlConnection(createMockConnection());
      await conn.close();
      expect(() => conn.createStatement()).toThrow(ConnectionError);
      expect(() => conn.createStatement()).toThrow("Connection is closed");
    });

    it("prepareStatement throws ConnectionError", async () => {
      const conn = new MysqlConnection(createMockConnection());
      await conn.close();
      expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
    });

    it("prepareNamedStatement throws ConnectionError", async () => {
      const conn = new MysqlConnection(createMockConnection());
      await conn.close();
      expect(() => conn.prepareNamedStatement("SELECT :id")).toThrow(
        ConnectionError,
      );
    });

    it("prepareBatchStatement throws ConnectionError", async () => {
      const conn = new MysqlConnection(createMockConnection());
      await conn.close();
      expect(() =>
        conn.prepareBatchStatement("INSERT INTO t VALUES ($1)"),
      ).toThrow(ConnectionError);
    });

    it("beginTransaction throws ConnectionError", async () => {
      const conn = new MysqlConnection(createMockConnection());
      await conn.close();
      await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
    });

    it("ensureOpen throws with CONNECTION_CLOSED code", async () => {
      const conn = new MysqlConnection(createMockConnection());
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
  });
});
