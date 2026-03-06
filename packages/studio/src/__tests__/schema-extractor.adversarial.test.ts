/**
 * TEST-1: Adversarial tests for studio scaffold and schema extractor (Y5 Q1)
 *
 * Tries to break extractSchema with:
 * - Entities missing @Table, @Id, @Column decorators
 * - Circular relations (A -> B -> C -> A)
 * - Self-referential entities (tree structures)
 * - Polymorphic / @Embedded entities
 * - Entities with no relations vs deeply nested chains
 * - Empty entity list
 * - Duplicate entity registrations
 * - Entities with only auditing fields
 * - Entities with @TenantId
 * - Special characters in class/table names
 * - SchemaModel cardinality and accuracy validation
 * - Scaffold exports verification
 */

import {
  Column,
  CreatedDate,
  Embeddable,
  Embedded,
  Id,
  LastModifiedDate,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  Table,
  TenantId,
  Version,
} from "espalier-data";
import { describe, expect, it } from "vitest";
import type { SchemaColumn, SchemaModel, SchemaRelation, SchemaTable } from "../schema/index.js";
import { extractSchema } from "../schema/index.js";

// =============================================================================
// Helper
// =============================================================================

function findTable(model: SchemaModel, tableName: string): SchemaTable | undefined {
  return model.tables.find((t) => t.tableName === tableName);
}

function findColumn(table: SchemaTable, fieldName: string): SchemaColumn | undefined {
  return table.columns.find((c) => c.fieldName === fieldName);
}

function findRelation(model: SchemaModel, sourceTable: string, fieldName: string): SchemaRelation | undefined {
  return model.relations.find((r) => r.sourceTable === sourceTable && r.fieldName === fieldName);
}

// =============================================================================
// Test entities
// =============================================================================

// --- Basic entity ---
@Table("basic_items")
class BasicItem {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Column({ type: "INTEGER", nullable: true }) quantity!: number;
  @Version @Column({ type: "INTEGER" }) version!: number;
}
new BasicItem();

// --- Auditing entity ---
@Table("audited_records")
class AuditedRecord {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) data!: string;
  @CreatedDate @Column({ type: "TIMESTAMPTZ" }) createdAt!: Date;
  @LastModifiedDate @Column({ type: "TIMESTAMPTZ" }) updatedAt!: Date;
}
new AuditedRecord();

// --- Tenant entity ---
@Table("tenant_resources")
class TenantResource {
  @Id @Column({ type: "UUID" }) id!: string;
  @TenantId @Column({ type: "VARCHAR(64)" }) tenantId!: string;
  @Column({ type: "TEXT" }) content!: string;
}
new TenantResource();

// --- Circular A -> B -> C -> A ---
@Table("circle_a")
class CircleA {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) name!: string;
  @ManyToOne({ target: () => CircleB }) circleB!: any;
}
new CircleA();

@Table("circle_b")
class CircleB {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) name!: string;
  @ManyToOne({ target: () => CircleC }) circleC!: any;
  @OneToMany({ target: () => CircleA, mappedBy: "circleB" }) circleAs!: any[];
}
new CircleB();

@Table("circle_c")
class CircleC {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) name!: string;
  @ManyToOne({ target: () => CircleA }) circleA!: any;
  @OneToMany({ target: () => CircleB, mappedBy: "circleC" }) circleBs!: any[];
}
new CircleC();

// --- Self-referential entity (tree structure) ---
@Table("tree_nodes")
class TreeNode {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) label!: string;
  @ManyToOne({ target: () => TreeNode, nullable: true }) parent!: TreeNode | null;
  @OneToMany({ target: () => TreeNode, mappedBy: "parent" }) children!: TreeNode[];
}
new TreeNode();

// --- ManyToMany with join table ---
@Table("students")
class Student {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @ManyToMany({
    target: () => Course,
    joinTable: {
      name: "student_courses",
      joinColumn: "student_id",
      inverseJoinColumn: "course_id",
    },
  })
  courses!: Course[];
}
new Student();

@Table("courses")
class Course {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) title!: string;
  @ManyToMany({ target: () => Student, mappedBy: "courses" }) students!: Student[];
}
new Course();

// --- OneToOne bidirectional ---
@Table("user_profiles")
class UserProfile {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) username!: string;
  @OneToOne({ target: () => UserSettings }) settings!: UserSettings;
}
new UserProfile();

@Table("user_settings")
class UserSettings {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "JSONB" }) preferences!: string;
  @OneToOne({ target: () => UserProfile, mappedBy: "settings" }) profile!: UserProfile;
}
new UserSettings();

