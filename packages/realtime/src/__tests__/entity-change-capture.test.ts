// Minimal @Table decorator simulation using the same WeakMap approach as espalier-data
// We import from espalier-data to ensure the real decorator works.
import { Table } from "espalier-data";
import { describe, expect, it } from "vitest";
import { EntityChangeCapture } from "../notifications/entity-change-capture.js";

@Table("users")
class User {
  id!: number;
  name!: string;
}

@Table("order_items")
class OrderItem {
  id!: number;
  orderId!: number;
}

class NoTableEntity {
  id!: number;
}

describe("EntityChangeCapture", () => {
  const capture = new EntityChangeCapture();

  it("should generate trigger DDL for a simple entity", () => {
    const ddl = capture.generateTriggerDdl(User, "user_changes");

    expect(ddl).toContain('CREATE OR REPLACE FUNCTION "espalier_notify_users_user_changes"()');
    expect(ddl).toContain("RETURNS trigger");
    expect(ddl).toContain("pg_notify('user_changes'");
    expect(ddl).toContain('CREATE OR REPLACE TRIGGER "espalier_trigger_users_user_changes"');
    expect(ddl).toContain('AFTER INSERT OR UPDATE OR DELETE ON "users"');
    expect(ddl).toContain("FOR EACH ROW");
    expect(ddl).toContain("row_to_json(OLD)");
    expect(ddl).toContain("row_to_json(NEW)");
  });

  it("should generate trigger DDL for an entity with underscores in table name", () => {
    const ddl = capture.generateTriggerDdl(OrderItem, "order_item_changes");

    expect(ddl).toContain('"order_items"');
    expect(ddl).toContain("pg_notify('order_item_changes'");
  });

  it("should throw for entity without @Table decorator", () => {
    expect(() => capture.generateTriggerDdl(NoTableEntity, "test_channel")).toThrow(/does not have a @Table decorator/);
  });

  it("should throw for invalid channel names", () => {
    expect(() => capture.generateTriggerDdl(User, "bad channel")).toThrow(/Invalid channel name/);
    expect(() => capture.generateTriggerDdl(User, "'; DROP TABLE users; --")).toThrow(/Invalid channel name/);
    expect(() => capture.generateTriggerDdl(User, "123starts_with_number")).toThrow(/Invalid channel name/);
  });

  it("should produce valid SQL with no injection vectors", () => {
    const ddl = capture.generateTriggerDdl(User, "user_changes");

    // Ensure the DDL uses quoted identifiers
    expect(ddl).toContain('"espalier_notify_users_user_changes"');
    expect(ddl).toContain('"espalier_trigger_users_user_changes"');
    expect(ddl).toContain('"users"');
  });
});

describe("generateRealtimeDdl", () => {
  it("should generate DDL for multiple entity classes", async () => {
    const { generateRealtimeDdl } = await import("../ddl.js");

    const ddl = generateRealtimeDdl([User, OrderItem]);

    expect(ddl).toContain('"users"');
    expect(ddl).toContain('"order_items"');
    expect(ddl).toContain("pg_notify('users_changes'");
    expect(ddl).toContain("pg_notify('order_items_changes'");
  });

  it("should throw for entity without @Table", async () => {
    const { generateRealtimeDdl } = await import("../ddl.js");

    expect(() => generateRealtimeDdl([NoTableEntity])).toThrow(/does not have a @Table decorator/);
  });
});
