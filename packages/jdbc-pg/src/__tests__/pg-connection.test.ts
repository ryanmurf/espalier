import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { PgConnection } from "../pg-connection.js";
import { PgStatement, PgPreparedStatement } from "../pg-statement.js";
import { IsolationLevel, TransactionError, ConnectionError } from "espalier-jdbc";

function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("PgConnection", () => {
  describe("createStatement()", () => {
    it("returns a PgStatement", () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      expect(conn.createStatement()).toBeInstanceOf(PgStatement);
    });
  });

  describe("prepareStatement()", () => {
    it("returns a PgPreparedStatement", () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      expect(conn.prepareStatement("SELECT 1")).toBeInstanceOf(
        PgPreparedStatement,
      );
    });
  });

  describe("beginTransaction()", () => {
    it("sends BEGIN to the client", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      await conn.beginTransaction();
      expect(client.query).toHaveBeenCalledWith("BEGIN");
    });

    it("sets isolation level when provided", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
      expect(client.query).toHaveBeenCalledWith("BEGIN");
      expect(client.query).toHaveBeenCalledWith(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      );
    });

    it("wraps errors in TransactionError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("begin failed"),
      );
      const conn = new PgConnection(client);
      await expect(conn.beginTransaction()).rejects.toThrow(TransactionError);
    });

    describe("transaction operations", () => {
      it("commit sends COMMIT", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        await tx.commit();
        expect(client.query).toHaveBeenCalledWith("COMMIT");
      });

      it("rollback sends ROLLBACK", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        await tx.rollback();
        expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      });

      it("setSavepoint sends SAVEPOINT sql", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        await tx.setSavepoint("sp1");
        expect(client.query).toHaveBeenCalledWith("SAVEPOINT sp1");
      });

      it("rollbackTo sends ROLLBACK TO SAVEPOINT sql", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        await tx.rollbackTo("sp1");
        expect(client.query).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT sp1");
      });

      it("commit wraps errors in TransactionError", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("commit failed"),
        );
        await expect(tx.commit()).rejects.toThrow(TransactionError);
      });

      it("rollback wraps errors in TransactionError", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("rollback failed"),
        );
        await expect(tx.rollback()).rejects.toThrow(TransactionError);
      });

      it("setSavepoint wraps errors in TransactionError", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("savepoint failed"),
        );
        await expect(tx.setSavepoint("sp")).rejects.toThrow(TransactionError);
      });

      it("rollbackTo wraps errors in TransactionError", async () => {
        const client = createMockClient();
        const conn = new PgConnection(client);
        const tx = await conn.beginTransaction();
        (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("rollback to failed"),
        );
        await expect(tx.rollbackTo("sp")).rejects.toThrow(TransactionError);
      });
    });
  });

  describe("close()", () => {
    it("releases the client and marks connection as closed", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      expect(conn.isClosed()).toBe(false);

      await conn.close();
      expect(client.release).toHaveBeenCalledOnce();
      expect(conn.isClosed()).toBe(true);
    });

    it("double-close is safe (release called only once)", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      await conn.close();
      await conn.close();
      expect(client.release).toHaveBeenCalledOnce();
    });
  });

  describe("after close", () => {
    it("createStatement throws ConnectionError", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      await conn.close();
      expect(() => conn.createStatement()).toThrow(ConnectionError);
      expect(() => conn.createStatement()).toThrow("Connection is closed");
    });

    it("prepareStatement throws ConnectionError", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      await conn.close();
      expect(() => conn.prepareStatement("SELECT 1")).toThrow(
        ConnectionError,
      );
    });

    it("beginTransaction throws ConnectionError", async () => {
      const client = createMockClient();
      const conn = new PgConnection(client);
      await conn.close();
      await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
    });
  });
});
