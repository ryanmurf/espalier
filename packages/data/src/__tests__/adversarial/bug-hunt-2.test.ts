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

describe("FIXED #49: DISTINCT SQL generation", () => {
  it("buildDerivedQuery with distinct generates single DISTINCT after SELECT", () => {
    const desc = parseDerivedQueryMethod("findDistinctByName");
    const query = buildDerivedQuery(desc, userMetadata, ["Alice"]);

    const selectPart = query.sql.split(" FROM ")[0];
    const distinctCount = (selectPart.match(/DISTINCT/g) || []).length;

    expect(distinctCount).toBe(1);
    expect(selectPart).toMatch(/^SELECT DISTINCT "?\w/);
  });
});

// ══════════════════════════════════════════════════
// BUG #53: OrderBy parser misidentifies properties with Asc/Desc substrings
// ══════════════════════════════════════════════════

describe("FIXED #53: OrderBy parser with Asc/Desc in property names", () => {
  it("property named 'description' parses correctly (no longer throws)", () => {
    // "findByNameOrderByDescription" -- "Description" contains "Desc" at position 0
    // Fixed: parser now uses endsWith() for Asc/Desc suffix detection
    const desc = parseDerivedQueryMethod("findByNameOrderByDescription");
    expect(desc.properties[0].property).toBe("name");
    expect(desc.orderBy).toHaveLength(1);
    expect(desc.orderBy![0].property).toBe("description");
  });

  it("property named 'ascending' parses correctly (no longer throws)", () => {
    // "findByNameOrderByAscending" -- "Ascending" contains "Asc" at position 0
    // Fixed: parser now uses endsWith() for Asc/Desc suffix detection
    const desc = parseDerivedQueryMethod("findByNameOrderByAscending");
    expect(desc.properties[0].property).toBe("name");
    expect(desc.orderBy).toHaveLength(1);
    expect(desc.orderBy![0].property).toBe("ascending");
  });

  it("'DescriptionDesc' parses as property=description, direction=Desc", () => {
    // "findByNameOrderByDescriptionDesc"
    // Fixed: parser correctly identifies trailing "Desc" suffix
    const desc = parseDerivedQueryMethod("findByNameOrderByDescriptionDesc");
    expect(desc.properties[0].property).toBe("name");
    expect(desc.orderBy).toHaveLength(1);
    expect(desc.orderBy![0].property).toBe("description");
    expect(desc.orderBy![0].direction).toBe("Desc");
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
