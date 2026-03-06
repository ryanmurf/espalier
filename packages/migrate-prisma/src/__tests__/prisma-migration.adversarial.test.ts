import { describe, expect, it } from "vitest";
import type { PrismaSchema } from "../index.js";
import { generateEntityFile, generateEnumFile, generateIndexFile, parsePrismaSchema } from "../index.js";

// ═══════════════════════════════════════════════════════════════
// Adversarial tests for Prisma migration tool
// ═══════════════════════════════════════════════════════════════

describe("prisma migration tool adversarial tests", () => {
  // ──────────────────────────────────────────────
  // 1. Parser: basic models
  // ──────────────────────────────────────────────

  describe("parser: basic models", () => {
    it("parses a single model with basic types", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  age   Int
}
      `);
      expect(schema.models).toHaveLength(1);
      expect(schema.models[0].name).toBe("User");
      expect(schema.models[0].fields).toHaveLength(4);
    });

    it("parses multiple models", () => {
      const schema = parsePrismaSchema(`
model User {
  id   Int    @id
  name String
}

model Post {
  id    Int    @id
  title String
}
      `);
      expect(schema.models).toHaveLength(2);
      expect(schema.models[0].name).toBe("User");
      expect(schema.models[1].name).toBe("Post");
    });

    it("recognizes all Prisma scalar types", () => {
      const schema = parsePrismaSchema(`
model AllTypes {
  id      Int       @id
  str     String
  num     Int
  flt     Float
  dec     Decimal
  big     BigInt
  bool    Boolean
  dt      DateTime
  json    Json
  bytes   Bytes
}
      `);
      const model = schema.models[0];
      expect(model.fields).toHaveLength(10);
      const types = model.fields.map((f) => f.type);
      expect(types).toEqual([
        "Int",
        "String",
        "Int",
        "Float",
        "Decimal",
        "BigInt",
        "Boolean",
        "DateTime",
        "Json",
        "Bytes",
      ]);
    });

    it("parses optional fields", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id    Int     @id
  name  String?
  bio   String?
}
      `);
      expect(schema.models[0].fields[1].isOptional).toBe(true);
      expect(schema.models[0].fields[2].isOptional).toBe(true);
      expect(schema.models[0].fields[0].isOptional).toBe(false);
    });

    it("parses list fields", () => {
      const schema = parsePrismaSchema(`
model Post {
  id   Int      @id
  tags String[]
}
      `);
      expect(schema.models[0].fields[1].isList).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // 2. Parser: attributes
  // ──────────────────────────────────────────────

  describe("parser: attributes", () => {
    it("parses @id attribute", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id Int @id
}
      `);
      const field = schema.models[0].fields[0];
      expect(field.attributes.some((a) => a.name === "id")).toBe(true);
    });

    it("parses @unique attribute", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id    Int    @id
  email String @unique
}
      `);
      const email = schema.models[0].fields[1];
      expect(email.attributes.some((a) => a.name === "unique")).toBe(true);
    });

    it("parses @default(autoincrement())", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id Int @id @default(autoincrement())
}
      `);
      const field = schema.models[0].fields[0];
      const defaultAttr = field.attributes.find((a) => a.name === "default");
      expect(defaultAttr).toBeDefined();
      expect(defaultAttr!.args[0]).toContain("autoincrement()");
    });

    it("parses @default(now())", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id        Int      @id
  createdAt DateTime @default(now())
}
      `);
      const field = schema.models[0].fields[1];
      const defaultAttr = field.attributes.find((a) => a.name === "default");
      expect(defaultAttr).toBeDefined();
      expect(defaultAttr!.args[0]).toContain("now()");
    });

    it("parses @default(uuid())", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id String @id @default(uuid())
}
      `);
      const field = schema.models[0].fields[0];
      const defaultAttr = field.attributes.find((a) => a.name === "default");
      expect(defaultAttr!.args[0]).toContain("uuid()");
    });

    it("parses @default(cuid())", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id String @id @default(cuid())
}
      `);
      const field = schema.models[0].fields[0];
      const defaultAttr = field.attributes.find((a) => a.name === "default");
      expect(defaultAttr!.args[0]).toContain("cuid()");
    });

    it("parses @default(true) and @default(false)", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id     Int     @id
  active Boolean @default(true)
  hidden Boolean @default(false)
}
      `);
      const active = schema.models[0].fields[1];
      const hidden = schema.models[0].fields[2];
      expect(active.attributes.find((a) => a.name === "default")!.args[0]).toBe("true");
      expect(hidden.attributes.find((a) => a.name === "default")!.args[0]).toBe("false");
    });

    it("parses @updatedAt", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id        Int      @id
  updatedAt DateTime @updatedAt
}
      `);
      const field = schema.models[0].fields[1];
      expect(field.attributes.some((a) => a.name === "updatedAt")).toBe(true);
    });

    it("parses @map for column renaming", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id       Int    @id
  userName String @map("user_name")
}
      `);
      const field = schema.models[0].fields[1];
      const mapAttr = field.attributes.find((a) => a.name === "map");
      expect(mapAttr).toBeDefined();
      expect(mapAttr!.args[0]).toContain("user_name");
    });

    it("parses @@map for table renaming", () => {
      const schema = parsePrismaSchema(`
