/**
 * Y5 Q2 — E2E adversarial tests for @Audited and audit log (TEST-3).
 *
 * Tests: audit log writing/querying with live Postgres, null user context,
 * AuditContext user propagation, field filtering, soft-delete + audit interaction,
 * concurrent audit writes, audit trail tampering detection, getFieldHistory,
 * getAuditLogForEntity, large JSONB payloads, SQL injection in audit queries.
 */

import type { AuditEntry, CrudRepository } from "espalier-data";
import {
  AuditContext,
  Audited,
  Column,
  createDerivedRepository,
  getAuditLog,
  getAuditLogForEntity,
  getFieldHistory,
  Id,
  SoftDelete,
  Table,
  Version,
} from "espalier-data";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// ──────────────────────────────────────────────────────
// Test entities
// ──────────────────────────────────────────────────────

@Audited()
@Table("e2e_audit_items")
class AuditItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() email!: string;
  @Column() age: number = 0;
}

@Audited({ fields: ["name"] })
@Table("e2e_audit_partial")
class AuditPartial {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() secret!: string;
}

@Audited()
@SoftDelete()
@Table("e2e_audit_soft")
class AuditSoft {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() deletedAt: Date | null = null;
}

@Audited()
@Table("e2e_audit_versioned")
class AuditVersioned {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Version @Column() version: number = 0;
}

const TABLE_ITEMS = "e2e_audit_items";
const TABLE_PARTIAL = "e2e_audit_partial";
const TABLE_SOFT = "e2e_audit_soft";
const TABLE_VERSIONED = "e2e_audit_versioned";
const AUDIT_TABLE = "espalier_audit_log";

interface AuditRepo<T, ID> extends CrudRepository<T, ID> {
  getAuditLog(entityId: unknown): Promise<AuditEntry[]>;
  softDelete?(entity: T): Promise<void>;
  restore?(entity: T): Promise<void>;
  findIncludingDeleted?(spec?: any): Promise<T[]>;
  findOnlyDeleted?(spec?: any): Promise<T[]>;
}