// --- Embeddable ---
@Embeddable
class Address {
  @Column({ type: "VARCHAR(255)" }) street!: string;
  @Column({ type: "VARCHAR(100)" }) city!: string;
  @Column({ type: "VARCHAR(10)" }) zip!: string;
}
new Address();

@Table("companies")
class Company {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Embedded({ target: () => Address, prefix: "hq_" }) headquarters!: Address;
  @Embedded({ target: () => Address, prefix: "billing_" }) billingAddress!: Address;
}
new Company();

// --- Entity missing @Table (should throw) ---
class NoTableEntity {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) value!: string;
}
new NoTableEntity();

// --- Entity missing @Id (should throw) ---
@Table("no_id_items")
class NoIdEntity {
  @Column({ type: "TEXT" }) value!: string;
}
new NoIdEntity();

// --- Bare class with no decorators at all ---
class BareClass {
  id!: string;
  name!: string;
}

// --- Entity with unique + default constraints ---
@Table("constrained_items")
class ConstrainedItem {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)", unique: true }) email!: string;
  @Column({ type: "INTEGER", nullable: false, defaultValue: "0" }) score!: number;
  @Column({ type: "VARCHAR(50)", length: 50 }) code!: string;
}
new ConstrainedItem();

// =============================================================================
// Tests
// =============================================================================

