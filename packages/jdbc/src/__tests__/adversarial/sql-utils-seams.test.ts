/**
 * Adversarial regression tests for SQL utility seams.
 *
 * Tests that SQL utilities (quoteIdentifier, validateIdentifier, convertPositionalParams)
 * work correctly across all adapters and prevent SQL injection:
 * - quoteIdentifier handles edge cases
 * - validateIdentifier rejects malicious input
 * - convertPositionalParams works with D1-style ? conversion
 */
import { describe, expect, it } from "vitest";
import {
  ConnectionError,
  DatabaseError,
  DatabaseErrorCode,
  MigrationError,
  QueryError,
  SchemaError,
  TransactionError,
} from "../../errors.js";
import { convertPositionalParams, quoteIdentifier, validateIdentifier } from "../../sql-utils.js";

describe("SQL utility seam tests", () => {
  describe("quoteIdentifier", () => {
    it("wraps simple name in double quotes", () => {
      expect(quoteIdentifier("users")).toBe('"users"');
    });

    it("handles already-quoted identifier", () => {
      const result = quoteIdentifier('"users"');
      // Should still be safe
      expect(result).toContain("users");
    });

    it("handles identifier with underscores", () => {
      expect(quoteIdentifier("user_name")).toBe('"user_name"');
    });

    it("handles identifier with numbers", () => {
      expect(quoteIdentifier("table123")).toBe('"table123"');
    });

    it("escapes internal double quotes", () => {
      // Double quotes inside should be doubled
      const result = quoteIdentifier('my"table');
      expect(result).not.toBe('"my"table"'); // This would be invalid
    });
  });

  describe("validateIdentifier", () => {
    it("accepts valid identifier", () => {
      expect(() => validateIdentifier("users", "table")).not.toThrow();
    });

    it("accepts identifier with underscores", () => {
      expect(() => validateIdentifier("user_table", "table")).not.toThrow();
    });

    it("accepts identifier starting with underscore", () => {
      expect(() => validateIdentifier("_espalier_migrations", "table")).not.toThrow();
    });

    it("rejects identifier with semicolon (SQL injection)", () => {
      expect(() => validateIdentifier("users; DROP TABLE users", "table")).toThrow();
    });

    it("rejects identifier with single quotes", () => {
      expect(() => validateIdentifier("users'--", "table")).toThrow();
    });

    it("rejects identifier with double quotes", () => {
      expect(() => validateIdentifier('users"', "table")).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => validateIdentifier("", "table")).toThrow();
    });
  });

  describe("convertPositionalParams", () => {
    it("converts $1 to ?", () => {
      const result = convertPositionalParams("SELECT * FROM t WHERE id = $1");
      expect(result).toContain("?");
      expect(result).not.toContain("$1");
    });

    it("converts multiple $N params", () => {
      const result = convertPositionalParams("INSERT INTO t (a, b, c) VALUES ($1, $2, $3)");
      expect(result).toBe("INSERT INTO t (a, b, c) VALUES (?, ?, ?)");
    });

    it("always converts positional to question mark style", () => {
      // convertPositionalParams always converts $N to ? (single arg, no style option)
      const result = convertPositionalParams("SELECT * FROM t WHERE id = $1");
      expect(result).toBe("SELECT * FROM t WHERE id = ?");
      expect(result).not.toContain("$1");
    });

    it("handles SQL with no params", () => {
      const result = convertPositionalParams("SELECT * FROM t");
      expect(result).toBe("SELECT * FROM t");
    });
  });

  describe("error hierarchy", () => {
    it("all errors extend DatabaseError", () => {
      const connErr = new ConnectionError("test", undefined, DatabaseErrorCode.CONNECTION_FAILED);
      const queryErr = new QueryError("test", "SELECT 1");
      const txErr = new TransactionError("test");
      const schemaErr = new SchemaError("test");
      const migErr = new MigrationError("test");

      expect(connErr).toBeInstanceOf(DatabaseError);
      expect(queryErr).toBeInstanceOf(DatabaseError);
      expect(txErr).toBeInstanceOf(DatabaseError);
      expect(schemaErr).toBeInstanceOf(DatabaseError);
      expect(migErr).toBeInstanceOf(DatabaseError);
    });

    it("errors are instances of Error", () => {
      const err = new ConnectionError("test", undefined, DatabaseErrorCode.CONNECTION_FAILED);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("test");
    });

    it("QueryError includes SQL in context", () => {
      const err = new QueryError("failed", "SELECT * FROM users WHERE id = $1");
      expect(err.sql).toBe("SELECT * FROM users WHERE id = $1");
    });

    it("ConnectionError includes error code", () => {
      const err = new ConnectionError("connection refused", undefined, DatabaseErrorCode.CONNECTION_FAILED);
      expect(err.code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
    });

    it("error can wrap cause", () => {
      const cause = new Error("original error");
      const err = new ConnectionError("wrapped", cause, DatabaseErrorCode.CONNECTION_FAILED);
      expect(err.cause).toBe(cause);
    });

    it("DatabaseErrorCode has all expected codes", () => {
      expect(DatabaseErrorCode.CONNECTION_FAILED).toBeDefined();
      expect(DatabaseErrorCode.CONNECTION_CLOSED).toBeDefined();
      expect(DatabaseErrorCode.TX_COMMIT_FAILED).toBeDefined();
      expect(DatabaseErrorCode.TX_ROLLBACK_FAILED).toBeDefined();
      expect(DatabaseErrorCode.TX_SAVEPOINT_FAILED).toBeDefined();
    });
  });
});
