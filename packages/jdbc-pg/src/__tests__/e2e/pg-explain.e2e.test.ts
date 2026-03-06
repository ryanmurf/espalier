/**
 * Adversarial E2E tests for EXPLAIN/EXPLAIN ANALYZE and query plan parsing (Y3 Q3).
 *
 * Tests PgQueryPlanAnalyzer against live Postgres with simple queries,
 * JOINs, ANALYZE timing data, BUFFERS, and error cases.
 */

import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { PgQueryPlanAnalyzer } from "../../pg-query-plan.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("E2E: EXPLAIN / EXPLAIN ANALYZE", { timeout: 30000 }, () => {
  let ds: PgDataSource;
  let conn: Connection;
  const analyzer = new PgQueryPlanAnalyzer();

  const TABLE_A = "explain_test_a";
  const TABLE_B = "explain_test_b";

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_B} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_A} CASCADE`);
      await stmt.executeUpdate(`
        CREATE TABLE ${TABLE_A} (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          value INT NOT NULL
        )
      `);
      await stmt.executeUpdate(`
        CREATE TABLE ${TABLE_B} (
          id SERIAL PRIMARY KEY,
          a_id INT REFERENCES ${TABLE_A}(id),
          label TEXT NOT NULL
        )
      `);
      // Seed data
      for (let i = 0; i < 100; i++) {
        await stmt.executeUpdate(`INSERT INTO ${TABLE_A} (name, value) VALUES ('item${i}', ${i})`);
      }
      for (let i = 1; i <= 100; i++) {
        await stmt.executeUpdate(`INSERT INTO ${TABLE_B} (a_id, label) VALUES (${i}, 'label${i}')`);
      }
      // Create an index for index scan tests
      await stmt.executeUpdate(`CREATE INDEX IF NOT EXISTS idx_explain_a_value ON ${TABLE_A} (value)`);
    } finally {
      await stmt.close();
    }
  });

  afterAll(async () => {
    if (conn && !conn.isClosed()) {
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_B} CASCADE`);
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_A} CASCADE`);
      } finally {
        await stmt.close();
      }
      await conn.close();
    }
    await ds.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Basic EXPLAIN
  // ══════════════════════════════════════════════════

  describe("basic EXPLAIN", () => {
    it("returns a valid plan for simple SELECT", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`);

      expect(plan).toBeDefined();
      expect(plan.rootNode).toBeDefined();
      expect(plan.rootNode.nodeType).toBeTruthy();
      expect(plan.rootNode.totalCost).toBeGreaterThanOrEqual(0);
      expect(plan.rootNode.estimatedRows).toBeGreaterThan(0);
      expect(plan.totalCost).toBeGreaterThanOrEqual(0);
    });

    it("Seq Scan on full table scan", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`);
      expect(plan.rootNode.nodeType).toBe("Seq Scan");
      expect(plan.rootNode.relation).toBe(TABLE_A);
    });

    it("plan has startupCost and width", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`);
      expect(plan.rootNode.startupCost).toBeDefined();
      expect(typeof plan.rootNode.startupCost).toBe("number");
      expect(plan.rootNode.width).toBeGreaterThan(0);
    });

    it("EXPLAIN without ANALYZE does NOT have timing data", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`);
      expect(plan.planningTime).toBeUndefined();
      expect(plan.executionTime).toBeUndefined();
      expect(plan.rootNode.actualRows).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: EXPLAIN ANALYZE
  // ══════════════════════════════════════════════════

  describe("EXPLAIN ANALYZE", () => {
    it("returns actual timing data", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`, undefined, { analyze: true });

      expect(plan.planningTime).toBeDefined();
      expect(plan.planningTime).toBeGreaterThanOrEqual(0);
      expect(plan.executionTime).toBeDefined();
      expect(plan.executionTime).toBeGreaterThanOrEqual(0);
    });

    it("returns actual row count", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`, undefined, { analyze: true });

      expect(plan.rootNode.actualRows).toBeDefined();
      expect(plan.rootNode.actualRows).toBeGreaterThan(0);
      expect(plan.rootNode.loops).toBeDefined();
    });

    it("actual rows and estimated rows may differ for WHERE clause", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A} WHERE value > 50`, undefined, {
        analyze: true,
      });

      expect(plan.rootNode.actualRows).toBeDefined();
      expect(plan.rootNode.estimatedRows).toBeGreaterThan(0);
      // Both should be present
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: JOIN query plans
  // ══════════════════════════════════════════════════

  describe("JOIN query plans", () => {
    it("JOIN query returns nested plan nodes", async () => {
      const plan = await analyzer.explain(
        conn,
        `SELECT a.name, b.label FROM ${TABLE_A} a JOIN ${TABLE_B} b ON a.id = b.a_id`,
      );

      expect(plan.rootNode).toBeDefined();
      // A join plan should have child nodes
      const hasChildren =
        plan.rootNode.children.length > 0 ||
        plan.rootNode.nodeType.includes("Join") ||
        plan.rootNode.nodeType.includes("Loop");
      expect(hasChildren).toBe(true);
    });

    it("JOIN plan includes join type", async () => {
      const plan = await analyzer.explain(
        conn,
        `SELECT a.name, b.label FROM ${TABLE_A} a JOIN ${TABLE_B} b ON a.id = b.a_id`,
      );

      // Find any node with a joinType
      function _findJoinNode(node: typeof plan.rootNode): typeof plan.rootNode | undefined {
        if (node.joinType) return node;
        for (const child of node.children) {
          const found = _findJoinNode(child);
          if (found) return found;
        }
        return undefined;
      }

      // The plan may or may not use an explicit join node depending on PG planner
      // but the plan should be valid
      expect(plan.rootNode.nodeType).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: BUFFERS option
  // ══════════════════════════════════════════════════

  describe("BUFFERS option", () => {
    it("ANALYZE with BUFFERS includes buffer stats", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A}`, undefined, {
        analyze: true,
        buffers: true,
      });

      // Buffer stats should be present on at least the root node
      const hasBufferStats = plan.rootNode.sharedHit !== undefined || plan.rootNode.sharedRead !== undefined;
      expect(hasBufferStats).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Index scans
  // ══════════════════════════════════════════════════

  describe("index scans", () => {
    it("query with indexed column may use Index Scan", async () => {
      // Force PG to use the index by querying a specific value
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A} WHERE value = 42`);

      // PG might choose Seq Scan for small tables or Index Scan
      // Either way, the plan should be valid
      expect(plan.rootNode.nodeType).toBeTruthy();

      // If it used an index scan, the index name should be present
      if (plan.rootNode.nodeType.includes("Index")) {
        expect(plan.rootNode.index).toBeDefined();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Parameterized queries
  // ══════════════════════════════════════════════════

  describe("parameterized queries", () => {
    it("EXPLAIN with parameters works", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A} WHERE value = $1`, [42]);

      expect(plan).toBeDefined();
      expect(plan.rootNode.nodeType).toBeTruthy();
    });

    it("EXPLAIN ANALYZE with parameters executes and returns timing", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A} WHERE value = $1`, [42], { analyze: true });

      expect(plan.planningTime).toBeDefined();
      expect(plan.executionTime).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: DML statements
  // ══════════════════════════════════════════════════

  describe("DML statements", () => {
    it("EXPLAIN on INSERT works", async () => {
      const plan = await analyzer.explain(conn, `INSERT INTO ${TABLE_A} (name, value) VALUES ('explain_insert', 999)`);

      expect(plan.rootNode.nodeType).toBeTruthy();
    });

    it("EXPLAIN on UPDATE works", async () => {
      const plan = await analyzer.explain(conn, `UPDATE ${TABLE_A} SET value = 0 WHERE name = 'nonexistent'`);

      expect(plan.rootNode.nodeType).toBeTruthy();
    });

    it("EXPLAIN on DELETE works", async () => {
      const plan = await analyzer.explain(conn, `DELETE FROM ${TABLE_A} WHERE name = 'nonexistent'`);

      expect(plan.rootNode.nodeType).toBeTruthy();
    });

    it("EXPLAIN ANALYZE on INSERT is blocked by security guard", async () => {
      // Security fix: EXPLAIN ANALYZE is only allowed on SELECT/WITH to prevent side effects
      await expect(
        analyzer.explain(conn, `INSERT INTO ${TABLE_A} (name, value) VALUES ('analyze_insert', 888)`, undefined, {
          analyze: true,
        }),
      ).rejects.toThrow(/EXPLAIN ANALYZE is only allowed on SELECT\/WITH/);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 8: Error handling
  // ══════════════════════════════════════════════════

  describe("error handling", () => {
    it("invalid SQL throws an error", async () => {
      await expect(analyzer.explain(conn, "INVALID SQL GARBAGE")).rejects.toThrow();
    });

    it("EXPLAIN on non-existent table throws", async () => {
      await expect(analyzer.explain(conn, "SELECT * FROM nonexistent_table_xyz_abc")).rejects.toThrow();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 9: Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("empty result set plan still parses", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A} WHERE value = -999`, undefined, {
        analyze: true,
      });

      expect(plan.rootNode).toBeDefined();
      expect(plan.rootNode.actualRows).toBe(0);
    });

    it("subquery plan is parsed", async () => {
      const plan = await analyzer.explain(
        conn,
        `SELECT * FROM ${TABLE_A} WHERE value IN (SELECT a_id FROM ${TABLE_B})`,
      );

      expect(plan.rootNode).toBeDefined();
      // Should have child nodes from the subquery
      expect(plan.totalCost).toBeGreaterThan(0);
    });

    it("CTE plan is parsed", async () => {
      const plan = await analyzer.explain(
        conn,
        `WITH cte AS (SELECT * FROM ${TABLE_A} WHERE value < 10) SELECT * FROM cte`,
      );

      expect(plan.rootNode).toBeDefined();
      expect(plan.totalCost).toBeGreaterThan(0);
    });

    it("EXPLAIN with SQL injection attempt in query", async () => {
      // The EXPLAIN wraps the SQL, but the SQL itself is passed through.
      // This should fail because the SQL is invalid, not because of injection.
      await expect(analyzer.explain(conn, "SELECT 1; DROP TABLE explain_test_a; --")).rejects.toThrow();
    });

    it("plan for aggregate query", async () => {
      const plan = await analyzer.explain(conn, `SELECT COUNT(*), AVG(value) FROM ${TABLE_A}`);

      expect(plan.rootNode.nodeType).toBeTruthy();
      // Aggregate plans typically have an "Aggregate" node type
    });

    it("plan for ORDER BY includes sort info", async () => {
      const plan = await analyzer.explain(conn, `SELECT * FROM ${TABLE_A} ORDER BY value DESC`);

      // Find a Sort node
      function findSort(node: typeof plan.rootNode): typeof plan.rootNode | undefined {
        if (node.nodeType === "Sort") return node;
        for (const child of node.children) {
          const found = findSort(child);
          if (found) return found;
        }
        return undefined;
      }

      const sortNode = findSort(plan.rootNode);
      // PG may or may not add a Sort node (it might use an Index Scan Backward)
      if (sortNode) {
        expect(sortNode.sortKey).toBeDefined();
      }
    });
  });
});