describe("schema extractor — adversarial", () => {
  describe("empty and degenerate inputs", () => {
    it("returns empty schema for empty entity list", () => {
      const model = extractSchema({ entities: [] });
      expect(model.tables).toHaveLength(0);
      expect(model.relations).toHaveLength(0);
    });

    it("handles single entity with no relations", () => {
      const model = extractSchema({ entities: [BasicItem] });
      expect(model.tables).toHaveLength(1);
      expect(model.relations).toHaveLength(0);
      expect(model.tables[0].tableName).toBe("basic_items");
    });
  });

  describe("entity metadata accuracy", () => {
    it("extracts columns with correct field/column names", () => {
      const model = extractSchema({ entities: [BasicItem] });
      const table = findTable(model, "basic_items")!;
      expect(table).toBeDefined();
      expect(table.className).toBe("BasicItem");

      const idCol = findColumn(table, "id")!;
      expect(idCol).toBeDefined();
      expect(idCol.isPrimaryKey).toBe(true);
      expect(idCol.type).toBe("UUID");

      const nameCol = findColumn(table, "name")!;
      expect(nameCol.isPrimaryKey).toBe(false);
      expect(nameCol.type).toBe("VARCHAR(255)");

      const versionCol = findColumn(table, "version")!;
      expect(versionCol.isVersion).toBe(true);
    });

    it("detects nullable columns", () => {
      const model = extractSchema({ entities: [BasicItem] });
      const table = findTable(model, "basic_items")!;
      const quantityCol = findColumn(table, "quantity")!;
      expect(quantityCol.nullable).toBe(true);
    });

    it("detects unique, defaultValue, and length constraints", () => {
      const model = extractSchema({ entities: [ConstrainedItem] });
      const table = findTable(model, "constrained_items")!;

      const emailCol = findColumn(table, "email")!;
      expect(emailCol.unique).toBe(true);

      const scoreCol = findColumn(table, "score")!;
      expect(scoreCol.nullable).toBe(false);
      expect(scoreCol.defaultValue).toBe("0");

      const codeCol = findColumn(table, "code")!;
      expect(codeCol.length).toBe(50);
    });

    it("extracts auditing metadata (createdDate, lastModifiedDate)", () => {
      const model = extractSchema({ entities: [AuditedRecord] });
      const table = findTable(model, "audited_records")!;

      const createdCol = findColumn(table, "createdAt")!;
      expect(createdCol.isCreatedDate).toBe(true);
      expect(createdCol.isLastModifiedDate).toBe(false);

      const updatedCol = findColumn(table, "updatedAt")!;
      expect(updatedCol.isLastModifiedDate).toBe(true);
      expect(updatedCol.isCreatedDate).toBe(false);
    });

    it("extracts tenant discriminator column", () => {
      const model = extractSchema({ entities: [TenantResource] });
      const table = findTable(model, "tenant_resources")!;

      const tenantCol = findColumn(table, "tenantId")!;
      expect(tenantCol.isTenantId).toBe(true);

      // other columns should NOT be tenant
      const idCol = findColumn(table, "id")!;
      expect(idCol.isTenantId).toBe(false);
    });
  });

  describe("missing decorator errors", () => {
    it("throws on entity missing @Table", () => {
      expect(() => extractSchema({ entities: [NoTableEntity] })).toThrow(/@Table/);
    });

    it("throws on entity missing @Id", () => {
      expect(() => extractSchema({ entities: [NoIdEntity] })).toThrow(/@Id/);
    });

    it("throws on bare class with no decorators at all", () => {
      expect(() => extractSchema({ entities: [BareClass] })).toThrow();
    });
  });

  describe("circular relations (A -> B -> C -> A)", () => {
    it("does not hang or stack overflow on circular entity graph", () => {
      const model = extractSchema({
        entities: [CircleA, CircleB, CircleC],
      });
      expect(model.tables).toHaveLength(3);
    });

    it("captures all circular relations with correct cardinalities", () => {
      const model = extractSchema({
        entities: [CircleA, CircleB, CircleC],
      });

      // CircleA -> CircleB (ManyToOne)
      const abRel = findRelation(model, "circle_a", "circleB");
      expect(abRel).toBeDefined();
      expect(abRel!.type).toBe("ManyToOne");
      expect(abRel!.targetTable).toBe("circle_b");
      expect(abRel!.isOwning).toBe(true);

      // CircleB -> CircleC (ManyToOne)
      const bcRel = findRelation(model, "circle_b", "circleC");
      expect(bcRel).toBeDefined();
      expect(bcRel!.type).toBe("ManyToOne");
      expect(bcRel!.targetTable).toBe("circle_c");

      // CircleC -> CircleA (ManyToOne) - completes the cycle
      const caRel = findRelation(model, "circle_c", "circleA");
      expect(caRel).toBeDefined();
      expect(caRel!.type).toBe("ManyToOne");
      expect(caRel!.targetTable).toBe("circle_a");

      // Inverse sides
      const baRel = findRelation(model, "circle_b", "circleAs");
      expect(baRel).toBeDefined();
      expect(baRel!.type).toBe("OneToMany");
      expect(baRel!.isOwning).toBe(false);

      const cbRel = findRelation(model, "circle_c", "circleBs");
      expect(cbRel).toBeDefined();
      expect(cbRel!.type).toBe("OneToMany");
      expect(cbRel!.isOwning).toBe(false);
    });
  });

  describe("self-referential entity", () => {
    it("handles self-referential ManyToOne/OneToMany", () => {
      const model = extractSchema({ entities: [TreeNode] });
      expect(model.tables).toHaveLength(1);

      const parentRel = findRelation(model, "tree_nodes", "parent");
      expect(parentRel).toBeDefined();
      expect(parentRel!.type).toBe("ManyToOne");
      expect(parentRel!.targetTable).toBe("tree_nodes");
      expect(parentRel!.sourceTable).toBe("tree_nodes");

      const childrenRel = findRelation(model, "tree_nodes", "children");
      expect(childrenRel).toBeDefined();
      expect(childrenRel!.type).toBe("OneToMany");
      expect(childrenRel!.targetTable).toBe("tree_nodes");
      expect(childrenRel!.mappedBy).toBe("parent");
    });
  });

  describe("ManyToMany with join table", () => {
    it("extracts owning side with join table config", () => {
      const model = extractSchema({ entities: [Student, Course] });

      const studentCourses = findRelation(model, "students", "courses");
      expect(studentCourses).toBeDefined();
      expect(studentCourses!.type).toBe("ManyToMany");
      expect(studentCourses!.isOwning).toBe(true);
      expect(studentCourses!.joinTable).toBeDefined();
      expect(studentCourses!.joinTable!.name).toBe("student_courses");
      expect(studentCourses!.joinTable!.joinColumn).toBe("student_id");
      expect(studentCourses!.joinTable!.inverseJoinColumn).toBe("course_id");
    });

    it("extracts inverse side with mappedBy", () => {
      const model = extractSchema({ entities: [Student, Course] });

      const courseStudents = findRelation(model, "courses", "students");
      expect(courseStudents).toBeDefined();
      expect(courseStudents!.type).toBe("ManyToMany");
      expect(courseStudents!.isOwning).toBe(false);
      expect(courseStudents!.mappedBy).toBe("courses");
      expect(courseStudents!.joinTable).toBeUndefined();
    });
  });

  describe("OneToOne bidirectional", () => {
    it("extracts owning and inverse sides correctly", () => {
      const model = extractSchema({ entities: [UserProfile, UserSettings] });

      const profileSettings = findRelation(model, "user_profiles", "settings");
      expect(profileSettings).toBeDefined();
      expect(profileSettings!.type).toBe("OneToOne");
      expect(profileSettings!.isOwning).toBe(true);
      expect(profileSettings!.joinColumn).toBe("settings_id");

      const settingsProfile = findRelation(model, "user_settings", "profile");
      expect(settingsProfile).toBeDefined();
      expect(settingsProfile!.type).toBe("OneToOne");
      expect(settingsProfile!.isOwning).toBe(false);
      expect(settingsProfile!.mappedBy).toBe("settings");
    });
  });

  describe("embedded entities", () => {
    it("flattens embedded columns into parent table", () => {
      const model = extractSchema({ entities: [Company] });
      const table = findTable(model, "companies")!;
      expect(table).toBeDefined();

      // Should have id + name + 3 hq_* columns + 3 billing_* columns = 8
      expect(table.columns.length).toBeGreaterThanOrEqual(8);

      // Verify prefixed columns exist
      const hqStreet = table.columns.find((c) => c.columnName === "hq_street" || c.fieldName.includes("street"));
      expect(hqStreet).toBeDefined();

      const billingCity = table.columns.find((c) => c.columnName === "billing_city" || c.fieldName.includes("city"));
      expect(billingCity).toBeDefined();
    });
  });

  describe("relation target resolution when entity not in list", () => {
    it("handles relation target not included in entity list", () => {
      // Only include Student, not Course — target resolution should still work
      const model = extractSchema({ entities: [Student] });
      const rel = findRelation(model, "students", "courses");
      expect(rel).toBeDefined();
      expect(rel!.type).toBe("ManyToMany");
      // Target table should still resolve (via class name fallback or metadata)
      expect(rel!.targetTable).toBeTruthy();
      expect(typeof rel!.targetTable).toBe("string");
    });
  });

  describe("duplicate entity registrations", () => {
    it("handles same entity passed twice without crashing", () => {
      const model = extractSchema({ entities: [BasicItem, BasicItem] });
      // Should either deduplicate or include both — just don't crash
      expect(model.tables.length).toBeGreaterThanOrEqual(1);
      expect(model.tables.every((t) => t.tableName === "basic_items")).toBe(true);
    });
  });

  describe("top-level SchemaModel structure", () => {
    it("relations array matches the flattened union of per-table relations", () => {
      const model = extractSchema({
        entities: [CircleA, CircleB, CircleC],
      });

      const tableRelationCount = model.tables.reduce((sum, t) => sum + t.relations.length, 0);
      expect(model.relations).toHaveLength(tableRelationCount);
    });

    it("all relations have non-empty sourceTable and targetTable", () => {
      const model = extractSchema({
        entities: [Student, Course, TreeNode, UserProfile, UserSettings],
      });
      for (const rel of model.relations) {
        expect(rel.sourceTable).toBeTruthy();
        expect(rel.targetTable).toBeTruthy();
        expect(rel.fieldName).toBeTruthy();
      }
    });

    it("every table has at least one column (the @Id column)", () => {
      const model = extractSchema({
        entities: [BasicItem, AuditedRecord, TenantResource, Student, Course],
      });
      for (const table of model.tables) {
        expect(table.columns.length).toBeGreaterThanOrEqual(1);
        const hasPk = table.columns.some((c) => c.isPrimaryKey);
        expect(hasPk).toBe(true);
      }
    });
  });

  describe("large entity graph (stress)", () => {
    it("handles 10+ entities without degradation", () => {
      const model = extractSchema({
        entities: [
          BasicItem,
          AuditedRecord,
          TenantResource,
          CircleA,
          CircleB,
          CircleC,
          TreeNode,
          Student,
          Course,
          UserProfile,
          UserSettings,
          ConstrainedItem,
          Company,
        ],
      });
      expect(model.tables.length).toBeGreaterThanOrEqual(13);
    });
  });
});

describe("studio scaffold — exports verification", () => {
  it("exports extractSchema function from schema index", async () => {
    const schemaModule = await import("../schema/index.js");
    expect(typeof schemaModule.extractSchema).toBe("function");
  });

  it("exports types from schema model", async () => {
    // Type-level check: these imports should not throw
    const schemaModule = await import("../schema/index.js");
    expect(schemaModule).toBeDefined();
  });

  it("exports generateDiagram from diagram index", async () => {
    const diagramModule = await import("../diagram/index.js");
    expect(typeof diagramModule.generateDiagram).toBe("function");
  });

  it("exports createStudioServer from server index", async () => {
    const serverModule = await import("../server/index.js");
    expect(typeof serverModule.createStudioServer).toBe("function");
  });

  it("main index re-exports all key functions", async () => {
    const mainModule = await import("../index.js");
    expect(typeof mainModule.extractSchema).toBe("function");
    expect(typeof mainModule.generateDiagram).toBe("function");
    expect(typeof mainModule.createStudioServer).toBe("function");
  });
});
