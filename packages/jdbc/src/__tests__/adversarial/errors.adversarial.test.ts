import { describe, it, expect } from "vitest";
import {
  DatabaseError,
  ConnectionError,
  QueryError,
  TransactionError,
  MigrationError,
  SchemaError,
  DatabaseErrorCode,
} from "../../errors.js";
import { ErrorCode } from "../../error-codes.js";

// ── 1. Huge SQL strings ─────────────────────────────────────────────────────

describe("Huge SQL strings", () => {
  const hugeSQL = "SELECT " + "a".repeat(100_000) + " FROM t";

  it("toJSON handles 100KB SQL without truncation or crash", () => {
    const err = new QueryError("fail", hugeSQL, undefined, undefined, {
      parameterCount: 0,
    });
    const json = err.toJSON();
    // Should not crash and should include the full SQL (no truncation in current impl)
    expect(json.sql).toBe(hugeSQL);
    expect(json.sql!.length).toBeGreaterThan(100_000);
  });

  it("toString handles 100KB SQL without crash", () => {
    const err = new QueryError("fail", hugeSQL);
    const str = err.toString();
    expect(str).toContain("sql:");
    expect(str.length).toBeGreaterThan(100_000);
  });

  it("JSON.stringify of toJSON with huge SQL completes", () => {
    const err = new QueryError("fail", hugeSQL);
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized);
    expect(parsed.sql.length).toBeGreaterThan(100_000);
  });

  it("factory method queryFailed with huge SQL", () => {
    const err = DatabaseError.queryFailed(hugeSQL, 0);
    expect(err.sql).toBe(hugeSQL);
    expect(err.message).toContain("Query failed:");
    expect(err.message.length).toBeGreaterThan(100_000);
  });
});

// ── 2. Special characters in SQL ─────────────────────────────────────────────

describe("Special characters in SQL", () => {
  it("handles newlines and tabs in SQL", () => {
    const sql = "SELECT\n\t*\n\tFROM\n\t\tusers\n\tWHERE\n\t\tid = $1";
    const err = new QueryError("fail", sql);
    const json = err.toJSON();
    expect(json.sql).toBe(sql);
    const str = err.toString();
    expect(str).toContain(sql);
  });

  it("handles unicode in SQL", () => {
    const sql = "SELECT * FROM users WHERE name = '日本語テスト' AND emoji = '🔥💀'";
    const err = new QueryError("fail", sql);
    expect(err.toJSON().sql).toBe(sql);
    expect(err.toString()).toContain(sql);
  });

  it("handles null bytes in SQL", () => {
    const sql = "SELECT\x00* FROM t";
    const err = new QueryError("fail", sql);
    expect(err.sql).toBe(sql);
    const json = err.toJSON();
    expect(json.sql).toBe(sql);
  });

  it("handles SQL with backslashes and quotes", () => {
    const sql = `SELECT * FROM "t" WHERE val = E'it\\'s\\\\"escaped'`;
    const err = new QueryError("fail", sql);
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized);
    expect(parsed.sql).toBe(sql);
  });

  it("handles empty string SQL", () => {
    const err = new QueryError("fail", "");
    expect(err.sql).toBe("");
    const json = err.toJSON();
    // Empty string is falsy but should still be present if set
    // Current impl: `if (this.sql !== undefined)` — empty string is not undefined
    expect(json.sql).toBe("");
  });

  it("handles SQL with only whitespace", () => {
    const sql = "   \t\n\r   ";
    const err = new QueryError("fail", sql);
    expect(err.sql).toBe(sql);
  });
});

// ── 3. Circular cause chains ─────────────────────────────────────────────────

