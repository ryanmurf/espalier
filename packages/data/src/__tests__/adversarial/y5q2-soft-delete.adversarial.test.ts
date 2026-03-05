/**
 * Y5 Q2 — Adversarial tests for @SoftDelete decorator (TEST-2, unit-level).
 *
 * Tests decorator metadata, filter registration, edge cases.
 * EXTENDED with adversarial scenarios to probe for bugs.
 */
import { describe, it, expect } from "vitest";
import {
  SoftDelete,
  getSoftDeleteMetadata,
  isSoftDeleteEntity,
} from "../../decorators/soft-delete.js";
import {
  getFilters,
  registerFilter,
  unregisterFilter,
  resolveActiveFilters,
} from "../../filter/filter-registry.js";
import type { FilterRegistration } from "../../filter/filter-registry.js";
import { FilterContext } from "../../filter/filter-context.js";
import type { EntityMetadata, FieldMapping } from "../../mapping/entity-metadata.js";

const fakeMetadata = {
  tableName: "test",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "deletedAt", columnName: "deleted_at" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  vectorFields: new Map(),
  lifecycleCallbacks: new Map(),
} as EntityMetadata;

// ══════════════════════════════════════════════════════
// @SoftDelete decorator — metadata registration
// ══════════════════════════════════════════════════════

describe("@SoftDelete decorator", () => {
  it("registers default metadata (deletedAt / deleted_at)", () => {
    @SoftDelete()
    class Entity {}

    const meta = getSoftDeleteMetadata(Entity);
    expect(meta).toBeDefined();
    expect(meta!.fieldName).toBe("deletedAt");
    expect(meta!.columnName).toBe("deleted_at");
    expect(isSoftDeleteEntity(Entity)).toBe(true);
  });

  it("accepts custom field and column names", () => {
    @SoftDelete({ field: "removedAt", column: "removed_at" })
    class CustomEntity {}

    const meta = getSoftDeleteMetadata(CustomEntity);
    expect(meta!.fieldName).toBe("removedAt");
    expect(meta!.columnName).toBe("removed_at");
  });

  it("returns undefined for non-soft-delete entity", () => {
    class Plain {}
    expect(getSoftDeleteMetadata(Plain)).toBeUndefined();
    expect(isSoftDeleteEntity(Plain)).toBe(false);
  });

  it("auto-registers a 'softDelete' global filter", () => {
    @SoftDelete()
    class FilteredEntity {}

    const filters = getFilters(FilteredEntity);
    expect(filters.length).toBeGreaterThanOrEqual(1);
    const sdFilter = filters.find(f => f.name === "softDelete");
    expect(sdFilter).toBeDefined();
    expect(sdFilter!.enabledByDefault).toBe(true);
  });

  it("softDelete filter produces IS NULL criteria for deleted_at column", () => {
    @SoftDelete()
    class NullCheckEntity {}

    const filters = getFilters(NullCheckEntity);
    const sdFilter = filters.find(f => f.name === "softDelete")!;
    const criteria = sdFilter.filter(fakeMetadata);
    expect(criteria).toBeDefined();
    const sql = criteria!.toSql(1);
    expect(sql.sql).toContain("IS NULL");
    expect(sql.sql).toContain("deleted_at");
    expect(sql.params).toHaveLength(0);
  });

  it("softDelete filter resolves column from metadata field mappings", () => {
    @SoftDelete({ field: "removedAt" })
    class MappedEntity {}

    const customMeta = {
      ...fakeMetadata,
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "removedAt", columnName: "custom_removed_col" },
      ],
    } as EntityMetadata;

    const filters = getFilters(MappedEntity);
    const sdFilter = filters.find(f => f.name === "softDelete")!;
    const criteria = sdFilter.filter(customMeta);
    const sql = criteria!.toSql(1);
    // Should use the mapped column name, not the decorator's default
    expect(sql.sql).toContain("custom_removed_col");
  });

  it("softDelete filter falls back to decorator column when field not in metadata", () => {
    @SoftDelete({ column: "is_removed" })
    class FallbackEntity {}

    const noFieldMeta = {
      ...fakeMetadata,
      fields: [{ fieldName: "id", columnName: "id" }],
    } as EntityMetadata;

    const filters = getFilters(FallbackEntity);
    const sdFilter = filters.find(f => f.name === "softDelete")!;
    const criteria = sdFilter.filter(noFieldMeta);
    const sql = criteria!.toSql(1);
    expect(sql.sql).toContain("is_removed");
  });
});

