/**
 * Adversarial unit tests for cascade operations (Y3 Q1).
 * Covers: cascade metadata parsing, cascade type combinations,
 * "all" expansion, no-cascade defaults, and per-relation-type storage.
 * E2E tests are in packages/jdbc-pg/src/__tests__/e2e/pg-cascade.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  Table,
  Column,
  Id,
  ManyToOne,
  OneToMany,
  ManyToMany,
  OneToOne,
  getManyToOneRelations,
  getOneToManyRelations,
  getManyToManyRelations,
  getOneToOneRelations,
} from "../../index.js";
import type { CascadeType } from "../../index.js";

// ══════════════════════════════════════════════════
// Section 1: parseCascade — Cascade Metadata Parsing
// ══════════════════════════════════════════════════

describe("cascade metadata: parseCascade behavior", () => {
  it("should default to empty cascade set when no cascade option given", () => {
    @Table("csc_defaults")
    class CscDefaults {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscDefaults }) parent!: CscDefaults;
    }
    const inst = new CscDefaults();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade).toBeInstanceOf(Set);
    expect(rels[0].cascade.size).toBe(0);
  });

  it("should parse single string cascade type", () => {
    @Table("csc_single")
    class CscSingle {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscSingle, cascade: "persist" }) parent!: CscSingle;
    }
    const inst = new CscSingle();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.size).toBe(1);
  });

  it("should parse array of cascade types", () => {
    @Table("csc_array")
    class CscArray {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscArray, cascade: ["persist", "merge"] }) parent!: CscArray;
    }
    const inst = new CscArray();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.has("merge")).toBe(true);
    expect(rels[0].cascade.has("remove")).toBe(false);
    expect(rels[0].cascade.has("refresh")).toBe(false);
    expect(rels[0].cascade.size).toBe(2);
  });

  it("should expand 'all' to persist, merge, remove, refresh", () => {
    @Table("csc_all")
    class CscAll {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscAll, cascade: "all" }) parent!: CscAll;
    }
    const inst = new CscAll();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.has("merge")).toBe(true);
    expect(rels[0].cascade.has("remove")).toBe(true);
    expect(rels[0].cascade.has("refresh")).toBe(true);
    // "all" should NOT be in the set itself — only the 4 concrete types
    expect(rels[0].cascade.has("all" as CascadeType)).toBe(false);
    expect(rels[0].cascade.size).toBe(4);
  });

  it("should deduplicate when 'all' combined with individual types", () => {
    @Table("csc_all_dup")
    class CscAllDup {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({
        target: () => CscAllDup,
        cascade: ["all", "persist", "remove"],
      })
      parent!: CscAllDup;
    }
    const inst = new CscAllDup();
    const rels = getManyToOneRelations(inst.constructor);
    // Set deduplicates, so still 4 concrete types
    expect(rels[0].cascade.size).toBe(4);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.has("merge")).toBe(true);
    expect(rels[0].cascade.has("remove")).toBe(true);
    expect(rels[0].cascade.has("refresh")).toBe(true);
  });

  it("should handle empty array cascade", () => {
    @Table("csc_empty_arr")
    class CscEmptyArr {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscEmptyArr, cascade: [] }) parent!: CscEmptyArr;
    }
    const inst = new CscEmptyArr();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade.size).toBe(0);
  });

  it("should handle all four individual cascade types in array", () => {
    @Table("csc_four")
    class CscFour {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({
        target: () => CscFour,
        cascade: ["persist", "merge", "remove", "refresh"],
      })
      parent!: CscFour;
    }
    const inst = new CscFour();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade.size).toBe(4);
  });
});

// ══════════════════════════════════════════════════
// Section 2: Cascade Metadata on All Relation Types
// ══════════════════════════════════════════════════

describe("cascade metadata: stored on all relation types", () => {
  @Table("csc_target")
  class CscTarget {
    @Id @Column({ type: "SERIAL" }) id: number = 0;
    @Column() name: string = "";
  }

  it("@ManyToOne stores cascade set", () => {
    @Table("csc_mto")
    class CscMto {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscTarget, cascade: ["persist", "merge"] })
      target!: CscTarget;
    }
    const inst = new CscMto();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].cascade).toBeInstanceOf(Set);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.has("merge")).toBe(true);
  });

  it("@OneToMany stores cascade set", () => {
    @Table("csc_otm")
    class CscOtm {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @OneToMany({ target: () => CscTarget, mappedBy: "parent", cascade: "all" })
      children!: CscTarget[];
    }
    const inst = new CscOtm();
    const rels = getOneToManyRelations(inst.constructor);
    expect(rels[0].cascade.size).toBe(4);
    expect(rels[0].cascade.has("remove")).toBe(true);
  });

  it("@ManyToMany stores cascade set", () => {
    @Table("csc_mtm")
    class CscMtm {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToMany({
        target: () => CscTarget,
        joinTable: { name: "csc_mtm_targets", joinColumn: "mtm_id", inverseJoinColumn: "target_id" },
        cascade: ["persist", "remove"],
      })
      targets!: CscTarget[];
    }
    const inst = new CscMtm();
    const rels = getManyToManyRelations(inst.constructor);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.has("remove")).toBe(true);
    expect(rels[0].cascade.has("merge")).toBe(false);
    expect(rels[0].cascade.has("refresh")).toBe(false);
    expect(rels[0].cascade.size).toBe(2);
  });

  it("@OneToOne (owning) stores cascade set", () => {
    @Table("csc_oto_own")
    class CscOtoOwn {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @OneToOne({ target: () => CscTarget, joinColumn: "target_id", cascade: "remove" })
      target!: CscTarget;
    }
    const inst = new CscOtoOwn();
    const rels = getOneToOneRelations(inst.constructor);
    expect(rels[0].cascade.has("remove")).toBe(true);
    expect(rels[0].cascade.size).toBe(1);
  });

  it("@OneToOne (inverse) stores cascade set", () => {
    @Table("csc_oto_inv")
    class CscOtoInv {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @OneToOne({ target: () => CscTarget, mappedBy: "parent", cascade: ["persist", "refresh"] })
      target!: CscTarget;
    }
    const inst = new CscOtoInv();
    const rels = getOneToOneRelations(inst.constructor);
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.has("refresh")).toBe(true);
    expect(rels[0].cascade.has("remove")).toBe(false);
    expect(rels[0].cascade.size).toBe(2);
  });
});

// ══════════════════════════════════════════════════
// Section 3: Cascade Edge Cases and Combinations
// ══════════════════════════════════════════════════

describe("cascade metadata: edge cases", () => {
  @Table("csc_edge_target")
  class CscEdgeTarget {
    @Id @Column({ type: "SERIAL" }) id: number = 0;
  }

  it("cascade with lazy: true — both stored independently", () => {
    @Table("csc_lazy")
    class CscLazy {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscEdgeTarget, cascade: "all", lazy: true })
      target!: CscEdgeTarget;
    }
    const inst = new CscLazy();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].lazy).toBe(true);
    expect(rels[0].cascade.size).toBe(4);
  });

  it("cascade with fetch strategy — both stored independently", () => {
    @Table("csc_fetch")
    class CscFetch {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscEdgeTarget, cascade: ["persist"], fetch: "JOIN" })
      target!: CscEdgeTarget;
    }
    const inst = new CscFetch();
    const rels = getManyToOneRelations(inst.constructor);
    expect(rels[0].fetchStrategy).toBe("JOIN");
    expect(rels[0].cascade.has("persist")).toBe(true);
    expect(rels[0].cascade.size).toBe(1);
  });

  it("multiple relations on same entity each have independent cascade sets", () => {
    @Table("csc_multi_target")
    class CscMultiTarget {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
    }

    @Table("csc_multi")
    class CscMulti {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @ManyToOne({ target: () => CscMultiTarget, joinColumn: "a_id", cascade: "persist" })
      relA!: CscMultiTarget;
      @ManyToOne({ target: () => CscMultiTarget, joinColumn: "b_id", cascade: "remove" })
      relB!: CscMultiTarget;
    }
    const inst = new CscMulti();
    const rels = getManyToOneRelations(inst.constructor);
    const relA = rels.find(r => String(r.fieldName) === "relA")!;
    const relB = rels.find(r => String(r.fieldName) === "relB")!;
    expect(relA.cascade.has("persist")).toBe(true);
    expect(relA.cascade.has("remove")).toBe(false);
    expect(relB.cascade.has("remove")).toBe(true);
    expect(relB.cascade.has("persist")).toBe(false);
  });

  it("cascade 'remove' only — no persist or merge", () => {
    @Table("csc_rm_only")
    class CscRmOnly {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @OneToMany({ target: () => CscEdgeTarget, mappedBy: "parent", cascade: "remove" })
      children!: CscEdgeTarget[];
    }
    const inst = new CscRmOnly();
    const rels = getOneToManyRelations(inst.constructor);
    expect(rels[0].cascade.has("remove")).toBe(true);
    expect(rels[0].cascade.has("persist")).toBe(false);
    expect(rels[0].cascade.has("merge")).toBe(false);
    expect(rels[0].cascade.has("refresh")).toBe(false);
    expect(rels[0].cascade.size).toBe(1);
  });

  it("cascade 'refresh' only — no persist, merge, or remove", () => {
    @Table("csc_ref_only")
    class CscRefOnly {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @OneToOne({ target: () => CscEdgeTarget, joinColumn: "target_id", cascade: "refresh" })
      target!: CscEdgeTarget;
    }
    const inst = new CscRefOnly();
    const rels = getOneToOneRelations(inst.constructor);
    expect(rels[0].cascade.has("refresh")).toBe(true);
    expect(rels[0].cascade.size).toBe(1);
  });
});