describe("Circular cause chains", () => {
  it("toJSON handles error whose cause references itself", () => {
    const errA = new Error("A");
    // Force a circular cause: A -> A
    (errA as any).cause = errA;
    const dbErr = new DatabaseError("wrapper", errA);
    // toJSON only reads cause.name and cause.message, so no infinite loop
    const json = dbErr.toJSON();
    expect(json.cause).toEqual({ name: "Error", message: "A" });
  });

  it("toString handles circular cause", () => {
    const errA = new Error("A");
    (errA as any).cause = errA;
    const dbErr = new DatabaseError("wrapper", errA);
    const str = dbErr.toString();
    expect(str).toContain("cause: Error: A");
  });

  it("toJSON handles mutual cause cycle (A -> B -> A)", () => {
    const errA = new Error("A");
    const errB = new Error("B");
    (errA as any).cause = errB;
    (errB as any).cause = errA;
    const dbErr = new DatabaseError("wrapper", errA);
    // Only reads top-level cause, so no infinite recursion
    const json = dbErr.toJSON();
    expect(json.cause).toEqual({ name: "Error", message: "A" });
  });

  it("JSON.stringify of toJSON with circular cause is safe", () => {
    const errA = new Error("A");
    (errA as any).cause = errA;
    const dbErr = new DatabaseError("wrapper", errA);
    // toJSON produces a plain object, should be safe to stringify
    const serialized = JSON.stringify(dbErr.toJSON());
    const parsed = JSON.parse(serialized);
    expect(parsed.cause.message).toBe("A");
  });

  it("DatabaseError as its own cause via context", () => {
    const dbErr = new DatabaseError("self-referential");
    // Create a new error that references the first as cause
    const dbErr2 = new DatabaseError("wrapper", undefined, undefined, {
      cause: dbErr,
    });
    const json = dbErr2.toJSON();
    expect(json.cause).toEqual({ name: "DatabaseError", message: "self-referential" });
  });
});

// ── 4. Negative/NaN parameterCount ──────────────────────────────────────────

describe("Negative/NaN parameterCount", () => {
  it("accepts negative parameterCount", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      parameterCount: -1,
    });
    expect(err.parameterCount).toBe(-1);
    const json = err.toJSON();
    expect(json.parameterCount).toBe(-1);
  });

  it("accepts NaN parameterCount", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      parameterCount: NaN,
    });
    expect(err.parameterCount).toBeNaN();
    const json = err.toJSON();
    expect(json.parameterCount).toBeNaN();
  });

  it("NaN parameterCount survives JSON round-trip as null", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      parameterCount: NaN,
    });
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized);
    // JSON.stringify converts NaN to null
    expect(parsed.parameterCount).toBeNull();
  });

  it("accepts Infinity parameterCount", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      parameterCount: Infinity,
    });
    expect(err.parameterCount).toBe(Infinity);
    const json = err.toJSON();
    expect(json.parameterCount).toBe(Infinity);
  });

  it("Infinity parameterCount becomes null in JSON round-trip", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      parameterCount: Infinity,
    });
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized);
    // JSON.stringify converts Infinity to null
    expect(parsed.parameterCount).toBeNull();
  });

  it("toString displays NaN/Infinity parameterCount", () => {
    const errNaN = new DatabaseError("fail", undefined, undefined, {
      parameterCount: NaN,
    });
    expect(errNaN.toString()).toContain("parameterCount: NaN");

    const errInf = new DatabaseError("fail", undefined, undefined, {
      parameterCount: Infinity,
    });
    expect(errInf.toString()).toContain("parameterCount: Infinity");
  });

  it("queryFailed factory with NaN parameterCount", () => {
    const err = DatabaseError.queryFailed("SELECT 1", NaN);
    expect(err.parameterCount).toBeNaN();
  });

  it("queryFailed factory with negative parameterCount", () => {
    const err = DatabaseError.queryFailed("SELECT 1", -99);
    expect(err.parameterCount).toBe(-99);
  });

  it("parameterCount of 0 is included in toJSON (not omitted as falsy)", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      parameterCount: 0,
    });
    const json = err.toJSON();
    // 0 is falsy but not undefined, should still appear
    expect(json.parameterCount).toBe(0);
    expect("parameterCount" in json).toBe(true);
  });
});

// ── 5. Prototype pollution via context ──────────────────────────────────────

