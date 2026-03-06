import { Column, CreatedDate, DdlGenerator, Id, LastModifiedDate, Table } from "espalier-data";
import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { PgSchemaIntrospector } from "../../pg-schema-introspector.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// ---------- Entity definitions ----------

@Table("e2e_ddl_basic")
class BasicEntity {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
  @Column() active: boolean = false;
}

@Table("e2e_ddl_constrained")
class ConstrainedEntity {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) name: string = "";
  @Column({ nullable: false, unique: true }) email: string = "";
  @Column({ defaultValue: "'pending'" }) status: string = "";
}

@Table("e2e_ddl_audited")
class AuditedEntity {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ nullable: false }) title: string = "";
  @CreatedDate @Column("created_at") createdAt: Date = new Date();
  @LastModifiedDate @Column("updated_at") updatedAt: Date = new Date();
}

@Table("e2e_ddl_varchar")
class VarcharEntity {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ length: 255, nullable: false }) name: string = "";
  @Column({ length: 100 }) description: string = "";
}

@Table("e2e_ddl_idempotent")
class IdempotentEntity {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() value: string = "";
}

@Table("e2e_ddl_drop")
class DropEntity {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() data: string = "";
}

// Instantiate all entities to register decorator metadata
new BasicEntity();
new ConstrainedEntity();
new AuditedEntity();
new VarcharEntity();
new IdempotentEntity();
new DropEntity();

// ---------- Tests ----------

