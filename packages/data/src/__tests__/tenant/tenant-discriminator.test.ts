/**
 * Adversarial unit tests for @TenantId decorator and discriminator column metadata (Y3 Q2).
 *
 * Tests: decorator metadata storage/retrieval, getTenantIdField, entity-metadata
 * integration, tenantFilter specification, getTenantColumn, DDL index generation.
 */
import { describe, expect, it } from "vitest";
import { Column, getTenantIdField, Id, Table, TenantId, tenantFilter } from "../../index.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import { DdlGenerator } from "../../schema/ddl-generator.js";
import { getTenantColumn } from "../../tenant/tenant-filter.js";

// ══════════════════════════════════════════════════
// Section 1: @TenantId decorator metadata
// ══════════════════════════════════════════════════

describe("@TenantId decorator — metadata", () => {
  it("stores the field name marked with @TenantId", () => {
    @Table("tid_basic")
    class TidBasic {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column() tenantId!: string;
      @Column() name!: string;
    }
    const inst = new TidBasic();
    expect(getTenantIdField(inst.constructor)).toBe("tenantId");
  });

  it("returns undefined for entity without @TenantId", () => {
    @Table("tid_none")
    class TidNone {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @Column() name!: string;
    }
    const inst = new TidNone();
    expect(getTenantIdField(inst.constructor)).toBeUndefined();
  });

  it("works with custom field name", () => {
    @Table("tid_custom")
    class TidCustom {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column({ name: "org_id" }) organizationId!: string;
    }
    const inst = new TidCustom();
    expect(getTenantIdField(inst.constructor)).toBe("organizationId");
  });
});

// ══════════════════════════════════════════════════
// Section 2: Entity metadata integration
// ══════════════════════════════════════════════════

describe("@TenantId — entity metadata integration", () => {
  it("tenantIdField is set in EntityMetadata", () => {
    @Table("tid_meta")
    class TidMeta {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column() tenantId!: string;
      @Column() data!: string;
    }
    new TidMeta(); // trigger decorator initializers
    const metadata = getEntityMetadata(TidMeta);
    expect(metadata.tenantIdField).toBe("tenantId");
  });

  it("tenantIdField is undefined when no @TenantId", () => {
    @Table("tid_nometa")
    class TidNoMeta {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @Column() data!: string;
    }
    new TidNoMeta();
    const metadata = getEntityMetadata(TidNoMeta);
    expect(metadata.tenantIdField).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Section 3: getTenantColumn
// ══════════════════════════════════════════════════

describe("getTenantColumn", () => {
  it("resolves tenant column name from metadata", () => {
    @Table("tid_col")
    class TidCol {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column({ name: "org_id" }) orgId!: string;
    }
    new TidCol();
    const metadata = getEntityMetadata(TidCol);
    expect(getTenantColumn(metadata)).toBe("org_id");
  });

  it("returns column name matching field name when no explicit column name", () => {
    @Table("tid_col2")
    class TidCol2 {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column() tenantId!: string;
    }
    new TidCol2();
    const metadata = getEntityMetadata(TidCol2);
    // Default column name should be snake_case of field name
    const col = getTenantColumn(metadata);
    expect(col).toBeDefined();
    expect(typeof col).toBe("string");
  });

  it("returns undefined for entity without @TenantId", () => {
    @Table("tid_nocol")
    class TidNoCol {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @Column() data!: string;
    }
    new TidNoCol();
    const metadata = getEntityMetadata(TidNoCol);
    expect(getTenantColumn(metadata)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Section 4: tenantFilter specification
// ══════════════════════════════════════════════════

describe("tenantFilter", () => {
  it("creates a Specification with equality criteria on tenant column", () => {
    @Table("tid_filter")
    class TidFilter {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column() tenantId!: string;
    }
    new TidFilter();
    const metadata = getEntityMetadata(TidFilter);
    const spec = tenantFilter<TidFilter>("tenant_id", "acme");
    const criteria = spec.toPredicate(metadata);
    expect(criteria).toBeDefined();
    // The criteria should be a ComparisonCriteria eq
    expect((criteria as any).type).toBe("eq");
  });
});

// ══════════════════════════════════════════════════
// Section 5: DDL index generation
// ══════════════════════════════════════════════════

describe("DdlGenerator — tenant index", () => {
  const ddl = new DdlGenerator();

  it("generates CREATE INDEX for @TenantId column", () => {
    @Table("tid_ddl")
    class TidDdl {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column({ name: "org_id" }) orgId!: string;
    }
    new TidDdl();
    const sql = ddl.generateTenantIndex(TidDdl);
    expect(sql).toBeDefined();
    expect(sql).toContain("CREATE INDEX");
    expect(sql).toContain("org_id");
    expect(sql).toContain("tid_ddl");
  });

  it("generates CREATE INDEX IF NOT EXISTS when option set", () => {
    @Table("tid_ddl2")
    class TidDdl2 {
      @Id @Column({ type: "SERIAL" }) id!: number;
      @TenantId @Column({ name: "tenant_id" }) tenantId!: string;
    }
    new TidDdl2();
    const sql = ddl.generateTenantIndex(TidDdl2, { ifNotExists: true });
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("returns undefined for entity without @TenantId", () => {
    @Table("tid_ddl3")
    class TidDdl3 {
      @Id @Column({ type: "SERIAL" }) id!: number;
    }
    new TidDdl3();
    expect(ddl.generateTenantIndex(TidDdl3)).toBeUndefined();
  });
});
