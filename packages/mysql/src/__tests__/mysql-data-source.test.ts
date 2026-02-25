import { describe, it, expect, vi } from "vitest";
import { ConnectionError, DatabaseErrorCode } from "espalier-jdbc";

// Mock the mysql2/promise module — each createPool call gets fresh spies
vi.mock("mysql2/promise", () => {
  return {
    default: {
      createPool: vi.fn().mockImplementation(() => ({
        getConnection: vi.fn(),
        end: vi.fn(),
        pool: {
          _allConnections: { length: 5 },
          _freeConnections: { length: 3 },
          _connectionQueue: { length: 1 },
        },
      })),
    },
  };
});

import mysql from "mysql2/promise";
import { MysqlDataSource } from "../mysql-data-source.js";
import { MysqlConnection } from "../mysql-connection.js";

function getMockPool() {
  const instance = (mysql.createPool as unknown as ReturnType<typeof vi.fn>)
    .mock.results.at(-1)?.value;
  return instance as {
    getConnection: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    pool: {
      _allConnections: { length: number };
      _freeConnections: { length: number };
      _connectionQueue: { length: number };
    };
  };
}

describe("MysqlDataSource", () => {
  describe("constructor", () => {
    it("accepts MysqlDataSourceConfig with mysql and pool sections", () => {
      const ds = new MysqlDataSource({
        mysql: { host: "localhost", port: 3306 },
        pool: { maxConnections: 10, acquireTimeout: 5000 },
      });
      expect(ds).toBeDefined();
      expect(mysql.createPool).toHaveBeenCalled();
    });

    it("accepts plain PoolOptions", () => {
      const ds = new MysqlDataSource({ host: "localhost", port: 3306 });
      expect(ds).toBeDefined();
      expect(mysql.createPool).toHaveBeenCalled();
    });

    it("maps pool config fields to mysql2 options", () => {
      new MysqlDataSource({
        mysql: { host: "db.example.com" },
        pool: {
          maxConnections: 20,
          acquireTimeout: 3000,
          idleTimeout: 60000,
        },
      });
      const lastCall = (mysql.createPool as unknown as ReturnType<typeof vi.fn>)
        .mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({
        host: "db.example.com",
        connectionLimit: 20,
        connectTimeout: 3000,
        idleTimeout: 60000,
      });
    });
  });

  describe("getConnection()", () => {
    it("returns a MysqlConnection wrapping the pool connection", async () => {
      const mockConn = {
        execute: vi.fn(),
        query: vi.fn(),
        release: vi.fn(),
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
      };
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.getConnection.mockResolvedValue(mockConn);

      const conn = await ds.getConnection();
      expect(conn).toBeInstanceOf(MysqlConnection);
      expect(pool.getConnection).toHaveBeenCalledOnce();
    });

    it("wraps connection errors in ConnectionError", async () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.getConnection.mockRejectedValue(
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      );

      await expect(ds.getConnection()).rejects.toThrow(ConnectionError);
      await expect(ds.getConnection()).rejects.toThrow(
        /Failed to get connection/,
      );
    });

    it("maps ECONNREFUSED to CONNECTION_FAILED code", async () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.getConnection.mockRejectedValue(
        Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      );

      try {
        await ds.getConnection();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as ConnectionError).code).toBe(
          DatabaseErrorCode.CONNECTION_FAILED,
        );
      }
    });

    it("maps ETIMEDOUT to CONNECTION_TIMEOUT code", async () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.getConnection.mockRejectedValue(
        Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      );

      try {
        await ds.getConnection();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as ConnectionError).code).toBe(
          DatabaseErrorCode.CONNECTION_TIMEOUT,
        );
      }
    });

    it("throws ConnectionError when DataSource is closed", async () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.end.mockResolvedValue(undefined);
      await ds.close();

      await expect(ds.getConnection()).rejects.toThrow(ConnectionError);
      await expect(ds.getConnection()).rejects.toThrow("DataSource is closed");
    });
  });

  describe("getPoolStats()", () => {
    it("returns pool statistics from mysql2 internals", () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const stats = ds.getPoolStats();
      expect(stats).toEqual({
        total: 5,
        idle: 3,
        waiting: 1,
      });
    });
  });

  describe("close()", () => {
    it("calls pool.end()", async () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.end.mockResolvedValue(undefined);

      await ds.close();
      expect(pool.end).toHaveBeenCalledOnce();
    });

    it("double close is safe (end called only once)", async () => {
      const ds = new MysqlDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.end.mockResolvedValue(undefined);

      await ds.close();
      await ds.close();
      expect(pool.end).toHaveBeenCalledOnce();
    });
  });
});
