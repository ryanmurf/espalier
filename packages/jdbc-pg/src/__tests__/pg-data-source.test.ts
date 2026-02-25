import { describe, it, expect, vi } from "vitest";
import { PgConnection } from "../pg-connection.js";
import { ConnectionError } from "espalier-jdbc";

// Mock the pg module
vi.mock("pg", () => {
  const mockConnect = vi.fn();
  const mockEnd = vi.fn();
  return {
    Pool: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      end: mockEnd,
      on: vi.fn(),
    })),
    __mockConnect: mockConnect,
    __mockEnd: mockEnd,
  };
});

import { Pool } from "pg";
import { PgDataSource } from "../pg-data-source.js";

function getMockPool() {
  // Get the most recently created mock pool instance
  const instance = (Pool as unknown as ReturnType<typeof vi.fn>).mock.results.at(
    -1,
  )?.value;
  return instance as { connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

describe("PgDataSource", () => {
  describe("getConnection()", () => {
    it("returns a PgConnection wrapping the pool client", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      const ds = new PgDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.connect.mockResolvedValue(mockClient);

      const conn = await ds.getConnection();
      expect(conn).toBeInstanceOf(PgConnection);
      expect(pool.connect).toHaveBeenCalledOnce();
    });

    it("wraps pg errors in ConnectionError", async () => {
      const ds = new PgDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.connect.mockRejectedValue(new Error("connection refused"));

      await expect(ds.getConnection()).rejects.toThrow(ConnectionError);
      await expect(ds.getConnection()).rejects.toThrow(
        /Failed to get connection/,
      );
    });
  });

  describe("close()", () => {
    it("calls pool.end()", async () => {
      const ds = new PgDataSource({ host: "localhost" });
      const pool = getMockPool();
      pool.end.mockResolvedValue(undefined);

      await ds.close();
      expect(pool.end).toHaveBeenCalledOnce();
    });
  });
});
