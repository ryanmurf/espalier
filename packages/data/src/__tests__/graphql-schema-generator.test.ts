/**
 * Adversarial tests for GraphQL schema generation (Y3 Q4).
 *
 * Verifies:
 * - Schema generation for entities with all column types
 * - Relation types: @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
 * - @Embedded entities appear in SDL
 * - @Version, @CreatedDate, @LastModifiedDate excluded from input types
 * - @TenantId field present in object type
 * - Pagination types and Connection types
 * - Mutation generation (create, update, delete)
 * - Options: mutations disabled, pagination disabled, custom scalars, excludeFromInput
 * - Type mapping edge cases: unknown types, JSON, UUID, BIT, etc.
 * - Empty entity list
 * - Entity with only @Id (minimal)
 * - GraphQLPlugin integration
 * - camelCase query field naming
 * - SDL structure validation
 */
import { describe, expect, it } from "vitest";
import { CreatedDate, LastModifiedDate } from "../decorators/auditing.js";
import { Column } from "../decorators/column.js";
import { Embeddable, Embedded } from "../decorators/embeddable.js";
import { Id } from "../decorators/id.js";
import { ManyToMany, ManyToOne, OneToMany, OneToOne } from "../decorators/relations.js";
import { Table } from "../decorators/table.js";
import { TenantId } from "../decorators/tenant.js";
import { Version } from "../decorators/version.js";
import { GraphQLPlugin } from "../graphql/graphql-plugin.js";
import { GraphQLSchemaGenerator } from "../graphql/schema-generator.js";

// ══════════════════════════════════════════════════
// Test entities
// ══════════════════════════════════════════════════

@Table("users")
class User {
  @Id
  @Column({ type: "SERIAL" })
  id: number = 0;

  @Column({ type: "VARCHAR" })
  name: string = "";

  @Column({ type: "VARCHAR" })
  email: string = "";

  @Column({ type: "BOOLEAN" })
  active: boolean = true;

  @Column({ type: "INTEGER" })
  age: number = 0;

  @Version
  version: number = 0;

  @CreatedDate
  @Column({ type: "TIMESTAMP" })
  createdAt: Date = new Date();

  @LastModifiedDate
  @Column({ type: "TIMESTAMP" })
  updatedAt: Date = new Date();

  @OneToMany({ target: () => Post, mappedBy: "author" })
  posts: Post[] = [];

  @OneToOne({ target: () => Profile })
  profile: Profile | null = null;
}

@Table("posts")
class Post {
  @Id
  @Column({ type: "SERIAL" })
  id: number = 0;

  @Column({ type: "VARCHAR" })
  title: string = "";

  @Column({ type: "TEXT" })
  content: string = "";

  @Column({ type: "TIMESTAMP" })
  publishedAt: Date | null = null;

  @ManyToOne({ target: () => User })
  author: User | null = null;

