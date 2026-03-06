import { describe, expect, it } from "vitest";
import { JsonbConverter, JsonConverter } from "../../converters/json-converter.js";

describe("JsonConverter", () => {
  const converter = new JsonConverter();

  it("has name 'json' and dbType 'json'", () => {
    expect(converter.name).toBe("json");
    expect(converter.dbType).toBe("json");
  });

  describe("toDatabaseValue", () => {
    it("converts a plain object to JSON string", () => {
      expect(converter.toDatabaseValue({ a: 1 })).toBe('{"a":1}');
    });

    it("converts a nested object to JSON string", () => {
      const value = { user: { name: "Alice", tags: ["admin", "active"] } };
      expect(converter.toDatabaseValue(value)).toBe(JSON.stringify(value));
    });

    it("converts an array to JSON string", () => {
      expect(converter.toDatabaseValue([1, 2, 3] as unknown as object)).toBe("[1,2,3]");
    });

    it("returns null for null", () => {
      expect(converter.toDatabaseValue(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(converter.toDatabaseValue(undefined as unknown as null)).toBeNull();
    });
  });

  describe("fromDatabaseValue", () => {
    it("converts a valid JSON string to object", () => {
      expect(converter.fromDatabaseValue('{"a":1}')).toEqual({ a: 1 });
    });

    it("converts a JSON array string to array", () => {
      expect(converter.fromDatabaseValue("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("returns null for null", () => {
      expect(converter.fromDatabaseValue(null)).toBeNull();
    });

    it("returns the value as-is if already an object", () => {
      const obj = { already: "parsed" };
      expect(converter.fromDatabaseValue(obj as unknown as string)).toBe(obj);
    });

    it("throws on invalid JSON", () => {
      expect(() => converter.fromDatabaseValue("not-json")).toThrow();
    });
  });

  describe("round-trip", () => {
    it("preserves data through toDatabaseValue then fromDatabaseValue", () => {
      const original = { name: "test", nested: { count: 42, items: [1, 2] } };
      const dbValue = converter.toDatabaseValue(original);
      const restored = converter.fromDatabaseValue(dbValue);
      expect(restored).toEqual(original);
    });

    it("preserves null through round-trip", () => {
      const dbValue = converter.toDatabaseValue(null);
      expect(converter.fromDatabaseValue(dbValue)).toBeNull();
    });
  });
});

describe("JsonbConverter", () => {
  const converter = new JsonbConverter();

  it("has name 'jsonb' and dbType 'jsonb'", () => {
    expect(converter.name).toBe("jsonb");
    expect(converter.dbType).toBe("jsonb");
  });

  it("inherits toDatabaseValue behavior from JsonConverter", () => {
    expect(converter.toDatabaseValue({ x: 1 })).toBe('{"x":1}');
    expect(converter.toDatabaseValue(null)).toBeNull();
  });

  it("inherits fromDatabaseValue behavior from JsonConverter", () => {
    expect(converter.fromDatabaseValue('{"x":1}')).toEqual({ x: 1 });
    expect(converter.fromDatabaseValue(null)).toBeNull();
  });
});