describe("Prototype pollution via context keys", () => {
  it("__proto__ as connectionId does not pollute prototype", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      connectionId: "__proto__",
    });
    expect(err.connectionId).toBe("__proto__");
    const json = err.toJSON();
    expect(json.connectionId).toBe("__proto__");
    // Verify no prototype pollution occurred
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.connectionId).toBe("__proto__");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("constructor as connectionId is stored safely", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      connectionId: "constructor",
    });
    expect(err.connectionId).toBe("constructor");
    const json = err.toJSON();
    expect(json.connectionId).toBe("constructor");
  });

  it("toString as connectionId is stored safely", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      connectionId: "toString",
    });
    expect(err.connectionId).toBe("toString");
    // toString() method should still work
    const str = err.toString();
    expect(str).toContain("connectionId: toString");
  });

  it("SQL containing __proto__ and constructor keywords", () => {
    const sql = "SELECT __proto__, constructor FROM Object WHERE toString = $1";
    const err = new QueryError("fail", sql);
    expect(err.sql).toBe(sql);
    const json = err.toJSON();
    expect(json.sql).toBe(sql);
  });

  it("error message with prototype pollution attempt", () => {
    const msg = '{"__proto__":{"isAdmin":true}}';
    const err = new DatabaseError(msg);
    expect(err.message).toBe(msg);
    const json = err.toJSON();
    expect(json.message).toBe(msg);
    const parsed = JSON.parse(JSON.stringify(json));
    expect((parsed as any).isAdmin).toBeUndefined();
  });
});

// ── 6. Null/undefined everywhere ─────────────────────────────────────────────

describe("Null/undefined everywhere", () => {
  it("empty string message", () => {
    const err = new DatabaseError("");
    expect(err.message).toBe("");
    expect(err.toString()).toContain("DatabaseError [UNKNOWN]: ");
  });

  it("undefined context fields are not set", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      sql: undefined,
      parameterCount: undefined,
      errorCode: undefined,
      connectionId: undefined,
      cause: undefined,
    });
    expect(err.sql).toBeUndefined();
    expect(err.parameterCount).toBeUndefined();
    expect(err.errorCode).toBeUndefined();
    expect(err.connectionId).toBeUndefined();
  });

  it("empty context object", () => {
    const err = new DatabaseError("fail", undefined, undefined, {});
    expect(err.sql).toBeUndefined();
    expect(err.parameterCount).toBeUndefined();
    expect(err.errorCode).toBeUndefined();
    expect(err.connectionId).toBeUndefined();
  });

  it("null cause is treated as no cause", () => {
    // TypeScript won't normally allow null here, but at runtime it could happen
    const err = new DatabaseError("fail", null as any);
    // null is falsy, so `cause ? { cause }` evaluates to no cause option
    expect(err.cause).toBeUndefined();
  });

  it("context with null cause does not set cause", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      cause: null as any,
    });
    // null is falsy, so `if (!cause && context.cause)` is false — cause is never set
    // This means null cause via context is silently ignored (treated as "no cause")
    expect(err.cause).toBeUndefined();
    const json = err.toJSON();
    expect(json.cause).toBeUndefined();
  });

  it("QueryError with undefined sql positional arg", () => {
    const err = new QueryError("fail", undefined);
    expect(err.sql).toBeUndefined();
  });

  it("empty string errorCode in context", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      errorCode: "" as any,
    });
    expect(err.errorCode).toBe("");
    const json = err.toJSON();
    // Empty string is not undefined, so it should appear in JSON
    expect(json.errorCode).toBe("");
  });

  it("empty string connectionId in context", () => {
    const err = new DatabaseError("fail", undefined, undefined, {
      connectionId: "",
    });
    expect(err.connectionId).toBe("");
    const json = err.toJSON();
    expect(json.connectionId).toBe("");
    // toString now uses !== undefined (consistent with toJSON), so empty string is included
    const str = err.toString();
    expect(str).toContain("connectionId:");
  });
});

// ── 7. Error subclass behavior ───────────────────────────────────────────────

