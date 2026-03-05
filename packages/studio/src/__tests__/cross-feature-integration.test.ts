/**
 * TEST-5: Cross-feature integration and regression tests (Y5 Q1)
 *
 * Seam tests between studio and the existing espalier ecosystem:
 * - Studio server + existing PgDataSource connection pool (connection release)
 * - Schema extractor + multi-tenant entities
 * - Schema extractor + @Embedded / polymorphic types
 * - Diagram CLI command + various entity configurations
 * - Studio server lifecycle (start + stop, connection cleanup)
 * - All exports are accessible from the main package index
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { PgDataSource } from "espalier-jdbc-pg";
import {
  Table,
  Column,
  Id,
  Version,
  ManyToOne,
  OneToMany,
  ManyToMany,
  OneToOne,
  CreatedDate,
  LastModifiedDate,
  TenantId,
  Embeddable,
  Embedded,
} from "espalier-data";
import { extractSchema } from "../schema/index.js";
import { generateDiagram } from "../diagram/index.js";
import { createApiRoutes } from "../server/api-routes.js";
import { createStudioServer } from "../server/index.js";
import { runDiagramCommand } from "../cli/diagram-command.js";
import type { ApiRouteContext } from "../server/api-routes.js";
import type { SchemaModel } from "../schema/schema-model.js";

// =============================================================================
// Postgres connectivity check
// =============================================================================

async function isPostgresAvailable(): Promise<boolean> {
  const ds = createTestDataSource();
  try {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT 1");
    await conn.close();
    await ds.close();
    return true;
  } catch {
    try { await ds.close(); } catch { /* ignore */ }
    return false;
  }
}

function createTestDataSource(): PgDataSource {
  return new PgDataSource({
    host: "localhost",
    port: 55432,
    user: "nesify",
    password: "nesify",
    database: "nesify",
  });
}

const canConnect = await isPostgresAvailable();

// =============================================================================
// Complex entity graph for integration testing
// =============================================================================

// Multi-tenant entity
@Table("integ_tenanted_products")
class TenantedProduct {
  @Id @Column({ type: "UUID" }) id!: string;
  @TenantId @Column({ type: "VARCHAR(64)" }) tenantId!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Column({ type: "DECIMAL(10,2)" }) price!: number;
  @Version @Column({ type: "INTEGER" }) version!: number;
  @CreatedDate @Column({ type: "TIMESTAMPTZ" }) createdAt!: Date;
  @LastModifiedDate @Column({ type: "TIMESTAMPTZ" }) updatedAt!: Date;
}
new TenantedProduct();

// Embeddable value object
@Embeddable
class GeoLocation {
  @Column({ type: "DOUBLE PRECISION" }) latitude!: number;
  @Column({ type: "DOUBLE PRECISION" }) longitude!: number;
}
new GeoLocation();

@Embeddable
class ContactInfo {
  @Column({ type: "VARCHAR(255)" }) email!: string;
  @Column({ type: "VARCHAR(20)" }) phone!: string;
}
new ContactInfo();

// Entity with multiple @Embedded fields
@Table("integ_warehouses")
class Warehouse {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Embedded({ target: () => GeoLocation, prefix: "loc_" }) location!: GeoLocation;
  @Embedded({ target: () => ContactInfo, prefix: "contact_" }) contact!: ContactInfo;
}
new Warehouse();

// Bidirectional OneToMany
@Table("integ_departments")
class Department {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @OneToMany({ target: () => Employee, mappedBy: "department" }) employees!: Employee[];
}
new Department();

@Table("integ_employees")
class Employee {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @ManyToOne({ target: () => Department }) department!: Department;
}
new Employee();

// Self-referential
@Table("integ_categories")
class Category {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @ManyToOne({ target: () => Category, nullable: true }) parent!: Category | null;
  @OneToMany({ target: () => Category, mappedBy: "parent" }) children!: Category[];
}
new Category();

// ManyToMany
@Table("integ_roles")
class Role {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(100)" }) name!: string;
  @ManyToMany({
    target: () => Permission,
    joinTable: { name: "role_permissions", joinColumn: "role_id", inverseJoinColumn: "permission_id" },
  })
  permissions!: Permission[];
}
new Role();

@Table("integ_permissions")
class Permission {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(100)" }) code!: string;
  @ManyToMany({ target: () => Role, mappedBy: "permissions" }) roles!: Role[];
}
new Permission();