  @ManyToMany({
    target: () => Tag,
    joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags: Tag[] = [];
}

@Table("tags")
class Tag {
  @Id
  @Column({ type: "SERIAL" })
  id: number = 0;

  @Column({ type: "VARCHAR" })
  name: string = "";

  @ManyToMany({ target: () => Post, mappedBy: "tags" })
  posts: Post[] = [];
}

@Table("profiles")
class Profile {
  @Id
  @Column({ type: "SERIAL" })
  id: number = 0;

  @Column({ type: "TEXT" })
  bio: string = "";

  @Column({ type: "VARCHAR" })
  avatarUrl: string = "";
}

@Embeddable
class Address {
  @Column()
  street: string = "";

  @Column()
  city: string = "";

  @Column()
  zip: string = "";
}

@Table("companies")
class Company {
  @Id
  @Column({ type: "SERIAL" })
  id: number = 0;

  @Column({ type: "VARCHAR" })
  name: string = "";

  @Embedded({ target: () => Address, prefix: "addr_" })
  address: Address = new Address();
}

@Table("tenant_items")
class TenantItem {
  @Id
  @Column({ type: "UUID" })
  id: string = "";

  @Column({ type: "VARCHAR" })
  name: string = "";

  @TenantId
  @Column({ type: "VARCHAR" })
  tenantId: string = "";
}

// Minimal entity — only @Id
@Table("minimal")
class MinimalEntity {
  @Id
  @Column({ type: "SERIAL" })
  id: number = 0;
}

// Entity with diverse column types for type mapping tests
@Table("typed_things")
class TypedEntity {
  @Id
  @Column({ type: "UUID" })
  id: string = "";

  @Column({ type: "INTEGER" })
  intCol: number = 0;

  @Column({ type: "BIGINT" })
  bigintCol: number = 0;

  @Column({ type: "SMALLINT" })
  smallintCol: number = 0;

  @Column({ type: "FLOAT" })
  floatCol: number = 0;

  @Column({ type: "DOUBLE PRECISION" })
  doubleCol: number = 0;

  @Column({ type: "DECIMAL(10,2)" })
  decimalCol: number = 0;

  @Column({ type: "NUMERIC" })
  numericCol: number = 0;

  @Column({ type: "REAL" })
  realCol: number = 0;

  @Column({ type: "BOOLEAN" })
  boolCol: boolean = false;

  @Column({ type: "BIT" })
  bitCol: boolean = false;

  @Column({ type: "TEXT" })
  textCol: string = "";

  @Column({ type: "VARCHAR" })
  varcharCol: string = "";

  @Column({ type: "JSON" })
  jsonCol: unknown = null;

  @Column({ type: "JSONB" })
  jsonbCol: unknown = null;

  @Column({ type: "TIMESTAMP" })
  tsCol: Date = new Date();

  @Column({ type: "DATE" })
  dateCol: Date = new Date();

  @Column({ type: "TIME" })
  timeCol: string = "";

  @Column({ type: "BYTEA" })
  bytesCol: Uint8Array = new Uint8Array();

  @Column()
  noTypeCol: string = "";
}

// ══════════════════════════════════════════════════
// Schema generation — basic
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — basic schema", () => {
  const generator = new GraphQLSchemaGenerator();

  it("generates SDL for a single entity", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.sdl).toBeDefined();
    expect(schema.sdl.length).toBeGreaterThan(0);
    expect(schema.sdl).toContain("type MinimalEntity");
  });

  it("types map contains the entity type", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.types.has("MinimalEntity")).toBe(true);
  });

  it("generates query fields", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.queryFields.length).toBeGreaterThan(0);
    expect(schema.sdl).toContain("type Query");
  });

  it("generates mutation fields by default", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.mutationFields.length).toBeGreaterThan(0);
    expect(schema.sdl).toContain("type Mutation");
  });

  it("generates input types by default", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.inputTypes.has("MinimalEntityInput")).toBe(true);
    expect(schema.inputTypes.has("MinimalEntityUpdateInput")).toBe(true);
  });

  it("generates DateTime scalar by default", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.sdl).toContain("scalar DateTime");
  });

  it("generates pagination types by default", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.sdl).toContain("type PageInfo");
    expect(schema.sdl).toContain("type MinimalEntityOffsetConnection");
  });
});

// ══════════════════════════════════════════════════
// Schema generation — full entity with relations
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — relations", () => {
  const generator = new GraphQLSchemaGenerator();

  it("includes @OneToMany as list type", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    const userType = schema.types.get("User")!;
    expect(userType).toContain("posts: [Post!]!");
  });

  it("includes @ManyToOne as single type", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    const postType = schema.types.get("Post")!;
    expect(postType).toContain("author: User");
  });

  it("includes @ManyToMany as list type", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    const postType = schema.types.get("Post")!;
    expect(postType).toContain("tags: [Tag!]!");
  });

  it("includes @OneToOne as single type", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    const userType = schema.types.get("User")!;
    expect(userType).toContain("profile: Profile");
  });

  it("generates types for all entities", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    expect(schema.types.has("User")).toBe(true);
    expect(schema.types.has("Post")).toBe(true);
    expect(schema.types.has("Tag")).toBe(true);
    expect(schema.types.has("Profile")).toBe(true);
  });

  it("generates Connection types for all entities", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    expect(schema.sdl).toContain("type UserOffsetConnection");
    expect(schema.sdl).toContain("type PostOffsetConnection");
    expect(schema.sdl).toContain("type TagOffsetConnection");
    expect(schema.sdl).toContain("type ProfileOffsetConnection");
  });
});

// ══════════════════════════════════════════════════
// Schema generation — embedded entities
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — embedded entities", () => {
  const generator = new GraphQLSchemaGenerator();

  it("includes @Embedded type reference in object type", () => {
    const schema = generator.generate([Company]);
    const companyType = schema.types.get("Company")!;
    expect(companyType).toContain("address: Address");
  });

  it("generates SDL for entity with embedded", () => {
    const schema = generator.generate([Company]);
    expect(schema.sdl).toContain("type Company");
  });
});