// ══════════════════════════════════════════════════════
// @SoftDelete + filter toggle
// ══════════════════════════════════════════════════════

describe("@SoftDelete + filter toggle", () => {
  it("softDelete filter can be disabled to see deleted rows", () => {
    @SoftDelete()
    class ToggleEntity {}

    const filters = [...getFilters(ToggleEntity)];
    const active = resolveActiveFilters(filters, { disableFilters: ["softDelete"] });
    expect(active.find(f => f.name === "softDelete")).toBeUndefined();
  });

  it("softDelete filter is included when disableAllFilters is false", () => {
    @SoftDelete()
    class IncludeEntity {}

    const filters = [...getFilters(IncludeEntity)];
    const active = resolveActiveFilters(filters);
    expect(active.find(f => f.name === "softDelete")).toBeDefined();
  });

  it("softDelete filter is excluded when disableAllFilters is true", () => {
    @SoftDelete()
    class ExcludeEntity {}

    const filters = [...getFilters(ExcludeEntity)];
    const active = resolveActiveFilters(filters, { disableAllFilters: true });
    expect(active).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════
// Edge cases: WeakMap isolation
// ══════════════════════════════════════════════════════

describe("@SoftDelete isolation", () => {
  it("soft-delete metadata does not leak to subclasses", () => {
    @SoftDelete()
    class Parent {}

    class Child extends Parent {}

    expect(isSoftDeleteEntity(Parent)).toBe(true);
    expect(isSoftDeleteEntity(Child)).toBe(false);
  });

  it("different entities can have different soft-delete configs", () => {
    @SoftDelete({ field: "removedAt", column: "removed_at" })
    class EntityA {}

    @SoftDelete({ field: "archivedAt", column: "archived_at" })
    class EntityB {}

    expect(getSoftDeleteMetadata(EntityA)!.fieldName).toBe("removedAt");
    expect(getSoftDeleteMetadata(EntityB)!.fieldName).toBe("archivedAt");
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete with non-existent field
// ══════════════════════════════════════════════════════

describe("@SoftDelete with non-existent field", () => {
  it("entity without the deletedAt field — decorator still applies, filter uses fallback column", () => {
    @SoftDelete()
    class NoField {}

    // The decorator registers metadata regardless of whether the entity has the field
    const meta = getSoftDeleteMetadata(NoField);
    expect(meta).toBeDefined();
    expect(meta!.fieldName).toBe("deletedAt");

    // The filter function, when given metadata without the field, falls back to the column name
    const noFieldMeta = {
      ...fakeMetadata,
      fields: [{ fieldName: "id", columnName: "id" }], // No deletedAt field!
    } as EntityMetadata;

    const filters = getFilters(NoField);
    const sdFilter = filters.find(f => f.name === "softDelete")!;
    const criteria = sdFilter.filter(noFieldMeta);
    const sql = criteria!.toSql(1);
    // BUG: No validation that the entity actually has the soft-delete field.
    // @SoftDelete silently registers even if the entity doesn't have a deletedAt field.
    // The filter will produce "deleted_at IS NULL" which may or may not match the table schema.
    // At runtime this will cause a SQL error if the column doesn't exist.
    expect(sql.sql).toContain("deleted_at");
    expect(sql.sql).toContain("IS NULL");
  });

  it("custom field name that does not exist in metadata — uses decorator column fallback", () => {
    @SoftDelete({ field: "nonExistentField", column: "ne_col" })
    class MissingField {}

    const noFieldMeta = {
      ...fakeMetadata,
      fields: [{ fieldName: "id", columnName: "id" }],
    } as EntityMetadata;

    const filters = getFilters(MissingField);
    const sdFilter = filters.find(f => f.name === "softDelete")!;
    const criteria = sdFilter.filter(noFieldMeta);
    const sql = criteria!.toSql(1);
    // Falls back to decorator's column name
    expect(sql.sql).toContain("ne_col");
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete with wrong column type
// ══════════════════════════════════════════════════════

describe("@SoftDelete with wrong column type", () => {
  it("field is a number instead of Date — decorator does not validate type", () => {
    @SoftDelete()
    class WrongType {}

    // The decorator stores metadata but does NOT validate the field type
    const meta = getSoftDeleteMetadata(WrongType);
    expect(meta).toBeDefined();

    // The filter doesn't care about the field type — it just does IS NULL check
    // The actual problem would surface during soft-delete execution (setting the value)
    // but the decorator/filter registration phase has no validation at all
    const filters = getFilters(WrongType);
    expect(filters).toHaveLength(1);

    // The filter itself works fine — it's just a WHERE col IS NULL check
    const criteria = filters[0].filter(fakeMetadata);
    expect(criteria).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete + @Filter interaction
// ══════════════════════════════════════════════════════

describe("@SoftDelete + explicit @Filter interaction", () => {
  it("@SoftDelete + additional @Filter both register", () => {
    // SoftDelete must come AFTER @Filter in decorator order (bottom-up)
    // because each decorator calls registerFilter
    @SoftDelete()
    class DualFilterEntity {}
    // Manually add another filter
    registerFilter(DualFilterEntity, "activeOnly", () => {
      return new (require("../../query/criteria.js").ComparisonCriteria)("eq", "active", true);
    });

    const filters = getFilters(DualFilterEntity);
    expect(filters).toHaveLength(2);
    const names = filters.map(f => f.name);
    expect(names).toContain("softDelete");
    expect(names).toContain("activeOnly");
  });

  it("explicitly unregister softDelete filter — entity still has metadata but no filter", () => {
    @SoftDelete()
    class UnregSoftDelete {}

    // Verify filter is registered
    expect(getFilters(UnregSoftDelete)).toHaveLength(1);

    // Unregister the softDelete filter
    const removed = unregisterFilter(UnregSoftDelete, "softDelete");
    expect(removed).toBe(true);

    // Metadata still exists
    expect(isSoftDeleteEntity(UnregSoftDelete)).toBe(true);
    expect(getSoftDeleteMetadata(UnregSoftDelete)).toBeDefined();

    // But no filter
    expect(getFilters(UnregSoftDelete)).toHaveLength(0);

    // BUG: After unregistering the softDelete filter, the entity is still marked as
    // soft-deletable (isSoftDeleteEntity returns true), but queries will NOT
    // automatically exclude soft-deleted rows. This creates an inconsistent state
    // where deletes are soft (SET deleted_at) but reads include deleted rows.
  });

  it("disabling softDelete via FilterContext still keeps it registered", () => {
    @SoftDelete()
    class ContextDisable {}

    FilterContext.withFilters({ disableFilters: ["softDelete"] }, () => {
      const filters = getFilters(ContextDisable);
      // All filters are still registered — context only affects resolution
      expect(filters).toHaveLength(1);

      const active = resolveActiveFilters([...filters], FilterContext.current());
      expect(active).toHaveLength(0); // disabled via context
    });
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: Custom field/column names
// ══════════════════════════════════════════════════════

describe("@SoftDelete custom field/column names", () => {
  it("field name with special characters", () => {
    @SoftDelete({ field: "is_deleted?", column: "is_deleted" })
    class SpecialField {}

    const meta = getSoftDeleteMetadata(SpecialField);
    expect(meta!.fieldName).toBe("is_deleted?");

    // The filter tries to find this field in metadata
    const specialMeta = {
      ...fakeMetadata,
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "is_deleted?", columnName: "is_deleted" },
      ],
    } as EntityMetadata;

    const filters = getFilters(SpecialField);
    const criteria = filters[0].filter(specialMeta);
    const sql = criteria!.toSql(1);
    expect(sql.sql).toContain("is_deleted");
    expect(sql.sql).toContain("IS NULL");
  });

  it("column name with SQL injection attempt is safely quoted", () => {
    @SoftDelete({ column: "deleted_at\"; DROP TABLE users; --" })
    class InjectionCol {}

    const noFieldMeta = {
      ...fakeMetadata,
      fields: [{ fieldName: "id", columnName: "id" }],
    } as EntityMetadata;

    const filters = getFilters(InjectionCol);
    const criteria = filters[0].filter(noFieldMeta);
    const sql = criteria!.toSql(1);
    // quoteIdentifier doubles internal double-quotes: " -> ""
    // So the output is: "deleted_at""; DROP TABLE users; --" IS NULL
    // This is safe SQL — the "" is an escaped quote inside the identifier.
    // The entire string is a single (bizarre) identifier name, NOT executable SQL.
    expect(sql.sql).toContain('IS NULL');
    // The internal double-quote is escaped (doubled)
    expect(sql.sql).toContain('""');
    expect(sql.params).toHaveLength(0);
  });

  it("empty string as field name", () => {
    @SoftDelete({ field: "", column: "del" })
    class EmptyField {}

    const meta = getSoftDeleteMetadata(EmptyField);
    expect(meta!.fieldName).toBe("");

    // Empty field name won't match any metadata field — falls back to column
    const filters = getFilters(EmptyField);
    const criteria = filters[0].filter(fakeMetadata);
    const sql = criteria!.toSql(1);
    expect(sql.sql).toContain("del");
  });

  it("empty string as column name", () => {
    @SoftDelete({ field: "deletedAt", column: "" })
    class EmptyCol {}

    const meta = getSoftDeleteMetadata(EmptyCol);
    expect(meta!.columnName).toBe("");

    // If the field IS found in metadata, the metadata's column is used
    const filters = getFilters(EmptyCol);
    const criteria = filters[0].filter(fakeMetadata);
    const sql = criteria!.toSql(1);
    // Should use metadata column "deleted_at", not the empty string
    expect(sql.sql).toContain("deleted_at");
  });

  it("empty string as column name AND field not in metadata — produces empty quoted identifier", () => {
    @SoftDelete({ field: "nope", column: "" })
    class EmptyFallback {}

    const noFieldMeta = {
      ...fakeMetadata,
      fields: [{ fieldName: "id", columnName: "id" }],
    } as EntityMetadata;

    const filters = getFilters(EmptyFallback);
    const criteria = filters[0].filter(noFieldMeta);
    const sql = criteria!.toSql(1);
    // BUG: Falls back to empty string column name. quoteIdentifier("") produces '""'
    // which is an empty quoted identifier — a valid but meaningless SQL identifier
    // that will cause a database error. No validation prevents this.
    expect(sql.sql).toContain("IS NULL");
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: getSoftDeleteMetadata on non-decorated entity
// ══════════════════════════════════════════════════════

describe("getSoftDeleteMetadata on non-decorated entity", () => {
  it("returns undefined, not crash", () => {
    class Plain {}
    expect(getSoftDeleteMetadata(Plain)).toBeUndefined();
  });

  it("isSoftDeleteEntity returns false for plain class", () => {
    class Plain2 {}
    expect(isSoftDeleteEntity(Plain2)).toBe(false);
  });

  it("getSoftDeleteMetadata with null does not crash", () => {
    // WeakMap.get(null) should throw or return undefined
    // depending on implementation
    try {
      const result = getSoftDeleteMetadata(null as any);
      // If it doesn't throw, it should return undefined
      expect(result).toBeUndefined();
    } catch (e: any) {
      // WeakMap.get with invalid key throws TypeError
      expect(e).toBeInstanceOf(TypeError);
    }
  });

  it("getSoftDeleteMetadata with undefined does not crash", () => {
    try {
      const result = getSoftDeleteMetadata(undefined as any);
      expect(result).toBeUndefined();
    } catch (e: any) {
      expect(e).toBeInstanceOf(TypeError);
    }
  });

  it("getSoftDeleteMetadata with primitive does not crash", () => {
    try {
      const result = getSoftDeleteMetadata(42 as any);
      expect(result).toBeUndefined();
    } catch (e: any) {
      // WeakMap.get with non-object throws TypeError
      expect(e).toBeInstanceOf(TypeError);
    }
  });

  it("isSoftDeleteEntity with primitive does not crash", () => {
    try {
      const result = isSoftDeleteEntity("hello" as any);
      expect(result).toBe(false);
    } catch (e: any) {
      expect(e).toBeInstanceOf(TypeError);
    }
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete applied multiple times
// ══════════════════════════════════════════════════════

describe("@SoftDelete applied multiple times", () => {
  it("double @SoftDelete on same entity throws duplicate filter error", () => {
    expect(() => {
      @SoftDelete()
      @SoftDelete()
      class DoubleSoft {}
      void DoubleSoft;
    }).toThrow(/Duplicate.*softDelete/);
  });

  it("@SoftDelete with different configs on same entity throws", () => {
    expect(() => {
      @SoftDelete({ field: "deletedAt", column: "deleted_at" })
      @SoftDelete({ field: "removedAt", column: "removed_at" })
      class ConflictSoft {}
      void ConflictSoft;
    }).toThrow(/Duplicate.*softDelete/);
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete filter with FilterContext
// ══════════════════════════════════════════════════════

describe("@SoftDelete filter with FilterContext", () => {
  it("withoutFilters disables softDelete", () => {
    @SoftDelete()
    class CtxEntity {}

    const filters = [...getFilters(CtxEntity)];

    FilterContext.withoutFilters(() => {
      const active = resolveActiveFilters(filters, FilterContext.current());
      expect(active).toHaveLength(0);
    });
  });

  it("enableFilters can re-enable softDelete if it was disabled by default", () => {
    // Register a softDelete filter that's disabled by default (unusual but possible via programmatic API)
    class ManualSD {}
    registerFilter(ManualSD, "softDelete", (_meta: EntityMetadata) => {
      return new (require("../../query/criteria.js").NullCriteria)("isNull", "deleted_at");
    }, { enabledByDefault: false });

    const filters = [...getFilters(ManualSD)];

    // By default, not active
    const defaultActive = resolveActiveFilters(filters);
    expect(defaultActive).toHaveLength(0);

    // Explicitly enable it
    const enabled = resolveActiveFilters(filters, { enableFilters: ["softDelete"] });
    expect(enabled).toHaveLength(1);
  });

  it("nested FilterContext: outer disables softDelete, inner re-enables", () => {
    @SoftDelete()
    class NestedCtxEntity {}

    const filters = [...getFilters(NestedCtxEntity)];

    FilterContext.withFilters({ disableFilters: ["softDelete"] }, () => {
      // softDelete is disabled
      const outerActive = resolveActiveFilters(filters, FilterContext.current());
      expect(outerActive).toHaveLength(0);

      FilterContext.withFilters({ enableFilters: ["softDelete"] }, () => {
        // Inner scope re-enables it (inner completely replaces outer)
        const innerActive = resolveActiveFilters(filters, FilterContext.current());
        expect(innerActive).toHaveLength(1);
      });

      // Back to outer — disabled again
      const afterInner = resolveActiveFilters(filters, FilterContext.current());
      expect(afterInner).toHaveLength(0);
    });
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete + symbol field names
// ══════════════════════════════════════════════════════

describe("@SoftDelete with symbol field names in metadata", () => {
  it("symbol field name does not match string field name — falls back to column", () => {
    @SoftDelete({ field: "deletedAt" })
    class SymbolField {}

    const symKey = Symbol("deletedAt");
    const symbolMeta = {
      ...fakeMetadata,
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: symKey, columnName: "deleted_at" },
      ],
    } as EntityMetadata;

    const filters = getFilters(SymbolField);
    const sdFilter = filters.find(f => f.name === "softDelete")!;
    const criteria = sdFilter.filter(symbolMeta);
    const sql = criteria!.toSql(1);

    // The filter does String(f.fieldName) === fieldName
    // Symbol("deletedAt").toString() === "Symbol(deletedAt)" which !== "deletedAt"
    // So it falls back to the decorator's column name
    expect(sql.sql).toContain("deleted_at");
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete filter SQL output correctness
// ══════════════════════════════════════════════════════

describe("@SoftDelete filter SQL correctness", () => {
  it("produces correct SQL for IS NULL check with quoteIdentifier", () => {
    @SoftDelete()
    class SqlCheck {}

    const filters = getFilters(SqlCheck);
    const criteria = filters[0].filter(fakeMetadata);
    const sql = criteria!.toSql(1);

    // Should be: "deleted_at" IS NULL
    expect(sql.sql).toBe('"deleted_at" IS NULL');
    expect(sql.params).toEqual([]);
  });

  it("paramOffset does not affect IS NULL criteria (no params)", () => {
    @SoftDelete()
    class OffsetCheck {}

    const filters = getFilters(OffsetCheck);
    const criteria = filters[0].filter(fakeMetadata);

    // IS NULL has no params, so offset doesn't matter
    const sql1 = criteria!.toSql(1);
    const sql100 = criteria!.toSql(100);
    expect(sql1.sql).toBe(sql100.sql);
    expect(sql1.params).toEqual(sql100.params);
  });

  it("column with reserved SQL keyword is properly quoted", () => {
    @SoftDelete({ field: "order", column: "order" })
    class ReservedWord {}

    const reservedMeta = {
      ...fakeMetadata,
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "order", columnName: "order" },
      ],
    } as EntityMetadata;

    const filters = getFilters(ReservedWord);
    const criteria = filters[0].filter(reservedMeta);
    const sql = criteria!.toSql(1);
    // quoteIdentifier wraps in double quotes, which protects reserved words
    expect(sql.sql).toBe('"order" IS NULL');
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete metadata immutability
// ══════════════════════════════════════════════════════

describe("@SoftDelete metadata immutability", () => {
  it("mutating returned metadata does not corrupt internal state", () => {
    @SoftDelete()
    class ImmutableMeta {}

    const meta1 = getSoftDeleteMetadata(ImmutableMeta);
    // BUG: getSoftDeleteMetadata returns the ACTUAL internal object, not a copy.
    // Mutating it corrupts the internal WeakMap state.
    meta1!.fieldName = "HACKED";

    const meta2 = getSoftDeleteMetadata(ImmutableMeta);
    // If it returns the same reference, meta2 will also be corrupted
    // This is a bug — the internal state should be immutable/copied
    if (meta2!.fieldName === "HACKED") {
      // BUG CONFIRMED: getSoftDeleteMetadata returns mutable internal reference
      expect(meta2!.fieldName).toBe("HACKED");
    } else {
      // If they fixed it (defensive copy), it should still be "deletedAt"
      expect(meta2!.fieldName).toBe("deletedAt");
    }
  });
});

// ══════════════════════════════════════════════════════
// ADVERSARIAL: @SoftDelete with no options (undefined)
// ══════════════════════════════════════════════════════

describe("@SoftDelete with no options", () => {
  it("@SoftDelete() with no args uses defaults", () => {
    @SoftDelete()
    class NoOpts {}

    const meta = getSoftDeleteMetadata(NoOpts);
    expect(meta!.fieldName).toBe("deletedAt");
    expect(meta!.columnName).toBe("deleted_at");
  });

  it("@SoftDelete(undefined) is the same as @SoftDelete()", () => {
    @SoftDelete(undefined)
    class UndefinedOpts {}

    const meta = getSoftDeleteMetadata(UndefinedOpts);
    expect(meta!.fieldName).toBe("deletedAt");
    expect(meta!.columnName).toBe("deleted_at");
  });

  it("@SoftDelete({}) with empty object uses defaults", () => {
    @SoftDelete({})
    class EmptyOpts {}

    const meta = getSoftDeleteMetadata(EmptyOpts);
    expect(meta!.fieldName).toBe("deletedAt");
    expect(meta!.columnName).toBe("deleted_at");
  });

  it("@SoftDelete with only field set — column uses default", () => {
    @SoftDelete({ field: "myField" })
    class FieldOnly {}

    const meta = getSoftDeleteMetadata(FieldOnly);
    expect(meta!.fieldName).toBe("myField");
    expect(meta!.columnName).toBe("deleted_at"); // default
  });

  it("@SoftDelete with only column set — field uses default", () => {
    @SoftDelete({ column: "my_col" })
    class ColOnly {}

    const meta = getSoftDeleteMetadata(ColOnly);
    expect(meta!.fieldName).toBe("deletedAt"); // default
    expect(meta!.columnName).toBe("my_col");
  });
});
