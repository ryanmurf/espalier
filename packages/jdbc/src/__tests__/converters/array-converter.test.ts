import { describe, it, expect } from "vitest";
import {
  ArrayConverter,
  PostgresArrayConverter,
} from "../../converters/array-converter.js";

describe("ArrayConverter", () => {
  const converter = new ArrayConverter<string>();

  it("has default name 'array' and dbType 'text'", () => {
    expect(converter.name).toBe("array");
    expect(converter.dbType).toBe("text");
  });

  it("accepts custom name and dbType", () => {
    const custom = new ArrayConverter<number>("int-array", "integer[]");
    expect(custom.name).toBe("int-array");
    expect(custom.dbType).toBe("integer[]");
  });

  describe("toDatabaseValue", () => {
    it("converts a string array to JSON string", () => {
      expect(converter.toDatabaseValue(["a", "b", "c"])).toBe('["a","b","c"]');
    });

    it("converts a number array to JSON string", () => {
      const numConverter = new ArrayConverter<number>();
      expect(numConverter.toDatabaseValue([1, 2, 3])).toBe("[1,2,3]");
    });

    it("converts an empty array to '[]'", () => {
      expect(converter.toDatabaseValue([])).toBe("[]");
    });

    it("returns null for null", () => {
      expect(converter.toDatabaseValue(null)).toBeNull();
    });
  });

  describe("fromDatabaseValue", () => {
    it("converts a JSON array string to typed array", () => {
      expect(converter.fromDatabaseValue('["a","b"]')).toEqual(["a", "b"]);
    });

    it("returns the value as-is if already an array", () => {
      const arr = ["x", "y"];
      expect(converter.fromDatabaseValue(arr as unknown as string)).toBe(arr);
    });

    it("returns null for null", () => {
      expect(converter.fromDatabaseValue(null)).toBeNull();
    });

    it("handles empty JSON array", () => {
      expect(converter.fromDatabaseValue("[]")).toEqual([]);
    });
  });

  describe("round-trip", () => {
    it("preserves data through toDatabaseValue then fromDatabaseValue", () => {
      const original = ["hello", "world"];
      const dbValue = converter.toDatabaseValue(original);
      expect(converter.fromDatabaseValue(dbValue)).toEqual(original);
    });
  });
});

describe("PostgresArrayConverter", () => {
  const converter = new PostgresArrayConverter<string>();

  it("has default name 'pg-array' and dbType 'text[]'", () => {
    expect(converter.name).toBe("pg-array");
    expect(converter.dbType).toBe("text[]");
  });

  it("accepts custom name and dbType", () => {
    const custom = new PostgresArrayConverter<number>("int-arr", "integer[]");
    expect(custom.name).toBe("int-arr");
    expect(custom.dbType).toBe("integer[]");
  });

  describe("toDatabaseValue", () => {
    it("converts a string array to Postgres literal", () => {
      expect(converter.toDatabaseValue(["a", "b", "c"])).toBe("{a,b,c}");
    });

    it("quotes strings containing commas", () => {
      expect(converter.toDatabaseValue(["a,b", "c"])).toBe('{"a,b",c}');
    });

    it("quotes strings containing double quotes", () => {
      expect(converter.toDatabaseValue(['say "hi"'])).toBe('{"say \\"hi\\""}');
    });

    it("quotes strings containing backslashes", () => {
      expect(converter.toDatabaseValue(["a\\b"])).toBe('{"a\\\\b"}');
    });

    it("quotes strings containing curly braces", () => {
      expect(converter.toDatabaseValue(["{x}"])).toBe('{"{x}"}');
    });

    it("converts null elements to NULL", () => {
      expect(
        converter.toDatabaseValue([null as unknown as string, "a"]),
      ).toBe("{NULL,a}");
    });

    it("handles empty array", () => {
      expect(converter.toDatabaseValue([])).toBe("{}");
    });

    it("returns null for null input", () => {
      expect(converter.toDatabaseValue(null)).toBeNull();
    });
  });

  describe("fromDatabaseValue", () => {
    it("parses simple Postgres array literal", () => {
      expect(converter.fromDatabaseValue("{a,b,c}")).toEqual(["a", "b", "c"]);
    });

    it("parses quoted elements", () => {
      expect(converter.fromDatabaseValue('{"a,b",c}')).toEqual(["a,b", "c"]);
    });

    it("parses escaped quotes inside quoted elements", () => {
      expect(converter.fromDatabaseValue('{"say \\"hi\\""}')).toEqual([
        'say "hi"',
      ]);
    });

    it("parses escaped backslashes", () => {
      expect(converter.fromDatabaseValue('{"a\\\\b"}')).toEqual(["a\\b"]);
    });

    it("handles empty Postgres array", () => {
      expect(converter.fromDatabaseValue("{}")).toEqual([]);
    });

    it("converts NULL elements to empty strings", () => {
      expect(converter.fromDatabaseValue("{NULL,a}")).toEqual(["", "a"]);
    });

    it("returns the value as-is if already an array", () => {
      const arr = ["x"];
      expect(converter.fromDatabaseValue(arr as unknown as string)).toBe(arr);
    });

    it("returns null for null", () => {
      expect(converter.fromDatabaseValue(null)).toBeNull();
    });

    it("falls back to JSON.parse for non-Postgres format", () => {
      expect(converter.fromDatabaseValue('["a","b"]')).toEqual(["a", "b"]);
    });
  });

  describe("round-trip", () => {
    it("preserves simple arrays through toDatabaseValue then fromDatabaseValue", () => {
      const original = ["hello", "world"];
      const dbValue = converter.toDatabaseValue(original);
      expect(converter.fromDatabaseValue(dbValue)).toEqual(original);
    });
  });
});
