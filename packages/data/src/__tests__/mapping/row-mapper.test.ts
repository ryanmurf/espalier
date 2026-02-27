import { describe, it, expect } from "vitest";
import { createRowMapper } from "../../mapping/row-mapper.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";
import type { ResultSet } from "espalier-jdbc";

function createMockResultSet(row: Record<string, unknown>): ResultSet {
  return {
    getRow: () => row,
    // Unused methods - minimal mock
    next: async () => false,
    getString: () => null,
    getNumber: () => null,
    getBoolean: () => null,
    getDate: () => null,
    getMetadata: () => [],
    close: async () => {},
    [Symbol.asyncIterator]: () => ({
      async next() {
        return { value: undefined as any, done: true as const };
      },
    }),
  };
}

describe("createRowMapper", () => {
  it("maps column values to entity fields", () => {
    class User {
      id!: number;
      name!: string;
    }

    const metadata: EntityMetadata = {
      tableName: "users",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "name", columnName: "name" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      lifecycleCallbacks: new Map(),
    };

    const mapper = createRowMapper(User, metadata);
    const rs = createMockResultSet({ id: 42, name: "Alice" });
    const entity = mapper.mapRow(rs);

    expect(entity).toBeInstanceOf(User);
    expect(entity.id).toBe(42);
    expect(entity.name).toBe("Alice");
  });

  it("handles renamed columns (column_name -> fieldName)", () => {
    class Post {
      id!: number;
      createdAt!: string;
      updatedAt!: string;
    }

    const metadata: EntityMetadata = {
      tableName: "posts",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "createdAt", columnName: "created_at" },
        { fieldName: "updatedAt", columnName: "updated_at" },
      ],
      createdDateField: "createdAt",
      lastModifiedDateField: "updatedAt",
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      lifecycleCallbacks: new Map(),
    };

    const mapper = createRowMapper(Post, metadata);
    const rs = createMockResultSet({
      id: 1,
      created_at: "2024-01-01",
      updated_at: "2024-06-15",
    });
    const entity = mapper.mapRow(rs);

    expect(entity).toBeInstanceOf(Post);
    expect(entity.id).toBe(1);
    expect(entity.createdAt).toBe("2024-01-01");
    expect(entity.updatedAt).toBe("2024-06-15");
  });

  it("returns instance with correct prototype", () => {
    class Order {
      id!: number;
      getLabel() {
        return `Order #${this.id}`;
      }
    }

    const metadata: EntityMetadata = {
      tableName: "orders",
      idField: "id",
      fields: [{ fieldName: "id", columnName: "id" }],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      lifecycleCallbacks: new Map(),
    };

    const mapper = createRowMapper(Order, metadata);
    const rs = createMockResultSet({ id: 7 });
    const entity = mapper.mapRow(rs);

    expect(entity).toBeInstanceOf(Order);
    expect(entity.getLabel()).toBe("Order #7");
  });

  it("sets undefined for missing column in row data", () => {
    class Item {
      id!: number;
      name!: string;
    }

    const metadata: EntityMetadata = {
      tableName: "items",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "name", columnName: "item_name" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      lifecycleCallbacks: new Map(),
    };

    const mapper = createRowMapper(Item, metadata);
    const rs = createMockResultSet({ id: 1 }); // item_name missing
    const entity = mapper.mapRow(rs);

    expect(entity.id).toBe(1);
    expect(entity.name).toBeUndefined();
  });
});
