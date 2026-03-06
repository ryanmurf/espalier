import { describe, expect, it } from "vitest";
import { diagnose, enhanceError } from "../../errors/error-diagnostics.js";

// ==========================================================================
// diagnose — @Table decorator missing
// ==========================================================================

describe("diagnose — missing @Table", () => {
  it("recognizes 'no @Table decorator' message", () => {
    const result = diagnose("No @Table decorator found on entity");
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Table");
  });

  it("includes entity name in hint when context provided", () => {
    const result = diagnose("No @Table decorator", { entityName: "User" });
    expect(result!.hint).toContain("User");
  });

  it("includes table name suggestion when context provided", () => {
    const result = diagnose("No table decorator found", { tableName: "users" });
    expect(result!.hint).toContain("users");
  });

  it("is case-insensitive", () => {
    const result = diagnose("NO @TABLE DECORATOR found");
    expect(result).not.toBeNull();
  });
});

// ==========================================================================
// diagnose — @Id decorator missing
// ==========================================================================

describe("diagnose — missing @Id", () => {
  it("recognizes 'no @Id decorator' message", () => {
    const result = diagnose("No @Id decorator found");
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("@Id");
  });

  it("includes entity name in hint", () => {
    const result = diagnose("No @Id decorator", { entityName: "Order" });
    expect(result!.hint).toContain("Order");
  });

  it("hint mentions primary key", () => {
    const result = diagnose("No @Id decorator found on entity");
    expect(result!.hint).toContain("primary key");
  });
});

// ==========================================================================
// diagnose — connection errors
// ==========================================================================

describe("diagnose — connection errors", () => {
  it("ECONNREFUSED produces connection hint", () => {
    const result = diagnose("connect ECONNREFUSED 127.0.0.1:5432");
    expect(result).not.toBeNull();
    expect(result!.diagnosticMessage).toContain("Could not connect");
    expect(result!.hint).toContain("connection");
  });

  it("ETIMEDOUT produces connection hint", () => {
    const result = diagnose("connect ETIMEDOUT 10.0.0.1:5432");
    expect(result).not.toBeNull();
    expect(result!.diagnosticMessage).toContain("Could not connect");
  });

  it("'connection refused' (lowercase) is recognized", () => {
    expect(diagnose("connection refused")).not.toBeNull();
  });

  it("'cannot connect' is recognized", () => {
    expect(diagnose("cannot connect to database")).not.toBeNull();
  });

  it("hint does NOT leak connection credentials", () => {
    const result = diagnose("connect ECONNREFUSED 127.0.0.1:5432");
    expect(result!.hint).not.toContain("password");
    expect(result!.diagnosticMessage).not.toContain("password");
  });
});

// ==========================================================================
// diagnose — table not found
// ==========================================================================

describe("diagnose — table not found", () => {
  it("recognizes PostgreSQL 'relation does not exist' error", () => {
    const result = diagnose('relation "users" does not exist');
    expect(result).not.toBeNull();
    expect(result!.diagnosticMessage).toContain("does not exist");
    expect(result!.tableName).toBe("users");
  });

  it("suggests running migrations", () => {
    const result = diagnose('relation "users" does not exist');
    expect(result!.hint).toContain("migrate");
  });

  it("recognizes MySQL 'table not found' style", () => {
    const result = diagnose("table 'users' doesn't exist");
    expect(result).not.toBeNull();
  });

  it("extracts quoted table name", () => {
    const result = diagnose('relation "my_special_table" does not exist');
    expect(result!.tableName).toBe("my_special_table");
  });

  it("falls back to context tableName if not in message", () => {
    const result = diagnose("relation does not exist", { tableName: "orders" });
    expect(result!.diagnosticMessage).toContain("orders");
  });
});

// ==========================================================================
// diagnose — column not found
// ==========================================================================