describe.skipIf(!canConnect)("E2E: @Audited + audit log", { timeout: 20000 }, () => {
  let ds: PgDataSource;
  let itemRepo: AuditRepo<AuditItem, number>;
  let partialRepo: AuditRepo<AuditPartial, number>;
  let softRepo: AuditRepo<AuditSoft, number>;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();

    // Drop tables in correct order (audit log first to avoid FK issues)
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${AUDIT_TABLE} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_ITEMS} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_PARTIAL} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_SOFT} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_VERSIONED} CASCADE`);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_ITEMS} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        age INT NOT NULL DEFAULT 0
      )
    `);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_PARTIAL} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT NOT NULL DEFAULT ''
      )
    `);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_SOFT} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        deleted_at TIMESTAMPTZ
      )
    `);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_VERSIONED} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        version INT NOT NULL DEFAULT 0
      )
    `);

    // Pre-create the audit log table so beforeEach can truncate it
    await stmt.executeUpdate(`
      CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(255) NOT NULL,
        entity_id VARCHAR(255) NOT NULL,
        operation VARCHAR(10) NOT NULL,
        changes JSONB NOT NULL DEFAULT '[]',
        user_id VARCHAR(255),
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await conn.close();
  });

  beforeEach(async () => {
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`DELETE FROM ${TABLE_ITEMS}`);
    await stmt.executeUpdate(`DELETE FROM ${TABLE_PARTIAL}`);
    await stmt.executeUpdate(`DELETE FROM ${TABLE_SOFT}`);
    await stmt.executeUpdate(`DELETE FROM ${TABLE_VERSIONED}`);
    // Clear audit log between tests
    await stmt.executeUpdate(`DELETE FROM ${AUDIT_TABLE}`);
    await c.close();

    // Recreate repos to avoid query cache staleness
    itemRepo = createDerivedRepository(AuditItem, ds) as unknown as AuditRepo<AuditItem, number>;
    partialRepo = createDerivedRepository(AuditPartial, ds) as unknown as AuditRepo<AuditPartial, number>;
    softRepo = createDerivedRepository(AuditSoft, ds) as unknown as AuditRepo<AuditSoft, number>;
  });

  afterAll(async () => {
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${AUDIT_TABLE} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_ITEMS} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_PARTIAL} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_SOFT} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_VERSIONED} CASCADE`);
    await c.close();
    await ds.close();
  });

  // ══════════════════════════════════════════════════════
  // INSERT audit
  // ══════════════════════════════════════════════════════

  it("INSERT creates an audit log entry with all fields", async () => {
    const item = new AuditItem();
    item.name = "Alice";
    item.email = "alice@example.com";
    item.age = 30;

    const saved = await AuditContext.withUser({ id: "admin" }, () => itemRepo.save(item));

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    expect(log).toHaveLength(1);
    expect(log[0].operation).toBe("INSERT");
    expect(log[0].userId).toBe("admin");
    expect(log[0].entityId).toBe(String(saved.id));
    expect(log[0].entityType).toBe("AuditItem");
    expect(log[0].changes.length).toBeGreaterThan(0);

    // All non-id fields should be in the changes
    const fieldNames = log[0].changes.map((c) => c.field);
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("email");
    expect(fieldNames).toContain("age");
  });

  // ══════════════════════════════════════════════════════
  // UPDATE audit
  // ══════════════════════════════════════════════════════

  it("UPDATE creates an audit entry with old and new values", async () => {
    const item = new AuditItem();
    item.name = "Bob";
    item.email = "bob@test.com";
    item.age = 25;
    const saved = await itemRepo.save(item);

    saved.name = "Robert";
    saved.age = 26;
    await AuditContext.withUser({ id: "editor" }, () => itemRepo.save(saved));

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    // Should have 2 entries: INSERT + UPDATE
    expect(log).toHaveLength(2);
    // Most recent first
    const updateEntry = log[0];
    expect(updateEntry.operation).toBe("UPDATE");
    expect(updateEntry.userId).toBe("editor");

    const nameChange = updateEntry.changes.find((c) => c.field === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.oldValue).toBe("Bob");
    expect(nameChange!.newValue).toBe("Robert");
  });

  // ══════════════════════════════════════════════════════
  // DELETE audit
  // ══════════════════════════════════════════════════════

  it("DELETE creates an audit entry", async () => {
    const item = new AuditItem();
    item.name = "ToDelete";
    item.email = "del@test.com";
    const saved = await itemRepo.save(item);
    const savedId = saved.id;

    await AuditContext.withUser({ id: "deleter" }, () => itemRepo.delete(saved));

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditItem, savedId, c);
    await c.close();

    // INSERT + DELETE
    expect(log).toHaveLength(2);
    const deleteEntry = log.find((e) => e.operation === "DELETE");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.userId).toBe("deleter");
  });

  // ══════════════════════════════════════════════════════
  // Null user context
  // ══════════════════════════════════════════════════════

  it("audit entry with no AuditContext user — userId is null/undefined", async () => {
    const item = new AuditItem();
    item.name = "NoUser";
    item.email = "nouser@test.com";
    const saved = await itemRepo.save(item);

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    expect(log).toHaveLength(1);
    // userId should be undefined (null from DB -> undefined via ?? operator)
    expect(log[0].userId).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════
  // Field filtering (partial audit)
  // ══════════════════════════════════════════════════════

  it("@Audited({ fields: ['name'] }) — only audits name, not secret", async () => {
    const item = new AuditPartial();
    item.name = "Partial";
    item.secret = "s3cret";
    const saved = await partialRepo.save(item);

    saved.name = "Changed";
    saved.secret = "new-secret";
    await partialRepo.save(saved);

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditPartial, saved.id, c);
    await c.close();

    // INSERT + UPDATE
    expect(log.length).toBeGreaterThanOrEqual(2);
    const updateEntry = log[0];
    expect(updateEntry.operation).toBe("UPDATE");

    // Only 'name' should appear in changes, not 'secret'
    const fields = updateEntry.changes.map((c) => c.field);
    expect(fields).toContain("name");
    expect(fields).not.toContain("secret");
  });

  it("@Audited({ fields: ['name'] }) — update only secret skips audit entry", async () => {
    const item = new AuditPartial();
    item.name = "StaysSame";
    item.secret = "initial";
    const saved = await partialRepo.save(item);

    // Only change the non-audited field
    saved.secret = "changed-secret";
    await partialRepo.save(saved);

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditPartial, saved.id, c);
    await c.close();

    // Should only have INSERT — the UPDATE should have been skipped
    // because the only changed field (secret) is not in the audited fields list
    expect(log).toHaveLength(1);
    expect(log[0].operation).toBe("INSERT");
  });

  // ══════════════════════════════════════════════════════
  // getFieldHistory
  // ══════════════════════════════════════════════════════

  it("getFieldHistory returns change history for a specific field", async () => {
    const item = new AuditItem();
    item.name = "V1";
    item.email = "v1@test.com";
    const saved = await itemRepo.save(item);

    saved.name = "V2";
    const saved2 = await AuditContext.withUser({ id: "u1" }, () => itemRepo.save(saved));

    saved2.name = "V3";
    await AuditContext.withUser({ id: "u2" }, () => itemRepo.save(saved2));

    const c = await ds.getConnection();
    const history = await getFieldHistory(AuditItem, saved.id, "name", c);
    await c.close();

    // 3 entries with 'name' change
    expect(history.length).toBeGreaterThanOrEqual(3);

    const transitions = history.map((h) => `${h.oldValue}->${h.newValue}`);
    // INSERT creates null->V1
    expect(transitions).toContain("null->V1");
    // First update V1->V2
    expect(transitions).toContain("V1->V2");
    // Second update V2->V3 (works correctly when using the returned entity from save)
    expect(transitions).toContain("V2->V3");

    // Verify userId is captured
    const v2ToV3 = history.find((h) => h.oldValue === "V2" && h.newValue === "V3");
    expect(v2ToV3).toBeDefined();
    expect(v2ToV3!.userId).toBe("u2");
  });

  it("getFieldHistory for non-existent field returns empty", async () => {
    const item = new AuditItem();
    item.name = "Test";
    item.email = "t@t.com";
    const saved = await itemRepo.save(item);

    const c = await ds.getConnection();
    const history = await getFieldHistory(AuditItem, saved.id, "nonExistentField", c);
    await c.close();

    expect(history).toEqual([]);
  });

  // ══════════════════════════════════════════════════════
  // getAuditLogForEntity
  // ══════════════════════════════════════════════════════

  it("getAuditLogForEntity extracts class and id from instance", async () => {
    const item = new AuditItem();
    item.name = "ForEntity";
    item.email = "fe@test.com";
    const saved = await itemRepo.save(item);

    const c = await ds.getConnection();
    const log = await getAuditLogForEntity(saved as any, c);
    await c.close();

    expect(log).toHaveLength(1);
    expect(log[0].entityType).toBe("AuditItem");
  });

  // ══════════════════════════════════════════════════════
  // Soft-delete + audit interaction
  // ══════════════════════════════════════════════════════

  it("soft-delete generates a DELETE audit entry (not physical delete)", async () => {
    const item = new AuditSoft();
    item.name = "SoftAudited";
    const saved = await AuditContext.withUser({ id: "soft-user" }, () => softRepo.save(item));

    await AuditContext.withUser({ id: "soft-deleter" }, () => softRepo.delete(saved));

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditSoft, saved.id, c);
    await c.close();

    // INSERT + soft-delete (recorded as DELETE operation)
    expect(log.length).toBeGreaterThanOrEqual(2);
    // The soft-delete operation should be recorded with DELETE operation type
    const softDeleteEntry = log.find((e) => e.operation === "DELETE");
    expect(softDeleteEntry).toBeDefined();
    expect(softDeleteEntry!.userId).toBe("soft-deleter");
  });

  // ══════════════════════════════════════════════════════
  // Concurrent audit writes
  // ══════════════════════════════════════════════════════

  it("concurrent saves to different entities each get their own audit entries", async () => {
    const items = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const item = new AuditItem();
        item.name = `Concurrent-${i}`;
        item.email = `c${i}@test.com`;
        return AuditContext.withUser({ id: `user-${i}` }, () => itemRepo.save(item));
      }),
    );

    // Each should have its own audit entry
    for (let i = 0; i < items.length; i++) {
      const c = await ds.getConnection();
      const log = await getAuditLog(AuditItem, items[i].id, c);
      await c.close();

      expect(log).toHaveLength(1);
      expect(log[0].userId).toBe(`user-${i}`);
    }
  });

  // ══════════════════════════════════════════════════════
  // Audit trail tampering (direct table manipulation)
  // ══════════════════════════════════════════════════════

  it("directly modifying audit log table — entries can be tampered with", async () => {
    const item = new AuditItem();
    item.name = "TamperTest";
    item.email = "tamper@test.com";
    const saved = await itemRepo.save(item);

    // Tamper: directly update the audit log
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`UPDATE ${AUDIT_TABLE} SET user_id = 'hacker' WHERE entity_id = '${saved.id}'`);

    const log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    // The tampering succeeded — no integrity protection
    // This documents that the audit log has NO tamper-proofing (no checksums, no append-only enforcement)
    expect(log[0].userId).toBe("hacker");
  });

  it("directly deleting audit log entries — entries can be removed", async () => {
    const item = new AuditItem();
    item.name = "DeleteAudit";
    item.email = "del@test.com";
    const saved = await itemRepo.save(item);

    const c = await ds.getConnection();

    // Verify audit entry exists
    let log = await getAuditLog(AuditItem, saved.id, c);
    expect(log).toHaveLength(1);

    // Delete the audit entry directly
    const stmt = c.createStatement();
    await stmt.executeUpdate(`DELETE FROM ${AUDIT_TABLE} WHERE entity_id = '${saved.id}'`);

    log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    // Audit trail is gone — no protection
    expect(log).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════
  // Large JSONB payload
  // ══════════════════════════════════════════════════════

  it("audit entry with large text values survives round-trip", async () => {
    const item = new AuditItem();
    item.name = "X".repeat(5000);
    item.email = "Y".repeat(5000);
    const saved = await itemRepo.save(item);

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    expect(log).toHaveLength(1);
    const nameChange = log[0].changes.find((c) => c.field === "name");
    expect(nameChange).toBeDefined();
    expect((nameChange!.newValue as string).length).toBe(5000);
  });

  // ══════════════════════════════════════════════════════
  // Repository getAuditLog method
  // ══════════════════════════════════════════════════════

  it("repo.getAuditLog(entityId) works as convenience method", async () => {
    const item = new AuditItem();
    item.name = "RepoAudit";
    item.email = "repo@test.com";
    const saved = await itemRepo.save(item);

    const log = await itemRepo.getAuditLog(saved.id);

    expect(log).toHaveLength(1);
    expect(log[0].entityType).toBe("AuditItem");
  });

  // ══════════════════════════════════════════════════════
  // Multiple operations — full lifecycle
  // ══════════════════════════════════════════════════════

  it("full lifecycle: INSERT -> UPDATE -> UPDATE -> DELETE", async () => {
    const item = new AuditItem();
    item.name = "Lifecycle";
    item.email = "life@test.com";
    item.age = 1;

    const saved = await AuditContext.withUser({ id: "creator" }, () => itemRepo.save(item));

    saved.name = "Lifecycle-v2";
    const saved2 = await AuditContext.withUser({ id: "updater1" }, () => itemRepo.save(saved));

    saved2.age = 99;
    const saved3 = await AuditContext.withUser({ id: "updater2" }, () => itemRepo.save(saved2));

    await AuditContext.withUser({ id: "deleter" }, () => itemRepo.delete(saved3));

    const c = await ds.getConnection();
    const log = await getAuditLog(AuditItem, saved.id, c);
    await c.close();

    expect(log).toHaveLength(4);

    // Verify all 4 operations are present with correct users
    // (don't depend on exact ordering due to same-millisecond timestamps)
    const ops = log.map((e) => ({ op: e.operation, user: e.userId }));
    expect(ops).toContainEqual({ op: "INSERT", user: "creator" });
    expect(ops).toContainEqual({ op: "DELETE", user: "deleter" });
    // Two UPDATE entries
    const updates = ops.filter((o) => o.op === "UPDATE");
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u.user).sort()).toEqual(["updater1", "updater2"]);
  });

  // ══════════════════════════════════════════════════════
  // SQL injection in audit queries
  // ══════════════════════════════════════════════════════

  it("SQL injection in entityId for getAuditLog — parameterized, safe", async () => {
    const c = await ds.getConnection();
    const maliciousId = "'; DROP TABLE espalier_audit_log; --";
    const log = await getAuditLog(AuditItem, maliciousId, c);
    await c.close();

    // Should return empty, not crash or drop tables
    expect(log).toEqual([]);

    // Verify audit table still exists
    const c2 = await ds.getConnection();
    const stmt = c2.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = '${AUDIT_TABLE}'`,
    );
    await rs.next();
    const row = rs.getRow();
    await c2.close();
    expect(Number(row.cnt)).toBe(1);
  });

  // ══════════════════════════════════════════════════════
  // Audit log table auto-creation
  // ══════════════════════════════════════════════════════

  it("audit log table is auto-created on first write (idempotent)", async () => {
    // Drop the audit table
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${AUDIT_TABLE} CASCADE`);
    await c.close();

    // Create a new repo (fresh AuditLogWriter) and save — should auto-create table
    const freshRepo = createDerivedRepository(AuditItem, ds) as unknown as AuditRepo<AuditItem, number>;
    const item = new AuditItem();
    item.name = "AutoCreate";
    item.email = "auto@test.com";
    const saved = await freshRepo.save(item);

    // Verify audit log was written
    const c2 = await ds.getConnection();
    const log = await getAuditLog(AuditItem, saved.id, c2);
    await c2.close();

    expect(log).toHaveLength(1);
  });
});
