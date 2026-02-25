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
    expect(selectPart).toMatch(/^SELECT DISTINCT \w/);
  });
});

// ══════════════════════════════════════════════════
// BUG #53: OrderBy parser misidentifies properties with Asc/Desc substrings
// ══════════════════════════════════════════════════

describe("BUG #53: OrderBy parser with Asc/Desc in property names", () => {
  it("BUG: property named 'description' throws because parser finds 'Desc' inside it", () => {
    // "findByNameOrderByDescription" -- "Description" contains "Desc" at position 0
    // The parser uses indexOf("Desc") which finds it at position 0,
    // making propPart = "" (empty string), which triggers the error.
    // Correct behavior would be to parse "description" as the property name.
    expect(() => parseDerivedQueryMethod("findByNameOrderByDescription")).toThrow(
      "Invalid OrderBy clause: expected property name before direction."
    );
  });

  it("BUG: property named 'ascending' throws because parser finds 'Asc' inside it", () => {
    // "findByNameOrderByAscending" -- "Ascending" contains "Asc" at position 0
    // indexOf("Asc") returns 0, propPart = "" (empty), throws.
    // Correct behavior would be to parse "ascending" as the property name.
    expect(() => parseDerivedQueryMethod("findByNameOrderByAscending")).toThrow(
      "Invalid OrderBy clause: expected property name before direction."
    );
  });

  it("BUG: 'DescriptionDesc' throws because first 'Desc' is matched, not the suffix", () => {
    // "findByNameOrderByDescriptionDesc"
    // indexOf("Desc") returns 0 (the "Desc" at start of "Description"),
    // not the trailing "Desc" suffix. propPart = "" (empty), throws.
    // Correct behavior: property="description", direction="Desc"
    expect(() => parseDerivedQueryMethod("findByNameOrderByDescriptionDesc")).toThrow(
      "Invalid OrderBy clause: expected property name before direction."
    );
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
