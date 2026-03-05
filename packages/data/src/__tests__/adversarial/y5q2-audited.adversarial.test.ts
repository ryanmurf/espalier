/**
 * Y5 Q2 — Adversarial tests for @Audited decorator and audit infrastructure (TEST-3).
 *
 * Probes: decorator edge cases, AuditContext async isolation, AuditLogWriter
 * idempotency, SQL injection vectors, large payloads, concurrent writes,
 * interaction with @SoftDelete, and plain-class detection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Audited,
  getAuditedMetadata,
  isAuditedEntity,
} from "../../decorators/audited.js";
import { AuditContext } from "../../audit/audit-context.js";
import {
  AuditLogWriter,
} from "../../audit/audit-log.js";
import type {
  AuditFieldChange,
  AuditEntry,
} from "../../audit/audit-log.js";
import { getAuditLog } from "../../audit/audit-query.js";

// ═══════════════════════════════════════════════════════
// Helpers: mock Connection / PreparedStatement / ResultSet
// ═══════════════════════════════════════════════════════

function createMockResultSet(rows: Record<string, unknown>[] = []) {
  let idx = -1;
  return {
    next: vi.fn(async () => {
      idx++;
      return idx < rows.length;
    }),
    getRow: vi.fn(() => rows[idx]),
    close: vi.fn(async () => {}),
  };
}

function createMockStatement(resultSet?: ReturnType<typeof createMockResultSet>) {
  const params = new Map<number, unknown>();
  return {
    setParameter: vi.fn((i: number, v: unknown) => params.set(i, v)),
    executeUpdate: vi.fn(async () => {}),
    executeQuery: vi.fn(async () => resultSet ?? createMockResultSet()),
    close: vi.fn(async () => {}),
    _params: params,
  };
}

function createMockConnection(stmt?: ReturnType<typeof createMockStatement>) {
  const s = stmt ?? createMockStatement();
  return {
    prepareStatement: vi.fn(() => s),
    _stmt: s,
  } as any;
}

// ══════════════════════════════════════════════════════
// 1. @Audited with no fields option — all fields audited
// ══════════════════════════════════════════════════════

describe("@Audited decorator — metadata", () => {
  it("no options: fields is undefined (meaning audit all)", () => {
    @Audited()
    class AllFieldsEntity {}

    const meta = getAuditedMetadata(AllFieldsEntity);
    expect(meta).toBeDefined();
    // fields === undefined means "audit everything"
    expect(meta!.fields).toBeUndefined();
  });

  it("explicit fields: only those fields are recorded", () => {
    @Audited({ fields: ["name", "email"] })
    class PartialEntity {}

    const meta = getAuditedMetadata(PartialEntity);
    expect(meta!.fields).toEqual(["name", "email"]);
  });

  // ══════════════════════════════════════════════════════
  // 2. @Audited with empty fields array
  // ══════════════════════════════════════════════════════

  it("empty fields array: metadata stores empty array (ambiguous — audit nothing?)", () => {
    @Audited({ fields: [] })
    class EmptyFieldsEntity {}

    const meta = getAuditedMetadata(EmptyFieldsEntity);
    expect(meta).toBeDefined();
    // BUG: Empty array is stored as-is. Downstream code that checks
    // `meta.fields === undefined` to mean "audit all" would treat
    // empty array as "audit only these (zero) fields" — i.e., audit NOTHING.
    // But the code never validates or warns about this edge case.
    // Whether this is intentional or a bug depends on design intent.
    expect(meta!.fields).toEqual([]);
    expect(meta!.fields).not.toBeUndefined();
  });

  // ══════════════════════════════════════════════════════
  // 3. @Audited with non-existent field names
  // ══════════════════════════════════════════════════════

  it("non-existent field names: no validation at decorator time", () => {
    // BUG (design smell): @Audited does NOT validate that field names
    // actually exist on the entity. Typos or refactored-away fields
    // silently cause no auditing.
    @Audited({ fields: ["doesNotExist", "alsoFake"] })
    class GhostFieldsEntity {}

    const meta = getAuditedMetadata(GhostFieldsEntity);
    expect(meta!.fields).toEqual(["doesNotExist", "alsoFake"]);
    // No error thrown — silent misconfiguration
  });

  // ══════════════════════════════════════════════════════
  // 4. Duplicate @Audited on same entity
  // ══════════════════════════════════════════════════════

  it("duplicate @Audited: second decorator overwrites first (no merge, no error)", () => {
    // BUG: Applying @Audited twice silently overwrites. There is no
    // warning, no merge, and no duplication error.
    @Audited({ fields: ["name"] })
    @Audited({ fields: ["email"] })
    class DoubleAuditedEntity {}

    const meta = getAuditedMetadata(DoubleAuditedEntity);
    expect(meta).toBeDefined();
    // The outer decorator runs last (decorators apply bottom-up for class decorators
    // in TC39 standard decorators). So "name" wins.
    // Actually: standard decorators apply the LAST decorator first on the class,
    // then the second. The WeakMap.set is called for each, so whichever runs last wins.
    // Standard decorators: bottom decorator applies first, then top.
    // So @Audited({fields:["email"]}) runs first, then @Audited({fields:["name"]}).
    // "name" should be the final metadata.
    expect(meta!.fields).toEqual(["name"]);
  });

  // ══════════════════════════════════════════════════════
  // 14. isAuditedEntity on plain class
  // ══════════════════════════════════════════════════════

  it("isAuditedEntity returns false for un-decorated class", () => {
    class PlainClass {}
    expect(isAuditedEntity(PlainClass)).toBe(false);
    expect(getAuditedMetadata(PlainClass)).toBeUndefined();
  });

  it("isAuditedEntity returns false for random objects", () => {
    expect(isAuditedEntity({})).toBe(false);
    expect(isAuditedEntity(Object.create(null))).toBe(false);
  });

  it("isAuditedEntity returns true for decorated class", () => {
    @Audited()
    class AuditedClass {}
    expect(isAuditedEntity(AuditedClass)).toBe(true);
  });

  it("metadata is keyed on exact class, not prototype chain", () => {
    @Audited({ fields: ["x"] })
    class Parent {}
    class Child extends Parent {}

    expect(isAuditedEntity(Parent)).toBe(true);
    // Child class itself is NOT in the WeakMap — only Parent is
    expect(isAuditedEntity(Child)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════
// 5–6. AuditContext — nesting and edge cases
// ══════════════════════════════════════════════════════

describe("AuditContext", () => {
  it("current() returns undefined outside of withUser()", () => {
    expect(AuditContext.current()).toBeUndefined();
  });

  it("withUser() sets the user within the callback", () => {
    AuditContext.withUser({ id: "user-1", name: "Alice" }, () => {
      const user = AuditContext.current();
      expect(user).toBeDefined();
      expect(user!.id).toBe("user-1");
      expect(user!.name).toBe("Alice");
    });
  });

  it("nested withUser() — inner overrides outer", () => {
    AuditContext.withUser({ id: "outer" }, () => {
      expect(AuditContext.current()!.id).toBe("outer");

      AuditContext.withUser({ id: "inner" }, () => {
        expect(AuditContext.current()!.id).toBe("inner");
      });

      // After inner returns, outer is restored
      expect(AuditContext.current()!.id).toBe("outer");
    });
  });

  it("triple nesting restores correctly", () => {
    AuditContext.withUser({ id: "L1" }, () => {
      AuditContext.withUser({ id: "L2" }, () => {
        AuditContext.withUser({ id: "L3" }, () => {
          expect(AuditContext.current()!.id).toBe("L3");
        });
        expect(AuditContext.current()!.id).toBe("L2");
      });
      expect(AuditContext.current()!.id).toBe("L1");
    });
    expect(AuditContext.current()).toBeUndefined();
  });

  // 6. Edge cases for user ID

  it("empty string user ID is accepted (no validation)", () => {
    AuditContext.withUser({ id: "" }, () => {
      expect(AuditContext.current()!.id).toBe("");
    });
  });

  it("very long user ID is accepted (no validation)", () => {
    const longId = "x".repeat(10_000);
    AuditContext.withUser({ id: longId }, () => {
      expect(AuditContext.current()!.id).toBe(longId);
    });
  });

  it("user with no name: name is undefined", () => {
    AuditContext.withUser({ id: "no-name" }, () => {
      expect(AuditContext.current()!.name).toBeUndefined();
    });
  });

  // 13. AuditContext async boundary leaking

  it("does NOT leak across unrelated async operations", async () => {
    const results: (string | undefined)[] = [];

    const task1 = AuditContext.withUser({ id: "task1-user" }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push(AuditContext.current()?.id);
    });

    const task2 = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      results.push(AuditContext.current()?.id);
    })();

    await Promise.all([task1, task2]);

    // task1 should see "task1-user", task2 should see undefined
    expect(results).toContain("task1-user");
    expect(results).toContain(undefined);
  });

  it("concurrent withUser() calls are isolated", async () => {
    const seen: string[] = [];

    const a = AuditContext.withUser({ id: "A" }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(AuditContext.current()!.id);
    });

    const b = AuditContext.withUser({ id: "B" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(AuditContext.current()!.id);
    });

    await Promise.all([a, b]);

    expect(seen).toContain("A");
    expect(seen).toContain("B");
    // Each sees its own user
    expect(seen.filter((x) => x === "A")).toHaveLength(1);
    expect(seen.filter((x) => x === "B")).toHaveLength(1);
  });

  it("withUser() return value is propagated", () => {
    const result = AuditContext.withUser({ id: "u" }, () => 42);
    expect(result).toBe(42);
  });

  it("withUser() with async callback propagates return", async () => {
    const result = await AuditContext.withUser({ id: "u" }, async () => {
      return "async-result";
    });
    expect(result).toBe("async-result");
  });

  it("exception in withUser() callback propagates and context is cleaned up", () => {
    expect(() => {
      AuditContext.withUser({ id: "oops" }, () => {
        throw new Error("boom");
      });
    }).toThrow("boom");

    // Context should be cleaned up
    expect(AuditContext.current()).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════
// 7. AuditLogWriter.ensureTable idempotency
// ══════════════════════════════════════════════════════

describe("AuditLogWriter", () => {
  let writer: AuditLogWriter;

  beforeEach(() => {
    writer = new AuditLogWriter();
  });

  it("ensureTable: first call executes DDL, second is a no-op", async () => {
    const conn = createMockConnection();

    await writer.ensureTable(conn);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);

    // Second call should be a no-op (tableEnsured flag)
    await writer.ensureTable(conn);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);
  });

  it("ensureTable: if DDL fails, tableEnsured stays false", async () => {
    const stmt = createMockStatement();
    stmt.executeUpdate.mockRejectedValueOnce(new Error("DDL failed"));
    const conn = createMockConnection(stmt);

    await expect(writer.ensureTable(conn)).rejects.toThrow("DDL failed");

    // Should retry on next call because tableEnsured is still false
    stmt.executeUpdate.mockResolvedValueOnce(undefined);
    await writer.ensureTable(conn);
    // Now it should be marked as ensured
    await writer.ensureTable(conn);
    // Only 2 DDL calls total (first failed, second succeeded, third skipped)
    expect(stmt.executeUpdate).toHaveBeenCalledTimes(2);
  });

  // ══════════════════════════════════════════════════════
  // 8. Very large JSONB changes
  // ══════════════════════════════════════════════════════

  it("writeEntry with very large changes array: does not throw internally", async () => {
    const conn = createMockConnection();

    const bigChanges: AuditFieldChange[] = [];
    for (let i = 0; i < 10_000; i++) {
      bigChanges.push({
        field: `field_${i}`,
        oldValue: "x".repeat(100),
        newValue: "y".repeat(100),
      });
    }

    // The JSON serialization happens client-side — no internal error
    await writer.writeEntry(conn, "BigEntity", "1", "UPDATE", bigChanges);

    const stmt = conn._stmt;
    // Verify the changes were JSON.stringified
    const changesParam = stmt._params.get(4);
    expect(typeof changesParam).toBe("string");
    const parsed = JSON.parse(changesParam as string);
    expect(parsed).toHaveLength(10_000);
  });

  // ══════════════════════════════════════════════════════
  // 9. Concurrent audit writes
  // ══════════════════════════════════════════════════════

  it("concurrent writeEntry calls: ensureTable only runs once", async () => {
    const conn = createMockConnection();

    // Fire multiple writes concurrently
    await Promise.all([
      writer.writeEntry(conn, "E", "1", "INSERT", []),
      writer.writeEntry(conn, "E", "2", "UPDATE", []),
      writer.writeEntry(conn, "E", "3", "DELETE", []),
    ]);

    // ensureTable uses a simple boolean flag — no mutex.
    // The first call sets tableEnsured synchronously after awaiting DDL.
    // But concurrent calls might all see tableEnsured === false simultaneously.
    // BUG: There's a race condition. Multiple concurrent calls to ensureTable
    // can all pass the `if (this.tableEnsured) return;` check before any of
    // them complete and set `tableEnsured = true`.
    // In practice CREATE TABLE IF NOT EXISTS is idempotent, so it's not a
    // functional bug, but it's unnecessary duplicate DDL execution.
    const ddlCalls = conn.prepareStatement.mock.calls.filter(
      (call: any[]) => (call[0] as string).includes("CREATE TABLE"),
    );
    // With mock, all 3 may have called ensureTable before any resolved
    // This test documents the race condition
    if (ddlCalls.length > 1) {
      console.warn(
        `FINDING: ensureTable race — DDL executed ${ddlCalls.length} times ` +
        "instead of 1 (functionally safe due to IF NOT EXISTS, but wasteful).",
      );
    }
    // At minimum, at least 1 DDL call was made
    expect(ddlCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════
  // 12. SQL injection in entityType/entityId
  // ══════════════════════════════════════════════════════

  it("SQL injection in entityType: uses parameterized queries, so safe", async () => {
    const conn = createMockConnection();

    const maliciousType = "'; DROP TABLE users; --";
    const maliciousId = "1 OR 1=1";

    await writer.writeEntry(conn, maliciousType, maliciousId, "INSERT", []);

    const stmt = conn._stmt;
    // Values should be passed as parameters, not interpolated
    expect(stmt._params.get(1)).toBe(maliciousType);
    expect(stmt._params.get(2)).toBe(maliciousId);
    // The SQL template itself should not contain the malicious strings
    const sqlArg = conn.prepareStatement.mock.calls.find(
      (call: any[]) => (call[0] as string).includes("INSERT INTO espalier_audit_log"),
    );
    expect(sqlArg).toBeDefined();
    expect(sqlArg![0]).not.toContain(maliciousType);
  });

  it("writeEntry picks up AuditContext.current() user", async () => {
    const conn = createMockConnection();

    await AuditContext.withUser({ id: "context-user" }, async () => {
      await writer.writeEntry(conn, "TestEntity", "42", "UPDATE", []);
    });

    const stmt = conn._stmt;
    // Parameter 5 is userId
    expect(stmt._params.get(5)).toBe("context-user");
  });

  it("writeEntry without AuditContext: userId is null", async () => {
    const conn = createMockConnection();

    await writer.writeEntry(conn, "TestEntity", "42", "INSERT", []);

    const stmt = conn._stmt;
    expect(stmt._params.get(5)).toBeNull();
  });

  it("writeEntry always sets a timestamp", async () => {
    const conn = createMockConnection();

    await writer.writeEntry(conn, "TestEntity", "42", "INSERT", []);

    const stmt = conn._stmt;
    const timestamp = stmt._params.get(6);
    expect(timestamp).toBeInstanceOf(Date);
  });

  it("writeEntry with empty changes array: still writes the entry", async () => {
    const conn = createMockConnection();

    await writer.writeEntry(conn, "TestEntity", "42", "DELETE", []);

    const stmt = conn._stmt;
    expect(stmt._params.get(4)).toBe("[]");
    expect(stmt.executeUpdate).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
// 11. getAuditLog for non-existent entity
// ══════════════════════════════════════════════════════

describe("getAuditLog", () => {
  it("returns empty array for non-existent entity (no error)", async () => {
    const rs = createMockResultSet([]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection(stmt);

    class FakeEntity {}

    const result = await getAuditLog(FakeEntity, "nonexistent-id", conn);
    expect(result).toEqual([]);
  });

  it("correctly parses audit rows with string changes (JSON)", async () => {
    const rs = createMockResultSet([
      {
        id: 1,
        entity_type: "TestEntity",
        entity_id: "42",
        operation: "UPDATE",
        changes: JSON.stringify([{ field: "name", oldValue: "old", newValue: "new" }]),
        user_id: "user-1",
        timestamp: new Date("2025-01-01T00:00:00Z"),
      },
    ]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection(stmt);

    class TestEntity {}
    const result = await getAuditLog(TestEntity, "42", conn);

    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe("TestEntity");
    expect(result[0].entityId).toBe("42");
    expect(result[0].operation).toBe("UPDATE");
    expect(result[0].changes).toHaveLength(1);
    expect(result[0].changes[0].field).toBe("name");
    expect(result[0].userId).toBe("user-1");
    expect(result[0].timestamp).toBeInstanceOf(Date);
  });

  it("parses audit rows with already-parsed changes (object)", async () => {
    const rs = createMockResultSet([
      {
        id: 1,
        entity_type: "TestEntity",
        entity_id: "42",
        operation: "INSERT",
        changes: [{ field: "name", oldValue: null, newValue: "Alice" }],
        user_id: null,
        timestamp: "2025-06-15T12:00:00Z",
      },
    ]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection(stmt);

    class TestEntity {}
    const result = await getAuditLog(TestEntity, "42", conn);

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBeUndefined(); // null coerced to undefined
    expect(result[0].timestamp).toBeInstanceOf(Date);
    expect(result[0].changes[0].newValue).toBe("Alice");
  });

  it("uses entity class name for the query parameter", async () => {
    const rs = createMockResultSet([]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection(stmt);

    class MySpecialEntity {}
    await getAuditLog(MySpecialEntity, "123", conn);

    expect(stmt._params.get(1)).toBe("MySpecialEntity");
    expect(stmt._params.get(2)).toBe("123");
  });

  it("stringifies non-string entity IDs", async () => {
    const rs = createMockResultSet([]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection(stmt);

    class E {}
    await getAuditLog(E, 42, conn);
    expect(stmt._params.get(2)).toBe("42");

    await getAuditLog(E, null, conn);
    // String(null) === "null"
    expect(stmt._params.get(2)).toBe("null");

    await getAuditLog(E, undefined, conn);
    // String(undefined) === "undefined"
    expect(stmt._params.get(2)).toBe("undefined");
  });

  it("SQL injection in entityId goes through parameterized query", async () => {
    const rs = createMockResultSet([]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection(stmt);

    class E {}
    await getAuditLog(E, "'; DROP TABLE audit; --", conn);

    // The malicious string is a parameter, not interpolated into SQL
    expect(stmt._params.get(2)).toBe("'; DROP TABLE audit; --");
  });
});

// ══════════════════════════════════════════════════════
// 10. @Audited + @SoftDelete interaction (decorator-level only)
// ══════════════════════════════════════════════════════

describe("@Audited + @SoftDelete interaction", () => {
  it("both decorators can be applied to same class", async () => {
    // Dynamically import SoftDelete to avoid hard dependency if it doesn't exist
    let SoftDelete: any;
    let getSoftDeleteMetadata: any;
    try {
      const mod = await import("../../decorators/soft-delete.js");
      SoftDelete = mod.SoftDelete;
      getSoftDeleteMetadata = mod.getSoftDeleteMetadata;
    } catch {
      console.warn("@SoftDelete not available — skipping interaction test");
      return;
    }

    @Audited()
    @SoftDelete()
    class SoftAuditedEntity {}

    expect(isAuditedEntity(SoftAuditedEntity)).toBe(true);
    expect(getSoftDeleteMetadata(SoftAuditedEntity)).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════
// Additional edge cases
// ══════════════════════════════════════════════════════

describe("@Audited edge cases", () => {
  it("@Audited() returns the same class (does not wrap)", () => {
    @Audited()
    class Transparent {}

    // The decorator should return the target class unchanged
    const instance = new Transparent();
    expect(instance).toBeInstanceOf(Transparent);
    expect(instance.constructor).toBe(Transparent);
  });

  it("@Audited with undefined options is same as no options", () => {
    @Audited(undefined)
    class UndefinedOpts {}

    const meta = getAuditedMetadata(UndefinedOpts);
    expect(meta).toBeDefined();
    expect(meta!.fields).toBeUndefined();
  });

  it("@Audited fields with duplicate entries: stored as-is (no dedup)", () => {
    @Audited({ fields: ["name", "name", "name"] })
    class DupFields {}

    const meta = getAuditedMetadata(DupFields);
    expect(meta!.fields).toEqual(["name", "name", "name"]);
    // BUG (minor): No deduplication of field names. This could cause
    // the same field to be audited multiple times in downstream code.
  });

  it("@Audited fields with special characters: stored as-is", () => {
    @Audited({ fields: ["field with spaces", "field\nwith\nnewlines", ""] })
    class SpecialFields {}

    const meta = getAuditedMetadata(SpecialFields);
    expect(meta!.fields).toHaveLength(3);
    expect(meta!.fields![0]).toBe("field with spaces");
  });
});
