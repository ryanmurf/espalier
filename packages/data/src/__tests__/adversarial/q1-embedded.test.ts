/**
 * Adversarial tests for @Embeddable/@Embedded decorators (Y3 Q1).
 * Covers: decorator metadata edge cases, DDL generation, change tracking.
 * Repository E2E tests are in packages/jdbc-pg/src/__tests__/e2e/pg-embedded.e2e.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  Column,
  DdlGenerator,
  Embeddable,
  Embedded,
  getEmbeddedFields,
  getEntityMetadata,
  Id,
  isEmbeddable,
  Table,
} from "../../index.js";
import { EntityChangeTracker } from "../../mapping/change-tracker.js";

const generator = new DdlGenerator();

// ══════════════════════════════════════════════════
// Section 1: Decorator Metadata Edge Cases
// ══════════════════════════════════════════════════

describe("@Embeddable/@Embedded adversarial: metadata edge cases", () => {
  it("@Embeddable marks a class as embeddable", () => {
    @Embeddable
    class Address {
      @Column() street: string = "";
      @Column() city: string = "";
    }
    new Address();
    expect(isEmbeddable(Address)).toBe(true);
  });

  it("class without @Embeddable is not embeddable", () => {
    class NotEmbeddable {
      @Column() foo: string = "";
    }
    expect(isEmbeddable(NotEmbeddable)).toBe(false);
  });

  it("@Embedded without @Embeddable on target — getEntityMetadata throws", () => {
    class BadTarget {
      @Column() value: string = "";
    }

    @Table("emb_no_embeddable")
    class BadEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => BadTarget, prefix: "t_" })
      thing!: BadTarget;
    }
    new BadTarget();
    new BadEntity();

    expect(() => getEntityMetadata(BadEntity)).toThrow(/not decorated with @Embeddable/);
  });

  it("@Embedded with empty prefix — columns use embeddable's column names directly", () => {
    @Embeddable
    class EmptyPrefixAddr {
      @Column() street: string = "";
      @Column() city: string = "";
    }

    @Table("emb_empty_prefix")
    class EmptyPrefixEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => EmptyPrefixAddr })
      address!: EmptyPrefixAddr;
    }
    new EmptyPrefixAddr();
    new EmptyPrefixEntity();

    const metadata = getEntityMetadata(EmptyPrefixEntity);
    const embFields = metadata.fields.filter(
      (f) => typeof f.fieldName === "string" && f.fieldName.startsWith("address."),
    );
    // With empty prefix, column names should be the raw column names
    const columnNames = embFields.map((f) => f.columnName);
    expect(columnNames).toContain("street");
    expect(columnNames).toContain("city");
  });

  it("@Embedded with prefix — columns are prefixed", () => {
    @Embeddable
    class PrefixAddr {
      @Column() street: string = "";
      @Column() city: string = "";
    }

    @Table("emb_prefix")
    class PrefixEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => PrefixAddr, prefix: "home_" })
      home!: PrefixAddr;
    }
    new PrefixAddr();
    new PrefixEntity();

    const metadata = getEntityMetadata(PrefixEntity);
    const embFields = metadata.fields.filter((f) => typeof f.fieldName === "string" && f.fieldName.startsWith("home."));
    const columnNames = embFields.map((f) => f.columnName);
    expect(columnNames).toContain("home_street");
    expect(columnNames).toContain("home_city");
  });

  it("two @Embedded of same type with different prefixes", () => {
    @Embeddable
    class DualAddr {
      @Column() street: string = "";
      @Column() city: string = "";
    }

    @Table("emb_dual")
    class DualEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => DualAddr, prefix: "home_" })
      homeAddress!: DualAddr;
      @Embedded({ target: () => DualAddr, prefix: "work_" })
      workAddress!: DualAddr;
    }
    new DualAddr();
    new DualEntity();

    const metadata = getEntityMetadata(DualEntity);
    const homeFields = metadata.fields.filter(
      (f) => typeof f.fieldName === "string" && f.fieldName.startsWith("homeAddress."),
    );
    const workFields = metadata.fields.filter(
      (f) => typeof f.fieldName === "string" && f.fieldName.startsWith("workAddress."),
    );

    expect(homeFields.map((f) => f.columnName)).toContain("home_street");
    expect(homeFields.map((f) => f.columnName)).toContain("home_city");
    expect(workFields.map((f) => f.columnName)).toContain("work_street");
    expect(workFields.map((f) => f.columnName)).toContain("work_city");
  });

  it("nested @Embedded — should throw", () => {
    @Embeddable
    class InnerEmb {
      @Column() value: string = "";
    }

    @Embeddable
    class OuterEmb {
      @Column() label: string = "";
      @Embedded({ target: () => InnerEmb, prefix: "inner_" })
      inner!: InnerEmb;
    }

    @Table("emb_nested")
    class NestedEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => OuterEmb, prefix: "outer_" })
      outer!: OuterEmb;
    }
    new InnerEmb();
    new OuterEmb();
    new NestedEntity();

    expect(() => getEntityMetadata(NestedEntity)).toThrow(/Nested @Embedded is not supported/);
  });

  it("@Embeddable class with no @Column fields — metadata has no embedded columns", () => {
    @Embeddable
    class EmptyEmb {}

    @Table("emb_empty_cols")
    class EmptyColsEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => EmptyEmb, prefix: "e_" })
      empty!: EmptyEmb;
    }
    new EmptyEmb();
    new EmptyColsEntity();

    const metadata = getEntityMetadata(EmptyColsEntity);
    const embFields = metadata.fields.filter(
      (f) => typeof f.fieldName === "string" && f.fieldName.startsWith("empty."),
    );
    expect(embFields).toHaveLength(0);
  });

  it("getEmbeddedFields returns empty for class without @Embedded", () => {
    @Table("emb_none")
    class NoEmbEntity {
      @Id @Column() id: number = 0;
    }
    new NoEmbEntity();

    expect(getEmbeddedFields(NoEmbEntity)).toEqual([]);
  });

  it("getEmbeddedFields does not leak between classes", () => {
    @Embeddable
    class IsoEmb {
      @Column() val: string = "";
    }

    @Table("emb_iso_a")
    class IsoA {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => IsoEmb, prefix: "a_" })
      emb!: IsoEmb;
    }

    @Table("emb_iso_b")
    class IsoB {
      @Id @Column() id: number = 0;
    }
    new IsoEmb();
    new IsoA();
    new IsoB();

    expect(getEmbeddedFields(IsoA)).toHaveLength(1);
    expect(getEmbeddedFields(IsoB)).toHaveLength(0);
  });

  it("duplicate instantiation doesn't duplicate embedded fields", () => {
    @Embeddable
    class DupEmb {
      @Column() val: string = "";
    }

    @Table("emb_dup")
    class DupEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => DupEmb, prefix: "d_" })
      emb!: DupEmb;
    }
    new DupEmb();
    new DupEntity();
    new DupEntity();
    new DupEntity();

    const fields = getEmbeddedFields(DupEntity);
    expect(fields).toHaveLength(1);
  });

  it("@Embedded with custom column names in embeddable class", () => {
    @Embeddable
    class CustomColEmb {
      @Column({ name: "postal_code" }) zip: string = "";
      @Column({ name: "country_name" }) country: string = "";
    }

    @Table("emb_custom_col")
    class CustomColEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => CustomColEmb, prefix: "addr_" })
      address!: CustomColEmb;
    }
    new CustomColEmb();
    new CustomColEntity();

    const metadata = getEntityMetadata(CustomColEntity);
    const embFields = metadata.fields.filter(
      (f) => typeof f.fieldName === "string" && f.fieldName.startsWith("address."),
    );
    const columnNames = embFields.map((f) => f.columnName);
    // Prefix should be applied to the custom column names
    expect(columnNames).toContain("addr_postal_code");
    expect(columnNames).toContain("addr_country_name");
  });
});

// ══════════════════════════════════════════════════
// Section 2: DDL Generation Edge Cases
// ══════════════════════════════════════════════════

describe("@Embeddable/@Embedded adversarial: DDL generation", () => {
  it("generates prefixed columns for @Embedded fields in DDL", () => {
    @Embeddable
    class DdlAddr {
      @Column() street: string = "";
      @Column() city: string = "";
    }

    @Table("ddl_emb_basic")
    class DdlBasicEntity {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @Embedded({ target: () => DdlAddr, prefix: "home_" })
      homeAddress!: DdlAddr;
    }
    new DdlAddr();
    new DdlBasicEntity();

    const sql = generator.generateCreateTable(DdlBasicEntity);
    expect(sql).toContain('"id"');
    expect(sql).toContain('"name"');
    expect(sql).toContain('"home_street"');
    expect(sql).toContain('"home_city"');
  });

  it("embedded columns preserve type metadata from @Column", () => {
    @Embeddable
    class TypedEmb {
      @Column({ type: "VARCHAR(100)" }) label: string = "";
      @Column({ type: "INTEGER" }) count: number = 0;
      @Column({ type: "BOOLEAN" }) active: boolean = false;
    }

    @Table("ddl_emb_typed")
    class TypedEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => TypedEmb, prefix: "t_" })
      meta!: TypedEmb;
    }
    new TypedEmb();
    new TypedEntity();

    const sql = generator.generateCreateTable(TypedEntity);
    expect(sql).toContain('"t_label" VARCHAR(100)');
    expect(sql).toContain('"t_count" INTEGER');
    expect(sql).toContain('"t_active" BOOLEAN');
  });

  it("two @Embedded of same type generates distinct prefixed columns", () => {
    @Embeddable
    class DualDdlAddr {
      @Column() street: string = "";
      @Column() zip: string = "";
    }

    @Table("ddl_emb_dual")
    class DualDdlEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => DualDdlAddr, prefix: "home_" })
      home!: DualDdlAddr;
      @Embedded({ target: () => DualDdlAddr, prefix: "work_" })
      work!: DualDdlAddr;
    }
    new DualDdlAddr();
    new DualDdlEntity();

    const sql = generator.generateCreateTable(DualDdlEntity);
    expect(sql).toContain('"home_street"');
    expect(sql).toContain('"home_zip"');
    expect(sql).toContain('"work_street"');
    expect(sql).toContain('"work_zip"');
  });

  it("empty prefix — columns use embeddable names directly in DDL", () => {
    @Embeddable
    class NoPrefixEmb {
      @Column() x: number = 0;
      @Column() y: number = 0;
    }

    @Table("ddl_emb_noprefix")
    class NoPrefixEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => NoPrefixEmb })
      point!: NoPrefixEmb;
    }
    new NoPrefixEmb();
    new NoPrefixEntity();

    const sql = generator.generateCreateTable(NoPrefixEntity);
    expect(sql).toContain('"x"');
    expect(sql).toContain('"y"');
  });

  it("IF NOT EXISTS with @Embedded columns", () => {
    @Embeddable
    class IneEmb {
      @Column() val: string = "";
    }

    @Table("ddl_emb_ine")
    class IneEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => IneEmb, prefix: "e_" })
      emb!: IneEmb;
    }
    new IneEmb();
    new IneEntity();

    const sql = generator.generateCreateTable(IneEntity, { ifNotExists: true });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "ddl_emb_ine"');
    expect(sql).toContain('"e_val"');
  });

  it("@Embedded with @Column({ length }) — VARCHAR(N) preserved", () => {
    @Embeddable
    class LengthEmb {
      @Column({ length: 50 }) short: string = "";
      @Column({ length: 255 }) long: string = "";
    }

    @Table("ddl_emb_length")
    class LengthEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => LengthEmb, prefix: "l_" })
      data!: LengthEmb;
    }
    new LengthEmb();
    new LengthEntity();

    const sql = generator.generateCreateTable(LengthEntity);
    expect(sql).toContain('"l_short" VARCHAR(50)');
    expect(sql).toContain('"l_long" VARCHAR(255)');
  });
});

// ══════════════════════════════════════════════════
// Section 3: Change Tracking with Embedded Fields
// ══════════════════════════════════════════════════

describe("@Embeddable/@Embedded adversarial: change tracking", () => {
  it("modify embedded field — isDirty detects it", () => {
    @Embeddable
    class CtAddr {
      @Column() street: string = "";
      @Column() city: string = "";
    }

    @Table("ct_emb_dirty")
    class CtEntity {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @Embedded({ target: () => CtAddr, prefix: "home_" })
      home!: CtAddr;
    }
    new CtAddr();
    new CtEntity();

    const metadata = getEntityMetadata(CtEntity);
    const tracker = new EntityChangeTracker<CtEntity>(metadata);

    const entity = Object.assign(Object.create(CtEntity.prototype), {
      id: 1,
      name: "Alice",
      home: Object.assign(Object.create(CtAddr.prototype), {
        street: "123 Main",
        city: "Springfield",
      }),
    }) as CtEntity;

    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);

    // Modify embedded field
    entity.home.street = "456 Oak";
    expect(tracker.isDirty(entity)).toBe(true);

    const dirtyFields = tracker.getDirtyFields(entity);
    expect(dirtyFields).toHaveLength(1);
    expect(dirtyFields[0].field).toBe("home.street");
    expect(dirtyFields[0].columnName).toBe("home_street");
    expect(dirtyFields[0].oldValue).toBe("123 Main");
    expect(dirtyFields[0].newValue).toBe("456 Oak");
  });

  it("replace entire embedded object — isDirty detects all embedded fields changed", () => {
    @Embeddable
    class ReplAddr {
      @Column() street: string = "";
      @Column() city: string = "";
    }

    @Table("ct_emb_replace")
    class ReplEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => ReplAddr, prefix: "r_" })
      addr!: ReplAddr;
    }
    new ReplAddr();
    new ReplEntity();

    const metadata = getEntityMetadata(ReplEntity);
    const tracker = new EntityChangeTracker<ReplEntity>(metadata);

    const entity = Object.assign(Object.create(ReplEntity.prototype), {
      id: 1,
      addr: Object.assign(Object.create(ReplAddr.prototype), {
        street: "Old St",
        city: "Old City",
      }),
    }) as ReplEntity;

    tracker.snapshot(entity);

    // Replace entire embedded object
    entity.addr = Object.assign(Object.create(ReplAddr.prototype), {
      street: "New St",
      city: "New City",
    });

    expect(tracker.isDirty(entity)).toBe(true);
    const dirtyFields = tracker.getDirtyFields(entity);
    expect(dirtyFields).toHaveLength(2);
    const fieldNames = dirtyFields.map((d) => d.field);
    expect(fieldNames).toContain("addr.street");
    expect(fieldNames).toContain("addr.city");
  });

  it("set embedded to null from non-null — isDirty detects changes", () => {
    @Embeddable
    class NullAddr {
      @Column() street: string = "";
    }

    @Table("ct_emb_null")
    class NullEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => NullAddr, prefix: "n_" })
      addr!: NullAddr | null;
    }
    new NullAddr();
    new NullEntity();

    const metadata = getEntityMetadata(NullEntity);
    const tracker = new EntityChangeTracker<NullEntity>(metadata);

    const entity = Object.assign(Object.create(NullEntity.prototype), {
      id: 1,
      addr: Object.assign(Object.create(NullAddr.prototype), {
        street: "Has St",
      }),
    }) as NullEntity;

    tracker.snapshot(entity);

    // Set to null
    (entity as any).addr = null;
    expect(tracker.isDirty(entity)).toBe(true);

    const dirtyFields = tracker.getDirtyFields(entity);
    // When addr is null, getFieldValue("addr.street") returns undefined
    expect(dirtyFields.length).toBeGreaterThanOrEqual(1);
    const streetChange = dirtyFields.find((d) => d.field === "addr.street");
    expect(streetChange).toBeDefined();
    expect(streetChange!.oldValue).toBe("Has St");
    expect(streetChange!.newValue).toBeUndefined();
  });

  it("no change to embedded — isDirty returns false", () => {
    @Embeddable
    class StableAddr {
      @Column() street: string = "";
    }

    @Table("ct_emb_stable")
    class StableEntity {
      @Id @Column() id: number = 0;
      @Embedded({ target: () => StableAddr, prefix: "s_" })
      addr!: StableAddr;
    }
    new StableAddr();
    new StableEntity();

    const metadata = getEntityMetadata(StableEntity);
    const tracker = new EntityChangeTracker<StableEntity>(metadata);

    const entity = Object.assign(Object.create(StableEntity.prototype), {
      id: 1,
      addr: Object.assign(Object.create(StableAddr.prototype), {
        street: "Same St",
      }),
    }) as StableEntity;

    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);
    expect(tracker.getDirtyFields(entity)).toHaveLength(0);
  });
});