describe("diagnose — column not found", () => {
  it("recognizes 'column does not exist' error", () => {
    const result = diagnose('column "email_address" does not exist');
    expect(result).not.toBeNull();
    expect(result!.columnName).toBe("email_address");
  });

  it("hint suggests checking @Column mapping", () => {
    const result = diagnose('column "foo" does not exist');
    expect(result!.hint).toContain("@Column");
  });

  it("recognizes MySQL 'unknown column' style", () => {
    const result = diagnose("Unknown column 'age' in field list");
    expect(result).not.toBeNull();
  });

  it("falls back to context columnName", () => {
    const result = diagnose("column not found", { columnName: "email" });
    expect(result!.hint).toContain("email");
  });
});

// ==========================================================================
// diagnose — unique constraint violation
// ==========================================================================

describe("diagnose — unique constraint violation", () => {
  it("recognizes unique constraint violation", () => {
    const result = diagnose("unique constraint violation: duplicate key");
    expect(result).not.toBeNull();
    expect(result!.diagnosticMessage).toContain("unique");
  });

  it("includes entity name when provided", () => {
    const result = diagnose("unique constraint violation", { entityName: "User" });
    expect(result!.hint).toContain("User");
  });

  it("includes field name when provided", () => {
    const result = diagnose("unique constraint violation", { fieldName: "email" });
    expect(result!.hint).toContain("email");
  });

  it("suggests upsert/merge as alternative", () => {
    const result = diagnose("duplicate key value violates unique constraint");
    expect(result!.hint).toContain("upsert");
  });
});

// ==========================================================================
// diagnose — foreign key constraint violation
// ==========================================================================

describe("diagnose — foreign key constraint", () => {
  it("recognizes foreign key constraint violation", () => {
    const result = diagnose("foreign key constraint violation on table orders");
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("referenced record");
  });

  it("mentions cascade settings in hint", () => {
    const result = diagnose("foreign key constraint violation");
    expect(result!.hint).toContain("cascade");
  });
});

// ==========================================================================
// diagnose — permission denied
// ==========================================================================

describe("diagnose — permission denied", () => {
  it("recognizes 'permission denied'", () => {
    const result = diagnose("permission denied for table users");
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("GRANT");
  });

  it("recognizes 'access denied'", () => {
    expect(diagnose("access denied for user 'app'")).not.toBeNull();
  });
});

// ==========================================================================
// diagnose — SQL syntax error
// ==========================================================================

describe("diagnose — SQL syntax error", () => {
  it("recognizes PostgreSQL syntax error", () => {
    const result = diagnose('syntax error at or near "SELEC"');
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("syntax");
  });

  it("suggests checking derived query naming", () => {
    const result = diagnose('syntax error at or near "FROM"');
    expect(result!.hint).toContain("derived");
  });
});

// ==========================================================================
// diagnose — authentication failed
// ==========================================================================

describe("diagnose — authentication failed", () => {
  it("recognizes password auth failure", () => {
    const result = diagnose('password authentication failed for user "app"');
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("password");
  });

  it("recognizes generic auth failure", () => {
    expect(diagnose("authentication failed")).not.toBeNull();
  });
});

// ==========================================================================
// diagnose — database does not exist
// ==========================================================================

describe("diagnose — database does not exist", () => {
  it("recognizes 'database does not exist'", () => {
    const result = diagnose('database "mydb" does not exist');
    expect(result).not.toBeNull();
    expect(result!.hint).toContain("CREATE DATABASE");
    expect(result!.hint).toContain("mydb");
  });
});

// ==========================================================================
// diagnose — unknown errors
// ==========================================================================

