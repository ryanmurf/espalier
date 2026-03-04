/**
 * Unit tests for TenantSchemaManager DDL generation and validation (Y3 Q2).
 */
import { describe, it, expect } from "vitest";
import {
  Table,
  Column,
  Id,
  TenantId,
  DdlGenerator,
} from "../../index.js";

const ddl = new DdlGenerator();

// ══════════════════════════════════════════════════
// Test entities
// ══════════════════════════════════════════════════

@Table("tsm_items")
class TsmItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @TenantId @Column({ name: "tenant_id" }) tenantId!: string;
  @Column() name!: string;
}

@Table("tsm_plain")
class TsmPlain {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() value!: string;
}

// Trigger decorators
new TsmItem();
new TsmPlain();

// ══════════════════════════════════════════════════
// Section 1: Schema-qualified DDL
// ══════════════════════════════════════════════════

describe("DdlGenerator — schema-qualified output", () => {
  it("generates CREATE TABLE with schema prefix", () => {
    const sql = ddl.generateCreateTable(TsmItem, { schema: "my_schema" });
    expect(sql).toContain('"my_schema"."tsm_items"');
    expect(sql).toContain("CREATE TABLE");
  });

  it("generates CREATE TABLE IF NOT EXISTS with schema", () => {
    const sql = ddl.generateCreateTable(TsmItem, {
      schema: "my_schema",
      ifNotExists: true,
    });
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).toContain('"my_schema"."tsm_items"');
  });

  it("schema name with SQL injection is rejected", () => {
    expect(() =>
      ddl.generateCreateTable(TsmItem, { schema: "'; DROP TABLE --" }),
    ).toThrow(/Invalid schema/);
  });

  it("schema name with spaces is rejected", () => {
    expect(() =>
      ddl.generateCreateTable(TsmItem, { schema: "my schema" }),
    ).toThrow(/Invalid schema/);
  });

  it("schema name with dots is rejected", () => {
    expect(() =>
      ddl.generateCreateTable(TsmItem, { schema: "public.evil" }),
    ).toThrow(/Invalid schema/);
  });

  it("schema name that starts with digit is rejected", () => {
    expect(() =>
      ddl.generateCreateTable(TsmItem, { schema: "123schema" }),
    ).toThrow(/Invalid schema/);
  });

  it("valid schema with underscores accepted", () => {
    const sql = ddl.generateCreateTable(TsmItem, { schema: "tenant_abc_123" });
    expect(sql).toContain('"tenant_abc_123"');
  });
});

// ══════════════════════════════════════════════════
// Section 2: Tenant index with schema
// ══════════════════════════════════════════════════

describe("DdlGenerator — tenant index with schema", () => {
  it("generateTenantIndex produces index for @TenantId entity", () => {
    const sql = ddl.generateTenantIndex(TsmItem, { schema: "my_schema" });
    expect(sql).toBeDefined();
    expect(sql).toContain("CREATE INDEX");
    expect(sql).toContain("tenant_id");
  });

  it("generateTenantIndex returns undefined for non-tenant entity", () => {
    expect(ddl.generateTenantIndex(TsmPlain)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Section 3: Drop table with schema
// ══════════════════════════════════════════════════

describe("DdlGenerator — drop table with schema", () => {
  it("generates DROP TABLE with schema prefix", () => {
    const sql = ddl.generateDropTable(TsmItem, {
      ifExists: true,
      cascade: true,
      schema: "my_schema",
    });
    expect(sql).toContain('"my_schema"."tsm_items"');
    expect(sql).toContain("DROP TABLE");
    expect(sql).toContain("IF EXISTS");
    expect(sql).toContain("CASCADE");
  });
});