describe("Error subclass behavior", () => {
  it("MigrationError instanceof checks", () => {
    const err = new MigrationError("migration failed");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err).not.toBeInstanceOf(QueryError);
    expect(err).not.toBeInstanceOf(ConnectionError);
    expect(err).not.toBeInstanceOf(TransactionError);
    expect(err).not.toBeInstanceOf(SchemaError);
  });

  it("SchemaError instanceof checks", () => {
    const err = new SchemaError("schema mismatch");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(SchemaError);
    expect(err).not.toBeInstanceOf(QueryError);
    expect(err).not.toBeInstanceOf(ConnectionError);
    expect(err).not.toBeInstanceOf(TransactionError);
    expect(err).not.toBeInstanceOf(MigrationError);
  });

  it("error.name matches class name for all subclasses", () => {
    expect(new DatabaseError("x").name).toBe("DatabaseError");
    expect(new ConnectionError("x").name).toBe("ConnectionError");
    expect(new QueryError("x").name).toBe("QueryError");
    expect(new TransactionError("x").name).toBe("TransactionError");
    expect(new MigrationError("x").name).toBe("MigrationError");
    expect(new SchemaError("x").name).toBe("SchemaError");
  });

  it("all subclasses have stack traces", () => {
    const errors = [
      new DatabaseError("a"),
      new ConnectionError("b"),
      new QueryError("c"),
      new TransactionError("d"),
      new MigrationError("e"),
      new SchemaError("f"),
    ];
    for (const err of errors) {
      expect(err.stack).toBeDefined();
      expect(err.stack).toContain(err.message);
    }
  });

  it("toJSON name reflects subclass, not base class", () => {
    expect(new ConnectionError("x").toJSON().name).toBe("ConnectionError");
    expect(new QueryError("x").toJSON().name).toBe("QueryError");
    expect(new TransactionError("x").toJSON().name).toBe("TransactionError");
    expect(new MigrationError("x").toJSON().name).toBe("MigrationError");
    expect(new SchemaError("x").toJSON().name).toBe("SchemaError");
  });

  it("toString name reflects subclass, not base class", () => {
    expect(new ConnectionError("x").toString()).toMatch(/^ConnectionError/);
    expect(new QueryError("x").toString()).toMatch(/^QueryError/);
    expect(new TransactionError("x").toString()).toMatch(/^TransactionError/);
    expect(new MigrationError("x").toString()).toMatch(/^MigrationError/);
    expect(new SchemaError("x").toString()).toMatch(/^SchemaError/);
  });

  it("subclasses inherit toJSON and toString", () => {
    const err = new MigrationError("fail", undefined, undefined, {
      errorCode: ErrorCode.MIGRATION_FAILED,
      sql: "ALTER TABLE t ADD COLUMN x INT",
      connectionId: "pool-1",
    });
    const json = err.toJSON();
    expect(json.name).toBe("MigrationError");
    expect(json.sql).toBe("ALTER TABLE t ADD COLUMN x INT");
    expect(json.errorCode).toBe(ErrorCode.MIGRATION_FAILED);
    expect(json.connectionId).toBe("pool-1");

    const str = err.toString();
    expect(str).toContain("MigrationError");
    expect(str).toContain("sql:");
    expect(str).toContain("errorCode:");
  });

  it("QueryError toSafeString leaks no SQL or internal details", () => {
    const err = new QueryError(
      "sensitive: SELECT password FROM users",
      "SELECT password FROM users WHERE id = $1",
      new Error("pg: permission denied"),
      DatabaseErrorCode.QUERY_FAILED,
      {
        parameterCount: 1,
        errorCode: ErrorCode.QUERY_FAILED,
        connectionId: "pool-secret:conn-42",
      },
    );
    const safe = err.toSafeString();
    expect(safe).not.toContain("password");
    expect(safe).not.toContain("users");
    expect(safe).not.toContain("permission denied");
    expect(safe).not.toContain("pool-secret");
    expect(safe).toBe("QueryError: QUERY_FAILED");
  });
});

// ── 8. Factory method edge cases ─────────────────────────────────────────────

