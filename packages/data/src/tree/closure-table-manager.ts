import type { Connection, SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";

/**
 * Manages closure table operations for hierarchical tree entities.
 *
 * The closure table stores all ancestor/descendant relationships with depth:
 *   ancestor_id | descendant_id | depth
 *
 * Every node has a self-referencing row with depth 0.
 */
export class ClosureTableManager {
  private readonly entityTable: string;
  private readonly closureTable: string;
  private readonly idColumn: string;

  constructor(entityTable: string, idColumn: string) {
    this.entityTable = entityTable;
    this.closureTable = `${entityTable}_closure`;
    this.idColumn = idColumn;
  }

  /** Returns the closure table name. */
  getClosureTableName(): string {
    return this.closureTable;
  }

  /**
   * Inserts closure records for a new node.
   * If parentId is provided, copies the parent's ancestor paths + adds self-reference.
   * If no parent, only adds the self-reference (root node).
   */
  async insertNode(connection: Connection, nodeId: SqlValue, parentId?: SqlValue): Promise<void> {
    const ct = quoteIdentifier(this.closureTable);

    // Self-reference: every node is its own ancestor at depth 0
    const selfSql = `INSERT INTO ${ct} ("ancestor_id", "descendant_id", "depth") VALUES ($1, $2, 0)`;
    const selfStmt = connection.prepareStatement(selfSql);
    selfStmt.setParameter(1, nodeId);
    selfStmt.setParameter(2, nodeId);
    await selfStmt.executeUpdate();

    if (parentId != null) {
      // Copy all ancestor paths of the parent, incrementing depth by 1
      const ancestorSql =
        `INSERT INTO ${ct} ("ancestor_id", "descendant_id", "depth") ` +
        `SELECT "ancestor_id", $1, "depth" + 1 FROM ${ct} WHERE "descendant_id" = $2`;
      const ancestorStmt = connection.prepareStatement(ancestorSql);
      ancestorStmt.setParameter(1, nodeId);
      ancestorStmt.setParameter(2, parentId);
      await ancestorStmt.executeUpdate();
    }
  }

  /**
   * Moves a node (and its subtree) to a new parent.
   * 1. Detach the subtree from old ancestors
   * 2. Attach the subtree under the new parent
   */
  async moveNode(connection: Connection, nodeId: SqlValue, newParentId: SqlValue): Promise<void> {
    const ct = quoteIdentifier(this.closureTable);

    // Prevent circular reference: newParentId must not be a descendant of nodeId
    const checkSql = `SELECT 1 FROM ${ct} WHERE "ancestor_id" = $1 AND "descendant_id" = $2 AND "depth" > 0`;
    const checkStmt = connection.prepareStatement(checkSql);
    checkStmt.setParameter(1, nodeId);
    checkStmt.setParameter(2, newParentId);
    const checkRs = await checkStmt.executeQuery();
    if (await checkRs.next()) {
      throw new Error("Cannot move node under its own descendant — this would create a cycle.");
    }

    // Also prevent moving a node to itself
    if (nodeId === newParentId) {
      throw new Error("Cannot move node under itself.");
    }

    // Step 1: Delete all paths from ancestors of nodeId to descendants of nodeId,
    // except the subtree-internal paths.
    const deleteSql =
      `DELETE FROM ${ct} WHERE "descendant_id" IN (` +
      `SELECT "descendant_id" FROM ${ct} WHERE "ancestor_id" = $1` +
      `) AND "ancestor_id" NOT IN (` +
      `SELECT "descendant_id" FROM ${ct} WHERE "ancestor_id" = $2` +
      `)`;
    const deleteStmt = connection.prepareStatement(deleteSql);
    deleteStmt.setParameter(1, nodeId);
    deleteStmt.setParameter(2, nodeId);
    await deleteStmt.executeUpdate();

    // Step 2: Cross-join new parent's ancestors with the subtree's descendants
    const insertSql =
      `INSERT INTO ${ct} ("ancestor_id", "descendant_id", "depth") ` +
      `SELECT a."ancestor_id", d."descendant_id", a."depth" + d."depth" + 1 ` +
      `FROM ${ct} a CROSS JOIN ${ct} d ` +
      `WHERE a."descendant_id" = $1 AND d."ancestor_id" = $2`;
    const insertStmt = connection.prepareStatement(insertSql);
    insertStmt.setParameter(1, newParentId);
    insertStmt.setParameter(2, nodeId);
    await insertStmt.executeUpdate();
  }

  /**
   * Deletes a node and all its descendants from the closure table.
   */
  async deleteNode(connection: Connection, nodeId: SqlValue): Promise<void> {
    const ct = quoteIdentifier(this.closureTable);

    // Delete all closure records where descendant is in the subtree
    const sql =
      `DELETE FROM ${ct} WHERE "descendant_id" IN (` +
      `SELECT "descendant_id" FROM ${ct} WHERE "ancestor_id" = $1` +
      `)`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, nodeId);
    await stmt.executeUpdate();
  }

  /**
   * Finds all descendant IDs of a node, optionally limited by depth.
   */
  async findDescendants(connection: Connection, nodeId: SqlValue, maxDepth?: number): Promise<SqlValue[]> {
    const ct = quoteIdentifier(this.closureTable);
    let sql = `SELECT "descendant_id" FROM ${ct} WHERE "ancestor_id" = $1 AND "depth" > 0`;
    const params: SqlValue[] = [nodeId];

    if (maxDepth != null) {
      sql += ` AND "depth" <= $2`;
      params.push(maxDepth as SqlValue);
    }

    sql += ` ORDER BY "depth"`;
    const stmt = connection.prepareStatement(sql);
    for (let i = 0; i < params.length; i++) {
      stmt.setParameter(i + 1, params[i]);
    }
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row["descendant_id"] as SqlValue);
    }
    return ids;
  }

  /**
   * Finds all ancestor IDs of a node (excluding itself).
   */
  async findAncestors(connection: Connection, nodeId: SqlValue): Promise<SqlValue[]> {
    const ct = quoteIdentifier(this.closureTable);
    const sql = `SELECT "ancestor_id" FROM ${ct} WHERE "descendant_id" = $1 AND "depth" > 0 ORDER BY "depth"`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, nodeId);
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row["ancestor_id"] as SqlValue);
    }
    return ids;
  }

  /**
   * Finds root node IDs (nodes that have no ancestors other than themselves).
   */
  async findRoots(connection: Connection): Promise<SqlValue[]> {
    const ct = quoteIdentifier(this.closureTable);
    // Roots are nodes whose only ancestor is themselves (no row with depth > 0 where they're descendant)
    const sql =
      `SELECT DISTINCT "ancestor_id" FROM ${ct} WHERE "depth" = 0 ` +
      `AND "ancestor_id" NOT IN (` +
      `SELECT "descendant_id" FROM ${ct} WHERE "depth" > 0` +
      `)`;
    const stmt = connection.prepareStatement(sql);
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row["ancestor_id"] as SqlValue);
    }
    return ids;
  }

  /**
   * Returns the depth of a node (0 for root nodes).
   */
  async getDepth(connection: Connection, nodeId: SqlValue): Promise<number> {
    const ct = quoteIdentifier(this.closureTable);
    const sql = `SELECT MAX("depth") AS "max_depth" FROM ${ct} WHERE "descendant_id" = $1`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, nodeId);
    const rs = await stmt.executeQuery();
    if (await rs.next()) {
      const row = rs.getRow();
      const val = row["max_depth"];
      return typeof val === "number" ? val : 0;
    }
    return 0;
  }

  /**
   * Finds direct children of a node (depth = 1).
   */
  async findChildren(connection: Connection, nodeId: SqlValue): Promise<SqlValue[]> {
    const ct = quoteIdentifier(this.closureTable);
    const sql = `SELECT "descendant_id" FROM ${ct} WHERE "ancestor_id" = $1 AND "depth" = 1`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, nodeId);
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row["descendant_id"] as SqlValue);
    }
    return ids;
  }

  /**
   * Finds leaf node IDs (nodes with no children).
   */
  async findLeaves(connection: Connection): Promise<SqlValue[]> {
    const ct = quoteIdentifier(this.closureTable);
    // Leaves are nodes that don't appear as ancestor_id with depth > 0
    const sql =
      `SELECT DISTINCT "descendant_id" FROM ${ct} WHERE "depth" = 0 ` +
      `AND "descendant_id" NOT IN (` +
      `SELECT "ancestor_id" FROM ${ct} WHERE "depth" > 0` +
      `)`;
    const stmt = connection.prepareStatement(sql);
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row["descendant_id"] as SqlValue);
    }
    return ids;
  }
}
