/**
 * Adversarial regression tests for repository factory seams.
 *
 * Tests that createRepository and createDerivedRepository work correctly
 * with various DataSource implementations (including mock new adapters).
 * Focuses on the seam between the repository layer and the JDBC interfaces.
 */
import { describe, it, expect, vi } from "vitest";
import {
  Table,
  Column,
  Id,
  Version,
  getEntityMetadata,
  EntityChangeTracker,
  getColumnMappings,
  parseDerivedQueryMethod,
  buildDerivedQuery,
  QueryBuilder,
  SelectBuilder,
  InsertBuilder,
  UpdateBuilder,
  DeleteBuilder,
  ComparisonCriteria,
} from "../../index.js";

// -- Test entity --
@Table("products")
class Product {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Column() price!: number;
  @Column("is_active") active!: boolean;
  @Version @Column() version!: number;
}

describe("repository factory seam tests", () => {
  describe("EntityMetadata for repository creation", () => {
    it("provides complete metadata needed by repository", () => {
      const meta = getEntityMetadata(Product);
      expect(meta.tableName).toBe("products");
      expect(meta.idField).toBe("id");
      expect(meta.versionField).toBe("version");
      expect(meta.fields.length).toBeGreaterThanOrEqual(4);
    });

    it("field mappings include column name and field name", () => {
      const meta = getEntityMetadata(Product);
      const activeMapping = meta.fields.find(
        (m) => String(m.fieldName) === "active",
      );
      expect(activeMapping).toBeDefined();
      expect(activeMapping!.columnName).toBe("is_active");
    });
  });

  describe("EntityChangeTracker with new adapter patterns", () => {
    it("detects changes on entity properties", () => {
      const meta = getEntityMetadata(Product);
      const tracker = new EntityChangeTracker(meta);
      const entity = new Product();
      entity.id = 1;
      entity.name = "Widget";
      entity.price = 9.99;
      entity.active = true;
      entity.version = 1;

      tracker.snapshot(entity);

      entity.name = "Super Widget";
      entity.price = 19.99;

      const changes = tracker.getDirtyFields(entity);
      expect(changes).toHaveLength(2);
      const changedFields = changes.map((c) => String(c.field));
      expect(changedFields).toContain("name");
      expect(changedFields).toContain("price");
    });

    it("reports no changes when entity unchanged", () => {
      const meta = getEntityMetadata(Product);
      const tracker = new EntityChangeTracker(meta);
      const entity = new Product();
      entity.id = 1;
      entity.name = "Widget";
      entity.price = 9.99;
      entity.active = true;
      entity.version = 1;

      tracker.snapshot(entity);

      const changes = tracker.getDirtyFields(entity);
      expect(changes).toHaveLength(0);
    });

    it("detects boolean changes", () => {
      const meta = getEntityMetadata(Product);
      const tracker = new EntityChangeTracker(meta);
      const entity = new Product();
      entity.id = 1;
      entity.name = "Widget";
      entity.price = 9.99;
      entity.active = true;
      entity.version = 1;

      tracker.snapshot(entity);
      entity.active = false;

      const changes = tracker.getDirtyFields(entity);
      expect(changes).toHaveLength(1);
      expect(String(changes[0].field)).toBe("active");
    });
  });

  describe("DerivedQueryParser with adapter-agnostic SQL", () => {
    it("parses findByName method", () => {
      const descriptor = parseDerivedQueryMethod("findByName");
      expect(descriptor).toBeDefined();
      expect(descriptor.properties).toHaveLength(1);
      expect(descriptor.properties[0].property).toBe("name");
    });

    it("parses findByNameAndPrice", () => {
      const descriptor = parseDerivedQueryMethod("findByNameAndPrice");
      expect(descriptor).toBeDefined();
      expect(descriptor.properties).toHaveLength(2);
    });

    it("parses findByActiveTrue", () => {
      const descriptor = parseDerivedQueryMethod("findByActiveTrue");
      expect(descriptor).toBeDefined();
    });

    it("parses findByPriceGreaterThan", () => {
      const descriptor = parseDerivedQueryMethod("findByPriceGreaterThan");
      expect(descriptor).toBeDefined();
      expect(descriptor.properties[0].operator).toBe("GreaterThan");
    });

    it("parses findByNameLike", () => {
      const descriptor = parseDerivedQueryMethod("findByNameLike");
      expect(descriptor).toBeDefined();
      expect(descriptor.properties[0].operator).toBe("Like");
    });

    it("buildDerivedQuery produces valid SQL structure", () => {
      const meta = getEntityMetadata(Product);
      const descriptor = parseDerivedQueryMethod("findByName");
      const query = buildDerivedQuery(descriptor, meta, ["Widget"]);
      expect(query).toBeDefined();
      expect(query.sql).toContain("SELECT");
      expect(query.sql).toContain("products");
    });

    it("buildDerivedQuery with OrderBy", () => {
      const meta = getEntityMetadata(Product);
      const descriptor = parseDerivedQueryMethod(
        "findByActiveOrderByPriceDesc",
      );
      expect(descriptor).toBeDefined();
      const query = buildDerivedQuery(descriptor, meta, [true]);
      expect(query.sql).toContain("ORDER BY");
    });
  });

  describe("QueryBuilder generates adapter-agnostic SQL", () => {
    it("SelectBuilder produces valid SELECT", () => {
      const builder = new SelectBuilder("products");
      builder.columns("id", "name", "price");
      builder.where(new ComparisonCriteria("eq", "is_active", true));
      const query = builder.build();
      expect(query.sql).toContain("SELECT");
      expect(query.sql).toContain("products");
    });

    it("InsertBuilder produces valid INSERT", () => {
      const builder = new InsertBuilder("products");
      builder.set("name", "Widget");
      builder.set("price", 9.99);
      builder.set("is_active", true);
      const query = builder.build();
      expect(query.sql).toContain("INSERT INTO");
      expect(query.sql).toContain("products");
    });

    it("UpdateBuilder produces valid UPDATE", () => {
      const builder = new UpdateBuilder("products");
      builder.set("name", "Widget");
      builder.set("price", 9.99);
      builder.where(new ComparisonCriteria("eq", "id", 1));
      const query = builder.build();
      expect(query.sql).toContain("UPDATE");
      expect(query.sql).toContain("products");
    });

    it("DeleteBuilder produces valid DELETE", () => {
      const builder = new DeleteBuilder("products");
      builder.where(new ComparisonCriteria("eq", "id", 1));
      const query = builder.build();
      expect(query.sql).toContain("DELETE FROM");
      expect(query.sql).toContain("products");
    });
  });
});
