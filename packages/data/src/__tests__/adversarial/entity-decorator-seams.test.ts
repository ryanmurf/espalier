/**
 * Adversarial regression tests for entity decorator seams.
 *
 * Tests that existing decorators (@Table, @Column, @Id, @Version, @ManyToOne,
 * etc.) produce correct metadata that is consumed by the entity metadata
 * system, row mappers, and repository factory -- regardless of which
 * adapter/runtime is used.
 *
 * NOTE: TC39 standard decorators use addInitializer() which runs on
 * instantiation. Direct metadata getters (getColumnMappings, getIdField, etc.)
 * require an instance to be constructed first. getEntityMetadata() does this
 * internally.
 */
import { describe, it, expect } from "vitest";
import {
  Table,
  getTableName,
  Column,
  getColumnMappings,
  Id,
  getIdField,
  Version,
  getVersionField,
  ManyToOne,
  getManyToOneRelations,
  OneToMany,
  getOneToManyRelations,
  OneToOne,
  getOneToOneRelations,
  CreatedDate,
  getCreatedDateField,
  LastModifiedDate,
  getLastModifiedDateField,
  Embeddable,
  isEmbeddable,
  Embedded,
  getEmbeddedFields,
  getEntityMetadata,
  createRowMapper,
} from "../../index.js";
import type { ResultSet, ColumnMetadata } from "espalier-jdbc";

// -- Test entities (using correct decorator signatures) --

@Table("users")
class User {
  @Id @Column() id!: number;
  @Column("user_name") name!: string;
  @Column() email!: string;
  @Version @Column() version!: number;
  @CreatedDate @Column("created_at") createdAt!: Date;
  @LastModifiedDate @Column("updated_at") updatedAt!: Date;
}

@Table("posts")
class Post {
  @Id @Column() id!: number;
  @Column() title!: string;
  @Column() content!: string;
  @ManyToOne({ target: () => User, joinColumn: "author_id" })
  author!: User;
}

@Table("profiles")
class Profile {
  @Id @Column() id!: number;
  @OneToOne({ target: () => User, joinColumn: "user_id" })
  user!: User;
  @Column() bio!: string;
}

@Table("comments")
class Comment {
  @Id @Column() id!: number;
  @Column() text!: string;
  @ManyToOne({ target: () => Post, joinColumn: "post_id" })
  post!: Post;
}

@Table("categories")
class Category {
  @Id @Column() id!: number;
  @Column() name!: string;
  @OneToMany({ target: () => Post, mappedBy: "category" })
  posts!: Post[];
}

@Embeddable
class Address {
  @Column() street!: string;
  @Column() city!: string;
  @Column() zip!: string;
}

@Table("companies")
class Company {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Embedded({ target: () => Address, prefix: "addr_" })
  address!: Address;
}

// Helper: create a mock ResultSet from a row object
function createMockResultSet(row: Record<string, unknown>): ResultSet {
  return {
    async next() { return true; },
    getString(col: string | number) {
      if (typeof col === "number") {
        return String(Object.values(row)[col]);
      }
      return row[col] != null ? String(row[col]) : null;
    },
    getNumber(col: string | number) {
      if (typeof col === "number") {
        return Object.values(row)[col] as number;
      }
      return row[col] as number;
    },
    getBoolean(col: string | number) {
      if (typeof col === "number") {
        return Boolean(Object.values(row)[col]);
      }
      return Boolean(row[col]);
    },
    getDate(col: string | number) {
      return null;
    },
    getRow() {
      return { ...row };
    },
    getMetadata(): ColumnMetadata[] {
      return Object.keys(row).map((name) => ({ name, dataType: "text", nullable: true, primaryKey: false }));
    },
    async close() {},
    [Symbol.asyncIterator]() {
      return {
        async next() { return { value: undefined, done: true }; },
      };
    },
  } as ResultSet;
}