// ══════════════════════════════════════════════════
// Schema generation — auto-excluded fields
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — input type exclusions", () => {
  const generator = new GraphQLSchemaGenerator();

  it("@Id excluded from create input", () => {
    const schema = generator.generate([User]);
    const input = schema.inputTypes.get("UserInput")!;
    expect(input).not.toMatch(/\bid\b.*:\s*ID/);
  });

  it("@Version excluded from create input", () => {
    const schema = generator.generate([User]);
    const input = schema.inputTypes.get("UserInput")!;
    expect(input).not.toContain("version");
  });

  it("@CreatedDate excluded from create input", () => {
    const schema = generator.generate([User]);
    const input = schema.inputTypes.get("UserInput")!;
    expect(input).not.toContain("createdAt");
  });

  it("@LastModifiedDate excluded from create input", () => {
    const schema = generator.generate([User]);
    const input = schema.inputTypes.get("UserInput")!;
    expect(input).not.toContain("updatedAt");
  });

  it("@Id excluded from update input", () => {
    const schema = generator.generate([User]);
    const input = schema.inputTypes.get("UserUpdateInput")!;
    expect(input).not.toMatch(/\bid\b.*:\s*ID/);
  });

  it("@Version excluded from update input", () => {
    const schema = generator.generate([User]);
    const input = schema.inputTypes.get("UserUpdateInput")!;
    expect(input).not.toContain("version");
  });

  it("object type still contains @Id, @CreatedDate, @LastModifiedDate", () => {
    const schema = generator.generate([User]);
    const type = schema.types.get("User")!;
    expect(type).toContain("id:");
    expect(type).toContain("createdAt:");
    expect(type).toContain("updatedAt:");
  });

  it("@Version field without @Column does NOT appear in object type (documentation)", () => {
    // BUG CANDIDATE: @Version without @Column is invisible in GraphQL schema.
    // The schema generator only iterates metadata.fields (from @Column mappings).
    // If a user wants @Version visible in the API, they must also add @Column.
    const schema = generator.generate([User]);
    const type = schema.types.get("User")!;
    expect(type).not.toContain("version:");
  });
});

// ══════════════════════════════════════════════════
// Schema generation — type mapping
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — type mapping", () => {
  const generator = new GraphQLSchemaGenerator();

  it("SERIAL @Id maps to ID!", () => {
    const schema = generator.generate([User]);
    const type = schema.types.get("User")!;
    expect(type).toMatch(/id:\s*ID!/);
  });

  it("UUID @Id maps to ID!", () => {
    const schema = generator.generate([TenantItem]);
    const type = schema.types.get("TenantItem")!;
    expect(type).toMatch(/id:\s*ID!/);
  });

  it("INTEGER maps to Int", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("intCol: Int");
  });

  it("BIGINT maps to Int", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("bigintCol: Int");
  });

  it("SMALLINT maps to Int", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("smallintCol: Int");
  });

  it("FLOAT maps to Float", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("floatCol: Float");
  });

  it("DOUBLE PRECISION maps to Float", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("doubleCol: Float");
  });

  it("DECIMAL(10,2) maps to Float", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("decimalCol: Float");
  });

  it("NUMERIC maps to Float", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("numericCol: Float");
  });

  it("REAL maps to Float", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("realCol: Float");
  });

  it("BOOLEAN maps to Boolean", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("boolCol: Boolean");
  });

  it("BIT maps to Boolean (MSSQL compat)", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("bitCol: Boolean");
  });

  it("TEXT maps to String", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("textCol: String");
  });

  it("JSON maps to JSON", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("jsonCol: JSON");
  });

  it("JSONB maps to JSON", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("jsonbCol: JSON");
  });

  it("TIMESTAMP maps to DateTime", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("tsCol: DateTime");
  });

  it("DATE maps to DateTime", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("dateCol: DateTime");
  });

  it("TIME maps to DateTime", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("timeCol: DateTime");
  });

  it("column with no type and non-id name defaults to String", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    expect(type).toContain("noTypeCol: String");
  });

  it("UUID @Id field maps to ID! (not String)", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    // The id field is UUID type + named "id" -> should be ID!
    expect(type).toMatch(/id:\s*ID!/);
  });

  it("BYTEA maps to String (fallback — no binary scalar)", () => {
    const schema = generator.generate([TypedEntity]);
    const type = schema.types.get("TypedEntity")!;
    // BYTEA doesn't match any known type -> String
    expect(type).toContain("bytesCol: String");
  });
});

