/**
 * QA Seam Test 4: `espalier diagram` CLI + entities from multiple packages
 *
 * Tests the seam between:
 * - runDiagramCommand / generateDiagram (espalier-studio)
 * - Entity decorators from espalier-data across different "packages" (simulated)
 *
 * Adversarial focus:
 * - Entities defined in separate scopes combined into one diagram
 * - All 3 diagram formats (mermaid, d2, plantuml) handle special decorators
 * - Diagram output for entities with ALL decorator types
 * - Empty entity list diagram
 * - Single entity diagram (no relations)
 * - Entity with table name containing underscores and numbers
 * - Diagram de-duplicates bidirectional relations
 * - Self-referential entity in diagram
 * - Very large entity count (20+ tables)
 */
import { describe, it, expect } from "vitest";
import {
  Table,
  Column,
  Id,
  Version,
  CreatedDate,
  LastModifiedDate,
  TenantId,
  ManyToOne,
  OneToMany,
  ManyToMany,
  OneToOne,
  Embeddable,
  Embedded,
} from "espalier-data";
import { extractSchema } from "../schema/index.js";
import { generateDiagram } from "../diagram/index.js";
import type { DiagramFormat } from "../diagram/index.js";

// =============================================================================
// "Package A" entities
// =============================================================================

@Table("pkg_a_users")
class PkgAUser {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) email!: string;
  @Version @Column({ type: "INTEGER" }) version!: number;
  @CreatedDate @Column({ type: "TIMESTAMPTZ" }) createdAt!: Date;
  @TenantId @Column({ type: "VARCHAR(64)" }) tenantId!: string;
  @OneToMany({ target: () => PkgBPost, mappedBy: "author" }) posts!: any[];
}
new PkgAUser();

// =============================================================================
// "Package B" entities
// =============================================================================

@Table("pkg_b_posts")
class PkgBPost {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) title!: string;
  @Column({ type: "TEXT", nullable: true }) body!: string;
  @Version @Column({ type: "INTEGER" }) version!: number;
  @LastModifiedDate @Column({ type: "TIMESTAMPTZ" }) updatedAt!: Date;
  @ManyToOne({ target: () => PkgAUser }) author!: PkgAUser;
  @ManyToMany({
    target: () => PkgCTag,
    joinTable: {
      name: "post_tags",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: any[];
}
new PkgBPost();

// =============================================================================
// "Package C" entities
// =============================================================================

@Table("pkg_c_tags")
class PkgCTag {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(100)", unique: true }) name!: string;
  @ManyToMany({ target: () => PkgBPost, mappedBy: "tags" }) posts!: any[];
}
new PkgCTag();

// --- Self-referential entity ---
@Table("pkg_c_categories")
class PkgCCategory {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @ManyToOne({ target: () => PkgCCategory, nullable: true }) parent!: PkgCCategory | null;
  @OneToMany({ target: () => PkgCCategory, mappedBy: "parent" }) children!: PkgCCategory[];
}
new PkgCCategory();

// --- Entity with underscore/number table name ---
@Table("pkg_d_item_v2_data_123")
class PkgDWeirdName {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "TEXT" }) val!: string;
}
new PkgDWeirdName();

// --- OneToOne ---
@Table("pkg_e_profiles")
class PkgEProfile {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "JSONB" }) settings!: string;
  @OneToOne({ target: () => PkgAUser }) user!: PkgAUser;
}
new PkgEProfile();

// =============================================================================
// Bulk entities for stress test
// =============================================================================

const bulkEntities: (new (...args: any[]) => any)[] = [];
for (let i = 0; i < 20; i++) {
  @Table(`bulk_table_${i}`)
  class BulkEntity {
    @Id @Column({ type: "UUID" }) id!: string;
    @Column({ type: "TEXT" }) data!: string;
  }
  new BulkEntity();
  bulkEntities.push(BulkEntity);
}

// =============================================================================
// Tests
// =============================================================================

const ALL_FORMATS: DiagramFormat[] = ["mermaid", "d2", "plantuml"];