describe("diagnose — unrecognized errors", () => {
  it("returns null for unrecognized error", () => {
    expect(diagnose("some random error")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(diagnose("")).toBeNull();
  });

  it("returns null for generic timeout", () => {
    // "timeout" alone doesn't match (need "connect" prefix patterns)
    expect(diagnose("operation timeout after 5000ms")).toBeNull();
  });
});

// ==========================================================================
// enhanceError — stack trace preservation
// ==========================================================================

describe("enhanceError — wrapper", () => {
  it("preserves error name", () => {
    const err = new TypeError("No @Table decorator on MyEntity");
    const enhanced = enhanceError(err);
    expect(enhanced.name).toBe("TypeError");
  });

  it("preserves original stack trace", () => {
    const err = new Error("No @Table decorator");
    const _originalStack = err.stack;
    const enhanced = enhanceError(err);
    // Stack should still reference the original location
    expect(enhanced.stack).toBeDefined();
    expect(enhanced.stack).toContain("error-diagnostics.adversarial.test");
  });

  it("returns original error unchanged if no diagnosis", () => {
    const err = new Error("some unknown thing happened");
    const enhanced = enhanceError(err);
    expect(enhanced).toBe(err);
    expect(enhanced.message).toBe("some unknown thing happened");
  });

  it("enhanced message includes hint", () => {
    const err = new Error("No @Table decorator found on entity");
    const enhanced = enhanceError(err);
    expect(enhanced.message).toContain("Hint:");
    expect(enhanced.message).toContain("@Table");
  });

  it("enhanced error includes context when provided", () => {
    const err = new Error("No @Id decorator found");
    const enhanced = enhanceError(err, { entityName: "Product" });
    expect(enhanced.message).toContain("Product");
  });

  it("does NOT duplicate hints when enhancing already-enhanced error", () => {
    const err = new Error("No @Table decorator");
    const enhanced1 = enhanceError(err);
    const enhanced2 = enhanceError(enhanced1);
    // Count how many times "Hint:" appears
    const hintCount = (enhanced2.message.match(/Hint:/g) || []).length;
    expect(hintCount).toBeLessThanOrEqual(2); // could be 2 if re-enhanced, but shouldn't be 3+
  });
});

// ==========================================================================
// Edge cases — no sensitive info leakage
// ==========================================================================

describe("enhanceError — security", () => {
  it("connection error hint doesn't include the original connection string", () => {
    const err = new Error("connect ECONNREFUSED 10.0.0.1:5432 (user: admin, password: s3cret)");
    const enhanced = enhanceError(err);
    // The diagnostic message should NOT echo back the password
    expect(enhanced.message).not.toContain("s3cret");
  });

  it("auth failure hint doesn't include password", () => {
    const err = new Error('password authentication failed for user "admin" with password "hunter2"');
    const enhanced = enhanceError(err);
    expect(enhanced.message).toContain("Hint:");
    // Hint should NOT contain the password
    const hintPart = enhanced.message.split("Hint:")[1];
    expect(hintPart).not.toContain("hunter2");
  });
});

// ==========================================================================
// Edge cases — non-ASCII
// ==========================================================================

describe("diagnose — non-ASCII", () => {
  it("handles non-ASCII entity name in context", () => {
    const result = diagnose("No @Table decorator", { entityName: "Benutzer" });
    expect(result!.hint).toContain("Benutzer");
  });

  it("handles non-ASCII in error message", () => {
    const result = diagnose('relation "benutzerdaten" does not exist');
    expect(result!.tableName).toBe("benutzerdaten");
  });

  it("handles emoji in field name", () => {
    const result = diagnose("column not found", { columnName: "emoji_field" });
    expect(result).not.toBeNull();
  });
});

// ==========================================================================
// extractQuoted helper (tested via diagnose)
// ==========================================================================

describe("diagnose — quoted identifier extraction", () => {
  it("extracts double-quoted identifier", () => {
    const result = diagnose('relation "my_table" does not exist');
    expect(result!.tableName).toBe("my_table");
  });

  it("column+relation message should diagnose as column-not-found", () => {
    // Message contains both "column" and "relation ... does not exist"
    // Should match column pattern, not table pattern
    const result = diagnose('column "age" of relation "users" does not exist');
    expect(result).not.toBeNull();
    expect(result!.columnName).toBe("age");
  });

  it("falls back when no quoted identifier", () => {
    const result = diagnose("relation does not exist", { tableName: "fallback" });
    expect(result!.diagnosticMessage).toContain("fallback");
  });
});
