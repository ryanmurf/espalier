import { describe, it, expect } from "vitest";
import { DateConverter } from "../../converters/date-converter.js";

describe("DateConverter", () => {
  const converter = new DateConverter();

  it("has name 'date' and dbType 'text'", () => {
    expect(converter.name).toBe("date");
    expect(converter.dbType).toBe("text");
  });

  describe("toDatabaseValue", () => {
    it("converts a Date to ISO string", () => {
      const date = new Date("2024-06-15T12:30:00.000Z");
      expect(converter.toDatabaseValue(date)).toBe("2024-06-15T12:30:00.000Z");
    });

    it("returns null for null", () => {
      expect(converter.toDatabaseValue(null)).toBeNull();
    });

    it("includes milliseconds in the ISO string", () => {
      const date = new Date("2024-01-01T00:00:00.123Z");
      expect(converter.toDatabaseValue(date)).toBe("2024-01-01T00:00:00.123Z");
    });
  });

  describe("fromDatabaseValue", () => {
    it("converts an ISO string to a Date", () => {
      const result = converter.fromDatabaseValue("2024-06-15T12:30:00.000Z");
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toBe("2024-06-15T12:30:00.000Z");
    });

    it("returns null for null", () => {
      expect(converter.fromDatabaseValue(null)).toBeNull();
    });

    it("handles date-only strings", () => {
      const result = converter.fromDatabaseValue("2024-06-15");
      expect(result).toBeInstanceOf(Date);
      expect(result!.getFullYear()).toBe(2024);
    });

    it("handles datetime strings with timezone offset", () => {
      const result = converter.fromDatabaseValue("2024-06-15T12:30:00+05:00");
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toBe("2024-06-15T07:30:00.000Z");
    });
  });

  describe("round-trip", () => {
    it("preserves a Date through toDatabaseValue then fromDatabaseValue", () => {
      const original = new Date("2024-06-15T12:30:45.678Z");
      const dbValue = converter.toDatabaseValue(original);
      const restored = converter.fromDatabaseValue(dbValue);
      expect(restored!.getTime()).toBe(original.getTime());
    });

    it("preserves null through round-trip", () => {
      expect(
        converter.fromDatabaseValue(converter.toDatabaseValue(null)),
      ).toBeNull();
    });
  });
});
