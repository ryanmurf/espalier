import { Column, createDerivedRepository, Id, OptimisticLockException, Table, Version } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("lock_test_documents")
class LockTestDocument {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() title!: string;
  @Column() content!: string;
  @Version @Column() version!: number;
}
new LockTestDocument();

@Table("lock_test_notes")
class LockTestNote {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() text!: string;
}
new LockTestNote();

const CREATE_DOCS = `
  CREATE TABLE IF NOT EXISTS lock_test_documents (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    version INT NOT NULL DEFAULT 0
  )
`;

const CREATE_NOTES = `
  CREATE TABLE IF NOT EXISTS lock_test_notes (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL
  )
`;

const DROP_DOCS = `DROP TABLE IF EXISTS lock_test_documents CASCADE`;
const DROP_NOTES = `DROP TABLE IF EXISTS lock_test_notes CASCADE`;

describe.skipIf(!canConnect)("E2E: Optimistic Locking", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  function makeDoc(title: string, content: string): LockTestDocument {
    return Object.assign(Object.create(LockTestDocument.prototype), {
      title,
      content,
    }) as LockTestDocument;
  }

  function makeNote(text: string): LockTestNote {
    return Object.assign(Object.create(LockTestNote.prototype), {
      text,
    }) as LockTestNote;
  }

  function createDocRepo() {
    return createDerivedRepository<LockTestDocument, number>(LockTestDocument, ds);
  }

  function createNoteRepo() {
    return createDerivedRepository<LockTestNote, number>(LockTestNote, ds);
  }

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_DOCS);
    await stmt.executeUpdate(DROP_NOTES);
    await stmt.executeUpdate(CREATE_DOCS);
    await stmt.executeUpdate(CREATE_NOTES);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_DOCS);
    await stmt.executeUpdate(DROP_NOTES);
    await conn.close();
    await ds.close();
  });

  // ──────────────────────────────────────────────
  // INSERT: version initialization
  // ──────────────────────────────────────────────

  it("save new entity sets version to 1", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Doc A", "Content A"));
    expect(saved.version).toBe(1);
    expect(saved.id).toBeDefined();
  });

  it("save new entity with version=0 treats as new and sets version to 1", async () => {
    const docRepo = createDocRepo();
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Doc B",
      content: "Content B",
      version: 0,
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);
    expect(saved.version).toBe(1);
  });

  // ──────────────────────────────────────────────
  // UPDATE: happy path
  // ──────────────────────────────────────────────

  it("save existing entity increments version from 1 to 2", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("IncDoc", "Original"));
    expect(saved.version).toBe(1);

    saved.content = "Updated content v2";
    const updated = await docRepo.save(saved);
    expect(updated.version).toBe(2);
    expect(updated.content).toBe("Updated content v2");
  });

  it("save twice increments version from 1 to 2 to 3", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("MultiIncDoc", "Original"));
    expect(saved.version).toBe(1);

    saved.content = "Updated v2";
    const v2 = await docRepo.save(saved);
    expect(v2.version).toBe(2);

    v2.content = "Updated v3";
    const v3 = await docRepo.save(v2);
    expect(v3.version).toBe(3);
  });

  it("verify row in DB has correct version after saves", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("VerifyDoc", "Original"));
    saved.content = "Updated";
    const updated = await docRepo.save(saved);

    // Clear entity cache and reload from DB
    (docRepo as any).getEntityCache().clear();
    const reloaded = await docRepo.findById(updated.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.version).toBe(2);
    expect(reloaded!.content).toBe("Updated");
  });

  // ──────────────────────────────────────────────
  // UPDATE: conflict
  // ──────────────────────────────────────────────

  it("save with stale version throws OptimisticLockException", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Conflict Doc", "Original"));
    expect(saved.version).toBe(1);

    // Load it (user1)
    const user1Doc = await docRepo.findById(saved.id)!;
    expect(user1Doc!.version).toBe(1);

    // Simulate concurrent modification: update version in DB directly
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(`UPDATE lock_test_documents SET content = $1, version = $2 WHERE id = $3`);
    stmt.setParameter(1, "Concurrent update");
    stmt.setParameter(2, 2);
    stmt.setParameter(3, saved.id);
    await stmt.executeUpdate();
    await conn.close();

    // User1 tries to save with stale version=1 -> should throw
    user1Doc!.content = "User1 update";
    await expect(docRepo.save(user1Doc!)).rejects.toThrow(OptimisticLockException);
  });

  it("OptimisticLockException contains correct properties", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Props Doc", "Original"));

    // Bump version in DB
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(`UPDATE lock_test_documents SET version = $1 WHERE id = $2`);
    stmt.setParameter(1, 99);
    stmt.setParameter(2, saved.id);
    await stmt.executeUpdate();
    await conn.close();

    try {
      saved.content = "Should fail";
      await docRepo.save(saved);
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OptimisticLockException);
      const ex = e as OptimisticLockException;
      expect(ex.entityName).toBe("LockTestDocument");
      expect(ex.id).toBe(saved.id);
      expect(ex.expectedVersion).toBe(1);
    }
  });

  it("after conflict, entity version is NOT modified", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("NoMod Doc", "Original"));
    const originalVersion = saved.version;

    // Bump version in DB
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(`UPDATE lock_test_documents SET version = $1 WHERE id = $2`);
    stmt.setParameter(1, 99);
    stmt.setParameter(2, saved.id);
    await stmt.executeUpdate();
    await conn.close();

    try {
      saved.content = "Should fail";
      await docRepo.save(saved);
    } catch {
      // Expected
    }

    // The entity object should still have its old version
    expect(saved.version).toBe(originalVersion);
  });

  it("after conflict, DB row is unchanged", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Unchanged Doc", "Original content"));

    // Bump version in DB with a specific content
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(`UPDATE lock_test_documents SET content = $1, version = $2 WHERE id = $3`);
    stmt.setParameter(1, "DB content");
    stmt.setParameter(2, 2);
    stmt.setParameter(3, saved.id);
    await stmt.executeUpdate();
    await conn.close();

    try {
      saved.content = "Conflicting update";
      await docRepo.save(saved);
    } catch {
      // Expected
    }

    // Reload and verify DB row has the concurrent updater's content
    (docRepo as any).getEntityCache().clear();
    const reloaded = await docRepo.findById(saved.id);
    expect(reloaded!.content).toBe("DB content");
    expect(reloaded!.version).toBe(2);
  });

  // ──────────────────────────────────────────────
  // DELETE
  // ──────────────────────────────────────────────

  it("delete entity with correct version succeeds", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Delete OK", "To be deleted"));

    await docRepo.delete(saved);

    (docRepo as any).getEntityCache().clear();
    const found = await docRepo.findById(saved.id);
    expect(found).toBeNull();
  });

  it("delete entity with stale version throws OptimisticLockException", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Delete Fail", "Should not be deleted"));

    // Bump version in DB
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(`UPDATE lock_test_documents SET version = $1 WHERE id = $2`);
    stmt.setParameter(1, 99);
    stmt.setParameter(2, saved.id);
    await stmt.executeUpdate();
    await conn.close();

    await expect(docRepo.delete(saved)).rejects.toThrow(OptimisticLockException);

    // Verify entity still exists in DB
    (docRepo as any).getEntityCache().clear();
    const found = await docRepo.findById(saved.id);
    expect(found).not.toBeNull();
  });

  // ──────────────────────────────────────────────
  // Non-versioned entity regression
  // ──────────────────────────────────────────────

  it("save non-versioned entity works normally", async () => {
    const noteRepo = createNoteRepo();
    const saved = await noteRepo.save(makeNote("A simple note"));
    expect(saved.id).toBeDefined();
    expect(saved.text).toBe("A simple note");
  });

  it("update non-versioned entity works normally", async () => {
    const noteRepo = createNoteRepo();
    const saved = await noteRepo.save(makeNote("Original note"));
    saved.text = "Updated note";
    const updated = await noteRepo.save(saved);
    expect(updated.text).toBe("Updated note");
  });

  it("delete non-versioned entity works normally", async () => {
    const noteRepo = createNoteRepo();
    const saved = await noteRepo.save(makeNote("To be deleted"));
    await noteRepo.delete(saved);
    (noteRepo as any).getEntityCache().clear();
    const found = await noteRepo.findById(saved.id);
    expect(found).toBeNull();
  });

  // ──────────────────────────────────────────────
  // Concurrent simulation
  // ──────────────────────────────────────────────

  it("two users: first save succeeds, second save throws, reload shows first user's changes", async () => {
    const docRepo = createDocRepo();
    const saved = await docRepo.save(makeDoc("Concurrent Doc", "Original"));

    // Both users load the same entity
    const user1 = await docRepo.findById(saved.id);
    const user2 = await docRepo.findById(saved.id);

    // User1 saves first — succeeds
    user1!.content = "User1 changes";
    const user1Saved = await docRepo.save(user1!);
    expect(user1Saved.version).toBe(2);

    // User2 tries to save with stale version — throws
    user2!.content = "User2 changes";
    await expect(docRepo.save(user2!)).rejects.toThrow(OptimisticLockException);

    // Reload and verify first user's changes persisted
    (docRepo as any).getEntityCache().clear();
    const reloaded = await docRepo.findById(saved.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.content).toBe("User1 changes");
    expect(reloaded!.version).toBe(2);
  });
});
