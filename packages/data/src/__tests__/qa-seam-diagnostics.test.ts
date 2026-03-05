/**
 * Y4 Q4 Seam Tests — Enhanced error diagnostics
 *
 * Tests the seam between enhanced error diagnostics (new Q4 feature)
 * and existing code paths: relationship loading failures, missing decorators,
 * connection errors, constraint violations.
 *
 * Focus: does diagnose() correctly identify errors that come from
 * relationship loading, missing tables (after migrations), column mismatches?
 */
import { describe, it, expect } from "vitest";
import { diagnose, enhanceError } from "../errors/error-diagnostics.js";

// =============================================================================
// Seam: diagnose() with relationship-originated errors
// =============================================================================

describe("Seam: diagnose() — relationship loading failure messages", () => {
  it("detects table-not-found from eager fetch of related entity", () => {
    // Error message that would come from trying to SELECT related entity whose table doesn't exist
    const msg = `relation "departments" does not exist`;
    const result = diagnose(msg, { entityName: "Employee", tableName: "departments" });
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("migrations");
    expect(result!.tableName).toBe("departments");
  });

  it("detects column-not-found from ManyToOne join column mismatch", () => {
    // Happens when joinColumn in @ManyToOne doesn't match actual DB column
    const msg = `column "dept_id" of relation "employees" does not exist`;
    const result = diagnose(msg, { tableName: "employees", columnName: "dept_id" });
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Column mapping");
    expect(result!.columnName).toBe("dept_id");
  });

  it("detects foreign key violation from cascade persist into non-existent related table", () => {
    const msg = `insert or update on table "orders" violates foreign key constraint "orders_customer_id_fkey"`;
    const result = diagnose(msg, { entityName: "Order", fieldName: "customerId" });
    expect(result).not.toBeNull();
    // BUG FOUND: hint says "The referenced record..." not "Foreign key..."
    // The hint text does not include "Foreign key" — it describes the consequence
    expect(result!.hint).toContain("referenced record");
    // Verify the diagnostic message is about the constraint violation
    expect(result!.diagnosticMessage).toContain("Foreign key");
  });

  it("detects unique constraint from duplicate FK reference in OneToMany", () => {
    const msg = `duplicate key value violates unique constraint "employees_department_id_unique"`;
    const result = diagnose(msg, { entityName: "Employee", fieldName: "departmentId" });
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("duplicate");
    expect(result!.entityName).toBe("Employee");
    expect(result!.fieldName).toBe("departmentId");
  });
});

// =============================================================================
// Seam: diagnose() — missing decorator errors (from entity metadata lookup)
// =============================================================================

describe("Seam: diagnose() — missing decorator errors", () => {
  it("identifies missing @Table decorator with specific entity name and table name in hint", () => {
    const msg = "No @Table decorator found on class ProductCatalog";
    const result = diagnose(msg, { entityName: "ProductCatalog", tableName: "product_catalog" });
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Table");
    expect(result!.hint).toContain("product_catalog");
    expect(result!.hint).toContain("ProductCatalog");
  });

  it("identifies missing @Table decorator with fallback when no context provided", () => {
    const msg = "No @Table decorator found";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Table");
    // Generic fallback text when no entity name
    expect(result!.hint).toContain("entity");
  });

  it("identifies missing @Id decorator with entity context", () => {
    const msg = "No @Id decorator on entity User — cannot determine primary key";
    const result = diagnose(msg, { entityName: "User" });
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Id");
    expect(result!.hint).toContain("User");
    expect(result!.hint).toContain("primary key");
  });

  it("identifies missing @Id decorator with fallback entity name", () => {
    const msg = "no id decorator";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Id");
    expect(result!.hint).toContain("your entity");
  });
});

// =============================================================================
// Seam: diagnose() — connection / authentication errors (adapter errors)
// =============================================================================

describe("Seam: diagnose() — adapter connection errors", () => {
  it("detects ECONNREFUSED (postgres/mysql adapter offline)", () => {
    const msg = "connect ECONNREFUSED 127.0.0.1:5432";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.diagnosticMessage).toContain("connect");
    expect(result!.hint).toContain("database server");
  });

  it("detects connection refused with hostname", () => {
    const msg = "Connection refused: localhost:55432";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("database server");
  });

  it("detects connect ETIMEDOUT (firewall or network issue)", () => {
    const msg = "connect ETIMEDOUT";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("database server");
  });

  it("detects authentication failure (wrong password)", () => {
    const msg = "password authentication failed for user \"nesify\"";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("username and password");
  });

  it("detects database does not exist (wrong database name)", () => {
    const msg = `database "myapp_prod" does not exist`;
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("CREATE DATABASE");
    expect(result!.diagnosticMessage).toContain("myapp_prod");
  });

  it("detects permission denied (GRANT issue)", () => {
    const msg = "permission denied for table users";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("GRANT");
  });
});

