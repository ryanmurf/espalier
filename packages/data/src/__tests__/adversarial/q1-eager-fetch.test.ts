/**
 * Adversarial tests for FetchType and eager fetching strategies (Y3 Q1).
 * Covers: decorator metadata (fetchStrategy, batchSize defaults, explicit values),
 * relation-loader JOIN spec generation, and DDL verification.
 * Repository E2E tests are in packages/jdbc-pg/src/__tests__/e2e/pg-eager-fetch.e2e.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  Column,
  getEntityMetadata,
  getManyToManyRelations,
  getManyToOneRelations,
  getOneToManyRelations,
  getOneToOneRelations,
  Id,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  Table,
} from "../../index.js";
import { buildJoinColumns, getJoinFetchSpecs } from "../../repository/relation-loader.js";

// ══════════════════════════════════════════════════
// Section 1: FetchType Metadata Edge Cases
// ══════════════════════════════════════════════════

describe("FetchType adversarial: decorator metadata", () => {
  // --- @ManyToOne ---

  it("@ManyToOne defaults to SELECT fetch strategy", () => {
    @Table("ft_m2o_default_target")
    class Target {
      @Id @Column() id: number = 0;
    }

    @Table("ft_m2o_default")
    class Entity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => Target })
      ref!: Target;
    }
    new Target();
    new Entity();

    const rels = getManyToOneRelations(Entity);
    expect(rels[0].fetchStrategy).toBe("SELECT");
    expect(rels[0].batchSize).toBe(25);
  });

  it("@ManyToOne with fetch: 'JOIN'", () => {
    @Table("ft_m2o_join_target")
    class JTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ft_m2o_join")
    class JEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => JTarget, fetch: "JOIN" })
      ref!: JTarget;
    }
    new JTarget();
    new JEntity();

    const rels = getManyToOneRelations(JEntity);
    expect(rels[0].fetchStrategy).toBe("JOIN");
  });

  it("@ManyToOne with fetch options object", () => {
    @Table("ft_m2o_opts_target")
    class OTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ft_m2o_opts")
    class OEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => OTarget, fetch: { strategy: "BATCH", batchSize: 10 } })
      ref!: OTarget;
    }
    new OTarget();
    new OEntity();

    const rels = getManyToOneRelations(OEntity);
    expect(rels[0].fetchStrategy).toBe("BATCH");
    expect(rels[0].batchSize).toBe(10);
  });

  // --- @OneToMany ---

  it("@OneToMany defaults to SELECT fetch strategy", () => {
    @Table("ft_o2m_d_child")
    class DChild {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => DParent }) parent!: DParent;
    }

    @Table("ft_o2m_d_parent")
    class DParent {
      @Id @Column() id: number = 0;
      @OneToMany({ target: () => DChild, mappedBy: "parent" })
      children!: DChild[];
    }
    new DChild();
    new DParent();

    const rels = getOneToManyRelations(DParent);
    expect(rels[0].fetchStrategy).toBe("SELECT");
    expect(rels[0].batchSize).toBe(25);
  });

  it("@OneToMany with fetch: 'BATCH' and custom batchSize", () => {
    @Table("ft_o2m_b_child")
    class BChild {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => BParent }) parent!: BParent;
    }

    @Table("ft_o2m_b_parent")
    class BParent {
      @Id @Column() id: number = 0;
      @OneToMany({ target: () => BChild, mappedBy: "parent", fetch: { strategy: "BATCH", batchSize: 5 } })
      children!: BChild[];
    }
    new BChild();
    new BParent();

    const rels = getOneToManyRelations(BParent);
    expect(rels[0].fetchStrategy).toBe("BATCH");
    expect(rels[0].batchSize).toBe(5);
  });

  // --- @ManyToMany ---

  it("@ManyToMany defaults to SELECT fetch strategy", () => {
    @Table("ft_m2m_d_tag")
    class DTag {
      @Id @Column() id: number = 0;
    }

    @Table("ft_m2m_d_post")
    class DPost {
      @Id @Column() id: number = 0;
      @ManyToMany({
        target: () => DTag,
        joinTable: { name: "ft_m2m_d_post_tag", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
      })
      tags!: DTag[];
    }
    new DTag();
    new DPost();

    const rels = getManyToManyRelations(DPost);
    expect(rels[0].fetchStrategy).toBe("SELECT");
    expect(rels[0].batchSize).toBe(25);
  });

  it("@ManyToMany with fetch: 'BATCH'", () => {
    @Table("ft_m2m_b_tag")
    class BTag {
      @Id @Column() id: number = 0;
    }

    @Table("ft_m2m_b_post")
    class BPost {
      @Id @Column() id: number = 0;
      @ManyToMany({
        target: () => BTag,
        joinTable: { name: "ft_m2m_b_post_tag", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
        fetch: { strategy: "BATCH", batchSize: 3 },
      })
      tags!: BTag[];
    }
    new BTag();
    new BPost();

    const rels = getManyToManyRelations(BPost);
    expect(rels[0].fetchStrategy).toBe("BATCH");
    expect(rels[0].batchSize).toBe(3);
  });

  // --- @OneToOne ---

  it("@OneToOne defaults to SELECT fetch strategy", () => {
    @Table("ft_o2o_d_target")
    class DTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ft_o2o_d")
    class DEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => DTarget })
      ref!: DTarget;
    }
    new DTarget();
    new DEntity();

    const rels = getOneToOneRelations(DEntity);
    expect(rels[0].fetchStrategy).toBe("SELECT");
    expect(rels[0].batchSize).toBe(25);
  });

  it("@OneToOne with fetch: 'JOIN'", () => {
    @Table("ft_o2o_j_target")
    class JTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ft_o2o_j")
    class JEntity {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => JTarget, fetch: "JOIN" })
      ref!: JTarget;
    }
    new JTarget();
    new JEntity();

    const rels = getOneToOneRelations(JEntity);
    expect(rels[0].fetchStrategy).toBe("JOIN");
  });

  // --- Mixed strategies on same class ---

  it("multiple relations with different fetch strategies on same class", () => {
    @Table("ft_mix_dept")
    class MixDept {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }

    @Table("ft_mix_tag")
    class MixTag {
      @Id @Column() id: number = 0;
    }

    @Table("ft_mix_child")
    class MixChild {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => MixParent }) parent!: MixParent;
    }

    @Table("ft_mix_parent")
    class MixParent {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => MixDept, fetch: "JOIN" })
      department!: MixDept;
      @OneToMany({ target: () => MixChild, mappedBy: "parent", fetch: { strategy: "BATCH", batchSize: 10 } })
      children!: MixChild[];
      @ManyToMany({
        target: () => MixTag,
        joinTable: { name: "ft_mix_parent_tag", joinColumn: "parent_id", inverseJoinColumn: "tag_id" },
        fetch: "SUBSELECT",
      })
      tags!: MixTag[];
    }
    new MixDept();
    new MixTag();
    new MixChild();
    new MixParent();

    const m2o = getManyToOneRelations(MixParent);
    expect(m2o[0].fetchStrategy).toBe("JOIN");

    const o2m = getOneToManyRelations(MixParent);
    expect(o2m[0].fetchStrategy).toBe("BATCH");
    expect(o2m[0].batchSize).toBe(10);

    const m2m = getManyToManyRelations(MixParent);
    expect(m2m[0].fetchStrategy).toBe("SUBSELECT");
  });

  // --- Default batchSize ---

  it("batchSize defaults to 25 when not specified", () => {
    @Table("ft_bs_target")
    class BsTarget {
      @Id @Column() id: number = 0;
    }

    @Table("ft_bs")
    class BsEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => BsTarget, fetch: "BATCH" })
      ref!: BsTarget;
    }
    new BsTarget();
    new BsEntity();

    const rels = getManyToOneRelations(BsEntity);
    expect(rels[0].fetchStrategy).toBe("BATCH");
    expect(rels[0].batchSize).toBe(25);
  });
});

// ══════════════════════════════════════════════════
// Section 2: JOIN Fetch Spec Generation
// ══════════════════════════════════════════════════

describe("FetchType adversarial: JOIN spec generation", () => {
  it("getJoinFetchSpecs returns specs for JOIN-fetched @ManyToOne relations", () => {
    @Table("js_m2o_dept")
    class JsDept {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }

    @Table("js_m2o_emp")
    class JsEmp {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => JsDept, fetch: "JOIN" })
      department!: JsDept;
    }
    new JsDept();
    new JsEmp();

    const metadata = getEntityMetadata(JsEmp);
    const specs = getJoinFetchSpecs(metadata);
    expect(specs).toHaveLength(1);
    expect(specs[0].alias).toBe("j0");
    expect(specs[0].targetMetadata.tableName).toBe("js_m2o_dept");
  });

  it("getJoinFetchSpecs excludes non-JOIN @ManyToOne relations", () => {
    @Table("js_excl_dept")
    class ExclDept {
      @Id @Column() id: number = 0;
    }

    @Table("js_excl_emp")
    class ExclEmp {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => ExclDept, fetch: "SELECT" })
      department!: ExclDept;
    }
    new ExclDept();
    new ExclEmp();

    const metadata = getEntityMetadata(ExclEmp);
    const specs = getJoinFetchSpecs(metadata);
    expect(specs).toHaveLength(0);
  });

  it("getJoinFetchSpecs handles @OneToOne with JOIN", () => {
    @Table("js_o2o_profile")
    class JsProfile {
      @Id @Column() id: number = 0;
      @Column() bio: string = "";
    }

    @Table("js_o2o_user")
    class JsUser {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => JsProfile, fetch: "JOIN" })
      profile!: JsProfile;
    }
    new JsProfile();
    new JsUser();

    const metadata = getEntityMetadata(JsUser);
    const specs = getJoinFetchSpecs(metadata);
    expect(specs).toHaveLength(1);
    expect(specs[0].targetMetadata.tableName).toBe("js_o2o_profile");
  });

  it("getJoinFetchSpecs excludes inverse-side @OneToOne (no joinColumn)", () => {
    @Table("js_inv_owner")
    class InvOwner {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => InvInverse, joinColumn: "inv_id", fetch: "JOIN" })
      inverse!: InvInverse;
    }

    @Table("js_inv_inverse")
    class InvInverse {
      @Id @Column() id: number = 0;
      @OneToOne({ target: () => InvOwner, mappedBy: "inverse", fetch: "JOIN" })
      owner!: InvOwner;
    }
    new InvOwner();
    new InvInverse();

    const ownerMeta = getEntityMetadata(InvOwner);
    const inverseMeta = getEntityMetadata(InvInverse);

    const ownerSpecs = getJoinFetchSpecs(ownerMeta);
    const inverseSpecs = getJoinFetchSpecs(inverseMeta);

    // Owner has JOIN spec (has joinColumn)
    expect(ownerSpecs).toHaveLength(1);
    // Inverse does NOT (no joinColumn, not owning)
    expect(inverseSpecs).toHaveLength(0);
  });

  it("multiple JOIN relations get incrementing aliases", () => {
    @Table("js_multi_dept")
    class MDept {
      @Id @Column() id: number = 0;
    }

    @Table("js_multi_profile")
    class MProfile {
      @Id @Column() id: number = 0;
    }

    @Table("js_multi_entity")
    class MEntity {
      @Id @Column() id: number = 0;
      @ManyToOne({ target: () => MDept, fetch: "JOIN" }) dept!: MDept;
      @OneToOne({ target: () => MProfile, fetch: "JOIN" }) profile!: MProfile;
    }
    new MDept();
    new MProfile();
    new MEntity();

    const metadata = getEntityMetadata(MEntity);
    const specs = getJoinFetchSpecs(metadata);
    expect(specs).toHaveLength(2);
    expect(specs[0].alias).toBe("j0");
    expect(specs[1].alias).toBe("j1");
  });

  it("buildJoinColumns produces aliased column expressions", () => {
    @Table("jc_dept")
    class JcDept {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }

    @Table("jc_emp")
    class JcEmp {
      @Id @Column() id: number = 0;
      @Column() empName: string = "";
      @ManyToOne({ target: () => JcDept, fetch: "JOIN" })
      department!: JcDept;
    }
    new JcDept();
    new JcEmp();

    const metadata = getEntityMetadata(JcEmp);
    const specs = getJoinFetchSpecs(metadata);
    const cols = buildJoinColumns("jc_emp", metadata.fields, specs);

    // Parent columns: "jc_emp"."id" AS "jc_emp__id", etc.
    expect(cols.some((c) => c.includes('"jc_emp"."id"'))).toBe(true);
    expect(cols.some((c) => c.includes('"jc_emp__id"'))).toBe(true);

    // Joined columns: "j0"."id" AS "j0__id", "j0"."name" AS "j0__name"
    expect(cols.some((c) => c.includes('"j0"."id"'))).toBe(true);
    expect(cols.some((c) => c.includes('"j0__id"'))).toBe(true);
    expect(cols.some((c) => c.includes('"j0"."name"'))).toBe(true);
    expect(cols.some((c) => c.includes('"j0__name"'))).toBe(true);
  });

  it("entity with no JOIN relations returns empty specs", () => {
    @Table("jc_no_join")
    class NoJoin {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }
    new NoJoin();

    const metadata = getEntityMetadata(NoJoin);
    const specs = getJoinFetchSpecs(metadata);
    expect(specs).toHaveLength(0);
  });
});
