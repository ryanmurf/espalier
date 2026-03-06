/**
 * Adversarial regression tests for adapter compliance test seams.
 *
 * Tests that the runAdapterComplianceTests suite itself handles edge cases:
 * - Missing runner option throws clear error
 * - Suite options validation
 * - Integration with the DriverAdapter interface
 */
import { describe, expect, it } from "vitest";
import { runAdapterComplianceTests } from "../../adapter-compliance.js";
import type { DriverCapabilities } from "../../driver-adapter.js";
import { IsolationLevel } from "../../transaction.js";

describe("adapter compliance suite seam tests", () => {
  it("throws when runner option is missing", () => {
    expect(() => {
      runAdapterComplianceTests({
        createDataSource: async () => ({}) as any,
        createTableSql: "CREATE TABLE test (id INT)",
        dropTableSql: "DROP TABLE test",
        tableName: "test",
        paramStyle: "positional",
        // no runner!
      });
    }).toThrow(/runner is required/i);
  });

  it("accepts valid options without throwing", () => {
    // Just verify it does not throw during setup
    expect(() => {
      runAdapterComplianceTests({
        createDataSource: async () => ({}) as any,
        createTableSql: "CREATE TABLE test (id INT)",
        dropTableSql: "DROP TABLE test",
        tableName: "test",
        paramStyle: "question",
        runner: {
          describe: () => {},
          it: () => {},
          expect: () => ({}) as any,
          beforeAll: () => {},
          afterAll: () => {},
          beforeEach: () => {},
        },
      });
    }).not.toThrow();
  });

  describe("DriverCapabilities interface", () => {
    it("accepts minimal capabilities", () => {
      const caps: DriverCapabilities = {
        streaming: false,
        savepoints: false,
        namedParams: false,
        batchStatements: false,
        cursorResultSets: false,
        transactionIsolationLevels: [],
      };

      expect(caps.streaming).toBe(false);
      expect(caps.transactionIsolationLevels).toHaveLength(0);
    });

    it("accepts full capabilities", () => {
      const caps: DriverCapabilities = {
        streaming: true,
        savepoints: true,
        namedParams: true,
        batchStatements: true,
        cursorResultSets: true,
        transactionIsolationLevels: [
          IsolationLevel.READ_UNCOMMITTED,
          IsolationLevel.READ_COMMITTED,
          IsolationLevel.REPEATABLE_READ,
          IsolationLevel.SERIALIZABLE,
        ],
      };

      expect(caps.streaming).toBe(true);
      expect(caps.transactionIsolationLevels).toHaveLength(4);
    });

    it("D1-like capabilities (no transactions, no streaming)", () => {
      const caps: DriverCapabilities = {
        streaming: false,
        savepoints: false,
        namedParams: false,
        batchStatements: true, // D1 has batch API
        cursorResultSets: false,
        transactionIsolationLevels: [], // D1 has no real transactions
      };

      expect(caps.batchStatements).toBe(true);
      expect(caps.savepoints).toBe(false);
    });
  });

  describe("IsolationLevel enum values", () => {
    it("has all standard isolation levels", () => {
      expect(IsolationLevel.READ_UNCOMMITTED).toBeDefined();
      expect(IsolationLevel.READ_COMMITTED).toBeDefined();
      expect(IsolationLevel.REPEATABLE_READ).toBeDefined();
      expect(IsolationLevel.SERIALIZABLE).toBeDefined();
    });

    it("isolation levels are distinct strings", () => {
      const levels = new Set([
        IsolationLevel.READ_UNCOMMITTED,
        IsolationLevel.READ_COMMITTED,
        IsolationLevel.REPEATABLE_READ,
        IsolationLevel.SERIALIZABLE,
      ]);
      expect(levels.size).toBe(4);
    });
  });
});
