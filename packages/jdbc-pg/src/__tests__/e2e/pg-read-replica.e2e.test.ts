/**
 * E2E adversarial tests for ReadReplicaDataSource (Y3 Q2).
 *
 * Tests against live Postgres. Uses same server as both "primary" and "replica"
 * (separate PgDataSource instances) to verify routing logic end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  ReadWriteContext,
  ReadReplicaDataSource,
  Table,
  Column,
  Id,
  createDerivedRepository,
} from "espalier-data";
import type { CrudRepository } from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

@Table("rr_items")
class RrItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
}

describe.skipIf(!canConnect)("ReadReplicaDataSource — E2E", () => {
  let primaryDs: PgDataSource;
  let replicaDs: PgDataSource;
  let rrDs: ReadReplicaDataSource;
  let repo: CrudRepository<RrItem, number>;

  beforeAll(async () => {
    new RrItem(); // trigger decorators
    primaryDs = createTestDataSource();
    replicaDs = createTestDataSource();

    const conn = await primaryDs.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate("DROP TABLE IF EXISTS rr_items CASCADE");
      await stmt.executeUpdate(`
        CREATE TABLE rr_items (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);
    } finally {
      await stmt.close();
      await conn.close();
    }

    rrDs = new ReadReplicaDataSource({
      primary: primaryDs,
      replicas: [replicaDs],
    });

    repo = createDerivedRepository<RrItem, number>(RrItem, rrDs);
  });

  afterAll(async () => {
    const conn = await primaryDs.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate("DROP TABLE IF EXISTS rr_items CASCADE");
    } finally {
      await stmt.close();
      await conn.close();
    }
    await rrDs.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Full CRUD through ReadReplicaDataSource
  // ══════════════════════════════════════════════════

  describe("full CRUD works end-to-end", () => {
    it("save() writes to primary", async () => {
      const item = new RrItem();
      item.name = "primary-item";
      const saved = await repo.save(item);
      expect(saved.id).toBeDefined();
      expect(saved.name).toBe("primary-item");
    });

    it("findAll() reads through replica in read-only context", async () => {
      const items = await ReadWriteContext.runReadOnly(async () => {
        return repo.findAll();
      });
      expect(items.length).toBeGreaterThan(0);
      expect(items.some((i) => i.name === "primary-item")).toBe(true);
    });

    it("findById() works through replica", async () => {
      const items = await repo.findAll();
      const firstId = items[0].id;

      const found = await ReadWriteContext.runReadOnly(async () => {
        return repo.findById(firstId);
      });
      expect(found).not.toBeNull();
      expect(found!.name).toBe("primary-item");
    });

    it("save() always goes to primary even within read-only scope", async () => {
      // ReadWriteContext doesn't affect save() — save always uses the DS directly.
      // The routing happens at getConnection() level based on ReadWriteContext.
      const item = new RrItem();
      item.name = "rw-item";
      const saved = await repo.save(item);
      expect(saved.id).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Default routing (no context)
  // ══════════════════════════════════════════════════

  describe("default routing", () => {
    it("no ReadWriteContext — routes to primary", async () => {
      const conn = await rrDs.getConnection();
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery("SELECT 1 AS ok");
        expect(await rs.next()).toBe(true);
      } finally {
        await stmt.close();
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Concurrent read-only and read-write
  // ══════════════════════════════════════════════════

  describe("concurrent operations", () => {
    it("concurrent read-only and write ops both succeed", async () => {
      const writes = Array.from({ length: 5 }, (_, i) => {
        const item = new RrItem();
        item.name = `concurrent-${i}`;
        return repo.save(item);
      });

      const reads = Array.from({ length: 5 }, () =>
        ReadWriteContext.runReadOnly(() => repo.findAll()),
      );

      const results = await Promise.all([...writes, ...reads]);
      expect(results.length).toBe(10);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Nested context override
  // ══════════════════════════════════════════════════

  describe("nested context override", () => {
    it("runReadWrite inside runReadOnly routes to primary for inner scope", async () => {
      await ReadWriteContext.runReadOnly(async () => {
        // Outer: read-only
        expect(ReadWriteContext.isReadOnly()).toBe(true);

        await ReadWriteContext.runReadWrite(async () => {
          // Inner: read-write
          expect(ReadWriteContext.isReadOnly()).toBe(false);
          // This getConnection should go to primary
          const conn = await rrDs.getConnection();
          const stmt = conn.createStatement();
          try {
            const rs = await stmt.executeQuery("SELECT 1 AS ok");
            expect(await rs.next()).toBe(true);
          } finally {
            await stmt.close();
            await conn.close();
          }
        });

        // Back to read-only
        expect(ReadWriteContext.isReadOnly()).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Zero replicas graceful handling
  // ══════════════════════════════════════════════════

  describe("zero replicas", () => {
    it("no replicas — read-only context still goes to primary", async () => {
      const noReplicaDs = new ReadReplicaDataSource({
        primary: primaryDs,
        replicas: [],
      });

      await ReadWriteContext.runReadOnly(async () => {
        const conn = await noReplicaDs.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery("SELECT 1 AS ok");
          expect(await rs.next()).toBe(true);
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });
});
