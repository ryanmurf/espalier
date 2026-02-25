import { describe, it, expect } from "vitest";
import { Column, getColumnMappings, getColumnMetadataEntries, getColumnTypeMappings } from "../../decorators/column.js";

describe("@Column decorator", () => {
  it("uses field name as column name when no argument given", () => {
    class User {
      @Column() name: string = "";
    }
    // Field decorators with addInitializer require instantiation
    new User();

    const mappings = getColumnMappings(User);
    expect(mappings.get("name")).toBe("name");
  });

  it("sets custom column name via string shorthand", () => {
    class User {
      @Column("user_name") name: string = "";
    }
    new User();

    const mappings = getColumnMappings(User);
    expect(mappings.get("name")).toBe("user_name");
  });

  it("sets custom column name via options object", () => {
    class User {
      @Column({ name: "email_address" }) email: string = "";
    }
    new User();

    const mappings = getColumnMappings(User);
    expect(mappings.get("email")).toBe("email_address");
  });

  it("returns empty Map for undecorated class", () => {
    class Plain {}

    const mappings = getColumnMappings(Plain);
    expect(mappings.size).toBe(0);
  });

  it("collects multiple columns on the same class", () => {
    class User {
      @Column() id: number = 0;
      @Column("user_name") name: string = "";
      @Column({ name: "email_address" }) email: string = "";
    }
    new User();

    const mappings = getColumnMappings(User);
    expect(mappings.size).toBe(3);
    expect(mappings.get("id")).toBe("id");
    expect(mappings.get("name")).toBe("user_name");
    expect(mappings.get("email")).toBe("email_address");
  });

  it("isolates metadata between different classes", () => {
    class A {
      @Column("col_a") fieldA: string = "";
    }
    class B {
      @Column("col_b") fieldB: string = "";
    }
    new A();
    new B();

    const aMappings = getColumnMappings(A);
    const bMappings = getColumnMappings(B);
    expect(aMappings.size).toBe(1);
    expect(aMappings.get("fieldA")).toBe("col_a");
    expect(bMappings.size).toBe(1);
    expect(bMappings.get("fieldB")).toBe("col_b");
  });

  it("stores constraint options in metadata entries", () => {
    class Product {
      @Column({ nullable: false, unique: true, length: 100 }) name: string = "";
      @Column({ defaultValue: "'active'", type: "VARCHAR(20)" }) status: string = "";
    }
    new Product();

    const entries = getColumnMetadataEntries(Product);
    const nameEntry = entries.get("name");
    expect(nameEntry).toBeDefined();
    expect(nameEntry!.columnName).toBe("name");
    expect(nameEntry!.nullable).toBe(false);
    expect(nameEntry!.unique).toBe(true);
    expect(nameEntry!.length).toBe(100);

    const statusEntry = entries.get("status");
    expect(statusEntry).toBeDefined();
    expect(statusEntry!.defaultValue).toBe("'active'");
    expect(statusEntry!.type).toBe("VARCHAR(20)");
  });

  it("getColumnTypeMappings returns only explicit types", () => {
    class Entity {
      @Column({ type: "SERIAL" }) id: number = 0;
      @Column() name: string = "";
      @Column({ type: "DECIMAL(10,2)" }) price: number = 0;
    }
    new Entity();

    const types = getColumnTypeMappings(Entity);
    expect(types.size).toBe(2);
    expect(types.get("id")).toBe("SERIAL");
    expect(types.get("price")).toBe("DECIMAL(10,2)");
    expect(types.has("name")).toBe(false);
  });

  it("getColumnMetadataEntries returns empty map for undecorated class", () => {
    class Plain {}
    const entries = getColumnMetadataEntries(Plain);
    expect(entries.size).toBe(0);
  });
});