// OneToOne
@Table("integ_user_accounts")
class UserAccount {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)", unique: true }) email!: string;
  @OneToOne({ target: () => UserPreference }) preferences!: UserPreference;
}
new UserAccount();

@Table("integ_user_preferences")
class UserPreference {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "JSONB" }) settings!: string;
  @OneToOne({ target: () => UserAccount, mappedBy: "preferences" }) account!: UserAccount;
}
new UserPreference();

const ALL_ENTITIES = [
  TenantedProduct,
  Warehouse,
  Department,
  Employee,
  Category,
  Role,
  Permission,
  UserAccount,
  UserPreference,
];

// =============================================================================
// Tests
// =============================================================================

describe("cross-feature integration — schema extractor + diagram", () => {
  let schema: SchemaModel;

  beforeAll(() => {
    schema = extractSchema({ entities: ALL_ENTITIES });
  });

  it("extracts all 9 entity tables", () => {
    expect(schema.tables).toHaveLength(9);
  });

  it("tenant entity preserves tenantId column metadata", () => {
    const table = schema.tables.find((t) => t.tableName === "integ_tenanted_products")!;
    expect(table).toBeDefined();
    const tenantCol = table.columns.find((c) => c.isTenantId);
    expect(tenantCol).toBeDefined();
    expect(tenantCol!.fieldName).toBe("tenantId");
  });

  it("embedded fields flatten into parent table", () => {
    const table = schema.tables.find((t) => t.tableName === "integ_warehouses")!;
    expect(table).toBeDefined();
    // Should have: id, name, loc_latitude, loc_longitude, contact_email, contact_phone
    expect(table.columns.length).toBeGreaterThanOrEqual(6);
  });

  it("auditing fields are preserved", () => {
    const table = schema.tables.find((t) => t.tableName === "integ_tenanted_products")!;
    const created = table.columns.find((c) => c.isCreatedDate);
    const updated = table.columns.find((c) => c.isLastModifiedDate);
    expect(created).toBeDefined();
    expect(updated).toBeDefined();
  });

  it("version field is preserved", () => {
    const table = schema.tables.find((t) => t.tableName === "integ_tenanted_products")!;
    const version = table.columns.find((c) => c.isVersion);
    expect(version).toBeDefined();
  });

  it("generates valid Mermaid ER diagram from complex schema", () => {
    const diagram = generateDiagram(schema, { format: "mermaid", title: "Integration Test" });
    expect(diagram).toContain("erDiagram");
    expect(diagram).toContain("integ_departments");
    expect(diagram).toContain("integ_employees");
    expect(diagram).toContain("integ_categories"); // self-ref
    expect(diagram).toContain("integ_roles");
    expect(diagram).toContain("integ_permissions");
    expect(diagram).toContain("title: Integration Test");
  });

  it("generates valid D2 diagram from complex schema", () => {
    const diagram = generateDiagram(schema, { format: "d2" });
    expect(diagram).toContain("shape: sql_table");
    expect(diagram).toContain("integ_warehouses");
    expect(diagram).toContain("->");
  });

  it("generates valid PlantUML diagram from complex schema", () => {
    const diagram = generateDiagram(schema, { format: "plantuml" });
    expect(diagram).toContain("@startuml");
    expect(diagram).toContain("@enduml");
    expect(diagram).toContain("integ_tenanted_products");
  });

  it("self-referential relations appear in diagram", () => {
    const diagram = generateDiagram(schema, { format: "mermaid" });
    // integ_categories should reference itself
    const lines = diagram.split("\n");
    const catRelLines = lines.filter(
      (l) => l.includes("integ_categories") && l.includes(":"),
    );
    expect(catRelLines.length).toBeGreaterThan(0);
  });

  it("ManyToMany join table info preserved in schema", () => {
    const rolePerms = schema.relations.find(
      (r) => r.sourceTable === "integ_roles" && r.fieldName === "permissions",
    );
    expect(rolePerms).toBeDefined();
    expect(rolePerms!.joinTable).toBeDefined();
    expect(rolePerms!.joinTable!.name).toBe("role_permissions");
  });

  it("OneToOne bidirectional has correct owning sides", () => {
    const owning = schema.relations.find(
      (r) => r.sourceTable === "integ_user_accounts" && r.fieldName === "preferences",
    );
    const inverse = schema.relations.find(
      (r) => r.sourceTable === "integ_user_preferences" && r.fieldName === "account",
    );
    expect(owning?.isOwning).toBe(true);
    expect(inverse?.isOwning).toBe(false);
  });
});