describe.skipIf(!canConnect)("DdlGenerator E2E (round-trip)", () => {
  let ds: PgDataSource;
  let conn: Connection;
  let introspector: PgSchemaIntrospector;
  const generator = new DdlGenerator();

  const ALL_TABLES = [
    "e2e_ddl_basic",
    "e2e_ddl_constrained",
    "e2e_ddl_audited",
    "e2e_ddl_varchar",
    "e2e_ddl_idempotent",
    "e2e_ddl_drop",
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    introspector = new PgSchemaIntrospector(conn);

    const stmt = conn.createStatement();
    // Clean up any leftover tables
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      for (const table of ALL_TABLES) {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  describe("basic round-trip: generate -> execute -> introspect", () => {
    it("should create table and verify column names and types", async () => {
      const sql = generator.generateCreateTable(BasicEntity);
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_basic");
      expect(columns).toHaveLength(3);

      const id = columns.find((c) => c.columnName === "id")!;
      expect(id.dataType).toBe("integer");
      expect(id.primaryKey).toBe(true);

      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.dataType).toBe("text");

      const active = columns.find((c) => c.columnName === "active")!;
      expect(active.dataType).toBe("boolean");
    });
  });

  describe("NOT NULL constraint round-trip", () => {
    it("should create table and verify nullable flags via introspection", async () => {
      const sql = generator.generateCreateTable(ConstrainedEntity);
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_constrained");

      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.nullable).toBe(false);

      const email = columns.find((c) => c.columnName === "email")!;
      expect(email.nullable).toBe(false);

      // status has no nullable constraint, should be nullable
      const status = columns.find((c) => c.columnName === "status")!;
      expect(status.nullable).toBe(true);
    });
  });

  describe("UNIQUE constraint round-trip", () => {
    it("should create table and verify unique flags via introspection", async () => {
      // Ensure the constrained table exists (don't depend on prior test order)
      const sql = generator.generateCreateTable(ConstrainedEntity, { ifNotExists: true });
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_constrained");

      const email = columns.find((c) => c.columnName === "email")!;
      expect(email.unique).toBe(true);

      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.unique).toBe(false);
    });
  });

  describe("DEFAULT value round-trip", () => {
    it("should apply default when inserting without the column", async () => {
      // Ensure the constrained table exists
      const createSql = generator.generateCreateTable(ConstrainedEntity, { ifNotExists: true });
      const stmt = conn.createStatement();
      await stmt.executeUpdate(createSql);

      // Insert a row without specifying status (has DEFAULT 'pending')
      await stmt.executeUpdate("INSERT INTO e2e_ddl_constrained (name, email) VALUES ('Alice', 'alice@test.com')");

      const ps = conn.prepareStatement("SELECT status FROM e2e_ddl_constrained WHERE email = $1");
      ps.setParameter(1, "alice@test.com");
      const rs = await ps.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("status")).toBe("pending");
    });

    it("should introspect default value from column metadata", async () => {
      // Ensure the constrained table exists
      const sql = generator.generateCreateTable(ConstrainedEntity, { ifNotExists: true });
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_constrained");
      const status = columns.find((c) => c.columnName === "status")!;
      expect(status.defaultValue).toContain("pending");
    });
  });

  describe("PRIMARY KEY round-trip", () => {
    it("should introspect primary key on @Id field", async () => {
      // Ensure the basic table exists
      const sql = generator.generateCreateTable(BasicEntity, { ifNotExists: true });
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_basic");
      const id = columns.find((c) => c.columnName === "id")!;
      expect(id.primaryKey).toBe(true);

      // Non-PK fields should not be primary key
      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.primaryKey).toBe(false);
    });

    it("should return id from getPrimaryKeys", async () => {
      // Ensure the basic table exists
      const sql = generator.generateCreateTable(BasicEntity, { ifNotExists: true });
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const keys = await introspector.getPrimaryKeys("e2e_ddl_basic");
      expect(keys).toEqual(["id"]);
    });
  });

  describe("VARCHAR(n) round-trip", () => {
    it("should create table and verify maxLength via introspection", async () => {
      const sql = generator.generateCreateTable(VarcharEntity);
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_varchar");

      const name = columns.find((c) => c.columnName === "name")!;
      expect(name.dataType).toBe("character varying");
      expect(name.maxLength).toBe(255);
      expect(name.nullable).toBe(false);

      const description = columns.find((c) => c.columnName === "description")!;
      expect(description.dataType).toBe("character varying");
      expect(description.maxLength).toBe(100);
      expect(description.nullable).toBe(true);
    });
  });

  describe("auditing column round-trip", () => {
    it("should create table with @CreatedDate DEFAULT NOW()", async () => {
      const sql = generator.generateCreateTable(AuditedEntity);
      const stmt = conn.createStatement();
      await stmt.executeUpdate(sql);

      const columns = await introspector.getColumns("e2e_ddl_audited");

      const createdAt = columns.find((c) => c.columnName === "created_at")!;
      expect(createdAt.dataType).toBe("timestamp with time zone");
      expect(createdAt.defaultValue).toMatch(/now/i);

      // @LastModifiedDate should NOT have automatic DEFAULT
      const updatedAt = columns.find((c) => c.columnName === "updated_at")!;
      expect(updatedAt.dataType).toBe("timestamp with time zone");
      expect(updatedAt.defaultValue).toBeNull();
    });

    it("should auto-populate @CreatedDate on insert", async () => {
      const before = new Date();
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO e2e_ddl_audited (title) VALUES ('test entry')");

      const ps = conn.prepareStatement("SELECT created_at FROM e2e_ddl_audited WHERE title = $1");
      ps.setParameter(1, "test entry");
      const rs = await ps.executeQuery();
      expect(await rs.next()).toBe(true);

      const createdAt = rs.getDate("created_at");
      expect(createdAt).not.toBeNull();
      // created_at should be recent (within a few seconds)
      expect(createdAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(createdAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe("DROP TABLE generation", () => {
    it("should generate and execute DROP TABLE, then verify table is gone", async () => {
      // First create the table
      const createSql = generator.generateCreateTable(DropEntity);
      const stmt = conn.createStatement();
      await stmt.executeUpdate(createSql);
      expect(await introspector.tableExists("e2e_ddl_drop")).toBe(true);

      // Drop it
      const dropSql = generator.generateDropTable(DropEntity, { ifExists: true, cascade: true });
      await stmt.executeUpdate(dropSql);
      expect(await introspector.tableExists("e2e_ddl_drop")).toBe(false);
    });
  });

  describe("IF NOT EXISTS is idempotent", () => {
    it("should execute CREATE TABLE IF NOT EXISTS twice without error", async () => {
      const sql = generator.generateCreateTable(IdempotentEntity, { ifNotExists: true });
      const stmt = conn.createStatement();

      // First execution creates the table
      await stmt.executeUpdate(sql);
      expect(await introspector.tableExists("e2e_ddl_idempotent")).toBe(true);

      // Second execution should not throw
      await expect(stmt.executeUpdate(sql)).resolves.not.toThrow();
      expect(await introspector.tableExists("e2e_ddl_idempotent")).toBe(true);
    });
  });
});
