import { describe, it, expect, vi } from "vitest";
import { ConnectionError, DatabaseErrorCode } from "espalier-jdbc";

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      pragma: vi.fn().mockReturnValue("wal"),
      close: vi.fn(),
      prepare: vi.fn(),
      exec: vi.fn(),
    })),
  };
});

import Database from "better-sqlite3";
import { SqliteDataSource } from "../sqlite-data-source.js";
import { SqliteConnection } from "../sqlite-connection.js";

describe("SqliteDataSource", () => {
  describe("constructor", () => {
    it("creates an in-memory database with :memory:", () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      expect(ds).toBeDefined();
      expect(Database).toHaveBeenCalledWith(":memory:", undefined);
    });

    it("enables WAL mode and foreign keys", () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      const instance = (Database as unknown as ReturnType<typeof vi.fn>).mock
        .results.at(-1)?.value;
      expect(instance.pragma).toHaveBeenCalledWith("journal_mode = WAL");
      expect(instance.pragma).toHaveBeenCalledWith("foreign_keys = ON");
    });

    it("passes options to better-sqlite3", () => {
      new SqliteDataSource({
        filename: ":memory:",
        options: { readonly: true },
      });
      expect(Database).toHaveBeenCalledWith(":memory:", { readonly: true });
    });

    it("wraps constructor errors in ConnectionError", () => {
      (Database as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => {
          throw new Error("cannot open");
        },
      );
      expect(
        () => new SqliteDataSource({ filename: "/invalid/path/db.sqlite" }),
      ).toThrow(ConnectionError);
    });
  });

  describe("getConnection()", () => {
    it("returns a SqliteConnection", async () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      const conn = await ds.getConnection();
      expect(conn).toBeInstanceOf(SqliteConnection);
    });

    it("throws ConnectionError when DataSource is closed", async () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      await ds.close();

      await expect(ds.getConnection()).rejects.toThrow(ConnectionError);
      await expect(ds.getConnection()).rejects.toThrow("DataSource is closed");
    });

    it("throws with CONNECTION_CLOSED code when closed", async () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      await ds.close();

      try {
        await ds.getConnection();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as ConnectionError).code).toBe(
          DatabaseErrorCode.CONNECTION_CLOSED,
        );
      }
    });
  });

  describe("close()", () => {
    it("closes the underlying database", async () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      const instance = (Database as unknown as ReturnType<typeof vi.fn>).mock
        .results.at(-1)?.value;
      await ds.close();
      expect(instance.close).toHaveBeenCalledOnce();
    });

    it("double close is safe", async () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      const instance = (Database as unknown as ReturnType<typeof vi.fn>).mock
        .results.at(-1)?.value;
      await ds.close();
      await ds.close();
      expect(instance.close).toHaveBeenCalledOnce();
    });
  });

  describe("getDatabase()", () => {
    it("returns the underlying better-sqlite3 Database", () => {
      const ds = new SqliteDataSource({ filename: ":memory:" });
      const db = ds.getDatabase();
      expect(db).toBeDefined();
    });
  });
});
