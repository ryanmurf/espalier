/**
 * Adversarial tests for @OneToOne decorator (Y3 Q1).
 * Covers: decorator metadata edge cases and DDL generation.
 * Repository E2E tests are in packages/jdbc-pg/src/__tests__/e2e/pg-one-to-one.e2e.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  Column,
  DdlGenerator,
  getEntityMetadata,
  getOneToOneRelations,
  Id,
  ManyToOne,
  OneToOne,
  Table,
} from "../../index.js";

const generator = new DdlGenerator();

// ══════════════════════════════════════════════════
// Section 1: Decorator Metadata Edge Cases
// ══════════════════════════════════════════════════

describe("@OneToOne adversarial: metadata edge cases", () => {
  it("both sides with joinColumn (no mappedBy) — both are owners with redundant FKs", () => {
    @Table("oto_side_a")
    class SideA {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => SideB, joinColumn: "side_b_id" })
      sideB!: SideB;
    }

    @Table("oto_side_b")
    class SideB {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => SideA, joinColumn: "side_a_id" })
      sideA!: SideA;
    }
    new SideA();
    new SideB();

    const aRelations = getOneToOneRelations(SideA);
    const bRelations = getOneToOneRelations(SideB);

    // Both should be owners since neither uses mappedBy
    expect(aRelations).toHaveLength(1);
    expect(aRelations[0].isOwning).toBe(true);
    expect(aRelations[0].joinColumn).toBe("side_b_id");

    expect(bRelations).toHaveLength(1);
    expect(bRelations[0].isOwning).toBe(true);
    expect(bRelations[0].joinColumn).toBe("side_a_id");
  });

  it("both sides with mappedBy — neither is owner, both have isOwning=false", () => {
    @Table("oto_neither_a")
    class NeitherA {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => NeitherB, mappedBy: "neitherA" })
      neitherB!: NeitherB;
    }

    @Table("oto_neither_b")
    class NeitherB {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => NeitherA, mappedBy: "neitherB" })
      neitherA!: NeitherA;
    }
    new NeitherA();
    new NeitherB();

    const aRelations = getOneToOneRelations(NeitherA);
    const bRelations = getOneToOneRelations(NeitherB);

    // Neither side is owning — no FK columns will be generated
    expect(aRelations[0].isOwning).toBe(false);
    expect(aRelations[0].joinColumn).toBeUndefined();
    expect(bRelations[0].isOwning).toBe(false);
    expect(bRelations[0].joinColumn).toBeUndefined();
  });

  it("self-referencing @OneToOne (e.g., User.spouse -> User)", () => {
    @Table("oto_self_ref")
    class SelfRef {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @OneToOne({ target: () => SelfRef, joinColumn: "spouse_id", nullable: true })
      spouse!: SelfRef | null;
    }
    new SelfRef();

    const relations = getOneToOneRelations(SelfRef);
    expect(relations).toHaveLength(1);
    expect(relations[0].target()).toBe(SelfRef);
    expect(relations[0].joinColumn).toBe("spouse_id");
    expect(relations[0].isOwning).toBe(true);
    expect(relations[0].nullable).toBe(true);
  });

  it("multiple @OneToOne on same class targeting the same entity", () => {
    @Table("oto_multi_target_ref")
    class RefTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_multi_target")
    class MultiTarget {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => RefTarget, joinColumn: "primary_ref_id" })
      primaryRef!: RefTarget;
      @OneToOne({ target: () => RefTarget, joinColumn: "secondary_ref_id" })
      secondaryRef!: RefTarget;
    }
    new RefTarget();
    new MultiTarget();

    const relations = getOneToOneRelations(MultiTarget);
    expect(relations).toHaveLength(2);
    const joinColumns = relations.map((r) => r.joinColumn);
    expect(joinColumns).toContain("primary_ref_id");
    expect(joinColumns).toContain("secondary_ref_id");
    expect(relations.every((r) => r.isOwning)).toBe(true);
  });

  it("@OneToOne combined with @ManyToOne on same class", () => {
    @Table("oto_combo_parent")
    class ComboParent {
      @Id @Column() id: number = 0;
    }

    @Table("oto_combo_profile")
    class ComboProfile {
      @Id @Column() id: number = 0;
    }

    @Table("oto_combo_entity")
    class ComboEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => ComboParent, joinColumn: "parent_id" })
      parent!: ComboParent;
      @OneToOne({ target: () => ComboProfile, joinColumn: "profile_id" })
      profile!: ComboProfile;
    }
    new ComboParent();
    new ComboProfile();
    new ComboEntity();

    const metadata = getEntityMetadata(ComboEntity);
    expect(metadata.manyToOneRelations).toHaveLength(1);
    expect(metadata.manyToOneRelations[0].joinColumn).toBe("parent_id");
    expect(metadata.oneToOneRelations).toHaveLength(1);
    expect(metadata.oneToOneRelations[0].joinColumn).toBe("profile_id");
  });

  it("@OneToOne default joinColumn derived from field name + _id", () => {
    @Table("oto_default_jc_target")
    class DefaultJcTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_default_jc")
    class DefaultJc {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DefaultJcTarget })
      myRelation!: DefaultJcTarget;
    }
    new DefaultJcTarget();
    new DefaultJc();

    const relations = getOneToOneRelations(DefaultJc);
    expect(relations[0].joinColumn).toBe("myRelation_id");
  });

  it("orphanRemoval defaults to false", () => {
    @Table("oto_orphan_default_target")
    class OrphanTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_orphan_default")
    class OrphanDefault {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => OrphanTarget })
      ref!: OrphanTarget;
    }
    new OrphanTarget();
    new OrphanDefault();

    const relations = getOneToOneRelations(OrphanDefault);
    expect(relations[0].orphanRemoval).toBe(false);
  });

  it("orphanRemoval = true is stored correctly", () => {
    @Table("oto_orphan_true_target")
    class OrphanTrueTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_orphan_true")
    class OrphanTrue {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => OrphanTrueTarget, orphanRemoval: true })
      ref!: OrphanTrueTarget;
    }
    new OrphanTrueTarget();
    new OrphanTrue();

    const relations = getOneToOneRelations(OrphanTrue);
    expect(relations[0].orphanRemoval).toBe(true);
  });

  it("nullable defaults to true", () => {
    @Table("oto_nullable_default_target")
    class NullableTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_nullable_default")
    class NullableDefault {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => NullableTarget })
      ref!: NullableTarget;
    }
    new NullableTarget();
    new NullableDefault();

    const relations = getOneToOneRelations(NullableDefault);
    expect(relations[0].nullable).toBe(true);
  });

  it("nullable: false is stored correctly", () => {
    @Table("oto_notnull_target")
    class NotNullTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_notnull")
    class NotNull {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => NotNullTarget, nullable: false })
      ref!: NotNullTarget;
    }
    new NotNullTarget();
    new NotNull();

    const relations = getOneToOneRelations(NotNull);
    expect(relations[0].nullable).toBe(false);
  });

  it("inverse side (mappedBy) has no joinColumn and isOwning=false", () => {
    @Table("oto_inv_owner")
    class InvOwner {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => InvInverse, joinColumn: "inverse_id" })
      inverse!: InvInverse;
    }

    @Table("oto_inv_inverse")
    class InvInverse {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => InvOwner, mappedBy: "inverse" })
      owner!: InvOwner;
    }
    new InvOwner();
    new InvInverse();

    const ownerRelations = getOneToOneRelations(InvOwner);
    const inverseRelations = getOneToOneRelations(InvInverse);

    expect(ownerRelations[0].isOwning).toBe(true);
    expect(ownerRelations[0].joinColumn).toBe("inverse_id");

    expect(inverseRelations[0].isOwning).toBe(false);
    expect(inverseRelations[0].joinColumn).toBeUndefined();
    expect(inverseRelations[0].mappedBy).toBe("inverse");
  });

  it("class never instantiated — no metadata until first instantiation", () => {
    @Table("oto_lazy_target")
    class LazyTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_lazy")
    class LazyEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => LazyTarget })
      ref!: LazyTarget;
    }

    // No instantiation — addInitializer hasn't fired
    const relations = getOneToOneRelations(LazyEntity);
    expect(relations).toHaveLength(0);

    // Now instantiate
    new LazyTarget();
    new LazyEntity();
    const afterRelations = getOneToOneRelations(LazyEntity);
    expect(afterRelations).toHaveLength(1);
  });

  it("getOneToOneRelations returns empty for class without @OneToOne", () => {
    @Table("oto_no_rel")
    class NoRel {
      @Id @Column() id: number = 0;
    }
    new NoRel();

    expect(getOneToOneRelations(NoRel)).toEqual([]);
  });

  it("metadata isolates between classes — one class's @OneToOne doesn't leak to another", () => {
    @Table("oto_iso_target")
    class IsoTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_iso_a")
    class IsoA {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => IsoTarget })
      ref!: IsoTarget;
    }

    @Table("oto_iso_b")
    class IsoB {
      @Id @Column() id: number = 0;
    }
    new IsoTarget();
    new IsoA();
    new IsoB();

    expect(getOneToOneRelations(IsoA)).toHaveLength(1);
    expect(getOneToOneRelations(IsoB)).toHaveLength(0);
  });

  it("duplicate instantiation — WeakMap prevents duplicate fields in same position", () => {
    @Table("oto_dup_target")
    class DupTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_dup")
    class DupEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DupTarget })
      ref!: DupTarget;
    }
    new DupTarget();

    new DupEntity();
    const after1 = getOneToOneRelations(DupEntity);

    new DupEntity();
    const after2 = getOneToOneRelations(DupEntity);

    new DupEntity();
    const after3 = getOneToOneRelations(DupEntity);

    // The WeakMap uses Map<fieldName, relation> so duplicate field names
    // should overwrite, NOT accumulate. All lengths should be 1.
    expect(after1).toHaveLength(1);
    expect(after2).toHaveLength(1);
    expect(after3).toHaveLength(1);
  });

  it("inheritance: child class gets parent @OneToOne metadata via constructor delegation", () => {
    @Table("oto_inherit_target")
    class InheritTarget {
      @Id @Column() id: number = 0;
    }

    @Table("oto_inherit_parent")
    class InheritParent {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => InheritTarget })
      ref!: InheritTarget;
    }

    @Table("oto_inherit_child")
    class InheritChild extends InheritParent {
      @Column() extra: string = "";
    }
    new InheritTarget();
    new InheritParent();
    new InheritChild();

    // TC39 addInitializer fires with `this.constructor`, so
    // when `new InheritChild()` runs, parent's addInitializer sets
    // metadata on InheritChild's constructor.
    const childRelations = getOneToOneRelations(InheritChild);
    expect(childRelations).toHaveLength(1);
    expect(childRelations[0].target()).toBe(InheritTarget);
  });
});

// ══════════════════════════════════════════════════
// Section 2: DDL Generation Edge Cases
// ══════════════════════════════════════════════════

describe("@OneToOne adversarial: DDL generation", () => {
  it("owner side generates FK column with UNIQUE constraint", () => {
    @Table("ddl_oto_profile")
    class DdlOtoProfile {
      @Id @Column() id: number = 0;
      @Column() bio: string = "";
    }

    @Table("ddl_oto_user")
    class DdlOtoUser {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @OneToOne({ target: () => DdlOtoProfile, joinColumn: "profile_id" })
      profile!: DdlOtoProfile;
    }
    new DdlOtoProfile();
    new DdlOtoUser();

    const sql = generator.generateCreateTable(DdlOtoUser);
    // Must have UNIQUE constraint — this is what distinguishes @OneToOne from @ManyToOne
    expect(sql).toContain('"profile_id"');
    expect(sql).toContain("UNIQUE");
    expect(sql).toContain('REFERENCES "ddl_oto_profile"("id")');
  });

  it("inverse side generates NO FK columns", () => {
    @Table("ddl_oto_inv_owner")
    class DdlInvOwner {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlInvInverse, joinColumn: "inv_id" })
      inverse!: DdlInvInverse;
    }

    @Table("ddl_oto_inv_inverse")
    class DdlInvInverse {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlInvOwner, mappedBy: "inverse" })
      owner!: DdlInvOwner;
    }
    new DdlInvOwner();
    new DdlInvInverse();

    const inverseSql = generator.generateCreateTable(DdlInvInverse);
    // Inverse side should NOT have any REFERENCES or FK columns
    expect(inverseSql).not.toContain("REFERENCES");
    expect(inverseSql).not.toContain("UNIQUE");
    // Should only have the id column
    expect(inverseSql).toContain('"id"');
  });

  it("nullable: false produces NOT NULL FK column", () => {
    @Table("ddl_oto_nn_target")
    class DdlNnTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ddl_oto_nn")
    class DdlNnEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlNnTarget, joinColumn: "target_id", nullable: false })
      target!: DdlNnTarget;
    }
    new DdlNnTarget();
    new DdlNnEntity();

    const sql = generator.generateCreateTable(DdlNnEntity);
    expect(sql).toContain('"target_id" INTEGER NOT NULL UNIQUE');
  });

  it("nullable: true (default) produces FK column without NOT NULL", () => {
    @Table("ddl_oto_null_target")
    class DdlNullTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ddl_oto_null")
    class DdlNullEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlNullTarget })
      ref!: DdlNullTarget;
    }
    new DdlNullTarget();
    new DdlNullEntity();

    const sql = generator.generateCreateTable(DdlNullEntity);
    // Should NOT have NOT NULL before UNIQUE
    expect(sql).not.toMatch(/"ref_id" INTEGER NOT NULL/);
    expect(sql).toContain('"ref_id" INTEGER UNIQUE');
  });

  it("self-referencing @OneToOne generates REFERENCES to own table", () => {
    @Table("ddl_oto_self")
    class DdlSelf {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlSelf, joinColumn: "partner_id", nullable: true })
      partner!: DdlSelf | null;
    }
    new DdlSelf();

    const sql = generator.generateCreateTable(DdlSelf);
    expect(sql).toContain('"partner_id" INTEGER UNIQUE REFERENCES "ddl_oto_self"("id")');
  });

  it("multiple @OneToOne owner-side relations generate multiple FK columns", () => {
    @Table("ddl_oto_multi_a")
    class DdlMultiA {
      @Id @Column() id: number = 0;
    }

    @Table("ddl_oto_multi_b")
    class DdlMultiB {
      @Id @Column() id: number = 0;
    }

    @Table("ddl_oto_multi")
    class DdlMulti {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlMultiA, joinColumn: "a_id" })
      a!: DdlMultiA;
      @OneToOne({ target: () => DdlMultiB, joinColumn: "b_id" })
      b!: DdlMultiB;
    }
    new DdlMultiA();
    new DdlMultiB();
    new DdlMulti();

    const sql = generator.generateCreateTable(DdlMulti);
    expect(sql).toContain('"a_id" INTEGER UNIQUE REFERENCES "ddl_oto_multi_a"("id")');
    expect(sql).toContain('"b_id" INTEGER UNIQUE REFERENCES "ddl_oto_multi_b"("id")');
  });

  it("both sides owner (no mappedBy) — both tables get FK columns", () => {
    @Table("ddl_oto_both_a")
    class DdlBothA {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlBothB, joinColumn: "b_id" })
      b!: DdlBothB;
    }

    @Table("ddl_oto_both_b")
    class DdlBothB {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlBothA, joinColumn: "a_id" })
      a!: DdlBothA;
    }
    new DdlBothA();
    new DdlBothB();

    const sqlA = generator.generateCreateTable(DdlBothA);
    const sqlB = generator.generateCreateTable(DdlBothB);

    // Both should have FK columns since both are owners
    expect(sqlA).toContain('"b_id" INTEGER UNIQUE REFERENCES "ddl_oto_both_b"("id")');
    expect(sqlB).toContain('"a_id" INTEGER UNIQUE REFERENCES "ddl_oto_both_a"("id")');
  });

  it("both sides mappedBy — neither table gets FK columns", () => {
    @Table("ddl_oto_no_fk_a")
    class DdlNoFkA {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlNoFkB, mappedBy: "a" })
      b!: DdlNoFkB;
    }

    @Table("ddl_oto_no_fk_b")
    class DdlNoFkB {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlNoFkA, mappedBy: "b" })
      a!: DdlNoFkA;
    }
    new DdlNoFkA();
    new DdlNoFkB();

    const sqlA = generator.generateCreateTable(DdlNoFkA);
    const sqlB = generator.generateCreateTable(DdlNoFkB);

    // Neither should have REFERENCES since neither is the owner
    expect(sqlA).not.toContain("REFERENCES");
    expect(sqlB).not.toContain("REFERENCES");
  });

  it("IF NOT EXISTS option works with @OneToOne FK columns", () => {
    @Table("ddl_oto_ine_target")
    class DdlIneTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ddl_oto_ine")
    class DdlIne {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DdlIneTarget })
      ref!: DdlIneTarget;
    }
    new DdlIneTarget();
    new DdlIne();

    const sql = generator.generateCreateTable(DdlIne, { ifNotExists: true });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "ddl_oto_ine"');
    expect(sql).toContain("REFERENCES");
  });
});
