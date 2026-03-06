import { describe, expect, it } from "vitest";
import { BooleanConverter } from "../../converters/boolean-converter.js";

describe("BooleanConverter", () => {
  const converter = new BooleanConverter();

  it("has name 'boolean' and dbType 'integer'", () => {
    expect(converter.name).toBe("boolean");
    expect(converter.dbType).toBe("integer");
  });

  describe("toDatabaseValue", () => {
    it("converts true to 1", () => {
      expect(converter.toDatabaseValue(true)).toBe(1);
    });

    it("converts false to 0", () => {
      expect(converter.toDatabaseValue(false)).toBe(0);
    });

    it("returns null for null", () => {
      expect(converter.toDatabaseValue(null)).toBeNull();
    });
  });

  describe("fromDatabaseValue", () => {
    it("converts 1 to true", () => {
      expect(converter.fromDatabaseValue(1)).toBe(true);
    });

    it("converts 0 to false", () => {
      expect(converter.fromDatabaseValue(0)).toBe(false);
    });

    it("converts any non-zero number to true", () => {
      expect(converter.fromDatabaseValue(42)).toBe(true);
      expect(converter.fromDatabaseValue(-1)).toBe(true);
    });

    it("returns null for null", () => {
      expect(converter.fromDatabaseValue(null)).toBeNull();
    });
  });

  describe("round-trip", () => {
    it("preserves true through round-trip", () => {
      expect(converter.fromDatabaseValue(converter.toDatabaseValue(true))).toBe(true);
    });

    it("preserves false through round-trip", () => {
      expect(converter.fromDatabaseValue(converter.toDatabaseValue(false))).toBe(false);
    });

    it("preserves null through round-trip", () => {
      expect(converter.fromDatabaseValue(converter.toDatabaseValue(null))).toBeNull();
    });
  });
});
