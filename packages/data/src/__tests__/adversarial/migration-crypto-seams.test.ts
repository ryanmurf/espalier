/**
 * Adversarial regression tests for migration checksum + Web Crypto seams.
 *
 * Tests that the migration runner's checksum computation works correctly
 * with the new Web Crypto sha256 (replacing node:crypto):
 * - Checksums are deterministic across calls
 * - Migration content ordering affects checksum
 * - Multi-statement migrations hash correctly
 * - Checksum validation catches tampering
 */

import { sha256 } from "espalier-jdbc";
import { describe, expect, it } from "vitest";
import type { Migration } from "../../migration/migration.js";

// Replicate the computeChecksum logic from sqlite-migration-runner
async function computeChecksum(migration: Migration): Promise<string> {
  const upSql = migration.up();
  const downSql = migration.down();
  const upNorm = Array.isArray(upSql) ? upSql.join("\n") : upSql;
  const downNorm = Array.isArray(downSql) ? downSql.join("\n") : downSql;
  const content = `version:${migration.version}\ndescription:${migration.description}\nup:${upNorm}\ndown:${downNorm}`;
  return sha256(content);
}

describe("migration checksum + Web Crypto seam tests", () => {
  const migration1: Migration = {
    version: "001",
    description: "create users table",
    up: () => "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    down: () => "DROP TABLE users",
  };

  const migration2: Migration = {
    version: "002",
    description: "add email column",
    up: () => "ALTER TABLE users ADD COLUMN email TEXT",
    down: () => "ALTER TABLE users DROP COLUMN email",
  };

  it("produces consistent checksums across multiple calls", async () => {
    const h1 = await computeChecksum(migration1);
    const h2 = await computeChecksum(migration1);
    expect(h1).toBe(h2);
  });

  it("different migrations produce different checksums", async () => {
    const h1 = await computeChecksum(migration1);
    const h2 = await computeChecksum(migration2);
    expect(h1).not.toBe(h2);
  });

  it("checksum changes when up SQL is modified", async () => {
    const original = await computeChecksum(migration1);
    const modified: Migration = {
      ...migration1,
      up: () => "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
    };
    const altered = await computeChecksum(modified);
    expect(original).not.toBe(altered);
  });

  it("checksum changes when down SQL is modified", async () => {
    const original = await computeChecksum(migration1);
    const modified: Migration = {
      ...migration1,
      down: () => "DROP TABLE IF EXISTS users",
    };
    const altered = await computeChecksum(modified);
    expect(original).not.toBe(altered);
  });

  it("checksum changes when version is modified", async () => {
    const original = await computeChecksum(migration1);
    const modified: Migration = {
      ...migration1,
      version: "001a",
    };
    const altered = await computeChecksum(modified);
    expect(original).not.toBe(altered);
  });

  it("checksum changes when description is modified", async () => {
    const original = await computeChecksum(migration1);
    const modified: Migration = {
      ...migration1,
      description: "Create users table", // capitalization change
    };
    const altered = await computeChecksum(modified);
    expect(original).not.toBe(altered);
  });

  it("multi-statement up migration hashes correctly", async () => {
    const multiMigration: Migration = {
      version: "003",
      description: "multi-statement",
      up: () => ["CREATE TABLE orders (id INTEGER PRIMARY KEY)", "CREATE INDEX idx_orders_id ON orders(id)"],
      down: () => ["DROP INDEX idx_orders_id", "DROP TABLE orders"],
    };

    const hash = await computeChecksum(multiMigration);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Must be deterministic
    const hash2 = await computeChecksum(multiMigration);
    expect(hash).toBe(hash2);
  });

  it("statement order in multi-statement migration affects checksum", async () => {
    const m1: Migration = {
      version: "003",
      description: "ordered",
      up: () => ["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"],
      down: () => ["DROP TABLE b", "DROP TABLE a"],
    };
    const m2: Migration = {
      version: "003",
      description: "ordered",
      up: () => ["CREATE TABLE b (id INT)", "CREATE TABLE a (id INT)"],
      down: () => ["DROP TABLE b", "DROP TABLE a"],
    };

    const h1 = await computeChecksum(m1);
    const h2 = await computeChecksum(m2);
    expect(h1).not.toBe(h2);
  });

  it("empty up/down statements produce valid checksum", async () => {
    const emptyMigration: Migration = {
      version: "000",
      description: "noop",
      up: () => "",
      down: () => "",
    };

    const hash = await computeChecksum(emptyMigration);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("migration with unicode in description hashes correctly", async () => {
    const unicodeMigration: Migration = {
      version: "004",
      description: "add \u00fc\u00f1\u00ee\u00e7\u00f6\u00f0\u00e9 column",
      up: () => "ALTER TABLE t ADD COLUMN val TEXT",
      down: () => "ALTER TABLE t DROP COLUMN val",
    };

    const hash = await computeChecksum(unicodeMigration);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const hash2 = await computeChecksum(unicodeMigration);
    expect(hash).toBe(hash2);
  });

  it("migration with special SQL characters hashes correctly", async () => {
    const specialMigration: Migration = {
      version: "005",
      description: "default values with quotes",
      up: () => "ALTER TABLE t ADD COLUMN status TEXT DEFAULT 'active'",
      down: () => "ALTER TABLE t DROP COLUMN status",
    };

    const hash = await computeChecksum(specialMigration);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
