/**
 * Adversarial tests for StatementCache bugs found by code reviewer.
 */
import { describe, expect, it, vi } from "vitest";
import type { PreparedStatement } from "../../statement.js";
import { StatementCache } from "../../statement-cache.js";

function mockStmt(): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(),
    executeUpdate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as PreparedStatement;
}

describe("FIXED #35: StatementCache.put() closes old statement on replace", () => {
  it("replacing a cached statement closes the old one", () => {
    const cache = new StatementCache();
    const oldStmt = mockStmt();
    const newStmt = mockStmt();

    cache.put("SELECT 1", oldStmt);
    cache.put("SELECT 1", newStmt); // replaces oldStmt

    // FIXED: oldStmt.close() is now called when replaced
    expect(oldStmt.close).toHaveBeenCalledOnce();

    // Verify the new statement is in the cache
    expect(cache.get("SELECT 1")).toBe(newStmt);
  });

  it("evict properly closes the statement (contrast with put replace)", () => {
    const cache = new StatementCache();
    const stmt = mockStmt();
    cache.put("SELECT 1", stmt);
    cache.evict("SELECT 1");

    // evict correctly closes the statement
    expect(stmt.close).toHaveBeenCalledOnce();
  });

  it("LRU eviction properly closes the evicted statement", () => {
    const cache = new StatementCache({ maxSize: 1 });
    const stmt1 = mockStmt();
    const stmt2 = mockStmt();

    cache.put("SELECT 1", stmt1);
    cache.put("SELECT 2", stmt2); // evicts stmt1

    // LRU eviction correctly closes stmt1
    expect(stmt1.close).toHaveBeenCalledOnce();
  });
});