model UserProfile {
  id Int @id

  @@map("user_profiles")
}
      `);
      const model = schema.models[0];
      expect(model.attributes.some((a) => a.name === "map")).toBe(true);
    });

    it("parses @@unique (composite unique)", () => {
      const schema = parsePrismaSchema(`
model Enrollment {
  id        Int @id
  userId    Int
  courseId  Int

  @@unique([userId, courseId])
}
      `);
      const model = schema.models[0];
      expect(model.attributes.some((a) => a.name === "unique")).toBe(true);
    });

    it("parses @@index", () => {
      const schema = parsePrismaSchema(`
model Post {
  id       Int    @id
  authorId Int
  title    String

  @@index([authorId, title])
}
      `);
      const model = schema.models[0];
      expect(model.attributes.some((a) => a.name === "index")).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // 3. Parser: enums
  // ──────────────────────────────────────────────

  describe("parser: enums", () => {
    it("parses a simple enum", () => {
      const schema = parsePrismaSchema(`
enum Role {
  ADMIN
  USER
  MODERATOR
}
      `);
      expect(schema.enums).toHaveLength(1);
      expect(schema.enums[0].name).toBe("Role");
      expect(schema.enums[0].values).toEqual(["ADMIN", "USER", "MODERATOR"]);
    });

    it("parses multiple enums", () => {
      const schema = parsePrismaSchema(`
enum Role {
  ADMIN
  USER
}

enum Status {
  ACTIVE
  INACTIVE
  PENDING
}
      `);
      expect(schema.enums).toHaveLength(2);
    });

    it("ignores comments inside enums", () => {
      const schema = parsePrismaSchema(`
enum Role {
  // Admin role
  ADMIN
  // Regular user
  USER
}
      `);
      expect(schema.enums[0].values).toEqual(["ADMIN", "USER"]);
    });
  });

  // ──────────────────────────────────────────────
  // 4. Parser: relations
  // ──────────────────────────────────────────────

  describe("parser: relations", () => {
    it("parses ManyToOne / OneToMany (1:N)", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      expect(schema.models).toHaveLength(2);
      const post = schema.models[1];
      const authorField = post.fields.find((f) => f.name === "author")!;
      expect(authorField.type).toBe("User");
      const rel = authorField.attributes.find((a) => a.name === "relation");
      expect(rel).toBeDefined();
    });

    it("parses self-referential relation", () => {
      const schema = parsePrismaSchema(`