// ══════════════════════════════════════════════════
// Schema generation — query/mutation naming
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — query/mutation field naming", () => {
  const generator = new GraphQLSchemaGenerator();

  it("query field uses camelCase of type name", () => {
    const schema = generator.generate([User]);
    // "User" -> "user" for single, "users" for list
    expect(schema.queryFields.some((f) => f.includes("user(id: ID!)"))).toBe(true);
    expect(schema.queryFields.some((f) => f.includes("users(page:"))).toBe(true);
    expect(schema.queryFields.some((f) => f.includes("userCount:"))).toBe(true);
  });

  it("mutation uses PascalCase type name", () => {
    const schema = generator.generate([User]);
    expect(schema.mutationFields.some((f) => f.includes("createUser("))).toBe(true);
    expect(schema.mutationFields.some((f) => f.includes("updateUser("))).toBe(true);
    expect(schema.mutationFields.some((f) => f.includes("deleteUser("))).toBe(true);
  });

  it("delete mutation returns Boolean!", () => {
    const schema = generator.generate([User]);
    const deleteMutation = schema.mutationFields.find((f) => f.includes("deleteUser"));
    expect(deleteMutation).toContain("Boolean!");
  });

  it("create mutation accepts input type and returns entity", () => {
    const schema = generator.generate([User]);
    const createMutation = schema.mutationFields.find((f) => f.includes("createUser"));
    expect(createMutation).toContain("input: UserInput!");
    expect(createMutation).toContain(": User!");
  });

  it("update mutation accepts id and input", () => {
    const schema = generator.generate([User]);
    const updateMutation = schema.mutationFields.find((f) => f.includes("updateUser"));
    expect(updateMutation).toContain("id: ID!");
    expect(updateMutation).toContain("input: UserUpdateInput!");
  });
});

// ══════════════════════════════════════════════════
// Options
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — options", () => {
  it("mutations: false disables mutation generation", () => {
    const gen = new GraphQLSchemaGenerator({ mutations: false });
    const schema = gen.generate([MinimalEntity]);
    expect(schema.mutationFields).toHaveLength(0);
    expect(schema.sdl).not.toContain("type Mutation");
    expect(schema.inputTypes.size).toBe(0);
  });

  it("pagination: false disables pagination types", () => {
    const gen = new GraphQLSchemaGenerator({ pagination: false });
    const schema = gen.generate([MinimalEntity]);
    expect(schema.sdl).not.toContain("type PageInfo");
    expect(schema.sdl).not.toContain("Connection");
    // Query should use simple list type
    expect(schema.queryFields.some((f) => f.includes("[MinimalEntity!]!"))).toBe(true);
  });

  it("custom scalars", () => {
    const gen = new GraphQLSchemaGenerator({ customScalars: ["DateTime", "JSON", "Upload"] });
    const schema = gen.generate([MinimalEntity]);
    expect(schema.sdl).toContain("scalar DateTime");
    expect(schema.sdl).toContain("scalar JSON");
    expect(schema.sdl).toContain("scalar Upload");
  });

  it("excludeFromInput removes specified fields", () => {
    const gen = new GraphQLSchemaGenerator({ excludeFromInput: ["email", "active"] });
    const schema = gen.generate([User]);
    const input = schema.inputTypes.get("UserInput")!;
    expect(input).not.toContain("email");
    expect(input).not.toContain("active");
    // Other fields should still be present
    expect(input).toContain("name");
  });

  it("empty custom scalars produces no scalar lines", () => {
    const gen = new GraphQLSchemaGenerator({ customScalars: [] });
    const schema = gen.generate([MinimalEntity]);
    expect(schema.sdl).not.toContain("scalar ");
  });
});

// ══════════════════════════════════════════════════
// Edge cases
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — edge cases", () => {
  it("empty entity list produces minimal SDL", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([]);
    expect(schema.types.size).toBe(0);
    expect(schema.queryFields).toHaveLength(0);
    expect(schema.mutationFields).toHaveLength(0);
    // Should still have scalar declaration
    expect(schema.sdl).toContain("scalar DateTime");
  });

  it("entity with only @Id (minimal) produces valid type", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([MinimalEntity]);
    const type = schema.types.get("MinimalEntity")!;
    expect(type).toContain("id: ID!");
  });

  it("@TenantId field appears in object type", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([TenantItem]);
    const type = schema.types.get("TenantItem")!;
    expect(type).toContain("tenantId:");
  });

  it("multiple entities generate separate types", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([User, Post, Tag, Profile, Company, TenantItem, MinimalEntity]);
    expect(schema.types.size).toBe(7);
  });

  it("SDL ends with newline", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([MinimalEntity]);
    expect(schema.sdl.endsWith("\n")).toBe(true);
  });

  it("id field is marked non-nullable (!) in object type", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([User]);
    const type = schema.types.get("User")!;
    // id field should have "!" suffix
    expect(type).toMatch(/id:\s*ID!/);
  });

  it("non-id fields are nullable (no !) in object type", () => {
    const gen = new GraphQLSchemaGenerator();
    const schema = gen.generate([User]);
    const type = schema.types.get("User")!;
    // name should NOT have "!" — BUG CANDIDATE: all non-id fields are nullable
    // Check that "name: String" does NOT have "!" appended
    const nameMatch = type.match(/name:\s*(\S+)/);
    expect(nameMatch).toBeTruthy();
    expect(nameMatch![1]).toBe("String");
  });
});

