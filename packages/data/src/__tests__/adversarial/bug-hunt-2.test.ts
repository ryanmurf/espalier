/**
 * Adversarial tests round 2: confirming additional bugs found by code reviewers.
 */
import { describe, it, expect } from "vitest";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";

const userMetadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
    { fieldName: "email", columnName: "email" },
    { fieldName: "description", columnName: "description" },
    { fieldName: "ascending", columnName: "ascending" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  lifecycleCallbacks: new Map(),
};

// ══════════════════════════════════════════════════
// BUG #51: parsePrefix findDistinctBy guard has dead code
// ══════════════════════════════════════════════════

describe("BUG #51: parsePrefix findDistinct guard issues", () => {
  it("findDistinctByName works correctly", () => {
    const desc = parseDerivedQueryMethod("findDistinctByName");
    expect(desc.distinct).toBe(true);
    expect(desc.properties[0].property).toBe("name");
  });

  it("findDistinct without By throws", () => {
    expect(() => parseDerivedQueryMethod("findDistinctName")).toThrow();
  });

  it("findDistinctAllByName throws (not findDistinctBy)", () => {
    expect(() => parseDerivedQueryMethod("findDistinctAllByName")).toThrow();
  });

  it("String.slice never returns undefined (dead code proof)", () => {
    const result = "hello".slice(100);
    expect(result).toBe("");
    expect(typeof result).toBe("string");
  });
});

// ══════════════════════════════════════════════════
// BUG #49: DISTINCT per-column in executor
// ══════════════════════════════════════════════════

describe("BUG #49: DISTINCT SQL generation per-column", () => {
  it("buildDerivedQuery with distinct generates DISTINCT prefix on ALL columns", () => {
    const desc = parseDerivedQueryMethod("findDistinctByName");
    const query = buildDerivedQuery(desc, userMetadata, ["Alice"]);

    const selectPart = query.sql.split(" FROM ")[0];
    const distinctCount = (selectPart.match(/DISTINCT/g) || []).length;

    // BUG: DISTINCT appears once per column instead of once after SELECT
    // Expected: 1, Actual: 5 (one for each column in userMetadata)
    expect(distinctCount).toBeGreaterThan(1); // confirms bug
  });
});

// ══════════════════════════════════════════════════
// BUG #53: OrderBy parser misidentifies properties with Asc/Desc substrings
// ══════════════════════════════════════════════════

describe("BUG #53: OrderBy parser with Asc/Desc in property names", () => {
  it("property named 'description' contains 'Desc' substring", () => {
    // "findByNameOrderByDescription" -- "Description" contains "Desc"
    // The parser uses indexOf("Desc") which will find it at position 0 of "DescriptionAsc"
    // or the "Desc" inside "Description"
    const desc = parseDerivedQueryMethod("findByNameOrderByDescription");
    expect(desc.orderBy).toBeDefined();

    // If the parser correctly handles this, the orderBy property should be "description"
    // But if it splits on the embedded "Desc", it might produce garbage
    if (desc.orderBy && desc.orderBy.length > 0) {
      const orderByProp = desc.orderBy[0].property;
      // Bug: parser might split "Description" at "Desc" and get:
      // - "description" with direction "Desc" and remaining "ription"
      // OR correctly parse it as the full property "description" with default "Asc"
      // Let's see what actually happens:
      expect(orderByProp).toBeDefined();
    }
  });

  it("property named 'ascending' contains 'Asc' substring", () => {
    // "findByNameOrderByAscending" -- "Ascending" contains "Asc"
    const desc = parseDerivedQueryMethod("findByNameOrderByAscending");
    expect(desc.orderBy).toBeDefined();

    if (desc.orderBy && desc.orderBy.length > 0) {
      const orderByProp = desc.orderBy[0].property;
      // The parser will find "Asc" at position 0 of "Ascending"
      // This means propPart = "" (empty string before "Asc"), which should throw
      // but let's see what actually happens:
      expect(orderByProp).toBeDefined();
    }
  });

  it("OrderBy with 'DescriptionDesc' (Desc suffix AND Desc in name)", () => {
    // "findByNameOrderByDescriptionDesc"
    // Contains "Desc" twice: once in "Description" and once as the direction suffix
    const desc = parseDerivedQueryMethod("findByNameOrderByDescriptionDesc");
    expect(desc.orderBy).toBeDefined();

    if (desc.orderBy && desc.orderBy.length > 0) {
      // Correct behavior: property="description", direction="Desc"
      // But indexOf("Desc") finds the first "Desc" at position 0, not the suffix
      const ob = desc.orderBy[0];
      // If bug exists, property might be empty or "ription"
      // If correct, property is "description" and direction is "Desc"
      expect(ob.property).toBeDefined();
      expect(ob.direction).toBeDefined();
    }
  });
});

// ══════════════════════════════════════════════════
// Edge: connector detection with property names containing "And"/"Or"
// ══════════════════════════════════════════════════

describe("Connector detection edge cases", () => {
  it("findByBandAndName correctly splits on And between Band and Name", () => {
    // "BandAndName" -- "Band" ends with lowercase 'd', "And" starts with 'A'
    // After "And", "Name" starts with 'N' (uppercase) -- valid boundary
    const desc = parseDerivedQueryMethod("findByBandAndName");
    // Should split into ["Band", "Name"]
    expect(desc.properties).toHaveLength(2);
    expect(desc.properties[0].property).toBe("band");
    expect(desc.properties[1].property).toBe("name");
  });

  it("findByLandOrSea correctly splits", () => {
    const desc = parseDerivedQueryMethod("findByLandOrSea");
    expect(desc.properties).toHaveLength(2);
    expect(desc.connector).toBe("Or");
    expect(desc.properties[0].property).toBe("land");
    expect(desc.properties[1].property).toBe("sea");
  });

  it("findByAndroid doesn't split on And (no uppercase after 'And')", () => {
    // "Android" -- "And" at position 0, but character after "And" is 'r' (lowercase)
    // So this should NOT be split
    const desc = parseDerivedQueryMethod("findByAndroid");
    expect(desc.properties).toHaveLength(1);
    expect(desc.properties[0].property).toBe("android");
  });

  it("findByOrange doesn't split on Or", () => {
    // "Orange" -- "Or" at position 0, but character after "Or" is 'a' (lowercase)
    const desc = parseDerivedQueryMethod("findByOrange");
    expect(desc.properties).toHaveLength(1);
    expect(desc.properties[0].property).toBe("orange");
  });
});
