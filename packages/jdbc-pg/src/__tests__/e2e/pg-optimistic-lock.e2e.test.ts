import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  Version,
  createDerivedRepository,
  OptimisticLockException,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

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
  let docRepo: ReturnType<typeof createDerivedRepository<LockTestDocument, number>>;
  let noteRepo: ReturnType<typeof createDerivedRepository<LockTestNote, number>>;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_DOCS);
    await stmt.executeUpdate(DROP_NOTES);
    await stmt.executeUpdate(CREATE_DOCS);
    await stmt.executeUpdate(CREATE_NOTES);
    await conn.close();

    docRepo = createDerivedRepository<LockTestDocument, number>(LockTestDocument, ds);
    noteRepo = createDerivedRepository<LockTestNote, number>(LockTestNote, ds);
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
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Doc A",
      content: "Content A",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);
    expect(saved.version).toBe(1);
    expect(saved.id).toBeDefined();
  });

  it("save new entity with version=0 treats as new and sets version to 1", async () => {
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
    const all = await docRepo.findAll();
    const doc = all[0];
    expect(doc.version).toBe(1);

    doc.content = "Updated content v2";
    const saved = await docRepo.save(doc);
    expect(saved.version).toBe(2);
    expect(saved.content).toBe("Updated content v2");
  });

  it("save again increments version from 2 to 3", async () => {
    const all = await docRepo.findAll();
    const doc = all.find((d) => d.version === 2)!;

    doc.content = "Updated content v3";
    const saved = await docRepo.save(doc);
    expect(saved.version).toBe(3);
  });

  it("verify row in DB has correct version after saves", async () => {
    const all = await docRepo.findAll();
    const doc = all.find((d) => d.version === 3);
    expect(doc).toBeDefined();
    expect(doc!.content).toBe("Updated content v3");
  });

  // ──────────────────────────────────────────────
  // UPDATE: conflict
  // ──────────────────────────────────────────────

  it("save with stale version throws OptimisticLockException", async () => {
    // Create a fresh document
    const fresh = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Conflict Doc",
      content: "Original",
    }) as LockTestDocument;
    const saved = await docRepo.save(fresh);
    expect(saved.version).toBe(1);

    // Load it (user1)
    const user1Doc = await docRepo.findById(saved.id)!;
    expect(user1Doc!.version).toBe(1);

    // Simulate concurrent modification: update version in DB directly
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(
      `UPDATE lock_test_documents SET content = $1, version = $2 WHERE id = $3`,
    );
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
    // Create a document and simulate a conflict
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Props Doc",
      content: "Original",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);

    // Bump version in DB
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(
      `UPDATE lock_test_documents SET version = $1 WHERE id = $2`,
    );
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
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "NoMod Doc",
      content: "Original",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);
    const originalVersion = saved.version;

    // Bump version in DB
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(
      `UPDATE lock_test_documents SET version = $1 WHERE id = $2`,
    );
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
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Unchanged Doc",
      content: "Original content",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);

    // Bump version in DB with a specific content
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(
      `UPDATE lock_test_documents SET content = $1, version = $2 WHERE id = $3`,
    );
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
    const reloaded = await docRepo.findById(saved.id);
    expect(reloaded!.content).toBe("DB content");
    expect(reloaded!.version).toBe(2);
  });

  // ──────────────────────────────────────────────
  // DELETE
  // ──────────────────────────────────────────────

  it("delete entity with correct version succeeds", async () => {
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Delete OK",
      content: "To be deleted",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);

    await docRepo.delete(saved);

    const found = await docRepo.findById(saved.id);
    expect(found).toBeNull();
  });

  it("delete entity with stale version throws OptimisticLockException", async () => {
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Delete Fail",
      content: "Should not be deleted",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);

    // Bump version in DB
    const conn = await ds.getConnection();
    const stmt = conn.prepareStatement(
      `UPDATE lock_test_documents SET version = $1 WHERE id = $2`,
    );
    stmt.setParameter(1, 99);
    stmt.setParameter(2, saved.id);
    await stmt.executeUpdate();
    await conn.close();

    await expect(docRepo.delete(saved)).rejects.toThrow(OptimisticLockException);

    // Verify entity still exists in DB
    const found = await docRepo.findById(saved.id);
    expect(found).not.toBeNull();
  });

  // ──────────────────────────────────────────────
  // Non-versioned entity regression
  // ──────────────────────────────────────────────

  it("save non-versioned entity works normally", async () => {
    const note = Object.assign(Object.create(LockTestNote.prototype), {
      text: "A simple note",
    }) as LockTestNote;
    const saved = await noteRepo.save(note);
    expect(saved.id).toBeDefined();
    expect(saved.text).toBe("A simple note");
  });

  it("update non-versioned entity works normally", async () => {
    const all = await noteRepo.findAll();
    const note = all[0];
    note.text = "Updated note";
    const saved = await noteRepo.save(note);
    expect(saved.text).toBe("Updated note");
  });

  it("delete non-versioned entity works normally", async () => {
    const note = Object.assign(Object.create(LockTestNote.prototype), {
      text: "To be deleted",
    }) as LockTestNote;
    const saved = await noteRepo.save(note);
    await noteRepo.delete(saved);
    const found = await noteRepo.findById(saved.id);
    expect(found).toBeNull();
  });

  // ──────────────────────────────────────────────
  // Concurrent simulation
  // ──────────────────────────────────────────────

  it("two users: first save succeeds, second save throws", async () => {
    const doc = Object.assign(Object.create(LockTestDocument.prototype), {
      title: "Concurrent Doc",
      content: "Original",
    }) as LockTestDocument;
    const saved = await docRepo.save(doc);

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
  });

  it("after concurrent conflict, reload shows first user's changes", async () => {
    // Find the concurrent doc
    const all = await docRepo.findAll();
    const doc = all.find((d) => d.title === "Concurrent Doc");
    expect(doc).toBeDefined();
    expect(doc!.content).toBe("User1 changes");
    expect(doc!.version).toBe(2);
  });
});