// ══════════════════════════════════════════════════
// GraphQLPlugin integration
// ══════════════════════════════════════════════════

describe("GraphQLPlugin", () => {
  it("has correct name and version", () => {
    const plugin = new GraphQLPlugin({ entities: [MinimalEntity] });
    expect(plugin.name).toBe("graphql");
    expect(plugin.version).toBe("1.0.0");
  });

  it("getSchema returns undefined before init", () => {
    const plugin = new GraphQLPlugin({ entities: [MinimalEntity] });
    expect(plugin.getSchema()).toBeUndefined();
  });

  it("getSdl returns empty string before init", () => {
    const plugin = new GraphQLPlugin({ entities: [MinimalEntity] });
    expect(plugin.getSdl()).toBe("");
  });

  it("generates schema on init", async () => {
    const plugin = new GraphQLPlugin({ entities: [User, Post] });
    const hooks: any[] = [];
    const ctx = {
      addHook: (h: any) => hooks.push(h),
      getPluginData: () => undefined,
      setPluginData: () => {},
    };
    await plugin.init(ctx as any);
    expect(plugin.getSchema()).toBeDefined();
    expect(plugin.getSdl()).toContain("type User");
    expect(plugin.getSdl()).toContain("type Post");
  });

  it("registers onEntityRegistered hook", async () => {
    const plugin = new GraphQLPlugin({ entities: [MinimalEntity] });
    const hooks: any[] = [];
    const ctx = {
      addHook: (h: any) => hooks.push(h),
      getPluginData: () => undefined,
      setPluginData: () => {},
    };
    await plugin.init(ctx as any);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].type).toBe("onEntityRegistered");
  });

  it("passes schema options through to generator", async () => {
    const plugin = new GraphQLPlugin({
      entities: [MinimalEntity],
      mutations: false,
      pagination: false,
    });
    const ctx = {
      addHook: () => {},
      getPluginData: () => undefined,
      setPluginData: () => {},
    };
    await plugin.init(ctx as any);
    const sdl = plugin.getSdl();
    expect(sdl).not.toContain("type Mutation");
    expect(sdl).not.toContain("type PageInfo");
  });
});

// ══════════════════════════════════════════════════
// SDL structural validation
// ══════════════════════════════════════════════════

describe("GraphQLSchemaGenerator — SDL structure", () => {
  const generator = new GraphQLSchemaGenerator();

  it("all opening braces have matching closing braces", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    const opens = (schema.sdl.match(/{/g) || []).length;
    const closes = (schema.sdl.match(/}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("no duplicate type definitions", () => {
    const schema = generator.generate([User, Post, Tag, Profile]);
    const typeNames = [...schema.sdl.matchAll(/^(type|input|scalar)\s+(\w+)/gm)].map((m) => `${m[1]} ${m[2]}`);
    const uniqueTypes = new Set(typeNames);
    expect(typeNames.length).toBe(uniqueTypes.size);
  });

  it("Query type contains all entity query fields", () => {
    const schema = generator.generate([User, Post]);
    expect(schema.sdl).toContain("user(id: ID!)");
    expect(schema.sdl).toContain("post(id: ID!)");
  });

  it("Mutation type contains all entity mutation fields", () => {
    const schema = generator.generate([User, Post]);
    expect(schema.sdl).toContain("createUser(");
    expect(schema.sdl).toContain("createPost(");
    expect(schema.sdl).toContain("deleteUser(");
    expect(schema.sdl).toContain("deletePost(");
  });

  it("PageInfo has all required fields", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.sdl).toContain("hasNextPage: Boolean!");
    expect(schema.sdl).toContain("hasPreviousPage: Boolean!");
    expect(schema.sdl).toContain("totalElements: Int!");
    expect(schema.sdl).toContain("totalPages: Int!");
    expect(schema.sdl).toContain("page: Int!");
    expect(schema.sdl).toContain("size: Int!");
  });

  it("Connection type has content and pageInfo", () => {
    const schema = generator.generate([MinimalEntity]);
    expect(schema.sdl).toContain("content: [MinimalEntity!]!");
    expect(schema.sdl).toContain("pageInfo: PageInfo!");
  });
});