model Employee {
  id         Int        @id
  managerId  Int?
  manager    Employee?  @relation("ManagerReports", fields: [managerId], references: [id])
  reports    Employee[] @relation("ManagerReports")
}
      `);
      expect(schema.models).toHaveLength(1);
      const model = schema.models[0];
      const manager = model.fields.find((f) => f.name === "manager")!;
      expect(manager.type).toBe("Employee");
      const reports = model.fields.find((f) => f.name === "reports")!;
      expect(reports.isList).toBe(true);
    });

    it("parses implicit many-to-many", () => {
      const schema = parsePrismaSchema(`
model Post {
  id         Int        @id
  categories Category[]
}

model Category {
  id    Int    @id
  posts Post[]
}
      `);
      expect(schema.models).toHaveLength(2);
      const post = schema.models[0];
      const categories = post.fields.find((f) => f.name === "categories")!;
      expect(categories.isList).toBe(true);
      expect(categories.type).toBe("Category");
    });
  });

  // ──────────────────────────────────────────────
  // 5. Parser: edge cases
  // ──────────────────────────────────────────────

  describe("parser: edge cases", () => {
    it("handles empty schema (no models or enums)", () => {
      const schema = parsePrismaSchema("");
      expect(schema.models).toHaveLength(0);
      expect(schema.enums).toHaveLength(0);
    });

    it("handles schema with only datasource/generator blocks", () => {
      const schema = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}
      `);
      expect(schema.models).toHaveLength(0);
      expect(schema.enums).toHaveLength(0);
    });

    it("handles comments interspersed in schema", () => {
      const schema = parsePrismaSchema(`
// This is a comment
model User {
  // The primary key
  id   Int    @id
  // User's name
  name String
}
      `);
      expect(schema.models).toHaveLength(1);
      expect(schema.models[0].fields).toHaveLength(2);
    });

    it("handles model with no fields (only closing brace)", () => {
      const schema = parsePrismaSchema(`
model Empty {
}
      `);
      expect(schema.models).toHaveLength(1);
      expect(schema.models[0].name).toBe("Empty");
      expect(schema.models[0].fields).toHaveLength(0);
    });

    it("handles multiple attributes on one field", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id    Int    @id @default(autoincrement()) @map("foo_id")
  email String @unique @map("email_address")
}
      `);
      const id = schema.models[0].fields[0];
      expect(id.attributes.length).toBeGreaterThanOrEqual(3);
      const email = schema.models[0].fields[1];
      expect(email.attributes.length).toBeGreaterThanOrEqual(2);
    });

    it("handles @db.VarChar(255) without crashing", () => {
      // @db.VarChar is an unsupported prisma-specific attribute
      const schema = parsePrismaSchema(`