describe("entity decorator seam tests", () => {
  describe("@Table metadata", () => {
    it("getTableName returns configured table name", () => {
      expect(getTableName(User)).toBe("users");
      expect(getTableName(Post)).toBe("posts");
      expect(getTableName(Profile)).toBe("profiles");
      expect(getTableName(Comment)).toBe("comments");
    });

    it("getTableName returns undefined for undecorated class", () => {
      class Undecorated {}
      expect(getTableName(Undecorated)).toBeUndefined();
    });
  });

  describe("@Column metadata", () => {
    it("getColumnMappings returns all mapped columns after instantiation", () => {
      // TC39 decorators require instantiation to trigger addInitializer
      new User();
      const mappings = getColumnMappings(User);
      expect(mappings).toBeDefined();
      expect(mappings).toBeInstanceOf(Map);
      expect(mappings.has("id")).toBe(true);
      expect(mappings.has("name")).toBe(true);
      expect(mappings.has("email")).toBe(true);
      expect(mappings.has("version")).toBe(true);
    });

    it("custom column name is reflected in mapping", () => {
      new User();
      const mappings = getColumnMappings(User);
      expect(mappings.get("name")).toBe("user_name");
    });

    it("default column name matches property name", () => {
      new User();
      const mappings = getColumnMappings(User);
      expect(mappings.get("id")).toBe("id");
      expect(mappings.get("email")).toBe("email");
    });
  });

  describe("@Id metadata", () => {
    it("getIdField returns correct field name after instantiation", () => {
      new User();
      new Post();
      expect(getIdField(User)).toBe("id");
      expect(getIdField(Post)).toBe("id");
    });

    it("getIdField returns undefined for class without @Id", () => {
      class NoId {
        @Column() name!: string;
      }
      new NoId();
      expect(getIdField(NoId)).toBeUndefined();
    });
  });

  describe("@Version metadata", () => {
    it("getVersionField returns correct field name", () => {
      new User();
      expect(getVersionField(User)).toBe("version");
    });

    it("getVersionField returns undefined for class without @Version", () => {
      new Post();
      expect(getVersionField(Post)).toBeUndefined();
    });
  });

  describe("@ManyToOne metadata", () => {
    it("getManyToOneRelations returns relation metadata", () => {
      new Post();
      const relations = getManyToOneRelations(Post);
      expect(relations).toHaveLength(1);
      expect(relations[0].fieldName).toBe("author");
      expect(relations[0].joinColumn).toBe("author_id");
    });

    it("target resolves to correct entity class", () => {
      new Post();
      const relations = getManyToOneRelations(Post);
      const target = relations[0].target();
      expect(target).toBe(User);
    });
  });

  describe("@OneToOne metadata", () => {
    it("getOneToOneRelations returns relation metadata", () => {
      new Profile();
      const relations = getOneToOneRelations(Profile);
      expect(relations).toHaveLength(1);
      expect(relations[0].fieldName).toBe("user");
      expect(relations[0].joinColumn).toBe("user_id");
    });
  });

  describe("@OneToMany metadata", () => {
    it("getOneToManyRelations returns relation metadata", () => {
      new Category();
      const relations = getOneToManyRelations(Category);
      expect(relations).toHaveLength(1);
      expect(relations[0].fieldName).toBe("posts");
    });
  });

  describe("Auditing decorators", () => {
    it("getCreatedDateField returns correct field", () => {
      new User();
      expect(getCreatedDateField(User)).toBe("createdAt");
    });

    it("getLastModifiedDateField returns correct field", () => {
      new User();
      expect(getLastModifiedDateField(User)).toBe("updatedAt");
    });
  });

  describe("@Embeddable / @Embedded metadata", () => {
    it("isEmbeddable returns true for @Embeddable class", () => {
      expect(isEmbeddable(Address)).toBe(true);
    });

    it("isEmbeddable returns false for regular entity", () => {
      expect(isEmbeddable(User)).toBe(false);
    });

    it("getEmbeddedFields returns embedded field info", () => {
      new Company();
      const fields = getEmbeddedFields(Company);
      expect(fields).toHaveLength(1);
      expect(fields[0].fieldName).toBe("address");
      expect(fields[0].prefix).toBe("addr_");
    });
  });

  describe("EntityMetadata integration", () => {
    it("getEntityMetadata returns complete metadata", () => {
      const meta = getEntityMetadata(User);
      expect(meta).toBeDefined();
      expect(meta.tableName).toBe("users");
      expect(meta.idField).toBe("id");
      expect(meta.versionField).toBe("version");
    });

    it("getEntityMetadata includes field mappings", () => {
      const meta = getEntityMetadata(User);
      expect(meta.fields).toBeDefined();
      expect(meta.fields.length).toBeGreaterThan(0);
    });

    it("getEntityMetadata works for entity with relations", () => {
      const meta = getEntityMetadata(Post);
      expect(meta.tableName).toBe("posts");
      expect(meta.idField).toBe("id");
    });

    it("getEntityMetadata includes embedded fields in flattened form", () => {
      const meta = getEntityMetadata(Company);
      expect(meta.tableName).toBe("companies");
      // Embedded Address fields should be flattened with prefix
      const addrFields = meta.fields.filter(
        (f) => String(f.columnName).startsWith("addr_"),
      );
      expect(addrFields.length).toBeGreaterThan(0);
    });
  });

  describe("RowMapper with entity decorators", () => {
    it("createRowMapper maps ResultSet row to entity instance", () => {
      const meta = getEntityMetadata(User);
      const mapper = createRowMapper(User, meta);
      const rs = createMockResultSet({
        id: 1,
        user_name: "Alice",
        email: "alice@example.com",
        version: 1,
        created_at: "2024-01-15T00:00:00.000Z",
        updated_at: "2024-01-15T00:00:00.000Z",
      });

      const user = mapper.mapRow(rs);
      expect(user).toBeInstanceOf(User);
      expect(user.id).toBe(1);
      expect(user.name).toBe("Alice");
      expect(user.email).toBe("alice@example.com");
    });

    it("createRowMapper handles null values", () => {
      const meta = getEntityMetadata(User);
      const mapper = createRowMapper(User, meta);
      const rs = createMockResultSet({
        id: 2,
        user_name: null,
        email: null,
        version: 1,
        created_at: null,
        updated_at: null,
      });

      const user = mapper.mapRow(rs);
      expect(user.id).toBe(2);
      expect(user.name).toBeNull();
    });

    it("createRowMapper ignores unmapped columns", () => {
      const meta = getEntityMetadata(User);
      const mapper = createRowMapper(User, meta);
      const rs = createMockResultSet({
        id: 3,
        user_name: "Bob",
        email: "bob@example.com",
        version: 1,
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
        extra_column: "should be ignored",
      });

      const user = mapper.mapRow(rs);
      expect(user.id).toBe(3);
      expect((user as any).extra_column).toBeUndefined();
    });
  });
});
