/**
 * Adversarial E2E tests for @OneToOne repository integration (Y3 Q1).
 * Tests save/load, constraint violations, self-referencing, dangling FKs,
 * and inverse-side loading against live Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  OneToOne,
  DdlGenerator,
  createRepository,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();
const generator = new DdlGenerator();

// --- E2E Entity Definitions ---

@Table("e2e_oto_profiles")
class E2eProfile {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
}

@Table("e2e_oto_users")
class E2eUser {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
  @OneToOne({ target: () => E2eProfile, joinColumn: "profile_id", nullable: true })
  profile!: E2eProfile | null;
}

@Table("e2e_oto_user_inv")
class E2eUserInv {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
  @OneToOne({ target: () => E2eProfileInv, joinColumn: "profile_id" })
  profile!: E2eProfileInv;
}

@Table("e2e_oto_profiles_inv")
class E2eProfileInv {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
  @OneToOne({ target: () => E2eUserInv, mappedBy: "profile" })
  user!: E2eUserInv;
}

// Self-referencing
@Table("e2e_oto_nodes")
class E2eNode {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() label: string = "";
  @OneToOne({ target: () => E2eNode, joinColumn: "next_id", nullable: true })
  next!: E2eNode | null;
}

// Non-null @OneToOne
@Table("e2e_oto_required_profiles")
class E2eRequiredProfile {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
}

@Table("e2e_oto_required_users")
class E2eRequiredUser {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
  @OneToOne({ target: () => E2eRequiredProfile, joinColumn: "profile_id", nullable: false })
  profile!: E2eRequiredProfile;
}

// Instantiate all to register metadata
new E2eProfile();
new E2eUser();
new E2eUserInv();
new E2eProfileInv();
new E2eNode();
new E2eRequiredProfile();
new E2eRequiredUser();

// Helper: create entity without id (id=undefined triggers INSERT path).
// Using `new Entity()` sets id=0, which the save logic treats as UPDATE (known issue #46).
function newEntity<T>(cls: new (...args: any[]) => T, fields: Partial<T>): T {
  return Object.assign(Object.create(cls.prototype), fields) as T;
}

describe.skipIf(!canConnect)("@OneToOne adversarial: repository E2E (Postgres)", () => {
  let ds: PgDataSource;
  let conn: Connection;

  const ALL_TABLES = [
    "e2e_oto_required_users",
    "e2e_oto_required_profiles",
    "e2e_oto_nodes",
    "e2e_oto_user_inv",
    "e2e_oto_profiles_inv",
    "e2e_oto_users",
    "e2e_oto_profiles",
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();

    const stmt = conn.createStatement();
    // Drop in reverse-dependency order
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    // Create tables in dependency order: referenced tables first
    await stmt.executeUpdate(generator.generateCreateTable(E2eProfile));
    await stmt.executeUpdate(generator.generateCreateTable(E2eUser));
    await stmt.executeUpdate(generator.generateCreateTable(E2eProfileInv));
    await stmt.executeUpdate(generator.generateCreateTable(E2eUserInv));
    await stmt.executeUpdate(generator.generateCreateTable(E2eNode));
    await stmt.executeUpdate(generator.generateCreateTable(E2eRequiredProfile));
    await stmt.executeUpdate(generator.generateCreateTable(E2eRequiredUser));
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      for (const table of ALL_TABLES) {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  async function clearAllData() {
    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DELETE FROM ${table}`);
    }
  }

  // ─── DDL Verification ───

  describe("DDL schema verification", () => {
    it("owner-side FK column has UNIQUE constraint in the actual database", async () => {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(`
        SELECT c.contype
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 'e2e_oto_users'
          AND c.contype = 'u'
      `);
      const constraints: string[] = [];
      while (await rs.next()) {
        constraints.push(rs.getString("contype")!);
      }
      // Should have at least one UNIQUE constraint (for profile_id)
      expect(constraints.length).toBeGreaterThanOrEqual(1);
    });

    it("inverse side table has no FK columns from @OneToOne", async () => {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'e2e_oto_profiles'
        ORDER BY ordinal_position
      `);
      const columns: string[] = [];
      while (await rs.next()) {
        columns.push(rs.getString("column_name")!);
      }
      // Profile table should only have id and bio
      expect(columns).toEqual(["id", "bio"]);
    });

    it("NOT NULL FK column is enforced in the database", async () => {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_name = 'e2e_oto_required_users'
          AND column_name = 'profile_id'
      `);
      await rs.next();
      expect(rs.getString("is_nullable")).toBe("NO");
    });
  });

  // ─── Save/Load Basic ───

  describe("save and load", () => {
    it("save entity with null @OneToOne relation", async () => {
      await clearAllData();

      const repo = createRepository<E2eUser, number>(E2eUser, ds);
      const user = newEntity(E2eUser, { name: "NoProfile" });

      const saved = await repo.save(user);
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.name).toBe("NoProfile");
    });

    it("save entity with @OneToOne relation then load — related entity loaded", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      // Save the profile first
      const profile = newEntity(E2eProfile, { bio: "Test bio" });
      const savedProfile = await profileRepo.save(profile);
      expect(savedProfile.id).toBeGreaterThan(0);

      // Save the user pointing to the profile
      const user = newEntity(E2eUser, { name: "WithProfile", profile: savedProfile });
      const savedUser = await userRepo.save(user);
      expect(savedUser.id).toBeGreaterThan(0);

      // BUG: save() caches entity without relations loaded, so findById hits cache
      // and returns entity without profile. Use a fresh repo to bypass the stale cache.
      const freshUserRepo = createRepository<E2eUser, number>(E2eUser, ds);
      const loadedUser = await freshUserRepo.findById(savedUser.id);
      expect(loadedUser).not.toBeNull();
      expect(loadedUser!.name).toBe("WithProfile");
      expect(loadedUser!.profile).not.toBeNull();
      expect(loadedUser!.profile!.bio).toBe("Test bio");
      expect(loadedUser!.profile!.id).toBe(savedProfile.id);
    });

    it("inverse side load — related entity loaded via mappedBy", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfileInv, number>(E2eProfileInv, ds);
      const userRepo = createRepository<E2eUserInv, number>(E2eUserInv, ds);

      const profile = newEntity(E2eProfileInv, { bio: "Inverse bio" });
      const savedProfile = await profileRepo.save(profile);

      const user = newEntity(E2eUserInv, { name: "InverseUser", profile: savedProfile });
      const savedUser = await userRepo.save(user);

      // Use fresh repo to avoid stale entity cache from save()
      const freshProfileRepo = createRepository<E2eProfileInv, number>(E2eProfileInv, ds);
      const loadedProfile = await freshProfileRepo.findById(savedProfile.id);
      expect(loadedProfile).not.toBeNull();
      expect(loadedProfile!.user).toBeDefined();
      expect(loadedProfile!.user.name).toBe("InverseUser");
      expect(loadedProfile!.user.id).toBe(savedUser.id);
    });
  });

  // ─── save() preserves relations ───

  describe("save() preserves @OneToOne relation on returned entity", () => {
    it("save() return value includes the @OneToOne relation object", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profile = newEntity(E2eProfile, { bio: "Preserved" });
      const savedProfile = await profileRepo.save(profile);

      const user = newEntity(E2eUser, { name: "PreservedUser", profile: savedProfile });
      const savedUser = await userRepo.save(user);

      // save() now copies relation fields from the original entity
      expect(savedUser.profile).toBeDefined();
      expect(savedUser.profile!.bio).toBe("Preserved");

      // findById from same repo uses cache — profile is present
      const cachedUser = await userRepo.findById(savedUser.id);
      expect(cachedUser!.profile).toBeDefined();
      expect(cachedUser!.profile!.bio).toBe("Preserved");
    });
  });

  // ─── Constraint Violations ───

  describe("constraint violations", () => {
    it("two users pointing to same profile — UNIQUE violation", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profile = newEntity(E2eProfile, { bio: "Shared profile" });
      const savedProfile = await profileRepo.save(profile);

      const user1 = newEntity(E2eUser, { name: "User1", profile: savedProfile });
      await userRepo.save(user1);

      const user2 = newEntity(E2eUser, { name: "User2", profile: savedProfile });

      // Should throw UNIQUE violation — only one user can point to a profile
      await expect(userRepo.save(user2)).rejects.toThrow();
    });

    it("inserting user without required profile — NOT NULL violation", async () => {
      await clearAllData();

      const repo = createRepository<E2eRequiredUser, number>(E2eRequiredUser, ds);
      const user = newEntity(E2eRequiredUser, { name: "MissingProfile" });
      // profile is not set, FK column will be null

      // Should throw NOT NULL constraint violation
      await expect(repo.save(user)).rejects.toThrow();
    });

    it("delete referenced profile while user still points to it — FK violation", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profile = newEntity(E2eProfile, { bio: "Will be deleted" });
      const savedProfile = await profileRepo.save(profile);

      const user = newEntity(E2eUser, { name: "PointsToProfile", profile: savedProfile });
      await userRepo.save(user);

      // Try to delete the profile while user references it
      await expect(profileRepo.delete(savedProfile)).rejects.toThrow();
    });
  });

  // ─── Self-Referencing ───

  describe("self-referencing @OneToOne", () => {
    it("save and load self-referencing chain (A -> B -> null)", async () => {
      await clearAllData();

      const repo = createRepository<E2eNode, number>(E2eNode, ds);

      const nodeB = newEntity(E2eNode, { label: "B" });
      const savedB = await repo.save(nodeB);

      const nodeA = newEntity(E2eNode, { label: "A", next: savedB });
      const savedA = await repo.save(nodeA);

      // Use fresh repo to bypass stale entity cache from save()
      const freshRepo = createRepository<E2eNode, number>(E2eNode, ds);
      const loadedA = await freshRepo.findById(savedA.id);
      expect(loadedA).not.toBeNull();
      expect(loadedA!.label).toBe("A");
      expect(loadedA!.next).not.toBeNull();
      expect(loadedA!.next!.label).toBe("B");
    });

    it("save self-referencing node pointing to itself via raw SQL", async () => {
      await clearAllData();

      const repo = createRepository<E2eNode, number>(E2eNode, ds);

      // Save a node first to get an ID
      const node = newEntity(E2eNode, { label: "Self" });
      const saved = await repo.save(node);

      // Update it to point to itself using raw SQL
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        `UPDATE e2e_oto_nodes SET next_id = ${saved.id} WHERE id = ${saved.id}`,
      );

      // Use fresh repo to bypass stale entity cache from save()
      const freshRepo = createRepository<E2eNode, number>(E2eNode, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.next).not.toBeNull();
      expect(loaded!.next!.id).toBe(saved.id);
      expect(loaded!.next!.label).toBe("Self");
    });

    it("UNIQUE constraint prevents two nodes pointing to the same next", async () => {
      await clearAllData();

      const repo = createRepository<E2eNode, number>(E2eNode, ds);

      const target = newEntity(E2eNode, { label: "Target" });
      const savedTarget = await repo.save(target);

      const nodeA = newEntity(E2eNode, { label: "A", next: savedTarget });
      await repo.save(nodeA);

      const nodeB = newEntity(E2eNode, { label: "B", next: savedTarget });

      // UNIQUE violation — only one node can point to a given next
      await expect(repo.save(nodeB)).rejects.toThrow();
    });
  });

  // ─── Dangling FK ───

  describe("dangling FK (orphaned reference)", () => {
    it("load entity whose @OneToOne FK points to non-existent row — relation is null/undefined", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profile = newEntity(E2eProfile, { bio: "Will be force deleted" });
      const savedProfile = await profileRepo.save(profile);

      const user = newEntity(E2eUser, { name: "DanglingRef", profile: savedProfile });
      const savedUser = await userRepo.save(user);

      // Drop the FK constraint so we can create a dangling reference
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`
        ALTER TABLE e2e_oto_users DROP CONSTRAINT IF EXISTS e2e_oto_users_profile_id_fkey
      `);
      // Point to a non-existent profile
      await stmt.executeUpdate(`
        UPDATE e2e_oto_users SET profile_id = 999999 WHERE id = ${savedUser.id}
      `);

      // Use fresh repo to bypass entity cache (which still has old profile from save())
      const freshRepo = createRepository<E2eUser, number>(E2eUser, ds);
      const loaded = await freshRepo.findById(savedUser.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe("DanglingRef");
      // The relation loader queries for profile with id=999999, which doesn't exist.
      // The field should remain undefined/null (not crash).
      const profileValue = (loaded as any).profile;
      expect(profileValue == null || profileValue === undefined).toBe(true);
    });
  });

  // ─── Update @OneToOne Reference ───

  describe("update @OneToOne reference", () => {
    it("BUG: change @OneToOne reference only — duplicate column assignment in UPDATE", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profileA = newEntity(E2eProfile, { bio: "Profile A" });
      const savedA = await profileRepo.save(profileA);

      const profileB = newEntity(E2eProfile, { bio: "Profile B" });
      const savedB = await profileRepo.save(profileB);

      const user = newEntity(E2eUser, { name: "Swapper", profile: savedA });
      const savedUser = await userRepo.save(user);

      const freshUserRepo = createRepository<E2eUser, number>(E2eUser, ds);
      const loaded1 = await freshUserRepo.findById(savedUser.id);
      expect(loaded1!.profile!.bio).toBe("Profile A");

      // BUG: The ChangeTracker now detects FK changes (adds profile_id as dirty field),
      // but the save code also adds profile_id via the @OneToOne FK loop.
      // This causes "multiple assignments to same column" error in Postgres.
      loaded1!.profile = savedB;
      await expect(freshUserRepo.save(loaded1!)).rejects.toThrow(
        /multiple assignments to same column/,
      );
    });

    it("BUG: change @OneToOne + @Column together — also fails with duplicate column", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profileA = newEntity(E2eProfile, { bio: "Profile A" });
      const savedA = await profileRepo.save(profileA);

      const profileB = newEntity(E2eProfile, { bio: "Profile B" });
      const savedB = await profileRepo.save(profileB);

      const user = newEntity(E2eUser, { name: "Swapper", profile: savedA });
      const savedUser = await userRepo.save(user);

      const freshUserRepo = createRepository<E2eUser, number>(E2eUser, ds);
      const loaded1 = await freshUserRepo.findById(savedUser.id);
      expect(loaded1!.profile!.bio).toBe("Profile A");

      // BUG: Same duplicate column issue
      loaded1!.profile = savedB;
      loaded1!.name = "SwapperUpdated";
      await expect(freshUserRepo.save(loaded1!)).rejects.toThrow(
        /multiple assignments to same column/,
      );
    });

    it("BUG: set @OneToOne to null — also fails with duplicate column", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profile = newEntity(E2eProfile, { bio: "Will be unlinked" });
      const savedProfile = await profileRepo.save(profile);

      const user = newEntity(E2eUser, { name: "WillUnlink", profile: savedProfile });
      const savedUser = await userRepo.save(user);

      // Verify initial state — save() now preserves profile on cached entity
      expect(savedUser.profile).toBeDefined();
      expect(savedUser.profile!.bio).toBe("Will be unlinked");

      // Set to null — this triggers both the ChangeTracker dirty field
      // AND the @OneToOne FK loop in save, causing duplicate column assignment
      savedUser.profile = null;
      await expect(userRepo.save(savedUser)).rejects.toThrow(
        /multiple assignments to same column/,
      );
    });
  });

  // ─── findAll with @OneToOne ───

  describe("findAll with @OneToOne relations", () => {
    it("findAll loads @OneToOne for every result", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      // Create profiles
      const p1 = newEntity(E2eProfile, { bio: "Bio1" });
      const sp1 = await profileRepo.save(p1);

      const p2 = newEntity(E2eProfile, { bio: "Bio2" });
      const sp2 = await profileRepo.save(p2);

      // Create users with profiles
      await userRepo.save(newEntity(E2eUser, { name: "User1", profile: sp1 }));
      await userRepo.save(newEntity(E2eUser, { name: "User2", profile: sp2 }));

      // Also a user with no profile
      await userRepo.save(newEntity(E2eUser, { name: "User3" }));

      const all = await userRepo.findAll();
      expect(all).toHaveLength(3);

      const withProfile = all.filter(u => u.profile != null);
      const withoutProfile = all.filter(u => u.profile == null);

      expect(withProfile).toHaveLength(2);
      expect(withoutProfile).toHaveLength(1);

      // Verify profiles have correct bio
      const bios = withProfile.map(u => u.profile!.bio).sort();
      expect(bios).toEqual(["Bio1", "Bio2"]);
    });
  });

  // ─── Delete owner entity ───

  describe("delete owner entity", () => {
    it("deleting user with profile should succeed (FK is on the user)", async () => {
      await clearAllData();

      const profileRepo = createRepository<E2eProfile, number>(E2eProfile, ds);
      const userRepo = createRepository<E2eUser, number>(E2eUser, ds);

      const profile = newEntity(E2eProfile, { bio: "Owner delete test" });
      const savedProfile = await profileRepo.save(profile);

      const user = newEntity(E2eUser, { name: "WillBeDeleted", profile: savedProfile });
      const savedUser = await userRepo.save(user);

      // Delete the user (FK owner) — should succeed
      await expect(userRepo.delete(savedUser)).resolves.toBeUndefined();

      // Verify user is gone
      const loaded = await userRepo.findById(savedUser.id);
      expect(loaded).toBeNull();

      // Profile should still exist (no cascade delete)
      const loadedProfile = await profileRepo.findById(savedProfile.id);
      expect(loadedProfile).not.toBeNull();
      expect(loadedProfile!.bio).toBe("Owner delete test");
    });
  });
});
