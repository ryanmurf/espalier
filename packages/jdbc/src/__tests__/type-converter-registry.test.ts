import { describe, expect, it } from "vitest";
import { BooleanConverter } from "../converters/boolean-converter.js";
import { DateConverter } from "../converters/date-converter.js";
import { JsonbConverter, JsonConverter } from "../converters/json-converter.js";
import type { TypeConverter } from "../type-converter.js";
import { DefaultTypeConverterRegistry } from "../type-converter-registry.js";

describe("DefaultTypeConverterRegistry", () => {
  it("registers and retrieves a converter by name", () => {
    const registry = new DefaultTypeConverterRegistry();
    const converter = new JsonConverter();
    registry.register(converter);
    expect(registry.get("json")).toBe(converter);
  });

  it("retrieves a converter by dbType", () => {
    const registry = new DefaultTypeConverterRegistry();
    const converter = new BooleanConverter();
    registry.register(converter);
    expect(registry.getForDbType("integer")).toBe(converter);
  });

  it("returns undefined for unknown name", () => {
    const registry = new DefaultTypeConverterRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("returns undefined for unknown dbType", () => {
    const registry = new DefaultTypeConverterRegistry();
    expect(registry.getForDbType("nonexistent")).toBeUndefined();
  });

  it("returns all registered converters via getAll()", () => {
    const registry = new DefaultTypeConverterRegistry();
    const json = new JsonConverter();
    const bool = new BooleanConverter();
    const date = new DateConverter();
    registry.register(json);
    registry.register(bool);
    registry.register(date);

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all).toContain(json);
    expect(all).toContain(bool);
    expect(all).toContain(date);
  });

  it("returns empty array from getAll() when nothing is registered", () => {
    const registry = new DefaultTypeConverterRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("overwrites a converter when registering with the same name", () => {
    const registry = new DefaultTypeConverterRegistry();
    const json1 = new JsonConverter();
    const json2 = new JsonConverter();
    registry.register(json1);
    registry.register(json2);
    expect(registry.get("json")).toBe(json2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("overwrites dbType mapping when registering with the same dbType", () => {
    const registry = new DefaultTypeConverterRegistry();
    const json = new JsonConverter();
    const _jsonb = new JsonbConverter();
    // Both have different names but if we register two with same dbType,
    // the second one wins for dbType lookup
    const customJson: TypeConverter = {
      name: "custom-json",
      dbType: "json",
      toDatabaseValue: (v) => v,
      fromDatabaseValue: (v) => v,
    };
    registry.register(json);
    registry.register(customJson);
    expect(registry.getForDbType("json")).toBe(customJson);
    // But both are still retrievable by name
    expect(registry.get("json")).toBe(json);
    expect(registry.get("custom-json")).toBe(customJson);
  });

  it("supports registering multiple converters with different names and dbTypes", () => {
    const registry = new DefaultTypeConverterRegistry();
    registry.register(new JsonConverter());
    registry.register(new JsonbConverter());
    registry.register(new BooleanConverter());
    registry.register(new DateConverter());

    expect(registry.get("json")).toBeDefined();
    expect(registry.get("jsonb")).toBeDefined();
    expect(registry.get("boolean")).toBeDefined();
    expect(registry.get("date")).toBeDefined();
    expect(registry.getForDbType("json")).toBeDefined();
    expect(registry.getForDbType("jsonb")).toBeDefined();
    expect(registry.getForDbType("integer")).toBeDefined();
    expect(registry.getForDbType("text")).toBeDefined();
    expect(registry.getAll()).toHaveLength(4);
  });
});
