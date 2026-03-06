import type { Connection, ExplainOptions, PlanNode, QueryPlan, QueryPlanAnalyzer, SqlValue } from "espalier-jdbc";

/**
 * PostgreSQL EXPLAIN implementation that parses JSON-format query plans.
 */
export class PgQueryPlanAnalyzer implements QueryPlanAnalyzer {
  async explain(
    connection: Connection,
    sql: string,
    params?: SqlValue[],
    options?: ExplainOptions,
  ): Promise<QueryPlan> {
    // Guard: EXPLAIN ANALYZE actually executes the query, so restrict to SELECT
    if (options?.analyze) {
      const trimmed = sql.trimStart().toUpperCase();
      if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
        throw new Error("EXPLAIN ANALYZE is only allowed on SELECT/WITH queries to prevent side effects");
      }
    }

    const explainParts = ["EXPLAIN (FORMAT JSON"];
    if (options?.analyze) explainParts.push(", ANALYZE");
    if (options?.buffers) explainParts.push(", BUFFERS");
    if (options?.verbose) explainParts.push(", VERBOSE");
    explainParts.push(")");

    const explainSql = `${explainParts.join("")} ${sql}`;

    let jsonResult: any;

    if (params && params.length > 0) {
      const stmt = connection.prepareStatement(explainSql);
      try {
        for (let i = 0; i < params.length; i++) {
          stmt.setParameter(i + 1, params[i]);
        }
        const rs = await stmt.executeQuery();
        if (await rs.next()) {
          const row = rs.getRow();
          const val = Object.values(row)[0];
          jsonResult = typeof val === "string" ? JSON.parse(val) : val;
        }
      } finally {
        await stmt.close();
      }
    } else {
      const stmt = connection.createStatement();
      try {
        const rs = await stmt.executeQuery(explainSql);
        if (await rs.next()) {
          const row = rs.getRow();
          const val = Object.values(row)[0];
          jsonResult = typeof val === "string" ? JSON.parse(val) : val;
        }
      } finally {
        await stmt.close();
      }
    }

    if (!jsonResult || !Array.isArray(jsonResult) || jsonResult.length === 0) {
      throw new Error("Failed to parse EXPLAIN output");
    }

    const planJson = jsonResult[0];
    const rootNode = parsePlanNode(planJson["Plan"]);

    const plan: QueryPlan = {
      rootNode,
      totalCost: rootNode.totalCost,
    };

    if (planJson["Planning Time"] !== undefined) {
      plan.planningTime = planJson["Planning Time"];
    }
    if (planJson["Execution Time"] !== undefined) {
      plan.executionTime = planJson["Execution Time"];
    }

    return plan;
  }
}

function parsePlanNode(node: any): PlanNode {
  const children: PlanNode[] = [];
  if (Array.isArray(node["Plans"])) {
    for (const child of node["Plans"]) {
      children.push(parsePlanNode(child));
    }
  }

  const planNode: PlanNode = {
    nodeType: node["Node Type"] ?? "Unknown",
    startupCost: node["Startup Cost"] ?? 0,
    totalCost: node["Total Cost"] ?? 0,
    estimatedRows: node["Plan Rows"] ?? 0,
    width: node["Plan Width"] ?? 0,
    children,
  };

  // Optional fields
  if (node["Relation Name"]) planNode.relation = node["Relation Name"];
  if (node["Index Name"]) planNode.index = node["Index Name"];
  if (node["Join Type"]) planNode.joinType = node["Join Type"];
  if (node["Sort Key"]) planNode.sortKey = node["Sort Key"];
  if (node["Filter"]) planNode.filter = node["Filter"];

  // ANALYZE fields
  if (node["Actual Rows"] !== undefined) planNode.actualRows = node["Actual Rows"];
  if (node["Actual Startup Time"] !== undefined) planNode.actualStartupTime = node["Actual Startup Time"];
  if (node["Actual Total Time"] !== undefined) planNode.actualTotalTime = node["Actual Total Time"];
  if (node["Actual Loops"] !== undefined) planNode.loops = node["Actual Loops"];

  // BUFFERS fields
  if (node["Shared Hit Blocks"] !== undefined) planNode.sharedHit = node["Shared Hit Blocks"];
  if (node["Shared Read Blocks"] !== undefined) planNode.sharedRead = node["Shared Read Blocks"];
  if (node["Shared Written Blocks"] !== undefined) planNode.sharedWritten = node["Shared Written Blocks"];

  return planNode;
}
