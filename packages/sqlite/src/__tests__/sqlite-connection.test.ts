import type Database from "better-sqlite3";
import { ConnectionError, DatabaseErrorCode, IsolationLevel, TransactionError } from "espalier-jdbc";
import { describe, expect, it, vi } from "vitest";
import { SqliteBatchStatement } from "../sqlite-batch-statement.js";
import { SqliteConnection } from "../sqlite-connection.js";
import { SqliteNamedPreparedStatement } from "../sqlite-named-statement.js";
import { SqlitePreparedStatement, SqliteStatement } from "../sqlite-statement.js";

function createMockDb(): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      run: vi.fn().mockReturnValue({ changes: 0 }),
      columns: vi.fn().mockReturnValue([]),
      iterate: vi.fn().mockReturnValue({ next: () => ({ done: true }) }),
    }),
    exec: vi.fn(),
    close: vi.fn(),
    pragma: vi.fn(),
    transaction: vi.fn((fn: Function) => fn),
  } as unknown as Database.Database;
}

describe("SqliteConnection", () => {
  describe("createStatement()", () => {
    it("returns a SqliteStatement", () => {
      const conn = new SqliteConnection(createMockDb());
      expect(conn.createStatement()).toBeInstanceOf(SqliteStatement);
    });
  });

  describe("prepareStatement()", () => {
    it("returns a SqlitePreparedStatement", () => {
      const conn = new SqliteConnection(createMockDb());
      expect(conn.prepareStatement("SELECT 1")).toBeInstanceOf(SqlitePreparedStatement);
    });
  });

  describe("prepareNamedStatement()", () => {
    it("returns a SqliteNamedPreparedStatement", () => {
      const conn = new SqliteConnection(createMockDb());
      expect(conn.prepareNamedStatement("SELECT * FROM t WHERE id = :id")).toBeInstanceOf(SqliteNamedPreparedStatement);
    });
  });

  describe("prepareBatchStatement()", () => {
    it("returns a SqliteBatchStatement", () => {
      const conn = new SqliteConnection(createMockDb());
      expect(conn.prepareBatchStatement("INSERT INTO t (x) VALUES ($1)")).toBeInstanceOf(SqliteBatchStatement);
    });
  });

  describe("beginTransaction()", () => {
    it("executes BEGIN DEFERRED by default", async () => {
      const db = createMockDb();
      const conn = new SqliteConnection(db);
      await conn.beginTransaction();
      expect(db.exec).toHaveBeenCalledWith("BEGIN DEFERRED");
    });

    it("maps SERIALIZABLE to EXCLUSIVE", async () => {
      const db = createMockDb();
      const conn = new SqliteConnection(db);
      await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
      expect(db.exec).toHaveBeenCalledWith("BEGIN EXCLUSIVE");
    });

    it("maps REPEATABLE READ to IMMEDIATE", async () => {
      const db = createMockDb();
      const conn = new SqliteConnection(db);
      await conn.beginTransaction(IsolationLevel.REPEATABLE_READ);
      expect(db.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    });

    it("wraps errors in TransactionError", async () => {
      const db = createMockDb();
      (db.exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("begin failed");
      });
      const conn = new SqliteConnection(db);
      await expect(conn.beginTransaction()).rejects.toThrow(TransactionError);
    });

    it("wraps begin errors with TX_BEGIN_FAILED code", async () => {
      const db = createMockDb();
      (db.exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("begin failed");
      });
      const conn = new SqliteConnection(db);
      try {
        await conn.beginTransaction();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_BEGIN_FAILED);
      }
    });

    describe("transaction operations", () => {
      it("commit executes COMMIT", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        await tx.commit();
        expect(db.exec).toHaveBeenCalledWith("COMMIT");
      });

      it("rollback executes ROLLBACK", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        await tx.rollback();
        expect(db.exec).toHaveBeenCalledWith("ROLLBACK");
      });

      it("setSavepoint executes SAVEPOINT sql", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        await tx.setSavepoint("sp1");
        expect(db.exec).toHaveBeenCalledWith("SAVEPOINT sp1");
      });

      it("rollbackTo executes ROLLBACK TO SAVEPOINT sql", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        await tx.rollbackTo("sp1");
        expect(db.exec).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT sp1");
      });

      it("commit wraps errors with TX_COMMIT_FAILED", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        (db.exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("commit failed");
        });
        try {
          await tx.commit();
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(TransactionError);
          expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
        }
      });

      it("rollback wraps errors with TX_ROLLBACK_FAILED", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        (db.exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("rollback failed");
        });
        try {
          await tx.rollback();
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(TransactionError);
          expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
        }
      });

      it("setSavepoint wraps errors with TX_SAVEPOINT_FAILED", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        (db.exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("savepoint failed");
        });
        try {
          await tx.setSavepoint("sp");
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(TransactionError);
          expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
        }
      });

      it("rollbackTo wraps errors with TX_ROLLBACK_FAILED", async () => {
        const db = createMockDb();
        const conn = new SqliteConnection(db);
        const tx = await conn.beginTransaction();
        (db.exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("rollback to failed");
        });
        try {
          await tx.rollbackTo("sp");
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(TransactionError);
          expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
        }
      });
    });
  });

  describe("close()", () => {
    it("marks connection as closed", async () => {
      const conn = new SqliteConnection(createMockDb());
      expect(conn.isClosed()).toBe(false);
      await conn.close();
      expect(conn.isClosed()).toBe(true);
    });
  });

  describe("after close", () => {
    it("createStatement throws ConnectionError", async () => {
      const conn = new SqliteConnection(createMockDb());
      await conn.close();
      expect(() => conn.createStatement()).toThrow(ConnectionError);
      expect(() => conn.createStatement()).toThrow("Connection is closed");
    });

    it("prepareStatement throws ConnectionError", async () => {
      const conn = new SqliteConnection(createMockDb());
      await conn.close();
      expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
    });

    it("prepareNamedStatement throws ConnectionError", async () => {
      const conn = new SqliteConnection(createMockDb());
      await conn.close();
      expect(() => conn.prepareNamedStatement("SELECT :id")).toThrow(ConnectionError);
    });

    it("prepareBatchStatement throws ConnectionError", async () => {
      const conn = new SqliteConnection(createMockDb());
      await conn.close();
      expect(() => conn.prepareBatchStatement("INSERT INTO t VALUES ($1)")).toThrow(ConnectionError);
    });

    it("beginTransaction throws ConnectionError", async () => {
      const conn = new SqliteConnection(createMockDb());
      await conn.close();
      await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
    });

    it("ensureOpen throws with CONNECTION_CLOSED code", async () => {
      const conn = new SqliteConnection(createMockDb());
      await conn.close();
      try {
        conn.createStatement();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
      }
    });
  });
});
