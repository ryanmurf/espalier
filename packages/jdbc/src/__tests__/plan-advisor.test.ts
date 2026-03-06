/**
 * Adversarial tests for PlanAdvisor query plan inefficiency detection (Y3 Q3).
 */
import { describe, expect, it } from "vitest";
import { PlanAdvisor } from "../plan-advisor.js";
import type { PlanNode, QueryPlan } from "../query-plan.js";

// ══════════════════════════════════════════════════
// Helper to build plan nodes and plans
// ══════════════════════════════════════════════════

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeType: "Seq Scan",
    startupCost: 0,
    totalCost: 100,
    estimatedRows: 100,
    width: 32,
    children: [],
    ...overrides,
  };
}

function makePlan(rootOverrides: Partial<PlanNode> = {}, planOverrides: Partial<QueryPlan> = {}): QueryPlan {
  const root = makeNode(rootOverrides);
  return {
    rootNode: root,
    totalCost: root.totalCost,
    ...planOverrides,
  };
}

// ══════════════════════════════════════════════════
// Rule 1: Seq Scan on large tables
// ══════════════════════════════════════════════════

describe("PlanAdvisor", () => {
  describe("Rule 1: Seq Scan on large tables", () => {
    it("Seq Scan above threshold triggers warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 50000, relation: "users" });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.message.includes("Sequential scan") && w.message.includes("users"));
      expect(seqWarn).toBeDefined();
      expect(seqWarn!.severity).toBe("warning");
      expect(seqWarn!.affectedRelation).toBe("users");
    });

    it("Seq Scan below threshold does not trigger warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 100, relation: "small_table" });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.severity === "warning" && w.message.includes("Sequential scan"));
      expect(seqWarn).toBeUndefined();
    });

    it("Seq Scan at exactly threshold does not trigger (> not >=)", () => {
      const advisor = new PlanAdvisor({ seqScanRowThreshold: 10000 });
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 10000, relation: "boundary" });

      const warnings = advisor.analyze(plan);
      // estimatedRows > threshold means 10000 > 10000 is false
      const seqWarn = warnings.find((w) => w.severity === "warning" && w.message.includes("Sequential scan"));
      expect(seqWarn).toBeUndefined();
    });

    it("Seq Scan at threshold + 1 triggers", () => {
      const advisor = new PlanAdvisor({ seqScanRowThreshold: 10000 });
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 10001, relation: "boundary" });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.severity === "warning" && w.message.includes("Sequential scan"));
      expect(seqWarn).toBeDefined();
    });

    it("Seq Scan with no relation shows 'unknown table'", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 50000 });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.message.includes("unknown table"));
      expect(seqWarn).toBeDefined();
    });

    it("Index Scan with many rows does NOT trigger Seq Scan warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Index Scan", estimatedRows: 50000, relation: "users" });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.message.includes("Sequential scan"));
      expect(seqWarn).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Rule 2: Seq Scan with filter → missing index
  // ══════════════════════════════════════════════════

  describe("Rule 2: Seq Scan with filter", () => {
    it("Seq Scan with filter triggers info suggestion", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 50,
        relation: "orders",
        filter: "(status = 'active')",
      });

      const warnings = advisor.analyze(plan);
      const filterWarn = warnings.find((w) => w.severity === "info" && w.message.includes("filter"));
      expect(filterWarn).toBeDefined();
      expect(filterWarn!.suggestion).toContain("index");
      expect(filterWarn!.affectedRelation).toBe("orders");
    });

    it("Seq Scan without filter does not trigger filter warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 50, relation: "orders" });

      const warnings = advisor.analyze(plan);
      const filterWarn = warnings.find((w) => w.severity === "info" && w.message.includes("filter"));
      expect(filterWarn).toBeUndefined();
    });

    it("Index Scan with filter does NOT trigger Seq Scan filter warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Index Scan",
        estimatedRows: 50,
        relation: "orders",
        filter: "(status = 'active')",
      });

      const warnings = advisor.analyze(plan);
      const seqFilterWarn = warnings.find((w) => w.message.includes("Sequential scan with filter"));
      expect(seqFilterWarn).toBeUndefined();
    });

    it("Seq Scan with filter AND large rows triggers BOTH warnings", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 50000,
        relation: "big_filtered",
        filter: "(id > 100)",
      });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.filter((w) => w.message.includes("Sequential scan"));
      // One "warning" for large table scan + one "info" for filter
      expect(seqWarn.length).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════
  // Rule 3: Nested Loop with large outer
  // ══════════════════════════════════════════════════

  describe("Rule 3: Nested Loop with large outer", () => {
    it("Nested Loop with large outer triggers warning", () => {
      const advisor = new PlanAdvisor();
      const outerChild = makeNode({ nodeType: "Seq Scan", estimatedRows: 5000 });
      const innerChild = makeNode({ nodeType: "Index Scan", estimatedRows: 1 });
      const plan = makePlan({
        nodeType: "Nested Loop",
        children: [outerChild, innerChild],
      });

      const warnings = advisor.analyze(plan);
      const nlWarn = warnings.find((w) => w.nodeType === "Nested Loop");
      expect(nlWarn).toBeDefined();
      expect(nlWarn!.severity).toBe("warning");
      expect(nlWarn!.suggestion).toContain("hash join");
    });

    it("Nested Loop with small outer does not trigger", () => {
      const advisor = new PlanAdvisor();
      const outerChild = makeNode({ nodeType: "Seq Scan", estimatedRows: 10 });
      const innerChild = makeNode({ nodeType: "Index Scan", estimatedRows: 1 });
      const plan = makePlan({
        nodeType: "Nested Loop",
        children: [outerChild, innerChild],
      });

      const warnings = advisor.analyze(plan);
      const nlWarn = warnings.find((w) => w.nodeType === "Nested Loop");
      expect(nlWarn).toBeUndefined();
    });

    it("Hash Join does NOT trigger nested loop warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Hash Join",
        children: [
          makeNode({ nodeType: "Seq Scan", estimatedRows: 50000 }),
          makeNode({ nodeType: "Hash", estimatedRows: 50000 }),
        ],
      });

      const warnings = advisor.analyze(plan);
      const nlWarn = warnings.find((w) => w.nodeType === "Nested Loop");
      expect(nlWarn).toBeUndefined();
    });

    it("Nested Loop with no children does not crash", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Nested Loop", children: [] });

      // children[0] is undefined — outerChild check should be safe
      const warnings = advisor.analyze(plan);
      const nlWarn = warnings.find((w) => w.nodeType === "Nested Loop");
      expect(nlWarn).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Rule 4: High cost operations
  // ══════════════════════════════════════════════════

  describe("Rule 4: High cost operations", () => {
    it("node above cost threshold triggers critical warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Hash Join", totalCost: 200000 });

      const warnings = advisor.analyze(plan);
      const costWarn = warnings.find((w) => w.severity === "critical");
      expect(costWarn).toBeDefined();
      expect(costWarn!.message).toContain("200000");
    });

    it("node below cost threshold does not trigger", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Seq Scan", totalCost: 500, estimatedRows: 10 });

      const warnings = advisor.analyze(plan);
      const costWarn = warnings.find((w) => w.severity === "critical");
      expect(costWarn).toBeUndefined();
    });

    it("custom high cost threshold", () => {
      const advisor = new PlanAdvisor({ highCostThreshold: 50 });
      const plan = makePlan({ nodeType: "Seq Scan", totalCost: 100, estimatedRows: 10 });

      const warnings = advisor.analyze(plan);
      const costWarn = warnings.find((w) => w.severity === "critical");
      expect(costWarn).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Rule 5: Row estimate mismatch (ANALYZE)
  // ══════════════════════════════════════════════════

  describe("Rule 5: Row estimate mismatch", () => {
    it("large overestimate triggers warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 10000,
        actualRows: 10, // 1000x mismatch
        relation: "stale_stats",
      });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      expect(mismatchWarn).toBeDefined();
      expect(mismatchWarn!.suggestion).toContain("ANALYZE");
    });

    it("large underestimate triggers warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 10,
        actualRows: 500, // 50x mismatch
      });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      expect(mismatchWarn).toBeDefined();
    });

    it("close estimate does not trigger", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 100,
        actualRows: 120, // 1.2x — within 10x threshold
      });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      expect(mismatchWarn).toBeUndefined();
    });

    it("no actualRows (non-ANALYZE) does not trigger", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 10000 });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      expect(mismatchWarn).toBeUndefined();
    });

    it("actualRows = 0, estimatedRows = 10000 triggers (estimatedRows/max(0,1) > 10)", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 10000,
        actualRows: 0,
      });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      // inverseRatio = 10000 / max(0,1) = 10000 > 10
      expect(mismatchWarn).toBeDefined();
    });

    it("estimatedRows = 0 skips mismatch check (guard: estimatedRows > 0)", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 0,
        actualRows: 500,
      });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      // estimatedRows > 0 is false, so this rule is skipped entirely
      expect(mismatchWarn).toBeUndefined();
    });

    it("custom mismatch factor", () => {
      const advisor = new PlanAdvisor({ estimateMismatchFactor: 2 });
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 100,
        actualRows: 300, // 3x mismatch, > 2x custom threshold
      });

      const warnings = advisor.analyze(plan);
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      expect(mismatchWarn).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Rule 6: Sort on large datasets
  // ══════════════════════════════════════════════════

  describe("Rule 6: Sort on large datasets", () => {
    it("Sort with many rows and sortKey triggers info", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Sort",
        sortKey: ["created_at DESC"],
        estimatedRows: 50000,
      });

      const warnings = advisor.analyze(plan);
      const sortWarn = warnings.find((w) => w.nodeType === "Sort" && w.severity === "info");
      expect(sortWarn).toBeDefined();
      expect(sortWarn!.suggestion).toContain("work_mem");
    });

    it("Sort with few rows does not trigger", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Sort",
        sortKey: ["id ASC"],
        estimatedRows: 100,
      });

      const warnings = advisor.analyze(plan);
      const sortWarn = warnings.find((w) => w.nodeType === "Sort" && w.severity === "info");
      expect(sortWarn).toBeUndefined();
    });

    it("Sort without sortKey does not trigger (guard: node.sortKey)", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Sort",
        estimatedRows: 50000,
        // no sortKey
      });

      const warnings = advisor.analyze(plan);
      const sortWarn = warnings.find((w) => w.nodeType === "Sort" && w.severity === "info");
      expect(sortWarn).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Empty plan / no issues
  // ══════════════════════════════════════════════════

  describe("clean plans", () => {
    it("plan with no issues returns empty array", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Index Scan",
        estimatedRows: 1,
        totalCost: 5,
        relation: "users",
        index: "users_pkey",
      });

      const warnings = advisor.analyze(plan);
      expect(warnings).toEqual([]);
    });

    it("plan with minimal node returns empty or only relevant warnings", () => {
      const advisor = new PlanAdvisor();
      const plan: QueryPlan = {
        rootNode: {
          nodeType: "Result",
          startupCost: 0,
          totalCost: 0.01,
          estimatedRows: 1,
          width: 4,
          children: [],
        },
        totalCost: 0.01,
      };

      const warnings = advisor.analyze(plan);
      expect(warnings).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════
  // Custom thresholds
  // ══════════════════════════════════════════════════

  describe("custom thresholds", () => {
    it("custom seqScanRowThreshold overrides default", () => {
      const advisor = new PlanAdvisor({ seqScanRowThreshold: 100 });
      const plan = makePlan({ nodeType: "Seq Scan", estimatedRows: 200, relation: "t" });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.severity === "warning" && w.message.includes("Sequential scan"));
      expect(seqWarn).toBeDefined();
    });

    it("custom nestedLoopRowThreshold overrides default", () => {
      const advisor = new PlanAdvisor({ nestedLoopRowThreshold: 10 });
      const plan = makePlan({
        nodeType: "Nested Loop",
        children: [makeNode({ estimatedRows: 50 }), makeNode({ estimatedRows: 1 })],
      });

      const warnings = advisor.analyze(plan);
      const nlWarn = warnings.find((w) => w.nodeType === "Nested Loop");
      expect(nlWarn).toBeDefined();
    });

    it("all thresholds at zero — everything triggers", () => {
      const advisor = new PlanAdvisor({
        seqScanRowThreshold: 0,
        nestedLoopRowThreshold: 0,
        highCostThreshold: 0,
        estimateMismatchFactor: 1,
      });

      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 1,
        totalCost: 1,
        relation: "t",
        filter: "(x = 1)",
        actualRows: 10,
      });

      const warnings = advisor.analyze(plan);
      // Should have: large seq scan (1 > 0), filter, high cost (1 > 0), estimate mismatch (10/1 > 1)
      expect(warnings.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ══════════════════════════════════════════════════
  // Complex multi-join plan with children
  // ══════════════════════════════════════════════════

  describe("complex plans with children", () => {
    it("warnings emitted for child nodes too", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Hash Join",
        totalCost: 500,
        estimatedRows: 1000,
        children: [
          makeNode({
            nodeType: "Seq Scan",
            estimatedRows: 50000,
            relation: "orders",
            filter: "(active = true)",
          }),
          makeNode({
            nodeType: "Hash",
            children: [
              makeNode({
                nodeType: "Seq Scan",
                estimatedRows: 20000,
                relation: "users",
              }),
            ],
          }),
        ],
      });

      const warnings = advisor.analyze(plan);
      const ordersWarn = warnings.find((w) => w.affectedRelation === "orders" && w.severity === "warning");
      const usersWarn = warnings.find((w) => w.affectedRelation === "users" && w.severity === "warning");
      expect(ordersWarn).toBeDefined();
      expect(usersWarn).toBeDefined();
    });

    it("deeply nested child nodes are visited", () => {
      const advisor = new PlanAdvisor();
      const deepChild = makeNode({
        nodeType: "Seq Scan",
        estimatedRows: 99999,
        relation: "deep_table",
      });
      const plan = makePlan({
        nodeType: "Aggregate",
        totalCost: 100,
        children: [
          makeNode({
            nodeType: "Sort",
            children: [
              makeNode({
                nodeType: "Merge Join",
                children: [deepChild, makeNode({ nodeType: "Index Scan" })],
              }),
            ],
          }),
        ],
      });

      const warnings = advisor.analyze(plan);
      const deepWarn = warnings.find((w) => w.affectedRelation === "deep_table");
      expect(deepWarn).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("NaN estimatedRows — BUG: NaN > threshold is false, so no Seq Scan warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: NaN,
        relation: "broken",
      });

      const warnings = advisor.analyze(plan);
      // NaN > 10000 is false, so no seq scan warning. Debatable if this is correct.
      const seqWarn = warnings.find((w) => w.severity === "warning" && w.message.includes("Sequential scan"));
      expect(seqWarn).toBeUndefined();
    });

    it("NaN totalCost — BUG: NaN > highCostThreshold is false, no critical warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        totalCost: NaN,
        estimatedRows: 10,
      });

      const warnings = advisor.analyze(plan);
      const costWarn = warnings.find((w) => w.severity === "critical");
      expect(costWarn).toBeUndefined();
    });

    it("Infinity totalCost triggers critical warning", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        totalCost: Infinity,
        estimatedRows: 10,
      });

      const warnings = advisor.analyze(plan);
      const costWarn = warnings.find((w) => w.severity === "critical");
      expect(costWarn).toBeDefined();
    });

    it("negative estimatedRows — does not trigger seq scan warning (-1 > 10000 false)", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: -1,
        relation: "negative",
      });

      const warnings = advisor.analyze(plan);
      const seqWarn = warnings.find((w) => w.severity === "warning" && w.message.includes("Sequential scan"));
      expect(seqWarn).toBeUndefined();
    });

    it("Infinity in totalCost.toFixed does not crash", () => {
      const advisor = new PlanAdvisor({ highCostThreshold: 0 });
      const plan = makePlan({ nodeType: "Seq Scan", totalCost: Infinity, estimatedRows: 0 });

      // Infinity.toFixed(2) returns "Infinity" — should not throw
      expect(() => advisor.analyze(plan)).not.toThrow();
    });

    it("NaN totalCost with highCostThreshold: 0 — NaN > 0 is false, no warning", () => {
      const advisor = new PlanAdvisor({ highCostThreshold: 0 });
      const plan = makePlan({ nodeType: "Seq Scan", totalCost: NaN, estimatedRows: 0 });

      const warnings = advisor.analyze(plan);
      const costWarn = warnings.find((w) => w.severity === "critical");
      // NaN > 0 is false
      expect(costWarn).toBeUndefined();
    });

    it("estimate mismatch with NaN actualRows — BUG potential", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 100,
        actualRows: NaN,
      });

      const warnings = advisor.analyze(plan);
      // NaN !== undefined, so the check enters the block.
      // ratio = NaN / 100 = NaN, inverseRatio = 100 / max(NaN, 1) = 100 / NaN = NaN
      // NaN > 10 is false for both, so no warning.
      const mismatchWarn = warnings.find((w) => w.message.includes("estimate mismatch"));
      expect(mismatchWarn).toBeUndefined();
    });

    it("multiple rules fire on same node", () => {
      const advisor = new PlanAdvisor({ highCostThreshold: 50 });
      const plan = makePlan({
        nodeType: "Seq Scan",
        estimatedRows: 50000,
        totalCost: 200,
        relation: "multi_rule",
        filter: "(x > 1)",
        actualRows: 5, // huge mismatch
      });

      const warnings = advisor.analyze(plan);
      const severities = new Set(warnings.map((w) => w.severity));
      // Should have: warning (seq scan large), info (filter), critical (high cost), warning (mismatch)
      expect(severities.has("warning")).toBe(true);
      expect(severities.has("info")).toBe(true);
      expect(severities.has("critical")).toBe(true);
      expect(warnings.length).toBeGreaterThanOrEqual(4);
    });

    it("plan with empty nodeType does not match any rules", () => {
      const advisor = new PlanAdvisor();
      const plan = makePlan({ nodeType: "", estimatedRows: 99999, totalCost: 0 });

      const warnings = advisor.analyze(plan);
      // nodeType "" !== "Seq Scan", !== "Nested Loop", !== "Sort"
      // totalCost 0 < 100000
      expect(warnings).toEqual([]);
    });

    it("default constructor uses expected defaults", () => {
      const advisor = new PlanAdvisor();

      // 10000 rows — exactly at threshold, should NOT trigger
      const plan1 = makePlan({ nodeType: "Seq Scan", estimatedRows: 10000, relation: "t" });
      expect(
        advisor.analyze(plan1).find((w) => w.severity === "warning" && w.message.includes("Sequential scan")),
      ).toBeUndefined();

      // 10001 rows — above threshold, SHOULD trigger
      const plan2 = makePlan({ nodeType: "Seq Scan", estimatedRows: 10001, relation: "t" });
      expect(
        advisor.analyze(plan2).find((w) => w.severity === "warning" && w.message.includes("Sequential scan")),
      ).toBeDefined();
    });
  });
});
