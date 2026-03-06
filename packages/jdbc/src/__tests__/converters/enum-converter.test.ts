import { describe, expect, it } from "vitest";
import { EnumConverter } from "../../converters/enum-converter.js";

type Status = "active" | "inactive" | "pending";

describe("EnumConverter", () => {
  const converter = new EnumConverter<Status>("enum:status", ["active", "inactive", "pending"]);

  it("has the configured name and dbType 'varchar'", () => {
    expect(converter.name).toBe("enum:status");
    expect(converter.dbType).toBe("varchar");
  });

  describe("toDatabaseValue", () => {
    it("returns the string value for a valid enum member", () => {
      expect(converter.toDatabaseValue("active")).toBe("active");
      expect(converter.toDatabaseValue("inactive")).toBe("inactive");
      expect(converter.toDatabaseValue("pending")).toBe("pending");
    });

    it("returns null for null", () => {
      expect(converter.toDatabaseValue(null)).toBeNull();
    });

    it("throws for an invalid value", () => {
      expect(() => converter.toDatabaseValue("deleted" as Status)).toThrow(/Invalid enum value "deleted"/);
    });

    it("includes allowed values in the error message", () => {
      expect(() => converter.toDatabaseValue("unknown" as Status)).toThrow(/Allowed values: active, inactive, pending/);
    });
  });

  describe("fromDatabaseValue", () => {
    it("returns the typed value for a valid string", () => {
      const result: Status | null = converter.fromDatabaseValue("active");
      expect(result).toBe("active");
    });

    it("returns null for null", () => {
      expect(converter.fromDatabaseValue(null)).toBeNull();
    });

    it("throws for an invalid database value", () => {
      expect(() => converter.fromDatabaseValue("deleted")).toThrow(/Invalid enum value "deleted" from database/);
    });

    it("includes converter name in the error message", () => {
      expect(() => converter.fromDatabaseValue("bad")).toThrow(/converter "enum:status"/);
    });
  });

  describe("round-trip", () => {
    it("preserves value through toDatabaseValue then fromDatabaseValue", () => {
      const original: Status = "pending";
      const dbValue = converter.toDatabaseValue(original);
      expect(converter.fromDatabaseValue(dbValue)).toBe(original);
    });
  });
});
