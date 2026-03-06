/**
 * E2E tests for repository streaming (findAllStream) and derived streaming methods.
 * Tests async iteration, early termination, PostLoad integration, and resource cleanup.
 */

import { Column, createDerivedRepository, Id, PostLoad, Table } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// External log for PostLoad tracking (rowMapper creates new objects without non-column fields)
const loadLog: number[] = [];

@Table("stream_test_items")
class StreamItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() category!: string;
  @Column({ type: "INT" }) priority!: number;

  @PostLoad
  onLoad() {
    loadLog.push(this.id);
  }
}
new StreamItem();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS stream_test_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    priority INT NOT NULL
  )
`;
const DROP_TABLE = `DROP TABLE IF EXISTS stream_test_items CASCADE`;

describe.skipIf(!canConnect)("E2E: Repository Streaming", { timeout: 15000 }, () => {
  let ds: PgDataSource;
  let totalRows: number;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);

    // Seed 100 rows across 4 categories
    const values: string[] = [];
    for (let i = 0; i < 100; i++) {
      const category = ["music", "sports", "tech", "food"][i % 4];
      const priority = (i % 5) + 1;
      values.push(`('Item${i}', '${category}', ${priority})`);
    }
    await stmt.executeUpdate(`INSERT INTO stream_test_items (name, category, priority) VALUES ${values.join(",")}`);

    // Count total rows
    const rs = await stmt.executeQuery("SELECT COUNT(*) as cnt FROM stream_test_items");
    await rs.next();
    totalRows = Number(rs.getRow().cnt);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await conn.close();
    await ds.close();
  });

  function createRepo() {
    return createDerivedRepository<StreamItem, number>(StreamItem, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
    });
  }

  // ──────────────────────────────────────────────
  // findAllStream() basic
  // ──────────────────────────────────────────────

  it("findAllStream iterates all rows", async () => {
    const repo = createRepo();
    let count = 0;
    for await (const entity of repo.findAllStream()) {
      count++;
      expect(entity.id).toBeDefined();
      expect(entity.name).toBeDefined();
    }
    expect(count).toBe(totalRows);
  });

  it("findAllStream entities are properly mapped", async () => {
    const repo = createRepo();
    const entities: StreamItem[] = [];
    for await (const entity of repo.findAllStream()) {
      entities.push(entity);
      if (entities.length >= 5) break;
    }
    expect(entities.length).toBe(5);
    for (const e of entities) {
      expect(typeof e.id).toBe("number");
      expect(typeof e.name).toBe("string");
      expect(typeof e.category).toBe("string");
      expect(typeof e.priority).toBe("number");
    }
  });

  // ──────────────────────────────────────────────
  // PostLoad integration with streaming
  // ──────────────────────────────────────────────

  it("@PostLoad fired for each streamed entity", async () => {
    const repo = createRepo();
    loadLog.length = 0;

    let count = 0;
    for await (const _entity of repo.findAllStream()) {
      count++;
    }

    // PostLoad should have been called for every entity
    expect(loadLog.length).toBe(count);
    expect(loadLog.length).toBe(totalRows);
  });

  // ──────────────────────────────────────────────
  // Early termination
  // ──────────────────────────────────────────────

  it("breaking out of for-await-of after 10 rows releases resources", async () => {
    const repo = createRepo();
    let count = 0;
    for await (const _entity of repo.findAllStream()) {
      count++;
      if (count >= 10) break;
    }
    expect(count).toBe(10);

    // Verify repo still works after early termination (connection was released)
    const all = await repo.findAll();
    expect(all.length).toBe(totalRows);
  });

  it("breaking immediately (after 1 row) works", async () => {
    const repo = createRepo();
    let count = 0;
    for await (const _entity of repo.findAllStream()) {
      count++;
      break;
    }
    expect(count).toBe(1);

    // Repo still functional
    const found = await repo.findById(1);
    expect(found).not.toBeNull();
  });

  // ──────────────────────────────────────────────
  // findAllStream with specification (where clause)
  // ──────────────────────────────────────────────

  it("findAllStream with where clause filters results", async () => {
    const repo = createRepo();
    const { ComparisonCriteria } = await import("espalier-data");

    const musicSpec = {
      toPredicate: () => new ComparisonCriteria("eq", "category", "music"),
    };

    let count = 0;
    for await (const entity of repo.findAllStream({ where: musicSpec as any })) {
      expect(entity.category).toBe("music");
      count++;
    }
    // 100 rows / 4 categories = 25 music items
    expect(count).toBe(25);
  });

  // ──────────────────────────────────────────────
  // Empty result stream
  // ──────────────────────────────────────────────

  it("findAllStream with no matching rows yields nothing", async () => {
    const repo = createRepo();
    const { ComparisonCriteria } = await import("espalier-data");

    const noMatchSpec = {
      toPredicate: () => new ComparisonCriteria("eq", "category", "nonexistent"),
    };

    let count = 0;
    for await (const _entity of repo.findAllStream({ where: noMatchSpec as any })) {
      count++;
    }
    expect(count).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Derived streaming: findByCategoryStream
  // ──────────────────────────────────────────────

  it("derived findByCategoryStream returns async iterable", async () => {
    const repo = createRepo();
    const stream = (repo as any).findByCategoryStream("tech");

    let count = 0;
    for await (const entity of stream) {
      expect(entity.category).toBe("tech");
      count++;
    }
    // 100 rows / 4 categories = 25 tech items
    expect(count).toBe(25);
  });

  it("derived findByCategoryStream with early break", async () => {
    const repo = createRepo();
    const stream = (repo as any).findByCategoryStream("sports");

    let count = 0;
    for await (const entity of stream) {
      expect(entity.category).toBe("sports");
      count++;
      if (count >= 5) break;
    }
    expect(count).toBe(5);

    // Repo still works
    const all = await repo.findAll();
    expect(all.length).toBe(totalRows);
  });

  it("derived findByCategoryStream PostLoad fires", async () => {
    const repo = createRepo();
    loadLog.length = 0;

    let count = 0;
    for await (const _entity of (repo as any).findByCategoryStream("food")) {
      count++;
    }

    expect(loadLog.length).toBe(count);
    expect(count).toBe(25);
  });

  // ──────────────────────────────────────────────
  // Streamed entities are snapshotted (change tracking)
  // ──────────────────────────────────────────────

  it("streamed entities have snapshots (change tracking active)", async () => {
    const repo = createRepo();
    let checked = 0;
    for await (const entity of repo.findAllStream()) {
      expect((repo as any).isDirty(entity)).toBe(false);
      checked++;
      if (checked >= 5) break;
    }
    expect(checked).toBe(5);
  });

  // ──────────────────────────────────────────────
  // Multiple concurrent streams
  // ──────────────────────────────────────────────

  it("multiple concurrent streams work independently", async () => {
    const repo1 = createRepo();
    const repo2 = createRepo();

    const [count1, count2] = await Promise.all([
      (async () => {
        let n = 0;
        for await (const _e of repo1.findAllStream()) n++;
        return n;
      })(),
      (async () => {
        let n = 0;
        for await (const _e of repo2.findAllStream()) n++;
        return n;
      })(),
    ]);

    expect(count1).toBe(totalRows);
    expect(count2).toBe(totalRows);
  });

  // ──────────────────────────────────────────────
  // Large set streaming (memory efficiency)
  // ──────────────────────────────────────────────

  it("streams all 100 entities without accumulating in memory", async () => {
    const repo = createRepo();
    let count = 0;
    let lastId = -1;
    for await (const entity of repo.findAllStream()) {
      // Just count, don't accumulate — verifies streaming works for larger sets
      count++;
      lastId = entity.id;
    }
    expect(count).toBe(totalRows);
    expect(lastId).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────
  // Subsequent operations after stream
  // ──────────────────────────────────────────────

  it("repository works normally after completed stream", async () => {
    const repo = createRepo();

    // Stream to completion
    let count = 0;
    for await (const _e of repo.findAllStream()) count++;
    expect(count).toBe(totalRows);

    // Normal operations
    const byId = await repo.findById(1);
    expect(byId).not.toBeNull();

    const cnt = await repo.count();
    expect(cnt).toBe(totalRows);
  });
});