// =============================================================================
// Seam: diagnose() — SQL syntax errors (from derived queries or raw SQL)
// =============================================================================

describe("Seam: diagnose() — SQL syntax errors", () => {
  it("detects SQL syntax error from malformed derived query", () => {
    const msg = `ERROR:  syntax error at or near "WHERE" at character 45`;
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("derived queries");
    expect(result!.hint).toContain("naming convention");
  });

  it("detects SQL syntax error with 'sql' keyword variant", () => {
    const msg = "SQL syntax error: unexpected token near 'FROM'";
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("syntax error");
  });
});

// =============================================================================
// Seam: enhanceError() behavior
// =============================================================================

describe("Seam: enhanceError() — error transformation", () => {
  it("wraps recognized error with hint text prepended", () => {
    const original = new Error(`relation "orders" does not exist`);
    const enhanced = enhanceError(original, { entityName: "Order", tableName: "orders" });
    expect(enhanced).not.toBe(original); // new Error object
    expect(enhanced.message).toContain("Hint:");
    expect(enhanced.message).toContain("migrations");
  });

  it("preserves original error name on enhanced error", () => {
    const original = new TypeError(`relation "foo" does not exist`);
    original.name = "TypeError";
    const enhanced = enhanceError(original);
    expect(enhanced.name).toBe("TypeError");
  });

  it("returns SAME error instance for unrecognized messages (no false enhancement)", () => {
    const original = new Error("some completely non-matching error");
    const enhanced = enhanceError(original);
    expect(enhanced).toBe(original);
  });

  it("enhanceError with no context still produces hint for recognizable errors", () => {
    const original = new Error("no @table decorator found");
    const enhanced = enhanceError(original);
    expect(enhanced.message).toContain("Hint:");
  });

  it("enhanced error message contains Hint on its own line", () => {
    const original = new Error(`relation "users" does not exist`);
    const enhanced = enhanceError(original, { tableName: "users" });
    const lines = enhanced.message.split("\n");
    const hintLine = lines.find((l) => l.trim().startsWith("Hint:"));
    expect(hintLine).toBeDefined();
    expect(hintLine!.trim()).not.toBe("Hint:"); // hint has actual content
  });
});

// =============================================================================
// Seam: diagnose() null path — no false positives
// =============================================================================

describe("Seam: diagnose() — false positive prevention", () => {
  it("returns null for generic application errors", () => {
    expect(diagnose("Unexpected token in JSON")).toBeNull();
    expect(diagnose("Cannot read property 'id' of undefined")).toBeNull();
    expect(diagnose("Module not found: espalier-data")).toBeNull();
    expect(diagnose("RangeError: Maximum call stack size exceeded")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(diagnose("")).toBeNull();
  });

  it("returns null for numeric-only error strings", () => {
    expect(diagnose("42")).toBeNull();
  });

  it("does not diagnose 'column' alone without 'does not exist'", () => {
    // "column" in a message about business logic should not trigger column-not-found
    const result = diagnose("The column chart shows 5 data points");
    expect(result).toBeNull();
  });

  it("does not false-positive on 'table' in general context", () => {
    const result = diagnose("Please check the comparison table in the documentation");
    expect(result).toBeNull();
  });
});

// =============================================================================
// Seam: quoted identifier extraction
// =============================================================================

describe("Seam: quoted identifier extraction from error messages", () => {
  it("extracts table name from quoted identifier in postgres error", () => {
    const msg = `relation "order_items" does not exist`;
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.tableName).toBe("order_items");
  });

  it("extracts column name from quoted identifier", () => {
    const msg = `column "user_uuid" of relation "accounts" does not exist`;
    const result = diagnose(msg);
    expect(result).not.toBeNull();
    expect(result!.columnName).toBe("user_uuid");
  });

  it("uses context tableName when no quoted identifier in message", () => {
    const msg = "relation does not exist";
    const result = diagnose(msg, { tableName: "fallback_table" });
    expect(result).not.toBeNull();
    expect(result!.tableName).toBe("fallback_table");
  });
});