model Foo {
  id   Int    @id
  name String @db.VarChar(255)
}
      `);
      expect(schema.models).toHaveLength(1);
      // Should not crash — the attribute may be parsed or ignored
      expect(schema.models[0].fields).toHaveLength(2);
    });

    it("handles dbgenerated default", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id   Int    @id
  code String @default(dbgenerated("gen_random_uuid()"))
}
      `);
      expect(schema.models).toHaveLength(1);
      const code = schema.models[0].fields[1];
      const def = code.attributes.find((a) => a.name === "default");
      expect(def).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────
  // 6. Generator: entity file output
  // ──────────────────────────────────────────────

  describe("generator: entity files", () => {
    it("generates a basic entity with Table, Column, Id decorators", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain('@Table("users")');
      expect(output).toContain("@Id()");
      expect(output).toContain("@Column(");
      expect(output).toContain("export class User");
      expect(output).toContain("accessor id");
      expect(output).toContain("accessor email");
      expect(output).toContain("accessor name");
    });

    it("imports from espalier-data/core", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id Int @id
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain('from "espalier-data/core"');
    });

    it("generates @CreatedDate for @default(now())", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id        Int      @id
  createdAt DateTime @default(now())
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("@CreatedDate()");
    });

    it("generates @LastModifiedDate for @updatedAt", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id        Int      @id
  updatedAt DateTime @updatedAt
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("@LastModifiedDate()");
    });

    it("generates Column with name option for @map fields", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id       Int    @id
  userName String @map("user_name")
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain('name: "user_name"');
    });

    it("generates unique: true for @unique fields", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id    Int    @id
  email String @unique
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("unique: true");
    });

    it("generates generated: true for autoincrement fields", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id Int @id @default(autoincrement())
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("generated: true");
    });

    it("@@map overrides table name", () => {
      const schema = parsePrismaSchema(`
model UserProfile {
  id Int @id

  @@map("user_profiles")
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain('@Table("user_profiles")');
    });

    it("default table name is snake_case plural", () => {
      const schema = parsePrismaSchema(`
model BlogPost {
  id Int @id
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain('@Table("blog_posts")');
    });

    it("optional fields use ? and undefined default", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id   Int     @id
  bio  String?
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor bio\?/);
    });

    it("uses accessor keyword (TC39 decorators)", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id Int @id
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("accessor ");
    });
  });

  // ──────────────────────────────────────────────
  // 7. Generator: type mappings
  // ──────────────────────────────────────────────

  describe("generator: type mappings", () => {
    it("maps String to string", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id   Int    @id
  name String
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor name.*=\s*""/);
    });

    it("maps Int to number", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id  Int @id
  age Int
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor age.*=\s*0/);
    });

    it("maps BigInt to bigint", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id  Int    @id
  big BigInt
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor big.*=\s*0n/);
    });

    it("maps Boolean to boolean", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id     Int     @id
  active Boolean
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor active.*=\s*false/);
    });

    it("maps DateTime to Date", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id Int      @id
  dt DateTime
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor dt.*=\s*new Date\(\)/);
    });

    it("maps Bytes to Uint8Array", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id   Int   @id
  data Bytes
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("new Uint8Array()");
    });

    it("maps Json to Record<string, unknown>", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id   Int  @id
  meta Json
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toMatch(/accessor meta.*=\s*\{\}/);
    });
  });

  // ──────────────────────────────────────────────
  // 8. Generator: relations
  // ──────────────────────────────────────────────

  describe("generator: relations", () => {
    it("generates @ManyToOne for belongs-to side", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      const output = generateEntityFile(schema.models[1], schema);
      expect(output).toContain("@ManyToOne");
      expect(output).toContain("() => User");
    });

    it("generates @OneToMany for has-many side", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("@OneToMany");
      expect(output).toContain("() => Post");
    });

    it("generates @ManyToMany for implicit M:N", () => {
      const schema = parsePrismaSchema(`
model Post {
  id         Int        @id
  categories Category[]
}

model Category {
  id    Int    @id
  posts Post[]
}
      `);
      const postOutput = generateEntityFile(schema.models[0], schema);
      expect(postOutput).toContain("@ManyToMany");
      expect(postOutput).toContain("() => Category");
    });

    it("imports relation decorators from espalier-data/relations", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain('from "espalier-data/relations"');
    });

    it("skips FK fields (authorId) in output — handled by relation", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      const output = generateEntityFile(schema.models[1], schema);
      expect(output).not.toMatch(/accessor authorId/);
    });

    it("generates joinColumn option for ManyToOne FK", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      const output = generateEntityFile(schema.models[1], schema);
      expect(output).toContain('joinColumn: "authorId"');
    });

    it("generates import type for related entities", () => {
      const schema = parsePrismaSchema(`
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
      `);
      const postOutput = generateEntityFile(schema.models[1], schema);
      expect(postOutput).toContain("import type { User }");
    });
  });

  // ──────────────────────────────────────────────
  // 9. Generator: enums
  // ──────────────────────────────────────────────

  describe("generator: enums", () => {
    it("generates TypeScript enum", () => {
      const output = generateEnumFile({ name: "Role", values: ["ADMIN", "USER", "MODERATOR"] });
      expect(output).toContain("export enum Role");
      expect(output).toContain('ADMIN = "ADMIN"');
      expect(output).toContain('USER = "USER"');
      expect(output).toContain('MODERATOR = "MODERATOR"');
    });

    it("generates single-value enum", () => {
      const output = generateEnumFile({ name: "Status", values: ["ACTIVE"] });
      expect(output).toContain("export enum Status");
      expect(output).toContain('ACTIVE = "ACTIVE"');
    });
  });

  // ──────────────────────────────────────────────
  // 10. Generator: index file
  // ──────────────────────────────────────────────

  describe("generator: index file", () => {
    it("re-exports all models and enums", () => {
      const schema = parsePrismaSchema(`
enum Role {
  ADMIN
  USER
}

model User {
  id Int @id
}

model Post {
  id Int @id
}
      `);
      const output = generateIndexFile(schema.models, schema.enums);
      expect(output).toContain("export { Role }");
      expect(output).toContain("export { User }");
      expect(output).toContain("export { Post }");
    });

    it("uses snake_case file names with .js extension", () => {
      const schema = parsePrismaSchema(`
model BlogPost {
  id Int @id
}
      `);
      const output = generateIndexFile(schema.models, schema.enums);
      expect(output).toContain('from "./blog_post.js"');
    });
  });

  // ──────────────────────────────────────────────
  // 11. Complex schema: real-world Prisma model
  // ──────────────────────────────────────────────

  describe("complex real-world schema", () => {
    const complexSchema = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum Role {
  ADMIN
  USER
  MODERATOR
}

enum PostStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  profile   Profile?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("users")
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String
  user   User   @relation(fields: [userId], references: [id])
  userId Int    @unique
}

model Post {
  id         Int        @id @default(autoincrement())
  title      String
  content    String?
  status     PostStatus @default(DRAFT)
  author     User       @relation(fields: [authorId], references: [id])
  authorId   Int
  categories Category[]
  createdAt  DateTime   @default(now())

  @@index([authorId])
}

model Category {
  id    Int    @id @default(autoincrement())
  name  String @unique
  posts Post[]
}
`;

    let schema: PrismaSchema;

    it("parses the complex schema without error", () => {
      schema = parsePrismaSchema(complexSchema);
      expect(schema.models).toHaveLength(4);
      expect(schema.enums).toHaveLength(2);
    });

    it("generates User entity with all decorators", () => {
      schema = parsePrismaSchema(complexSchema);
      const output = generateEntityFile(schema.models.find((m) => m.name === "User")!, schema);
      expect(output).toContain('@Table("users")');
      expect(output).toContain("@Id()");
      expect(output).toContain("@CreatedDate()");
      expect(output).toContain("@LastModifiedDate()");
      expect(output).toContain("@OneToMany");
      expect(output).toContain("generated: true");
    });

    it("generates Post entity with ManyToOne and ManyToMany", () => {
      schema = parsePrismaSchema(complexSchema);
      const output = generateEntityFile(schema.models.find((m) => m.name === "Post")!, schema);
      expect(output).toContain("@ManyToOne");
      expect(output).toContain("@ManyToMany");
      expect(output).toContain("() => User");
      expect(output).toContain("() => Category");
    });

    it("generates all entity files without throwing", () => {
      schema = parsePrismaSchema(complexSchema);
      for (const model of schema.models) {
        expect(() => generateEntityFile(model, schema)).not.toThrow();
      }
    });

    it("generates all enum files without throwing", () => {
      schema = parsePrismaSchema(complexSchema);
      for (const e of schema.enums) {
        expect(() => generateEnumFile(e)).not.toThrow();
      }
    });

    it("generates index file that references all models and enums", () => {
      schema = parsePrismaSchema(complexSchema);
      const output = generateIndexFile(schema.models, schema.enums);
      expect(output).toContain("User");
      expect(output).toContain("Post");
      expect(output).toContain("Profile");
      expect(output).toContain("Category");
      expect(output).toContain("Role");
      expect(output).toContain("PostStatus");
    });
  });

  // ──────────────────────────────────────────────
  // 12. Edge cases / adversarial inputs
  // ──────────────────────────────────────────────

  describe("adversarial inputs", () => {
    it("handles model name with numbers", () => {
      const schema = parsePrismaSchema(`
model V2User {
  id Int @id
}
      `);
      expect(schema.models[0].name).toBe("V2User");
    });

    it("handles field name that is a TypeScript reserved word", () => {
      // "class", "type", "new" are reserved — Prisma might use them
      const schema = parsePrismaSchema(`
model Foo {
  id    Int    @id
  type  String
  class String
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      // Should still generate, even if the field name is reserved
      expect(output).toContain("accessor type");
      expect(output).toContain("accessor class");
    });

    it("handles deeply nested @relation args without crashing", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id   Int   @id
  bar  Bar   @relation(fields: [barId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  barId Int
}

model Bar {
  id   Int   @id
  foos Foo[]
}
      `);
      expect(() => generateEntityFile(schema.models[0], schema)).not.toThrow();
    });

    it("handles schema with trailing whitespace and blank lines", () => {
      const schema = parsePrismaSchema(`

model Foo {
  id Int @id

  name String
}

      `);
      expect(schema.models).toHaveLength(1);
      expect(schema.models[0].fields).toHaveLength(2);
    });

    it("handles very long field name", () => {
      const longName = "a".repeat(200);
      const schema = parsePrismaSchema(`
model Foo {
  id         Int    @id
  ${longName} String
}
      `);
      expect(schema.models[0].fields).toHaveLength(2);
      expect(schema.models[0].fields[1].name).toBe(longName);
    });

    it("handles model with only @@map (no fields)", () => {
      const schema = parsePrismaSchema(`
model Empty {
  @@map("empty_table")
}
      `);
      expect(schema.models[0].fields).toHaveLength(0);
      expect(schema.models[0].attributes.length).toBeGreaterThan(0);
    });

    it("does not crash on @default with string literal", () => {
      const schema = parsePrismaSchema(`
model Foo {
  id     Int    @id
  status String @default("active")
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("accessor status");
    });

    it("handles enum used as field type", () => {
      const schema = parsePrismaSchema(`
enum Status {
  ACTIVE
  INACTIVE
}

model Foo {
  id     Int    @id
  status Status
}
      `);
      const output = generateEntityFile(schema.models[0], schema);
      // Should use the enum type name, not a primitive
      expect(output).toContain("accessor status");
    });
  });

  // ──────────────────────────────────────────────
  // 13. Self-referential relation generation
  // ──────────────────────────────────────────────

  describe("self-referential relations", () => {
    it("generates entity for self-referential model", () => {
      const schema = parsePrismaSchema(`
model Employee {
  id         Int        @id
  managerId  Int?
  manager    Employee?  @relation("ManagerReports", fields: [managerId], references: [id])
  reports    Employee[] @relation("ManagerReports")
}
      `);
      // Should not crash and should generate valid output
      expect(() => generateEntityFile(schema.models[0], schema)).not.toThrow();
      const output = generateEntityFile(schema.models[0], schema);
      expect(output).toContain("Employee");
    });
  });

  // ──────────────────────────────────────────────
  // 14. OneToOne relation generation
  // ──────────────────────────────────────────────

  describe("OneToOne relations", () => {
    it("generates @OneToOne for 1:1 relation", () => {
      const schema = parsePrismaSchema(`
model User {
  id      Int      @id
  profile Profile?
}

model Profile {
  id     Int  @id
  user   User @relation(fields: [userId], references: [id])
  userId Int  @unique
}
      `);
      const profileOutput = generateEntityFile(schema.models.find((m) => m.name === "Profile")!, schema);
      expect(profileOutput).toContain("@OneToOne");
    });
  });
});