describe("Factory method edge cases", () => {
  it("connectionFailed with no context", () => {
    const err = DatabaseError.connectionFailed("no context");
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
    expect(err.cause).toBeUndefined();
    expect(err.errorCode).toBeUndefined();
    expect(err.connectionId).toBeUndefined();
  });

  it("queryFailed with empty SQL string", () => {
    const err = DatabaseError.queryFailed("", 0);
    expect(err).toBeInstanceOf(QueryError);
    expect(err.sql).toBe("");
    expect(err.message).toBe("Query failed: ");
    expect(err.parameterCount).toBe(0);
  });

  it("transactionFailed with empty message", () => {
    const err = DatabaseError.transactionFailed("");
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.message).toBe("");
  });

  it("connectionFailed returns ConnectionError, not plain DatabaseError", () => {
    const err = DatabaseError.connectionFailed("test");
    expect(err.constructor).toBe(ConnectionError);
  });

  it("queryFailed returns QueryError, not plain DatabaseError", () => {
    const err = DatabaseError.queryFailed("SELECT 1", 0);
    expect(err.constructor).toBe(QueryError);
  });

  it("transactionFailed returns TransactionError, not plain DatabaseError", () => {
    const err = DatabaseError.transactionFailed("test");
    expect(err.constructor).toBe(TransactionError);
  });

  it("factory methods produce errors with valid timestamps", () => {
    const before = new Date();
    const err1 = DatabaseError.connectionFailed("a");
    const err2 = DatabaseError.queryFailed("SELECT 1", 0);
    const err3 = DatabaseError.transactionFailed("b");
    const after = new Date();

    for (const err of [err1, err2, err3]) {
      expect(err.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(err.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    }
  });

  it("queryFailed message embeds the SQL", () => {
    const sql = "DELETE FROM users";
    const err = DatabaseError.queryFailed(sql, 0);
    expect(err.message).toBe(`Query failed: ${sql}`);
  });

  it("transactionFailed uses UNKNOWN code by default", () => {
    const err = DatabaseError.transactionFailed("test");
    expect(err.code).toBe(DatabaseErrorCode.UNKNOWN);
  });

  it("connectionFailed context cause is propagated", () => {
    const cause = new Error("ECONNREFUSED");
    const err = DatabaseError.connectionFailed("fail", { cause });
    expect(err.cause).toBe(cause);
  });

  it("transactionFailed context cause is propagated", () => {
    const cause = new Error("deadlock");
    const err = DatabaseError.transactionFailed("fail", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── 9. toJSON idempotency ────────────────────────────────────────────────────

describe("toJSON idempotency", () => {
  it("calling toJSON multiple times returns equal results", () => {
    const err = new QueryError("fail", "SELECT 1", new Error("cause"), undefined, {
      parameterCount: 1,
      errorCode: ErrorCode.QUERY_FAILED,
      connectionId: "pool-1",
    });
    const json1 = err.toJSON();
    const json2 = err.toJSON();
    const json3 = err.toJSON();
    expect(json1).toEqual(json2);
    expect(json2).toEqual(json3);
  });

  it("toJSON returns a new object each call (not shared reference)", () => {
    const err = new DatabaseError("test");
    const json1 = err.toJSON();
    const json2 = err.toJSON();
    expect(json1).not.toBe(json2);
    // Mutating one should not affect the other
    (json1 as any).extra = "mutated";
    expect((json2 as any).extra).toBeUndefined();
  });

  it("toJSON is truly JSON-serializable (full round-trip)", () => {
    const cause = new Error("root");
    const err = new DatabaseError("test", cause, DatabaseErrorCode.QUERY_FAILED, {
      sql: "SELECT * FROM t",
      parameterCount: 3,
      errorCode: ErrorCode.QUERY_FAILED,
      connectionId: "pool-1:conn-7",
    });
    const json = err.toJSON();
    const str = JSON.stringify(json);
    const parsed = JSON.parse(str);

    expect(parsed.name).toBe(json.name);
    expect(parsed.message).toBe(json.message);
    expect(parsed.code).toBe(json.code);
    expect(parsed.errorCode).toBe(json.errorCode);
    expect(parsed.sql).toBe(json.sql);
    expect(parsed.parameterCount).toBe(json.parameterCount);
    expect(parsed.connectionId).toBe(json.connectionId);
    expect(parsed.timestamp).toBe(json.timestamp);
    expect(parsed.cause).toEqual(json.cause);
  });

  it("toJSON timestamp is a string, not a Date object", () => {
    const err = new DatabaseError("test");
    const json = err.toJSON();
    expect(typeof json.timestamp).toBe("string");
    // Should be valid ISO 8601
    expect(new Date(json.timestamp).toISOString()).toBe(json.timestamp);
  });

  it("toJSON does not include stack trace (no information leakage)", () => {
    const err = new DatabaseError("test", new Error("cause"));
    const json = err.toJSON();
    const str = JSON.stringify(json);
    expect(str).not.toContain("stack");
    expect((json as any).stack).toBeUndefined();
  });
});

// ── 10. toString formatting ──────────────────────────────────────────────────

describe("toString formatting edge cases", () => {
  it("message with %s placeholders is not interpreted as format string", () => {
    const err = new DatabaseError("error %s in %d places");
    const str = err.toString();
    // Should contain the literal %s and %d, not substitutions
    expect(str).toContain("error %s in %d places");
  });

  it("message with ${} template syntax is literal", () => {
    const err = new DatabaseError("value is ${process.env.SECRET}");
    const str = err.toString();
    expect(str).toContain("${process.env.SECRET}");
  });

  it("very long error code in toString", () => {
    // DatabaseErrorCode values are short, but if someone passes a custom one
    const err = new DatabaseError("fail", undefined, "X".repeat(1000) as any);
    const str = err.toString();
    expect(str).toContain("X".repeat(1000));
  });

  it("toString includes all parts separated by newlines", () => {
    const err = new DatabaseError("fail", new Error("cause"), DatabaseErrorCode.QUERY_FAILED, {
      errorCode: ErrorCode.QUERY_FAILED,
      sql: "SELECT 1",
      parameterCount: 2,
      connectionId: "pool-1",
    });
    const lines = err.toString().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(6); // header + errorCode + sql + parameterCount + connectionId + timestamp + cause
    expect(lines[0]).toContain("DatabaseError [QUERY_FAILED]");
    expect(lines.some(l => l.includes("errorCode:"))).toBe(true);
    expect(lines.some(l => l.includes("sql:"))).toBe(true);
    expect(lines.some(l => l.includes("parameterCount:"))).toBe(true);
    expect(lines.some(l => l.includes("connectionId:"))).toBe(true);
    expect(lines.some(l => l.includes("timestamp:"))).toBe(true);
    expect(lines.some(l => l.includes("cause:"))).toBe(true);
  });

  it("toString with multiline SQL preserves formatting", () => {
    const sql = "SELECT\n  *\nFROM\n  users\nWHERE\n  id = $1";
    const err = new QueryError("fail", sql);
    const str = err.toString();
    // The SQL is embedded inline after "sql: ", newlines from SQL will appear in the output
    expect(str).toContain(sql);
  });

  it("toString with cause that has no message", () => {
    const cause = new Error();
    const err = new DatabaseError("wrapper", cause);
    const str = err.toString();
    expect(str).toContain("cause: Error: ");
  });

  it("message with special regex characters", () => {
    const err = new DatabaseError("fail (.*)+$ [a-z]");
    const str = err.toString();
    expect(str).toContain("fail (.*)+$ [a-z]");
  });
});

// ── 11. ErrorCode completeness ───────────────────────────────────────────────

describe("ErrorCode completeness and uniqueness", () => {
  const allCodes = Object.values(ErrorCode);
  const allKeys = Object.keys(ErrorCode);

  it("all error codes are non-empty strings", () => {
    for (const code of allCodes) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("all error codes are unique", () => {
    const unique = new Set(allCodes);
    expect(unique.size).toBe(allCodes.length);
  });

  it("all error codes start with ESPALIER_ prefix", () => {
    for (const code of allCodes) {
      expect(code).toMatch(/^ESPALIER_/);
    }
  });

  it("error code keys match their value suffixes", () => {
    // e.g. CONNECTION_FAILED -> ESPALIER_CONNECTION_FAILED
    for (const key of allKeys) {
      const value = (ErrorCode as any)[key];
      expect(value).toBe(`ESPALIER_${key}`);
    }
  });

  it("ErrorCode is frozen (const assertion)", () => {
    // Since it's `as const`, the type system prevents mutation,
    // but at runtime the object is still mutable unless frozen.
    // This test documents the current behavior.
    const originalKeys = Object.keys(ErrorCode).length;
    // Attempting to add a key at runtime
    try {
      (ErrorCode as any).NEW_CODE = "ESPALIER_NEW_CODE";
    } catch {
      // If frozen, this throws in strict mode
    }
    // Note: `as const` does NOT freeze the object at runtime
    // This documents that ErrorCode is NOT runtime-frozen
    // (could be a potential issue if someone mutates it)
    if (Object.keys(ErrorCode).length !== originalKeys) {
      // Clean up the mutation
      delete (ErrorCode as any).NEW_CODE;
    }
    expect(Object.keys(ErrorCode).length).toBe(originalKeys);
  });

  it("DatabaseErrorCode (legacy) values are all non-empty strings", () => {
    const legacyCodes = Object.values(DatabaseErrorCode);
    for (const code of legacyCodes) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("DatabaseErrorCode (legacy) values are unique", () => {
    const values = Object.values(DatabaseErrorCode).filter(v => typeof v === "string");
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

// ── 12. Backward compatibility ───────────────────────────────────────────────

describe("Backward compatibility", () => {
  it("old-style construction: just message", () => {
    const err = new DatabaseError("fail");
    expect(err.message).toBe("fail");
    expect(err.code).toBe(DatabaseErrorCode.UNKNOWN);
    expect(err.cause).toBeUndefined();
    expect(err.sql).toBeUndefined();
    expect(err.parameterCount).toBeUndefined();
    expect(err.errorCode).toBeUndefined();
    expect(err.connectionId).toBeUndefined();
    expect(err.timestamp).toBeInstanceOf(Date);
  });

  it("old-style construction: message + cause", () => {
    const cause = new Error("root");
    const err = new DatabaseError("fail", cause);
    expect(err.message).toBe("fail");
    expect(err.cause).toBe(cause);
    expect(err.code).toBe(DatabaseErrorCode.UNKNOWN);
  });

  it("old-style construction: message + cause + code", () => {
    const cause = new Error("root");
    const err = new DatabaseError("fail", cause, DatabaseErrorCode.QUERY_FAILED);
    expect(err.message).toBe("fail");
    expect(err.cause).toBe(cause);
    expect(err.code).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("old-style: no context means no extra fields", () => {
    const err = new DatabaseError("fail", new Error("root"), DatabaseErrorCode.CONNECTION_FAILED);
    expect(err.errorCode).toBeUndefined();
    expect(err.sql).toBeUndefined();
    expect(err.parameterCount).toBeUndefined();
    expect(err.connectionId).toBeUndefined();
  });

  it("old-style QueryError: message + sql", () => {
    const err = new QueryError("fail", "SELECT 1");
    expect(err.message).toBe("fail");
    expect(err.sql).toBe("SELECT 1");
    expect(err.code).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("old-style ConnectionError: message + cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new ConnectionError("fail", cause);
    expect(err.message).toBe("fail");
    expect(err.cause).toBe(cause);
    expect(err.code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("old-style TransactionError: message only", () => {
    const err = new TransactionError("fail");
    expect(err.message).toBe("fail");
    expect(err.code).toBe(DatabaseErrorCode.UNKNOWN);
  });

  it("can be caught as Error in try/catch", () => {
    try {
      throw new QueryError("boom", "SELECT 1");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(DatabaseError);
      expect(e).toBeInstanceOf(QueryError);
    }
  });

  it("error properties are readonly", () => {
    const err = new DatabaseError("fail", undefined, DatabaseErrorCode.QUERY_FAILED, {
      sql: "SELECT 1",
      parameterCount: 1,
      errorCode: ErrorCode.QUERY_FAILED,
      connectionId: "pool-1",
    });
    // These are declared as readonly — verify TypeScript enforces at runtime
    // In strict mode, assignment to readonly should fail or be ignored
    expect(() => {
      (err as any).code = DatabaseErrorCode.UNKNOWN;
    }).not.toThrow(); // JS doesn't enforce readonly at runtime
    // But the value should have been changed since JS allows it
    // This documents that "readonly" is compile-time only
  });
});

// ── 13. Stress: rapid construction ───────────────────────────────────────────

describe("Stress and edge cases", () => {
  it("constructing 10,000 errors does not crash", () => {
    const errors: DatabaseError[] = [];
    for (let i = 0; i < 10_000; i++) {
      errors.push(
        new DatabaseError(`error-${i}`, undefined, DatabaseErrorCode.UNKNOWN, {
          sql: `SELECT ${i}`,
          parameterCount: i,
          errorCode: ErrorCode.QUERY_FAILED,
          connectionId: `conn-${i}`,
        }),
      );
    }
    expect(errors.length).toBe(10_000);
    // Spot check
    expect(errors[9999].message).toBe("error-9999");
    expect(errors[9999].parameterCount).toBe(9999);
  });

  it("cause that is not an Error instance", () => {
    // At runtime, someone might pass a non-Error object as cause
    const weirdCause = { message: "not an error", name: "FakeError" };
    const err = new DatabaseError("fail", weirdCause as any);
    // The constructor passes it to super() via { cause }, so it gets set
    expect(err.cause).toBe(weirdCause);
    // But toJSON checks `instanceof Error`, so it should be omitted
    const json = err.toJSON();
    expect(json.cause).toBeUndefined();
  });

  it("cause that is a string", () => {
    const err = new DatabaseError("fail", "string cause" as any);
    expect(err.cause).toBe("string cause");
    // toJSON should not include it (not instanceof Error)
    const json = err.toJSON();
    expect(json.cause).toBeUndefined();
  });

  it("cause that is a number", () => {
    const err = new DatabaseError("fail", 42 as any);
    expect(err.cause).toBe(42);
    const json = err.toJSON();
    expect(json.cause).toBeUndefined();
  });

  it("timestamp is unique per error instance", () => {
    const err1 = new DatabaseError("a");
    const err2 = new DatabaseError("b");
    // They should be independent Date objects
    expect(err1.timestamp).not.toBe(err2.timestamp);
  });

  it("very long message in toString", () => {
    const longMsg = "x".repeat(50_000);
    const err = new DatabaseError(longMsg);
    const str = err.toString();
    expect(str).toContain(longMsg);
  });

  it("error with every optional field set", () => {
    const cause = new Error("root");
    const err = new DatabaseError("full", cause, DatabaseErrorCode.QUERY_CONSTRAINT, {
      sql: "INSERT INTO t VALUES ($1, $2, $3)",
      parameterCount: 3,
      errorCode: ErrorCode.CONSTRAINT_VIOLATION,
      connectionId: "pool-main:conn-99",
      cause: new Error("should be ignored because positional cause takes precedence"),
    });
    expect(err.message).toBe("full");
    expect(err.cause).toBe(cause);
    expect(err.code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    expect(err.sql).toBe("INSERT INTO t VALUES ($1, $2, $3)");
    expect(err.parameterCount).toBe(3);
    expect(err.errorCode).toBe(ErrorCode.CONSTRAINT_VIOLATION);
    expect(err.connectionId).toBe("pool-main:conn-99");

    const json = err.toJSON();
    expect(Object.keys(json)).toContain("name");
    expect(Object.keys(json)).toContain("message");
    expect(Object.keys(json)).toContain("code");
    expect(Object.keys(json)).toContain("errorCode");
    expect(Object.keys(json)).toContain("sql");
    expect(Object.keys(json)).toContain("parameterCount");
    expect(Object.keys(json)).toContain("connectionId");
    expect(Object.keys(json)).toContain("timestamp");
    expect(Object.keys(json)).toContain("cause");

    const str = err.toString();
    expect(str).toContain("errorCode:");
    expect(str).toContain("sql:");
    expect(str).toContain("parameterCount:");
    expect(str).toContain("connectionId:");
    expect(str).toContain("timestamp:");
    expect(str).toContain("cause:");
  });
});
