import type { QueryPlan, PlanNode } from "./query-plan.js";

/**
 * Severity of a plan warning.
 */
export type PlanWarningSeverity = "info" | "warning" | "critical";

/**
 * A warning about a potential inefficiency in a query plan.
 */
export interface PlanWarning {
  severity: PlanWarningSeverity;
  message: string;
  nodeType: string;
  suggestion: string;
  affectedRelation?: string;
}

/**
 * Configuration for PlanAdvisor thresholds.
 */
export interface PlanAdvisorConfig {
  /** Seq scan row threshold above which a warning is raised. Default: 10000. */
  seqScanRowThreshold?: number;
  /** Nested loop outer row threshold. Default: 1000. */
  nestedLoopRowThreshold?: number;
  /** Total cost threshold for high-cost warnings. Default: 100000. */
  highCostThreshold?: number;
  /** Row estimate mismatch factor for ANALYZE results. Default: 10. */
  estimateMismatchFactor?: number;
}

const DEFAULT_CONFIG: Required<PlanAdvisorConfig> = {
  seqScanRowThreshold: 10000,
  nestedLoopRowThreshold: 1000,
  highCostThreshold: 100000,
  estimateMismatchFactor: 10,
};

/**
 * Analyzes query plans and flags potential performance problems.
 */
export class PlanAdvisor {
  private readonly config: Required<PlanAdvisorConfig>;

  constructor(config?: PlanAdvisorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze a query plan and return warnings about inefficiencies.
   */
  analyze(plan: QueryPlan): PlanWarning[] {
    const warnings: PlanWarning[] = [];
    this.visitNode(plan.rootNode, warnings);
    return warnings;
  }

  private visitNode(node: PlanNode, warnings: PlanWarning[]): void {
    // Rule 1: Sequential scan on large tables
    if (node.nodeType === "Seq Scan" && node.estimatedRows > this.config.seqScanRowThreshold) {
      const w: PlanWarning = {
        severity: "warning",
        message: `Sequential scan on ${node.relation ?? "unknown table"} scanning ~${node.estimatedRows} rows`,
        nodeType: node.nodeType,
        suggestion: "Consider adding an index to avoid full table scan",
        affectedRelation: node.relation,
      };
      warnings.push(w);
    }

    // Rule 2: Sequential scan with filter → missing index
    if (node.nodeType === "Seq Scan" && node.filter) {
      warnings.push({
        severity: "info",
        message: `Sequential scan with filter on ${node.relation ?? "unknown table"}: ${node.filter}`,
        nodeType: node.nodeType,
        suggestion: `Consider adding an index on the filtered column(s) for ${node.relation ?? "this table"}`,
        affectedRelation: node.relation,
      });
    }

    // Rule 3: Nested loop with large outer
    if (node.nodeType === "Nested Loop") {
      const outerChild = node.children[0];
      if (outerChild && outerChild.estimatedRows > this.config.nestedLoopRowThreshold) {
        warnings.push({
          severity: "warning",
          message: `Nested loop join with ${outerChild.estimatedRows} estimated outer rows`,
          nodeType: node.nodeType,
          suggestion: "Consider a hash join or merge join — the outer relation may be too large for nested loop",
        });
      }
    }

    // Rule 4: High cost operations
    if (node.totalCost > this.config.highCostThreshold) {
      warnings.push({
        severity: "critical",
        message: `High cost node: ${node.nodeType} with total cost ${node.totalCost.toFixed(2)}`,
        nodeType: node.nodeType,
        suggestion: "Review this operation for optimization opportunities",
        affectedRelation: node.relation,
      });
    }

    // Rule 5: Row estimate mismatch (ANALYZE only)
    if (node.actualRows !== undefined && node.estimatedRows > 0) {
      const ratio = node.actualRows / node.estimatedRows;
      const inverseRatio = node.estimatedRows / Math.max(node.actualRows, 1);
      if (ratio > this.config.estimateMismatchFactor || inverseRatio > this.config.estimateMismatchFactor) {
        warnings.push({
          severity: "warning",
          message: `Row estimate mismatch on ${node.nodeType}: estimated ${node.estimatedRows}, actual ${node.actualRows}`,
          nodeType: node.nodeType,
          suggestion: "Run ANALYZE on the affected table(s) to update statistics",
          affectedRelation: node.relation,
        });
      }
    }

    // Rule 6: Sort on disk (external sort)
    if (node.nodeType === "Sort" && node.sortKey) {
      // In PostgreSQL JSON plans, external sort shows "Sort Method": "external merge"
      // Since we don't capture that field yet, flag all sorts with high estimated rows
      if (node.estimatedRows > this.config.seqScanRowThreshold) {
        warnings.push({
          severity: "info",
          message: `Sort operation on ${node.estimatedRows} rows`,
          nodeType: node.nodeType,
          suggestion: "Consider adding an index that covers the sort order, or increase work_mem",
        });
      }
    }

    // Recurse into children
    for (const child of node.children) {
      this.visitNode(child, warnings);
    }
  }
}
