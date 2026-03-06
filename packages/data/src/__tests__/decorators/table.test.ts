import { describe, expect, it } from "vitest";
import { getTableName, Table } from "../../decorators/table.js";

describe("@Table decorator", () => {
  it("sets a custom table name", () => {
    @Table("users")
    class User {}

    expect(getTableName(User)).toBe("users");
  });

  it("defaults to lowercased class name when no argument given", () => {
    @Table()
    class Product {}

    expect(getTableName(Product)).toBe("product");
  });

  it("returns undefined for an undecorated class", () => {
    class Plain {}

    expect(getTableName(Plain)).toBeUndefined();
  });

  it("stores metadata per class (no cross-contamination)", () => {
    @Table("orders")
    class Order {}

    @Table("items")
    class Item {}

    expect(getTableName(Order)).toBe("orders");
    expect(getTableName(Item)).toBe("items");
  });
});