describe("cross-feature integration — diagram CLI command", () => {
  it("runDiagramCommand outputs to stdout when no output file", () => {
    const originalWrite = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as any;

    try {
      runDiagramCommand({
        entities: [TenantedProduct, Department, Employee],
        format: "mermaid",
        title: "CLI Test",
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured).toContain("erDiagram");
    expect(captured).toContain("integ_tenanted_products");
  });
});

describe("cross-feature integration — studio exports", () => {
  it("main index exports all key functions and types", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.extractSchema).toBe("function");
    expect(typeof mod.generateDiagram).toBe("function");
    expect(typeof mod.createStudioServer).toBe("function");
  });

  it("core subpath exports schema and server", async () => {
    const mod = await import("../core.js");
    expect(typeof mod.extractSchema).toBe("function");
    expect(typeof mod.createStudioServer).toBe("function");
  });

  it("diagram subpath exports generateDiagram", async () => {
    const mod = await import("../diagram.js");
    expect(typeof mod.generateDiagram).toBe("function");
  });
});

describe.skipIf(!canConnect)(
  "cross-feature integration — studio server + connection pool (E2E)",
  () => {
    let ds: PgDataSource;
    const TEST_TABLE = "integ_test_pool";

    beforeAll(async () => {
      ds = createTestDataSource();
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await stmt.executeUpdate(`
        CREATE TABLE ${TEST_TABLE} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL
        )
      `);
      await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name) VALUES ('test1')`);
      await stmt.close();
      await conn.close();
    });

    afterAll(async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await stmt.close();
      await conn.close();
      await ds.close();
    });

    it("studio API requests release connections back to pool", async () => {
      @Table(TEST_TABLE)
      class IntegPoolItem {
        @Id @Column({ type: "UUID" }) id!: string;
        @Column({ type: "VARCHAR(255)" }) name!: string;
      }
      new IntegPoolItem();

      const schema = extractSchema({ entities: [IntegPoolItem] });
      const app = new Hono();
      createApiRoutes(app, { schema, dataSource: ds, readOnly: true });

      // Make many sequential requests to verify connections are released
      for (let i = 0; i < 20; i++) {
        const res = await app.request(`http://localhost/api/tables/${TEST_TABLE}/rows`);
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.rows.length).toBeGreaterThan(0);
      }
    });

    it("concurrent studio requests don't exhaust pool", async () => {
      @Table(TEST_TABLE)
      class IntegPoolItem2 {
        @Id @Column({ type: "UUID" }) id!: string;
        @Column({ type: "VARCHAR(255)" }) name!: string;
      }
      new IntegPoolItem2();

      const schema = extractSchema({ entities: [IntegPoolItem2] });
      const app = new Hono();
      createApiRoutes(app, { schema, dataSource: ds, readOnly: true });

      const requests = Array.from({ length: 15 }, () =>
        app.request(`http://localhost/api/tables/${TEST_TABLE}/rows`),
      );
      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    });

    it("createStudioServer returns correct interface shape", () => {
      const schema = extractSchema({ entities: ALL_ENTITIES });
      const server = createStudioServer({
        schema,
        dataSource: ds,
        port: 0,
        readOnly: true,
      });

      expect(typeof server.start).toBe("function");
      expect(typeof server.stop).toBe("function");
      expect(typeof server.port).toBe("number");
      expect(server.app).toBeDefined();
    });

    it("schema + query API integration (query playground reads real data)", async () => {
      @Table(TEST_TABLE)
      class IntegPoolItem3 {
        @Id @Column({ type: "UUID" }) id!: string;
        @Column({ type: "VARCHAR(255)" }) name!: string;
      }
      new IntegPoolItem3();

      const schema = extractSchema({ entities: [IntegPoolItem3] });
      const app = new Hono();
      createApiRoutes(app, { schema, dataSource: ds, readOnly: true });

      // Use query playground to read from the same table
      const queryRes = await app.request("http://localhost/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: `SELECT * FROM ${TEST_TABLE}` }),
      });
      expect(queryRes.status).toBe(200);
      const body: any = await queryRes.json();
      expect(body.rows.length).toBeGreaterThan(0);

      // Schema endpoint should show the table
      const schemaRes = await app.request("http://localhost/api/schema");
      expect(schemaRes.status).toBe(200);
      const schemaBody: any = await schemaRes.json();
      expect(schemaBody.tables.some((t: any) => t.tableName === TEST_TABLE)).toBe(true);
    });
  },
);
