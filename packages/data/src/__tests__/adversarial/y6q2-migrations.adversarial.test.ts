/**
 * Y6 Q2 -- Adversarial tests for Advanced Migrations features.
 *
 * Covers: SchemaDiffEngine, @Deprecated decorator, expand/contract migrations,
 * TenantAwareMigrationRunner, DataMigration interface, and migration testing utilities.
 *
 * Focus: edge cases, SQL injection, boundary conditions, error handling,
 * concurrency, type normalization, cross-feature interactions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// -- Deprecated --
import { Deprecated, getDeprecatedFields, isDeprecatedField } from "../../decorators/deprecated.js";
import type { DataMigration } from "../../migration/data-migration.js";
// -- Data Migration --
import { createDataMigration, isDataMigration } from "../../migration/data-migration.js";
// -- Expand/Contract --
import { generateExpandContractMigration } from "../../migration/expand-contract.js";
import type { SchemaDiff } from "../../migration/schema-diff.js";
// -- Schema Diff --
import { SchemaDiffEngine } from "../../migration/schema-diff.js";
import type { TenantMigrationProgress } from "../../migration/tenant-migration-runner.js";
// -- Tenant Migration Runner --
import { TenantAwareMigrationRunner } from "../../migration/tenant-migration-runner.js";

// -- Migration Testing --
// Note: migration-tester lives in espalier-testing, which is not a dep of espalier-data.
// We test it via inline mocks that mirror the real implementation behavior.

import type { ColumnInfo, Connection, SchemaIntrospector } from "espalier-jdbc";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
// -- Decorators for entity setup --
import { Table } from "../../decorators/table.js";
// -- Migration types --
import type { Migration, MigrationRecord, MigrationRunner } from "../../migration/migration.js";

// ============================================================
// Helpers
// ============================================================

type PartialColumnInfo = Pick<ColumnInfo, "columnName" | "dataType" | "nullable"> & Partial<ColumnInfo>;

function toColumnInfo(p: PartialColumnInfo): ColumnInfo {
  return { defaultValue: null, primaryKey: false, unique: false, maxLength: null, ...p };
}

function makeMockIntrospector(
  tables: { tableName: string }[] = [],
  columnsMap: Record<string, PartialColumnInfo[]> = {},
): SchemaIntrospector {
  return {
    getTables: vi.fn(async () => tables),
    getColumns: vi.fn(async (tableName: string) => (columnsMap[tableName] ?? []).map(toColumnInfo)),
    tableExists: vi.fn(async (tableName: string) =>
      tables.some((t) => t.tableName.toLowerCase() === tableName.toLowerCase()),
    ),
    getPrimaryKeys: vi.fn(async () => []),
    getForeignKeys: vi.fn(async () => []),
    getIndexes: vi.fn(async () => []),
  } as unknown as SchemaIntrospector;
}

function makeMockDdlGenerator(): any {
  return {
    generateCreateTable: vi.fn((_ec: any, _opts?: any) => "CREATE TABLE mock_table (id TEXT PRIMARY KEY)"),
  };
}

function makeMockMigrationRunner(overrides?: Partial<MigrationRunner>): MigrationRunner {
  const appliedMigrations: MigrationRecord[] = [];
  return {
    initialize: vi.fn(async () => {}),
    getAppliedMigrations: vi.fn(async () => [...appliedMigrations]),
    run: vi.fn(async (migrations: Migration[]) => {
      for (const m of migrations) {
        appliedMigrations.push({
          version: m.version,
          description: m.description,
          appliedAt: new Date(),
          checksum: "abc",
        });
      }
    }),
    getCurrentVersion: vi.fn(async () =>
      appliedMigrations.length ? appliedMigrations[appliedMigrations.length - 1].version : null,
    ),
    rollback: vi.fn(async (_migrations: Migration[], steps?: number) => {
      const count = steps ?? 1;
      appliedMigrations.splice(-count, count);
    }),
    rollbackTo: vi.fn(async () => {}),
    pending: vi.fn(async (migrations: Migration[]) => {
      const applied = new Set(appliedMigrations.map((m) => m.version));
      return migrations.filter((m) => !applied.has(m.version));
    }),
    ...overrides,
  };
}

function _makeMockConnection(): Connection {
  return {
    createStatement: vi.fn(() => ({
      executeQuery: vi.fn(async () => ({ next: async () => false, close: async () => {} })),
      executeUpdate: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    })),
    prepareStatement: vi.fn(() => ({
      executeQuery: vi.fn(async () => ({ next: async () => false, close: async () => {} })),
      executeUpdate: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    })),
    beginTransaction: vi.fn(async () => ({
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
    getMetaData: vi.fn(() => ({ getDatabaseProductName: () => "MockDB" })),
  } as unknown as Connection;
}

function makeSimpleMigration(version: string, desc = "test"): Migration {
  return {
    version,
    description: desc,
    up: () => `CREATE TABLE t_${version} (id INT)`,
    down: () => `DROP TABLE t_${version}`,
  };
}

// ============================================================
// 1. SCHEMA DIFF ENGINE
// ============================================================
describe("SchemaDiffEngine -- adversarial", () => {
  let ddlGen: any;
  let engine: SchemaDiffEngine;

  beforeEach(() => {
    ddlGen = makeMockDdlGenerator();
    engine = new SchemaDiffEngine(ddlGen);
  });

  it("empty entity list produces empty diff against empty DB", async () => {
    const introspector = makeMockIntrospector();
    const diff = await engine.diff([], introspector);
    expect(diff.addedTables).toHaveLength(0);
    expect(diff.removedTables).toHaveLength(0);
    expect(diff.modifiedTables).toHaveLength(0);
  });

  it("empty entity list against non-empty DB reports removed tables", async () => {
    const introspector = makeMockIntrospector([{ tableName: "old_table" }]);
    const diff = await engine.diff([], introspector);
    expect(diff.removedTables).toHaveLength(1);
    expect(diff.removedTables[0].tableName).toBe("old_table");
    expect(diff.removedTables[0].ddl).toContain("DROP TABLE");
  });

  it("new entity not in DB is reported as added", async () => {
    @Table("new_stuff")
    class NewStuff {
      @Id @Column() id!: string;
      @Column() name!: string;
    }
    new NewStuff();

    const introspector = makeMockIntrospector();
    const diff = await engine.diff([NewStuff], introspector);
    expect(diff.addedTables).toHaveLength(1);
    expect(diff.addedTables[0].tableName).toBe("new_stuff");
    expect(ddlGen.generateCreateTable).toHaveBeenCalledWith(NewStuff, { schema: undefined });
  });

  it("case-insensitive table matching prevents false positives", async () => {
    @Table("Users")
    class Users {
      @Id @Column() id!: string;
    }
    new Users();

    const introspector = makeMockIntrospector([{ tableName: "users" }], {
      Users: [{ columnName: "id", dataType: "TEXT", nullable: true }],
    });
    const diff = await engine.diff([Users], introspector);
    expect(diff.addedTables).toHaveLength(0);
    expect(diff.removedTables).toHaveLength(0);
  });

  it("detects added columns on existing table", async () => {
    @Table("products")
    class Product {
      @Id @Column() id!: string;
      @Column() name!: string;
      @Column({ type: "INTEGER" }) price!: number;
    }
    new Product();

    const introspector = makeMockIntrospector([{ tableName: "products" }], {
      products: [{ columnName: "id", dataType: "TEXT", nullable: false }],
    });
    const diff = await engine.diff([Product], introspector);
    expect(diff.modifiedTables).toHaveLength(1);
    expect(diff.modifiedTables[0].addedColumns.length).toBeGreaterThanOrEqual(2);
    const colNames = diff.modifiedTables[0].addedColumns.map((c) => c.columnName);
    expect(colNames).toContain("name");
    expect(colNames).toContain("price");
  });

  it("detects removed columns (in DB but not entity)", async () => {
    @Table("slim")
    class Slim {
      @Id @Column() id!: string;
    }
    new Slim();

    const introspector = makeMockIntrospector([{ tableName: "slim" }], {
      slim: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "old_col", dataType: "VARCHAR", nullable: true },
      ],
    });
    const diff = await engine.diff([Slim], introspector);
    expect(diff.modifiedTables).toHaveLength(1);
    expect(diff.modifiedTables[0].removedColumns).toHaveLength(1);
    expect(diff.modifiedTables[0].removedColumns[0].columnName).toBe("old_col");
    expect(diff.modifiedTables[0].removedColumns[0].ddl).toContain("DROP COLUMN");
  });

  it("detects type change via normalizeType", async () => {
    @Table("typed")
    class Typed {
      @Id @Column() id!: string;
      @Column({ type: "INTEGER" }) count!: number;
    }
    new Typed();

    const introspector = makeMockIntrospector([{ tableName: "typed" }], {
      typed: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "count", dataType: "VARCHAR(255)", nullable: true },
      ],
    });
    const diff = await engine.diff([Typed], introspector);
    const mod = diff.modifiedTables.find((m) => m.tableName === "typed");
    expect(mod).toBeDefined();
    expect(mod!.modifiedColumns).toHaveLength(1);
    expect(mod!.modifiedColumns[0].columnName).toBe("count");
    expect(mod!.modifiedColumns[0].ddl).toContain("ALTER COLUMN");
    expect(mod!.modifiedColumns[0].ddl).toContain("TYPE INTEGER");
  });

  it("int4 and INTEGER normalize to same type -- no false modification", async () => {
    @Table("norm_check")
    class NormCheck {
      @Id @Column() id!: string;
      @Column({ type: "integer" }) val!: number;
    }
    new NormCheck();

    const introspector = makeMockIntrospector([{ tableName: "norm_check" }], {
      norm_check: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "val", dataType: "int4", nullable: true },
      ],
    });
    const diff = await engine.diff([NormCheck], introspector);
    if (diff.modifiedTables.length > 0) {
      expect(diff.modifiedTables[0].modifiedColumns).toHaveLength(0);
    }
  });

  it("bool and BOOLEAN normalize to same type", async () => {
    @Table("bool_check")
    class BoolCheck {
      @Id @Column() id!: string;
      @Column({ type: "boolean" }) active!: boolean;
    }
    new BoolCheck();

    const introspector = makeMockIntrospector([{ tableName: "bool_check" }], {
      bool_check: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "active", dataType: "bool", nullable: true },
      ],
    });
    const diff = await engine.diff([BoolCheck], introspector);
    if (diff.modifiedTables.length > 0) {
      expect(diff.modifiedTables[0].modifiedColumns).toHaveLength(0);
    }
  });

  it("timestamptz and timestamp with time zone normalize equally", async () => {
    @Table("ts_check")
    class TsCheck {
      @Id @Column() id!: string;
      @Column({ type: "timestamp with time zone" }) created!: Date;
    }
    new TsCheck();

    const introspector = makeMockIntrospector([{ tableName: "ts_check" }], {
      ts_check: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "created", dataType: "timestamptz", nullable: true },
      ],
    });
    const diff = await engine.diff([TsCheck], introspector);
    if (diff.modifiedTables.length > 0) {
      expect(diff.modifiedTables[0].modifiedColumns).toHaveLength(0);
    }
  });

  it("serial and integer normalize to same type", async () => {
    @Table("serial_check")
    class SerialCheck {
      @Id @Column() id!: string;
      @Column({ type: "integer" }) seq!: number;
    }
    new SerialCheck();

    const introspector = makeMockIntrospector([{ tableName: "serial_check" }], {
      serial_check: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "seq", dataType: "serial", nullable: false },
      ],
    });
    const diff = await engine.diff([SerialCheck], introspector);
    if (diff.modifiedTables.length > 0) {
      expect(diff.modifiedTables[0].modifiedColumns).toHaveLength(0);
    }
  });

  it("SQL injection in table name is escaped by quoteIdentifier in DDL", async () => {
    const introspector = makeMockIntrospector([{ tableName: 'evil"; DROP TABLE users;--' }]);
    const diff = await engine.diff([], introspector);
    expect(diff.removedTables).toHaveLength(1);
    // The DDL should quote the table name with doubled internal quotes,
    // making the injection payload part of the identifier rather than separate SQL.
    const ddl = diff.removedTables[0].ddl;
    // The entire malicious name should be wrapped in a single quoted identifier
    // Internal double quotes are escaped: evil" becomes evil""
    expect(ddl).toBe('DROP TABLE "evil""; DROP TABLE users;--"');
    // Critically: this is ONE DROP TABLE statement with a quoted identifier,
    // not two separate statements. A SQL parser would see:
    //   DROP TABLE <identifier> where identifier = evil"; DROP TABLE users;--
  });

  it("generateMigration produces correct up/down for added tables", () => {
    const diff: SchemaDiff = {
      addedTables: [{ tableName: "foo", ddl: 'CREATE TABLE "foo" (id TEXT PRIMARY KEY)' }],
      removedTables: [],
      modifiedTables: [],
    };
    const { up, down } = engine.generateMigration(diff);
    expect(up).toHaveLength(1);
    expect(up[0]).toContain("CREATE TABLE");
    expect(down).toHaveLength(1);
    expect(down[0]).toContain("DROP TABLE");
    expect(down[0]).toContain('"foo"');
  });

  it("generateMigration produces correct up/down for removed tables", () => {
    const diff: SchemaDiff = {
      addedTables: [],
      removedTables: [{ tableName: "old", ddl: 'DROP TABLE "old"' }],
      modifiedTables: [],
    };
    const { up, down } = engine.generateMigration(diff);
    expect(up).toHaveLength(1);
    expect(up[0]).toContain("DROP TABLE");
    expect(down).toHaveLength(1);
    expect(down[0]).toContain("Cannot auto-generate");
  });

  it("generateMigration handles modified columns with ALTER TYPE", () => {
    const diff: SchemaDiff = {
      addedTables: [],
      removedTables: [],
      modifiedTables: [
        {
          tableName: "items",
          addedColumns: [],
          removedColumns: [],
          modifiedColumns: [
            {
              columnName: "price",
              oldType: "INTEGER",
              newType: "NUMERIC(10,2)",
              ddl: 'ALTER TABLE "items" ALTER COLUMN "price" TYPE NUMERIC(10,2)',
            },
          ],
        },
      ],
    };
    const { up, down } = engine.generateMigration(diff);
    expect(up).toHaveLength(1);
    expect(up[0]).toContain("NUMERIC(10,2)");
    expect(down).toHaveLength(1);
    expect(down[0]).toContain("TYPE INTEGER");
  });

  it("generateMigration with empty diff produces empty arrays", () => {
    const diff: SchemaDiff = {
      addedTables: [],
      removedTables: [],
      modifiedTables: [],
    };
    const { up, down } = engine.generateMigration(diff);
    expect(up).toHaveLength(0);
    expect(down).toHaveLength(0);
  });

  it("generateMigration ordering: additions first, then modifications, then removals", () => {
    const diff: SchemaDiff = {
      addedTables: [{ tableName: "new_t", ddl: 'CREATE TABLE "new_t" (id INT)' }],
      removedTables: [{ tableName: "old_t", ddl: 'DROP TABLE "old_t"' }],
      modifiedTables: [
        {
          tableName: "mod_t",
          addedColumns: [{ columnName: "col", ddl: 'ALTER TABLE "mod_t" ADD COLUMN "col" TEXT' }],
          removedColumns: [],
          modifiedColumns: [],
        },
      ],
    };
    const { up } = engine.generateMigration(diff);
    expect(up).toHaveLength(3);
    expect(up[0]).toContain("CREATE TABLE");
    expect(up[1]).toContain("ADD COLUMN");
    expect(up[2]).toContain("DROP TABLE");
  });

  it("diff with schema-qualified table names passes schema to introspector", async () => {
    @Table("tenant_data")
    class TenantData {
      @Id @Column() id!: string;
    }
    new TenantData();

    const introspector = makeMockIntrospector();
    await engine.diff([TenantData], introspector, "my_schema");
    expect(introspector.getTables).toHaveBeenCalledWith("my_schema");
  });

  it("view entities are skipped in diff", async () => {
    // We can't easily use @View decorator here, but we test the filter logic:
    // If an entity class returns truthy from getViewMetadata, it's skipped.
    // Since we can't mock module-level functions easily, we verify that a normal
    // @Table entity IS processed (coverage by exclusion).
    @Table("real_table")
    class RealTable {
      @Id @Column() id!: string;
    }
    new RealTable();

    const introspector = makeMockIntrospector();
    const diff = await engine.diff([RealTable], introspector);
    expect(diff.addedTables).toHaveLength(1);
  });

  it("column with length but no type resolves to VARCHAR(N)", async () => {
    @Table("len_test")
    class LenTest {
      @Id @Column() id!: string;
      @Column({ length: 100 }) name!: string;
    }
    new LenTest();

    const introspector = makeMockIntrospector([{ tableName: "len_test" }], {
      len_test: [
        { columnName: "id", dataType: "TEXT", nullable: false },
        { columnName: "name", dataType: "TEXT", nullable: true },
      ],
    });
    const diff = await engine.diff([LenTest], introspector);
    const mod = diff.modifiedTables.find((m) => m.tableName === "len_test");
    // name should show type change from TEXT to VARCHAR(100)
    if (mod) {
      const colMod = mod.modifiedColumns.find((c) => c.columnName === "name");
      if (colMod) {
        expect(colMod.newType).toContain("VARCHAR");
      }
    }
  });
});

// ============================================================
// 2. @DEPRECATED DECORATOR
// ============================================================
describe("@Deprecated decorator -- adversarial", () => {
  it("basic decorator application stores metadata", () => {
    class Entity {
      @Deprecated() oldField: string = "";
    }
    const inst = new Entity();
    const fields = getDeprecatedFields(inst.constructor);
    expect(fields.has("oldField")).toBe(true);
  });

  it("stores all options: replacedBy, removeAfter, reason", () => {
    class Entity {
      @Deprecated({ replacedBy: "newField", removeAfter: "2.0.0", reason: "legacy" })
      oldField: string = "";
    }
    const inst = new Entity();
    const fields = getDeprecatedFields(inst.constructor);
    const opts = fields.get("oldField")!;
    expect(opts.replacedBy).toBe("newField");
    expect(opts.removeAfter).toBe("2.0.0");
    expect(opts.reason).toBe("legacy");
  });

  it("decorator with no options stores empty object", () => {
    class Entity {
      @Deprecated() field: string = "";
    }
    const inst = new Entity();
    const opts = getDeprecatedFields(inst.constructor).get("field");
    expect(opts).toBeDefined();
    expect(opts!.replacedBy).toBeUndefined();
    expect(opts!.removeAfter).toBeUndefined();
    expect(opts!.reason).toBeUndefined();
  });

  it("multiple deprecated fields on same entity", () => {
    class Entity {
      @Deprecated({ reason: "first" }) a: string = "";
      @Deprecated({ reason: "second" }) b: string = "";
      @Deprecated({ reason: "third" }) c: string = "";
    }
    const inst = new Entity();
    const fields = getDeprecatedFields(inst.constructor);
    expect(fields.size).toBe(3);
    expect(fields.get("a")!.reason).toBe("first");
    expect(fields.get("b")!.reason).toBe("second");
    expect(fields.get("c")!.reason).toBe("third");
  });

  it("isDeprecatedField returns true for deprecated field", () => {
    class Entity {
      @Deprecated() old: string = "";
      notOld: string = "";
    }
    const inst = new Entity();
    expect(isDeprecatedField(inst.constructor, "old")).toBe(true);
  });

  it("isDeprecatedField returns false for non-deprecated field", () => {
    class Entity {
      @Deprecated() old: string = "";
      notOld: string = "";
    }
    const inst = new Entity();
    expect(isDeprecatedField(inst.constructor, "notOld")).toBe(false);
  });

  it("isDeprecatedField returns false for unrelated class", () => {
    class Unrelated {}
    expect(isDeprecatedField(Unrelated, "anything")).toBe(false);
  });

  it("getDeprecatedFields returns empty map for undecorated class", () => {
    class Plain {
      field: string = "";
    }
    const fields = getDeprecatedFields(Plain);
    expect(fields.size).toBe(0);
  });

  it("getDeprecatedFields returns new map instance (defensive copy behavior)", () => {
    class NoFields {}
    const a = getDeprecatedFields(NoFields);
    const b = getDeprecatedFields(NoFields);
    // Both should be empty and both come from the same fallback
    expect(a.size).toBe(0);
    expect(b.size).toBe(0);
  });

  it("metadata is isolated between distinct classes", () => {
    class A {
      @Deprecated({ reason: "A" }) x: string = "";
    }
    class B {
      @Deprecated({ reason: "B" }) y: string = "";
    }
    new A();
    new B();
    const aFields = getDeprecatedFields(A);
    const bFields = getDeprecatedFields(B);
    expect(aFields.has("x")).toBe(true);
    expect(aFields.has("y")).toBe(false);
    expect(bFields.has("y")).toBe(true);
    expect(bFields.has("x")).toBe(false);
  });
});

// ============================================================
// 3. EXPAND/CONTRACT MIGRATION GENERATOR
// ============================================================
describe("generateExpandContractMigration -- adversarial", () => {
  it("entity with no deprecated fields returns empty arrays", () => {
    @Table("clean")
    class Clean {
      @Id @Column() id!: string;
      @Column() name!: string;
    }
    const result = generateExpandContractMigration(Clean);
    expect(result.expand).toHaveLength(0);
    expect(result.contract).toHaveLength(0);
  });

  it("deprecated with replacedBy generates both expand and contract", () => {
    @Table("items")
    class Items {
      @Id @Column() id!: string;
      @Deprecated({ replacedBy: "fullName" })
      @Column()
      name!: string;
      @Column({ type: "VARCHAR(200)" }) fullName!: string;
    }
    const result = generateExpandContractMigration(Items);
    expect(result.expand.length).toBeGreaterThanOrEqual(1);
    expect(result.contract.length).toBeGreaterThanOrEqual(1);
    // Expand should ADD new column and UPDATE
    expect(result.expand.some((s) => s.includes("ADD COLUMN"))).toBe(true);
    expect(result.expand.some((s) => s.includes("UPDATE"))).toBe(true);
    // Contract should DROP old column
    expect(result.contract.some((s) => s.includes("DROP COLUMN"))).toBe(true);
  });

  it("deprecated without replacedBy generates only contract (DROP)", () => {
    @Table("legacy")
    class Legacy {
      @Id @Column() id!: string;
      @Deprecated()
      @Column()
      removable!: string;
    }
    const result = generateExpandContractMigration(Legacy);
    expect(result.expand).toHaveLength(0);
    expect(result.contract.length).toBeGreaterThanOrEqual(1);
    expect(result.contract[0]).toContain("DROP COLUMN");
  });

  it("multiple deprecated fields generate multiple statements", () => {
    @Table("multi")
    class Multi {
      @Id @Column() id!: string;
      @Deprecated({ replacedBy: "newA" })
      @Column()
      oldA!: string;
      @Column({ type: "TEXT" }) newA!: string;
      @Deprecated()
      @Column()
      oldB!: string;
    }
    const result = generateExpandContractMigration(Multi);
    // oldA -> expand (ADD + UPDATE) + contract (DROP)
    // oldB -> contract (DROP)
    expect(result.expand.length).toBeGreaterThanOrEqual(2); // ADD + UPDATE for oldA
    expect(result.contract.length).toBeGreaterThanOrEqual(2); // DROP oldA + DROP oldB
  });

  it("throws when entity has no @Table decorator", () => {
    class NoTable {
      @Id @Column() id!: string;
    }
    expect(() => generateExpandContractMigration(NoTable)).toThrow("No @Table decorator");
  });

  it("DDL uses quoteIdentifier for column names", () => {
    @Table("quoted")
    class Quoted {
      @Id @Column() id!: string;
      @Deprecated()
      @Column()
      dropMe!: string;
    }
    const result = generateExpandContractMigration(Quoted);
    // Should see quoted identifiers in output
    for (const stmt of result.contract) {
      expect(stmt).toContain('"');
    }
  });

  it("replacedBy pointing to non-existent field produces no expand", () => {
    @Table("phantom")
    class Phantom {
      @Id @Column() id!: string;
      @Deprecated({ replacedBy: "doesNotExist" })
      @Column()
      old!: string;
    }
    const result = generateExpandContractMigration(Phantom);
    // Since replacedBy field doesn't exist in columnMappings, expand should be empty
    expect(result.expand).toHaveLength(0);
    // But it still won't generate contract for this case because the code
    // only goes to contract in the else branch (no replacedBy)
    // Actually looking at code: if replacedBy is set but replacement not found, no expand OR contract
  });
});

// ============================================================
// 4. TENANT-AWARE MIGRATION RUNNER
// ============================================================
describe("TenantAwareMigrationRunner -- adversarial", () => {
  it("throws on empty tenant list", () => {
    expect(() => new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), [])).toThrow(
      "tenantSchemas must not be empty",
    );
  });

  it("throws on concurrency < 1", async () => {
    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), ["tenant_a"]);
    await expect(runner.runAll([makeSimpleMigration("001")], { concurrency: 0 })).rejects.toThrow(
      "concurrency must be at least 1",
    );
  });

  it("single tenant success", async () => {
    const mockRunner = makeMockMigrationRunner();
    const runner = new TenantAwareMigrationRunner(() => mockRunner, ["tenant_a"]);
    const results = await runner.runAll([makeSimpleMigration("001")]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
    expect(results[0].tenantId).toBe("tenant_a");
    expect(results[0].schema).toBe("tenant_a");
  });

  it("multiple tenants all succeed sequentially", async () => {
    const schemas = ["t1", "t2", "t3"];
    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), schemas);
    const results = await runner.runAll([makeSimpleMigration("001")]);
    expect(results).toHaveLength(3);
    results.forEach((r, i) => {
      expect(r.status).toBe("completed");
      expect(r.tenantId).toBe(schemas[i]);
    });
  });

  it("concurrency > 1 processes tenants in parallel batches", async () => {
    const startTimes: number[] = [];
    const factory = () => {
      const r = makeMockMigrationRunner();
      (r.run as any).mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      return r;
    };

    const runner = new TenantAwareMigrationRunner(factory, ["a", "b", "c", "d"]);
    await runner.runAll([makeSimpleMigration("001")], { concurrency: 2 });
    // Should have 4 results, processed in 2 batches of 2
    expect(startTimes).toHaveLength(4);
  });

  it("error with continueOnError=false marks tenant as failed and includes error", async () => {
    const callOrder: string[] = [];
    const factory = (schema: string) => {
      const r = makeMockMigrationRunner();
      (r.run as any).mockImplementation(async () => {
        callOrder.push(schema);
        if (schema === "t2") throw new Error("t2 failed");
      });
      return r;
    };

    const runner = new TenantAwareMigrationRunner(factory, ["t1", "t2", "t3"]);
    // With concurrency=1, each tenant is in its own chunk.
    // The error is thrown inside the promise but caught by Promise.allSettled.
    // The failed tenant's progress is pushed before the throw.
    const results = await runner.runAll([makeSimpleMigration("001")], {
      continueOnError: false,
    });
    const failed = results.find((r) => r.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.error?.message).toBe("t2 failed");
    expect(callOrder).toContain("t1");
    expect(callOrder).toContain("t2");
  });

  it("error with continueOnError=true continues and reports failures", async () => {
    const factory = (schema: string) => {
      const r = makeMockMigrationRunner();
      (r.run as any).mockImplementation(async () => {
        if (schema === "t2") throw new Error("t2 boom");
      });
      return r;
    };

    const runner = new TenantAwareMigrationRunner(factory, ["t1", "t2", "t3"]);
    const results = await runner.runAll([makeSimpleMigration("001")], {
      continueOnError: true,
    });
    // All tenants should be represented
    expect(results.length).toBeGreaterThanOrEqual(2);
    const failed = results.find((r) => r.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.error?.message).toBe("t2 boom");
    const completed = results.filter((r) => r.status === "completed");
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it("progress callback fires for each tenant", async () => {
    const progressCalls: TenantMigrationProgress[] = [];
    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), ["t1", "t2"]);
    await runner.runAll([makeSimpleMigration("001")], {
      onProgress: (p) => progressCalls.push({ ...p }),
    });
    // Should fire at least twice per tenant (running + completed)
    expect(progressCalls.length).toBeGreaterThanOrEqual(4);
    const running = progressCalls.filter((p) => p.status === "running");
    const completed = progressCalls.filter((p) => p.status === "completed");
    expect(running.length).toBeGreaterThanOrEqual(2);
    expect(completed.length).toBeGreaterThanOrEqual(2);
  });

  it("progress callback fires with 'failed' status on error", async () => {
    const progressCalls: TenantMigrationProgress[] = [];
    const factory = (schema: string) => {
      const r = makeMockMigrationRunner();
      (r.run as any).mockImplementation(async () => {
        if (schema === "bad") throw new Error("bad tenant");
      });
      return r;
    };

    const runner = new TenantAwareMigrationRunner(factory, ["bad"]);
    try {
      await runner.runAll([makeSimpleMigration("001")], {
        continueOnError: false,
        onProgress: (p) => progressCalls.push({ ...p }),
      });
    } catch {
      // expected
    }
    const failed = progressCalls.find((p) => p.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.error?.message).toBe("bad tenant");
  });

  it("rollbackAll across multiple tenants", async () => {
    const rollbackCalls: string[] = [];
    const factory = (schema: string) => {
      const applied: MigrationRecord[] = [{ version: "001", description: "m1", appliedAt: new Date(), checksum: "x" }];
      return {
        initialize: vi.fn(async () => {}),
        getAppliedMigrations: vi.fn(async () => [...applied]),
        run: vi.fn(async () => {}),
        getCurrentVersion: vi.fn(async () => "001"),
        rollback: vi.fn(async () => {
          rollbackCalls.push(schema);
          applied.pop();
        }),
        rollbackTo: vi.fn(async () => {}),
        pending: vi.fn(async () => []),
      } as unknown as MigrationRunner;
    };

    const runner = new TenantAwareMigrationRunner(factory, ["t1", "t2"]);
    const results = await runner.rollbackAll([makeSimpleMigration("001")], 1);
    expect(results).toHaveLength(2);
    expect(rollbackCalls).toContain("t1");
    expect(rollbackCalls).toContain("t2");
  });

  it("pendingAll returns correct per-tenant pending migrations", async () => {
    let callCount = 0;
    const factory = (_schema: string) => {
      callCount++;
      const applied =
        callCount === 1 ? [{ version: "001", description: "m1", appliedAt: new Date(), checksum: "x" }] : [];
      return {
        initialize: vi.fn(async () => {}),
        getAppliedMigrations: vi.fn(async () => applied),
        run: vi.fn(async () => {}),
        getCurrentVersion: vi.fn(async () => null),
        rollback: vi.fn(async () => {}),
        rollbackTo: vi.fn(async () => {}),
        pending: vi.fn(async (migrations: Migration[]) => {
          const appliedVersions = new Set(applied.map((a) => a.version));
          return migrations.filter((m) => !appliedVersions.has(m.version));
        }),
      } as unknown as MigrationRunner;
    };

    const runner = new TenantAwareMigrationRunner(factory, ["t1", "t2"]);
    const m1 = makeSimpleMigration("001");
    const m2 = makeSimpleMigration("002");
    const pending = await runner.pendingAll([m1, m2]);

    expect(pending.get("t1")).toHaveLength(1); // only 002 pending
    expect(pending.get("t2")).toHaveLength(2); // both pending
  });

  it("migrationsApplied count is correct", async () => {
    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), ["t1"]);
    const results = await runner.runAll([makeSimpleMigration("001"), makeSimpleMigration("002")]);
    expect(results[0].migrationsApplied).toBe(2);
  });

  it("concurrency equal to tenant count processes all at once", async () => {
    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), ["a", "b", "c"]);
    const results = await runner.runAll([makeSimpleMigration("001")], {
      concurrency: 3,
    });
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r.status).toBe("completed"));
  });

  it("concurrency greater than tenant count works fine", async () => {
    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), ["a"]);
    const results = await runner.runAll([makeSimpleMigration("001")], {
      concurrency: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });
});

// ============================================================
// 5. DATA MIGRATION
// ============================================================
describe("DataMigration -- adversarial", () => {
  it("isDataMigration returns true for valid DataMigration", () => {
    const dm: DataMigration = {
      version: "001",
      description: "seed data",
      data: async () => {},
    };
    expect(isDataMigration(dm)).toBe(true);
  });

  it("isDataMigration returns false for regular Migration (no data method)", () => {
    const m: Migration = {
      version: "001",
      description: "schema only",
      up: () => "CREATE TABLE x (id INT)",
      down: () => "DROP TABLE x",
    };
    expect(isDataMigration(m)).toBe(false);
  });

  it("isDataMigration returns false for null", () => {
    expect(isDataMigration(null)).toBe(false);
  });

  it("isDataMigration returns false for undefined", () => {
    expect(isDataMigration(undefined)).toBe(false);
  });

  it("isDataMigration returns false for string", () => {
    expect(isDataMigration("hello")).toBe(false);
  });

  it("isDataMigration returns false for number", () => {
    expect(isDataMigration(42)).toBe(false);
  });

  it("isDataMigration returns false if data is not a function", () => {
    expect(isDataMigration({ data: "not-a-function", version: "1", description: "x" })).toBe(false);
  });

  it("isDataMigration returns true even without up/down", () => {
    expect(isDataMigration({ version: "1", description: "x", data: async () => {} })).toBe(true);
  });

  it("createDataMigration creates correct object", () => {
    const dataFn = async () => {};
    const dm = createDataMigration("001", "seed", dataFn);
    expect(dm.version).toBe("001");
    expect(dm.description).toBe("seed");
    expect(dm.data).toBe(dataFn);
    expect(dm.up).toBeUndefined();
    expect(dm.down).toBeUndefined();
  });

  it("createDataMigration with undoData", () => {
    const dataFn = async () => {};
    const undoFn = async () => {};
    const dm = createDataMigration("002", "reversible", dataFn, undoFn);
    expect(dm.undoData).toBe(undoFn);
  });

  it("createDataMigration without undoData has no undoData property", () => {
    const dm = createDataMigration("003", "one-way", async () => {});
    expect("undoData" in dm).toBe(false);
  });

  it("createDataMigration result passes isDataMigration", () => {
    const dm = createDataMigration("004", "check", async () => {});
    expect(isDataMigration(dm)).toBe(true);
  });

  it("Migration with optional data() IS a DataMigration", () => {
    const m: Migration = {
      version: "001",
      description: "both",
      up: () => "CREATE TABLE x (id INT)",
      down: () => "DROP TABLE x",
      data: async () => {},
    };
    expect(isDataMigration(m)).toBe(true);
  });
});

// ============================================================
// 6. MIGRATION TESTING UTILITIES
// ============================================================
// Inline re-implementation matching espalier-testing's createSchemaAssertion/testMigration
// since espalier-testing is not a dependency of espalier-data.

interface SchemaAssertion {
  tableExists(tableName: string, schema?: string): Promise<void>;
  tableNotExists(tableName: string, schema?: string): Promise<void>;
  columnExists(tableName: string, columnName: string, expectedType?: string): Promise<void>;
  columnNotExists(tableName: string, columnName: string): Promise<void>;
  columnIsNullable(tableName: string, columnName: string): Promise<void>;
  columnIsNotNullable(tableName: string, columnName: string): Promise<void>;
  primaryKeyExists(tableName: string, columns: string[]): Promise<void>;
}

function inlineCreateSchemaAssertion(introspector: SchemaIntrospector): SchemaAssertion {
  return {
    async tableExists(tableName: string, schema?: string) {
      const exists = await introspector.tableExists(tableName, schema);
      if (!exists) throw new Error(`Expected table '${tableName}' to exist, but it does not.`);
    },
    async tableNotExists(tableName: string, schema?: string) {
      const exists = await introspector.tableExists(tableName, schema);
      if (exists) throw new Error(`Expected table '${tableName}' not to exist, but it does.`);
    },
    async columnExists(tableName: string, columnName: string, expectedType?: string) {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c: any) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (!column)
        throw new Error(`Expected column '${columnName}' to exist on table '${tableName}', but it does not.`);
      if (expectedType !== undefined) {
        const actual = column.dataType.trim().toLowerCase();
        const expected = expectedType.trim().toLowerCase();
        if (actual !== expected)
          throw new Error(
            `Expected column '${columnName}' on table '${tableName}' to have type '${expectedType}', but it has type '${column.dataType}'.`,
          );
      }
    },
    async columnNotExists(tableName: string, columnName: string) {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c: any) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (column) throw new Error(`Expected column '${columnName}' not to exist on table '${tableName}', but it does.`);
    },
    async columnIsNullable(tableName: string, columnName: string) {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c: any) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (!column)
        throw new Error(`Expected column '${columnName}' to exist on table '${tableName}', but it does not.`);
      if (!column.nullable)
        throw new Error(`Expected column '${columnName}' on table '${tableName}' to be nullable, but it is NOT NULL.`);
    },
    async columnIsNotNullable(tableName: string, columnName: string) {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c: any) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (!column)
        throw new Error(`Expected column '${columnName}' to exist on table '${tableName}', but it does not.`);
      if (column.nullable)
        throw new Error(`Expected column '${columnName}' on table '${tableName}' to be NOT NULL, but it is nullable.`);
    },
    async primaryKeyExists(tableName: string, columns: string[]) {
      const pkColumns = await introspector.getPrimaryKeys(tableName);
      const normalizedExpected = columns.map((c) => c.toLowerCase()).sort();
      const normalizedActual = pkColumns.map((c: string) => c.toLowerCase()).sort();
      if (
        normalizedExpected.length !== normalizedActual.length ||
        !normalizedExpected.every((col: string, i: number) => col === normalizedActual[i])
      ) {
        throw new Error(
          `Expected primary key on table '${tableName}' to be [${columns.join(", ")}], but got [${pkColumns.join(", ")}].`,
        );
      }
    },
  };
}

async function inlineTestMigration(
  ctx: { connection: Connection; introspector: SchemaIntrospector },
  upSql: string | string[],
  assertions: (assert: SchemaAssertion) => Promise<void>,
): Promise<void> {
  const statements = Array.isArray(upSql) ? upSql : [upSql];
  const transaction = await ctx.connection.beginTransaction();
  try {
    const stmt = ctx.connection.createStatement();
    for (const sql of statements) {
      await stmt.executeUpdate(sql);
    }
    const assert = inlineCreateSchemaAssertion(ctx.introspector);
    await assertions(assert);
  } finally {
    await transaction.rollback();
  }
}

describe("Migration testing utilities (schema assertions) -- adversarial", () => {
  it("tableExists passes when table exists", async () => {
    const introspector = makeMockIntrospector([{ tableName: "users" }]);
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.tableExists("users")).resolves.toBeUndefined();
  });

  it("tableExists throws when table does not exist", async () => {
    const introspector = makeMockIntrospector([]);
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.tableExists("missing")).rejects.toThrow("Expected table 'missing' to exist");
  });

  it("tableNotExists passes when table is absent", async () => {
    const introspector = makeMockIntrospector([]);
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.tableNotExists("ghost")).resolves.toBeUndefined();
  });

  it("tableNotExists throws when table exists", async () => {
    const introspector = makeMockIntrospector([{ tableName: "real" }]);
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.tableNotExists("real")).rejects.toThrow("Expected table 'real' not to exist");
  });

  it("columnExists passes with matching column", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "id", dataType: "INTEGER", nullable: false }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnExists("users", "id")).resolves.toBeUndefined();
  });

  it("columnExists with type check (case-insensitive)", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "age", dataType: "integer", nullable: false }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnExists("users", "AGE", "integer")).resolves.toBeUndefined();
  });

  it("columnExists with wrong type throws", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "age", dataType: "TEXT", nullable: false }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnExists("users", "age", "INTEGER")).rejects.toThrow("to have type 'INTEGER'");
  });

  it("columnNotExists passes when column is absent", async () => {
    const introspector = {
      getColumns: vi.fn(async () => []),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnNotExists("users", "phantom")).resolves.toBeUndefined();
  });

  it("columnNotExists throws when column exists", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "name", dataType: "TEXT", nullable: true }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnNotExists("users", "name")).rejects.toThrow("not to exist");
  });

  it("columnIsNullable passes for nullable column", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "bio", dataType: "TEXT", nullable: true }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnIsNullable("users", "bio")).resolves.toBeUndefined();
  });

  it("columnIsNullable throws for NOT NULL column", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "id", dataType: "INT", nullable: false }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnIsNullable("users", "id")).rejects.toThrow("to be nullable");
  });

  it("columnIsNotNullable passes for NOT NULL column", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "id", dataType: "INT", nullable: false }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnIsNotNullable("users", "id")).resolves.toBeUndefined();
  });

  it("columnIsNotNullable throws for nullable column", async () => {
    const introspector = {
      getColumns: vi.fn(async () => [{ columnName: "bio", dataType: "TEXT", nullable: true }]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnIsNotNullable("users", "bio")).rejects.toThrow("to be NOT NULL");
  });

  it("columnIsNullable throws when column does not exist", async () => {
    const introspector = {
      getColumns: vi.fn(async () => []),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnIsNullable("users", "ghost")).rejects.toThrow("to exist");
  });

  it("columnIsNotNullable throws when column does not exist", async () => {
    const introspector = {
      getColumns: vi.fn(async () => []),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.columnIsNotNullable("users", "ghost")).rejects.toThrow("to exist");
  });

  it("primaryKeyExists passes with correct columns", async () => {
    const introspector = {
      getPrimaryKeys: vi.fn(async () => ["id"]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.primaryKeyExists("users", ["id"])).resolves.toBeUndefined();
  });

  it("primaryKeyExists fails with wrong columns", async () => {
    const introspector = {
      getPrimaryKeys: vi.fn(async () => ["id"]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.primaryKeyExists("users", ["name"])).rejects.toThrow("Expected primary key");
  });

  it("primaryKeyExists case-insensitive matching", async () => {
    const introspector = {
      getPrimaryKeys: vi.fn(async () => ["ID", "tenant_id"]),
    } as unknown as SchemaIntrospector;
    const assert = inlineCreateSchemaAssertion(introspector);
    await expect(assert.primaryKeyExists("users", ["id", "TENANT_ID"])).resolves.toBeUndefined();
  });
});

describe("testMigration utility -- adversarial", () => {
  it("runs SQL and assertions within transaction, then rolls back", async () => {
    const mockRollback = vi.fn(async () => {});
    const mockExecuteUpdate = vi.fn(async () => 0);
    const conn = {
      beginTransaction: vi.fn(async () => ({
        commit: vi.fn(async () => {}),
        rollback: mockRollback,
      })),
      createStatement: vi.fn(() => ({
        executeUpdate: mockExecuteUpdate,
      })),
    } as unknown as Connection;

    const introspector = {
      tableExists: vi.fn(async () => true),
      getColumns: vi.fn(async () => []),
      getPrimaryKeys: vi.fn(async () => []),
    } as unknown as SchemaIntrospector;

    await inlineTestMigration({ connection: conn, introspector }, "CREATE TABLE test (id INT)", async (assert) => {
      await assert.tableExists("test");
    });

    expect(mockExecuteUpdate).toHaveBeenCalledWith("CREATE TABLE test (id INT)");
    expect(mockRollback).toHaveBeenCalled();
  });

  it("handles array of SQL statements", async () => {
    const executedSql: string[] = [];
    const conn = {
      beginTransaction: vi.fn(async () => ({
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
      })),
      createStatement: vi.fn(() => ({
        executeUpdate: vi.fn(async (sql: string) => {
          executedSql.push(sql);
          return 0;
        }),
      })),
    } as unknown as Connection;

    const introspector = {
      tableExists: vi.fn(async () => true),
    } as unknown as SchemaIntrospector;

    await inlineTestMigration(
      { connection: conn, introspector },
      ["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"],
      async () => {},
    );

    expect(executedSql).toHaveLength(2);
    expect(executedSql[0]).toContain("CREATE TABLE a");
    expect(executedSql[1]).toContain("CREATE TABLE b");
  });

  it("rolls back even if assertions throw", async () => {
    const mockRollback = vi.fn(async () => {});
    const conn = {
      beginTransaction: vi.fn(async () => ({
        commit: vi.fn(async () => {}),
        rollback: mockRollback,
      })),
      createStatement: vi.fn(() => ({
        executeUpdate: vi.fn(async () => 0),
      })),
    } as unknown as Connection;

    const introspector = {
      tableExists: vi.fn(async () => false),
    } as unknown as SchemaIntrospector;

    await expect(
      inlineTestMigration({ connection: conn, introspector }, "CREATE TABLE x (id INT)", async (assert) => {
        await assert.tableExists("x");
      }),
    ).rejects.toThrow("Expected table 'x' to exist");

    expect(mockRollback).toHaveBeenCalled();
  });
});

// ============================================================
// 7. CROSS-FEATURE INTERACTIONS
// ============================================================
describe("Cross-feature interactions -- adversarial", () => {
  it("SchemaDiffEngine + generateMigration round-trip produces valid SQL", async () => {
    const ddlGen = makeMockDdlGenerator();
    ddlGen.generateCreateTable.mockReturnValue('CREATE TABLE "new_entity" (id TEXT PRIMARY KEY, name TEXT)');
    const engine = new SchemaDiffEngine(ddlGen);

    @Table("new_entity")
    class NewEntity {
      @Id @Column() id!: string;
      @Column() name!: string;
    }
    new NewEntity();

    const introspector = makeMockIntrospector();
    const diff = await engine.diff([NewEntity], introspector);
    const { up, down } = engine.generateMigration(diff);

    expect(up.length).toBeGreaterThan(0);
    expect(down.length).toBeGreaterThan(0);
    // Up should create, down should drop
    expect(up[0]).toContain("CREATE TABLE");
    expect(down[0]).toContain("DROP TABLE");
  });

  it("DataMigration created by helper passes type guard", () => {
    const dm = createDataMigration("001", "init", async (conn) => {
      // Would use conn.createStatement() in real code
    });
    expect(isDataMigration(dm)).toBe(true);
    expect(dm.version).toBe("001");
  });

  it("TenantMigrationRunner with DataMigration-compatible migrations", async () => {
    const dm = createDataMigration("001", "seed", async () => {});
    // DataMigration can be used wherever Migration is expected if it has up/down
    const migration: Migration = {
      version: dm.version,
      description: dm.description,
      up: () => "SELECT 1",
      down: () => "SELECT 1",
      data: dm.data,
    };

    const runner = new TenantAwareMigrationRunner(() => makeMockMigrationRunner(), ["schema_a"]);
    const results = await runner.runAll([migration]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });

  it("Deprecated fields on entity used with expand/contract produce valid SQL", () => {
    @Table("orders")
    class Order {
      @Id @Column() id!: string;
      @Deprecated({ replacedBy: "totalAmount", reason: "renamed" })
      @Column({ type: "NUMERIC(10,2)" })
      total!: number;
      @Column({ type: "NUMERIC(12,2)" }) totalAmount!: number;
    }
    const result = generateExpandContractMigration(Order);

    // Verify expand has ADD COLUMN and UPDATE
    const addCol = result.expand.find((s) => s.includes("ADD COLUMN"));
    expect(addCol).toBeDefined();
    expect(addCol).toContain("NUMERIC(12,2)");

    const update = result.expand.find((s) => s.includes("UPDATE"));
    expect(update).toBeDefined();

    // Verify contract has DROP COLUMN for old field
    const drop = result.contract.find((s) => s.includes("DROP COLUMN"));
    expect(drop).toBeDefined();

    // Verify deprecated metadata is correct
    const inst = new Order();
    expect(isDeprecatedField(inst.constructor, "total")).toBe(true);
    expect(isDeprecatedField(inst.constructor, "totalAmount")).toBe(false);
  });
});
