/**
 * Adversarial tests for SchemaSetupError information leak fix (#44).
 *
 * Verifies that error messages, toString(), toJSON(), and toSafeString()
 * do NOT leak tenant IDs or schema names to external callers.
 */
import { describe, expect, it } from "vitest";
import { SchemaSetupError } from "../../index.js";

describe("SchemaSetupError — information leak prevention (#44)", () => {
  // ══════════════════════════════════════════════════
  // Section 1: error.message does not leak info
  // ══════════════════════════════════════════════════

  describe("error.message", () => {
    it("does NOT contain tenant ID", () => {
      const err = new SchemaSetupError("tenant_acme", "acme-corp-12345", new Error("boom"));
      expect(err.message).not.toContain("acme-corp-12345");
      expect(err.message).not.toContain("acme");
    });

    it("does NOT contain schema name", () => {
      const err = new SchemaSetupError("secret_schema_42", "tenant-99", new Error("boom"));
      expect(err.message).not.toContain("secret_schema_42");
      expect(err.message).not.toContain("secret");
    });

    it("is a generic message about schema configuration", () => {
      const err = new SchemaSetupError("my_schema", "my_tenant", new Error("pg error"));
      expect(err.message).toMatch(/schema/i);
      expect(err.message.length).toBeGreaterThan(10);
      expect(err.message.length).toBeLessThan(200);
    });

    it("does NOT contain cause message", () => {
      const cause = new Error("FATAL: password authentication failed for user 'admin'");
      const err = new SchemaSetupError("schema", "tenant", cause);
      expect(err.message).not.toContain("password");
      expect(err.message).not.toContain("admin");
      expect(err.message).not.toContain("FATAL");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Internal fields still accessible
  // ══════════════════════════════════════════════════

  describe("internal fields", () => {
    it("error.schema is accessible for internal use", () => {
      const err = new SchemaSetupError("internal_schema", "internal_tenant", new Error());
      expect(err.schema).toBe("internal_schema");
    });

    it("error.tenantId is accessible for internal use", () => {
      const err = new SchemaSetupError("schema", "tenant-xyz", new Error());
      expect(err.tenantId).toBe("tenant-xyz");
    });

    it("error.tenantId can be undefined", () => {
      const err = new SchemaSetupError("schema", undefined, new Error());
      expect(err.tenantId).toBeUndefined();
    });

    it("error.cause preserves the original error", () => {
      const cause = new Error("original pg error");
      const err = new SchemaSetupError("schema", "tenant", cause);
      expect(err.cause).toBe(cause);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: toSafeString()
  // ══════════════════════════════════════════════════

  describe("toSafeString()", () => {
    it("returns generic message", () => {
      const err = new SchemaSetupError("secret_schema", "secret_tenant", new Error());
      const safe = err.toSafeString();
      expect(safe).not.toContain("secret_schema");
      expect(safe).not.toContain("secret_tenant");
      expect(safe.length).toBeGreaterThan(5);
    });

    it("is shorter than or equal to error.message", () => {
      const err = new SchemaSetupError("s", "t", new Error());
      expect(err.toSafeString().length).toBeLessThanOrEqual(err.message.length);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: String coercion and toString
  // ══════════════════════════════════════════════════

  describe("String() / toString()", () => {
    it("String(error) does not leak schema", () => {
      const err = new SchemaSetupError("leaked_schema", "leaked_tenant", new Error());
      const str = String(err);
      expect(str).not.toContain("leaked_schema");
      expect(str).not.toContain("leaked_tenant");
    });

    it("error.toString() does not leak info", () => {
      const err = new SchemaSetupError("foo_schema", "bar_tenant", new Error());
      expect(err.toString()).not.toContain("foo_schema");
      expect(err.toString()).not.toContain("bar_tenant");
    });

    it("template literal does not leak info", () => {
      const err = new SchemaSetupError("x_schema", "y_tenant", new Error());
      const result = `Error occurred: ${err}`;
      expect(result).not.toContain("x_schema");
      expect(result).not.toContain("y_tenant");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: toJSON()
  // ══════════════════════════════════════════════════

  describe("toJSON()", () => {
    it("does not include schema in JSON", () => {
      const err = new SchemaSetupError("json_schema", "json_tenant", new Error());
      const json = err.toJSON();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain("json_schema");
      expect(serialized).not.toContain("json_tenant");
    });

    it("includes name and safe message", () => {
      const err = new SchemaSetupError("s", "t", new Error());
      const json = err.toJSON();
      expect(json).toHaveProperty("name", "SchemaSetupError");
      expect(json).toHaveProperty("message");
      expect(typeof json.message).toBe("string");
    });

    it("JSON.stringify does not leak info", () => {
      const err = new SchemaSetupError("stringify_schema", "stringify_tenant", new Error());
      const serialized = JSON.stringify(err);
      expect(serialized).not.toContain("stringify_schema");
      expect(serialized).not.toContain("stringify_tenant");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Error identity
  // ══════════════════════════════════════════════════

  describe("error identity", () => {
    it("is instanceof Error", () => {
      const err = new SchemaSetupError("s", "t", new Error());
      expect(err).toBeInstanceOf(Error);
    });

    it("has name SchemaSetupError", () => {
      const err = new SchemaSetupError("s", "t", new Error());
      expect(err.name).toBe("SchemaSetupError");
    });

    it("has a stack trace", () => {
      const err = new SchemaSetupError("s", "t", new Error());
      expect(err.stack).toBeDefined();
      expect(err.stack!.length).toBeGreaterThan(0);
    });

    it("stack trace does NOT contain schema or tenant", () => {
      const err = new SchemaSetupError("stack_schema", "stack_tenant", new Error());
      // Stack should not contain our internal values
      // (they come from the message which is now generic)
      expect(err.stack).not.toContain("stack_schema");
      expect(err.stack).not.toContain("stack_tenant");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: Edge cases
  // ══════════════════════════════════════════════════

  describe("edge cases", () => {
    it("empty string schema and tenant", () => {
      const err = new SchemaSetupError("", "", new Error());
      expect(err.schema).toBe("");
      expect(err.tenantId).toBe("");
      expect(err.message).toBeTruthy();
    });

    it("very long schema and tenant names", () => {
      const longStr = "a".repeat(10000);
      const err = new SchemaSetupError(longStr, longStr, new Error());
      expect(err.message).not.toContain(longStr);
      expect(err.message.length).toBeLessThan(500);
    });

    it("special characters in schema/tenant don't appear in message", () => {
      const err = new SchemaSetupError("schema'; DROP TABLE --", "tenant<script>alert(1)</script>", new Error());
      expect(err.message).not.toContain("DROP");
      expect(err.message).not.toContain("script");
      expect(err.message).not.toContain("alert");
    });

    it("null-like cause values", () => {
      const err1 = new SchemaSetupError("s", "t", null);
      expect(err1.cause).toBeNull();

      const err2 = new SchemaSetupError("s", "t", undefined);
      expect(err2.cause).toBeUndefined();

      const err3 = new SchemaSetupError("s", "t", "string cause");
      expect(err3.cause).toBe("string cause");
    });
  });
});
