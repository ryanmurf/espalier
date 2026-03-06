import type { Connection, SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";

/**
 * Escape LIKE metacharacters in a user-supplied value.
 * Prevents wildcard injection by escaping %, _, and \.
 */
function escapeLikeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Manages materialized path operations for hierarchical tree entities.
 *
 * Path format: "/1/2/3/" — leading and trailing separator.
 * Depth is derived from the path string (count of IDs in path).
 */
export class MaterializedPathManager {
  private readonly entityTable: string;
  private readonly idColumn: string;
  private readonly pathColumn: string;
  private readonly separator: string;

  constructor(entityTable: string, idColumn: string, pathColumn: string, separator: string = "/") {
    this.entityTable = entityTable;
    this.idColumn = idColumn;
    this.pathColumn = pathColumn;
    this.separator = separator;
  }

  /**
   * Builds the path for a new node given its parent's path.
   * If no parentPath, returns "/nodeId/" (root).
   */
  buildPath(nodeId: string | number, parentPath?: string): string {
    const s = this.separator;
    const id = String(nodeId);
    if (id.includes(s)) {
      throw new Error(`Node ID "${id}" must not contain the path separator "${s}".`);
    }
    if (!parentPath) {
      return `${s}${id}${s}`;
    }
    return `${parentPath}${id}${s}`;
  }

  /**
   * Finds all descendant IDs of a node by matching the path prefix.
   */
  async findDescendants(connection: Connection, nodePath: string, maxDepth?: number): Promise<SqlValue[]> {
    const table = quoteIdentifier(this.entityTable);
    const pathCol = quoteIdentifier(this.pathColumn);
    const idCol = quoteIdentifier(this.idColumn);
    const escapedPath = escapeLikeValue(nodePath);

    let sql = `SELECT ${idCol} FROM ${table} WHERE ${pathCol} LIKE $1 AND ${pathCol} <> $2`;
    const params: SqlValue[] = [`${escapedPath}%` as SqlValue, nodePath as SqlValue];

    if (maxDepth != null) {
      // Filter by depth relative to the node
      const nodeDepth = this.getDepthFromPath(nodePath);
      const maxAbsoluteDepth = nodeDepth + maxDepth;
      // Count separators in path to determine depth
      sql += ` AND (LENGTH(${pathCol}) - LENGTH(REPLACE(${pathCol}, $3, ''))) <= $4`;
      params.push(this.separator as SqlValue, (maxAbsoluteDepth + 1) as SqlValue);
    }

    const stmt = connection.prepareStatement(sql);
    for (let i = 0; i < params.length; i++) {
      stmt.setParameter(i + 1, params[i]);
    }
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row[this.idColumn] as SqlValue);
    }
    return ids;
  }

  /**
   * Finds all ancestor IDs of a node by parsing its path.
   */
  findAncestorIdsFromPath(nodePath: string): string[] {
    const parts = nodePath.split(this.separator).filter(Boolean);
    // All parts except the last are ancestors
    return parts.slice(0, -1);
  }

  /**
   * Moves a node and all its descendants to a new parent path.
   * Updates all descendants whose path starts with the old node path.
   */
  async moveNode(connection: Connection, nodeId: SqlValue, oldPath: string, newParentPath: string): Promise<void> {
    const s = this.separator;
    const newNodePath = `${newParentPath}${String(nodeId)}${s}`;

    // Validate: new parent cannot be a descendant (circular reference check)
    if (newParentPath.startsWith(oldPath)) {
      throw new Error(`Cannot move node ${String(nodeId)}: new parent is a descendant of the node.`);
    }

    const table = quoteIdentifier(this.entityTable);
    const pathCol = quoteIdentifier(this.pathColumn);
    const escapedOldPath = escapeLikeValue(oldPath);

    // Update the node and all descendants: replace old path prefix with new path.
    // For the node itself, SUBSTRING(oldPath FROM len+1) = '', so it becomes newNodePath.
    // For descendants, the old prefix is replaced with the new one.
    const sql = `UPDATE ${table} SET ${pathCol} = $1 || SUBSTRING(${pathCol} FROM $2) ` + `WHERE ${pathCol} LIKE $3`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, newNodePath as SqlValue);
    stmt.setParameter(2, (oldPath.length + 1) as SqlValue);
    stmt.setParameter(3, `${escapedOldPath}%` as SqlValue);
    await stmt.executeUpdate();
  }

  /**
   * Returns the depth of a node from its path.
   * Depth is the number of IDs in the path minus 1 (root = 0).
   */
  getDepthFromPath(nodePath: string): number {
    const parts = nodePath.split(this.separator).filter(Boolean);
    return Math.max(0, parts.length - 1);
  }

  /**
   * Finds root node IDs (nodes with depth 0, path = "/id/").
   */
  async findRoots(connection: Connection): Promise<SqlValue[]> {
    const table = quoteIdentifier(this.entityTable);
    const pathCol = quoteIdentifier(this.pathColumn);
    const idCol = quoteIdentifier(this.idColumn);
    const s = this.separator;

    // Roots have exactly 2 separators in their path
    const sql =
      `SELECT ${idCol} FROM ${table} WHERE ${pathCol} LIKE $1 ` +
      `AND (LENGTH(${pathCol}) - LENGTH(REPLACE(${pathCol}, $2, ''))) = 2`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, `${s}%${s}` as SqlValue);
    stmt.setParameter(2, s as SqlValue);
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row[this.idColumn] as SqlValue);
    }
    return ids;
  }

  /**
   * Finds leaf node IDs (nodes whose path is not a prefix of any other node's path).
   */
  async findLeaves(connection: Connection): Promise<SqlValue[]> {
    const table = quoteIdentifier(this.entityTable);
    const pathCol = quoteIdentifier(this.pathColumn);
    const idCol = quoteIdentifier(this.idColumn);

    const sql =
      `SELECT a.${idCol} FROM ${table} a WHERE NOT EXISTS (` +
      `SELECT 1 FROM ${table} b WHERE b.${pathCol} LIKE a.${pathCol} || $1 AND b.${idCol} <> a.${idCol}` +
      `)`;
    const stmt = connection.prepareStatement(sql);
    stmt.setParameter(1, `%` as SqlValue);
    const rs = await stmt.executeQuery();
    const ids: SqlValue[] = [];
    while (await rs.next()) {
      const row = rs.getRow();
      ids.push(row[this.idColumn] as SqlValue);
    }
    return ids;
  }
}