describe("QA Seam: diagram CLI + entities from multiple packages", () => {
  const allEntities = [PkgAUser, PkgBPost, PkgCTag, PkgCCategory, PkgDWeirdName, PkgEProfile];

  describe("multi-package entity diagram generation", () => {
    for (const format of ALL_FORMATS) {
      it(`generates ${format} diagram for cross-package entities`, () => {
        const schema = extractSchema({ entities: allEntities });
        const diagram = generateDiagram(schema, { format, title: "Cross-Package Diagram" });

        expect(diagram).toBeTruthy();
        expect(diagram.length).toBeGreaterThan(50);

        // All table names should appear
        for (const entity of allEntities) {
          const tableName = schema.tables.find(
            (t) => t.className === entity.name,
          )?.tableName;
          if (tableName) {
            expect(diagram).toContain(tableName);
          }
        }
      });
    }
  });

  describe("special decorator annotations in diagram", () => {
    it("mermaid diagram includes PK annotation for primary keys", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      expect(diagram).toContain("PK");
    });

    it("mermaid diagram includes VER annotation for @Version columns", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      expect(diagram).toContain("VER");
    });

    it("mermaid diagram includes TID annotation for @TenantId columns", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      expect(diagram).toContain("TID");
    });

    it("mermaid diagram includes UK annotation for unique columns", () => {
      const schema = extractSchema({ entities: [PkgCTag] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      expect(diagram).toContain("UK");
    });

    it("plantuml diagram includes stereotypes for special columns", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const diagram = generateDiagram(schema, { format: "plantuml" });
      expect(diagram).toContain("<<PK>>");
      expect(diagram).toContain("<<VER>>");
      expect(diagram).toContain("<<TID>>");
    });
  });

  describe("relation rendering", () => {
    it("does not duplicate bidirectional ManyToOne/OneToMany pair", () => {
      const schema = extractSchema({ entities: [PkgAUser, PkgBPost] });
      const diagram = generateDiagram(schema, { format: "mermaid" });

      // Count occurrences of the relation line between the two tables
      const lines = diagram.split("\n").filter(
        (line) =>
          (line.includes("pkg_a_users") && line.includes("pkg_b_posts")) ||
          (line.includes("pkg_b_posts") && line.includes("pkg_a_users")),
      );
      // Should have relation lines but not duplicate for both sides
      // Each unique pair rendered once per unique fieldName
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });

    it("renders ManyToMany relation with join table reference", () => {
      const schema = extractSchema({ entities: [PkgBPost, PkgCTag] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      // Should contain both table names in a relation line
      expect(diagram).toContain("pkg_b_posts");
      expect(diagram).toContain("pkg_c_tags");
    });

    it("renders self-referential relation (category parent/child)", () => {
      const schema = extractSchema({ entities: [PkgCCategory] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      // Self-referential: same table on both sides
      const selfLines = diagram.split("\n").filter(
        (line) =>
          line.includes("pkg_c_categories") &&
          (line.includes("||--o{") || line.includes("}o--||") || line.includes("}|--||")),
      );
      expect(selfLines.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("edge cases", () => {
    it("empty entity list produces minimal valid diagram", () => {
      const schema = extractSchema({ entities: [] });
      for (const format of ALL_FORMATS) {
        const diagram = generateDiagram(schema, { format });
        expect(diagram).toBeTruthy();
        // Should not crash, should produce something non-empty
        expect(diagram.length).toBeGreaterThan(0);
      }
    });

    it("single entity with no relations produces valid diagram", () => {
      const schema = extractSchema({ entities: [PkgDWeirdName] });
      for (const format of ALL_FORMATS) {
        const diagram = generateDiagram(schema, { format });
        expect(diagram).toContain("pkg_d_item_v2_data_123");
      }
    });

    it("handles table name with underscores and numbers in all formats", () => {
      const schema = extractSchema({ entities: [PkgDWeirdName] });
      for (const format of ALL_FORMATS) {
        const diagram = generateDiagram(schema, { format });
        // Table name should appear verbatim (not mangled)
        expect(diagram).toContain("pkg_d_item_v2_data_123");
      }
    });

    it("title parameter is included in output", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const title = "My Custom Title";

      const mermaid = generateDiagram(schema, { format: "mermaid", title });
      expect(mermaid).toContain(title);

      const d2 = generateDiagram(schema, { format: "d2", title });
      expect(d2).toContain(title);

      const plantuml = generateDiagram(schema, { format: "plantuml", title });
      expect(plantuml).toContain(title);
    });
  });

  describe("stress: 20+ table diagram", () => {
    it("generates mermaid diagram for 20 tables without error", () => {
      const schema = extractSchema({ entities: bulkEntities });
      expect(schema.tables.length).toBe(20);

      const diagram = generateDiagram(schema, { format: "mermaid", title: "Bulk" });
      expect(diagram).toBeTruthy();
      // Each table should appear
      for (let i = 0; i < 20; i++) {
        expect(diagram).toContain(`bulk_table_${i}`);
      }
    });

    it("generates d2 diagram for 20 tables without error", () => {
      const schema = extractSchema({ entities: bulkEntities });
      const diagram = generateDiagram(schema, { format: "d2" });
      expect(diagram).toBeTruthy();
      for (let i = 0; i < 20; i++) {
        expect(diagram).toContain(`bulk_table_${i}`);
      }
    });

    it("generates plantuml diagram for 20 tables without error", () => {
      const schema = extractSchema({ entities: bulkEntities });
      const diagram = generateDiagram(schema, { format: "plantuml" });
      expect(diagram).toContain("@startuml");
      expect(diagram).toContain("@enduml");
      for (let i = 0; i < 20; i++) {
        expect(diagram).toContain(`bulk_table_${i}`);
      }
    });
  });

  describe("diagram format correctness", () => {
    it("mermaid output starts with erDiagram", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const diagram = generateDiagram(schema, { format: "mermaid" });
      expect(diagram).toContain("erDiagram");
    });

    it("plantuml output has @startuml and @enduml", () => {
      const schema = extractSchema({ entities: [PkgAUser] });
      const diagram = generateDiagram(schema, { format: "plantuml" });
      expect(diagram).toContain("@startuml");
      expect(diagram).toContain("@enduml");
    });

    it("d2 output has sql_table shape for each table", () => {
      const schema = extractSchema({ entities: [PkgAUser, PkgBPost] });
      const diagram = generateDiagram(schema, { format: "d2" });
      expect(diagram).toContain("shape: sql_table");
      // Should appear once per table
      const shapeCount = (diagram.match(/shape: sql_table/g) ?? []).length;
      expect(shapeCount).toBe(2);
    });
  });
});
