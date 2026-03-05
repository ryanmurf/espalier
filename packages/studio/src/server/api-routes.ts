import type { Hono } from "hono";
import type { SchemaModel, SchemaTable } from "../schema/schema-model.js";
import type { DataSource } from "espalier-jdbc";

export interface ApiRouteContext {
  schema: SchemaModel;
  dataSource: DataSource;
  readOnly: boolean;
}

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;

function findTable(schema: SchemaModel, tableName: string): SchemaTable | undefined {
  return schema.tables.find((t) => t.tableName === tableName);
}

function sanitizeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "");
}

function containsSemicolon(sql: string): boolean {
  // Check for semicolons outside of string literals, comments, and quoted identifiers
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : "";

    // Single-quoted string literal
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
          i += 2; // escaped quote ''
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && i + 1 < sql.length && sql[i + 1] === '"') {
          i += 2; // escaped quote ""
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Dollar-quoted string ($$...$$)
    if (ch === "$" && next === "$") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "$" && i + 1 < sql.length && sql[i + 1] === "$") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // Line comment (--)
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Block comment (/* ... */)
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && i + 1 < sql.length && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // Semicolon outside of any quoted/comment context
    if (ch === ";") {
      return true;
    }

    i++;
  }
  return false;
}

function isReadOnlyQuery(sql: string): boolean {
  // Strip SQL comments for analysis
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();

  // Must start with a known read keyword
  if (!/^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN|WITH|TABLE|VALUES)\b/i.test(stripped)) {
    return false;
  }

  // Reject EXPLAIN ANALYZE — it actually executes the statement
  if (/^\s*EXPLAIN\s+ANALYZE\b/i.test(stripped)) {
    return false;
  }

  // Reject SELECT ... INTO (creates tables) — allow INTO TEMP/TEMPORARY for safety
  if (/^\s*SELECT\b/i.test(stripped) && /\bINTO\s+(?!TEMP\b|TEMPORARY\b)\w/i.test(stripped)) {
    return false;
  }

  // Reject CTE (WITH) followed by DML (INSERT/UPDATE/DELETE)
  if (/^\s*WITH\b/i.test(stripped) && /\b(INSERT|UPDATE|DELETE)\b/i.test(stripped)) {
    return false;
  }

  return true;
}

function sanitizeErrorMessage(err: unknown): string {
  const msg = (err as Error).message ?? "Unknown error";
  // Strip file paths and stack traces
  return msg
    .replace(/\/[^\s:]+/g, "[path]")
    .replace(/at\s+.+/g, "")
    .trim();
}

function parsePageParams(query: Record<string, string>): { offset: number; limit: number } {
  const parsedPage = parseInt(query.page ?? "", 10);
  const page = Math.max(0, Number.isNaN(parsedPage) ? 0 : parsedPage);
  const parsedSize = parseInt(query.size ?? "", 10);
  let size = Number.isNaN(parsedSize) ? DEFAULT_PAGE_SIZE : parsedSize;
  if (size < 1) size = 1;
  if (size > MAX_PAGE_SIZE) size = MAX_PAGE_SIZE;
  return { offset: page * size, limit: size };
}

function parseSortParam(
  sort: string | undefined,
  table: SchemaTable,
): { column: string; direction: "ASC" | "DESC" } | null {
  if (!sort) return null;
  const parts = sort.split(",");
  const columnName = sanitizeIdentifier(parts[0]);
  const col = table.columns.find((c) => c.columnName === columnName);
  if (!col) return null;
  const dir = parts[1]?.toUpperCase() === "DESC" ? "DESC" as const : "ASC" as const;
  return { column: col.columnName, direction: dir };
}

export function createApiRoutes(app: Hono, ctx: ApiRouteContext): void {
  // CORS protection — reject cross-origin requests to API endpoints
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      return c.text("Cross-origin requests are not allowed", 403);
    }
    await next();
  });

  app.get("/api/schema", (c) => {
    return c.json(ctx.schema);
  });

  app.get("/api/tables", (c) => {
    const tables = ctx.schema.tables.map((t) => ({
      tableName: t.tableName,
      className: t.className,
      columnCount: t.columns.length,
      relationCount: t.relations.length,
    }));
    return c.json(tables);
  });

  app.get("/api/tables/:table", (c) => {
    const tableName = c.req.param("table");
    const table = findTable(ctx.schema, tableName);
    if (!table) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }
    return c.json(table);
  });

  app.get("/api/tables/:table/rows", async (c) => {
    const tableName = c.req.param("table");
    const table = findTable(ctx.schema, tableName);
    if (!table) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }

    const query = c.req.query();
    const { offset, limit } = parsePageParams(query);
    const sort = parseSortParam(query.sort, table);

    const safeName = sanitizeIdentifier(table.tableName);
    let sql = `SELECT * FROM ${safeName}`;
    if (sort) {
      sql += ` ORDER BY ${sort.column} ${sort.direction}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    const conn = await ctx.dataSource.getConnection();
    try {
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery(sql);
        const rows: Record<string, unknown>[] = [];
        while (await rs.next()) {
          rows.push(rs.getRow());
        }
        await rs.close();

        const countRs = await stmt.executeQuery(`SELECT COUNT(*) AS total FROM ${safeName}`);
        let total = 0;
        if (await countRs.next()) {
          total = countRs.getNumber("total") ?? 0;
        }
        await countRs.close();

        return c.json({
          rows,
          total,
          page: Math.floor(offset / limit),
          size: limit,
          totalPages: Math.ceil(total / limit),
        });
      } finally {
        await stmt.close();
      }
    } catch (err) {
      return c.json({ error: sanitizeErrorMessage(err) }, 500);
    } finally {
      await conn.close();
    }
  });

  app.get("/api/tables/:table/rows/:id", async (c) => {
    const tableName = c.req.param("table");
    const table = findTable(ctx.schema, tableName);
    if (!table) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }

    const pkCol = table.columns.find((col) => col.isPrimaryKey);
    if (!pkCol) {
      return c.json({ error: `No primary key column found for table "${tableName}"` }, 400);
    }

    const id = c.req.param("id");
    const safeName = sanitizeIdentifier(table.tableName);
    const safePk = sanitizeIdentifier(pkCol.columnName);

    const conn = await ctx.dataSource.getConnection();
    try {
      const ps = conn.prepareStatement(
        `SELECT * FROM ${safeName} WHERE ${safePk} = $1`,
      );
      try {
        ps.setParameter(1, id);
        const rs = await ps.executeQuery();
        if (await rs.next()) {
          const row = rs.getRow();
          await rs.close();
          return c.json(row);
        }
        await rs.close();
        return c.json({ error: "Row not found" }, 404);
      } finally {
        await ps.close();
      }
    } catch (err) {
      return c.json({ error: sanitizeErrorMessage(err) }, 500);
    } finally {
      await conn.close();
    }
  });

  app.post("/api/tables/:table/rows", async (c) => {
    if (ctx.readOnly) {
      return c.json({ error: "Write operations disabled. Start studio with --write-mode." }, 403);
    }

    const tableName = c.req.param("table");
    const table = findTable(ctx.schema, tableName);
    if (!table) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const columnNames = table.columns.map((col) => col.columnName);
    const insertCols: string[] = [];
    const values: unknown[] = [];

    for (const colName of columnNames) {
      if (colName in body) {
        insertCols.push(sanitizeIdentifier(colName));
        values.push(body[colName]);
      }
    }

    if (insertCols.length === 0) {
      return c.json({ error: "No valid columns provided" }, 400);
    }

    const safeName = sanitizeIdentifier(table.tableName);
    const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${safeName} (${insertCols.join(", ")}) VALUES (${placeholders})`;

    const conn = await ctx.dataSource.getConnection();
    try {
      const ps = conn.prepareStatement(sql);
      try {
        for (let i = 0; i < values.length; i++) {
          ps.setParameter(i + 1, values[i] as any);
        }
        const affected = await ps.executeUpdate();
        return c.json({ affected }, 201);
      } finally {
        await ps.close();
      }
    } catch (err) {
      return c.json({ error: sanitizeErrorMessage(err) }, 500);
    } finally {
      await conn.close();
    }
  });

  app.put("/api/tables/:table/rows/:id", async (c) => {
    if (ctx.readOnly) {
      return c.json({ error: "Write operations disabled. Start studio with --write-mode." }, 403);
    }

    const tableName = c.req.param("table");
    const table = findTable(ctx.schema, tableName);
    if (!table) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }

    const pkCol = table.columns.find((col) => col.isPrimaryKey);
    if (!pkCol) {
      return c.json({ error: `No primary key column found for table "${tableName}"` }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const columnNames = table.columns
      .filter((col) => !col.isPrimaryKey)
      .map((col) => col.columnName);
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const colName of columnNames) {
      if (colName in body) {
        setClauses.push(`${sanitizeIdentifier(colName)} = $${paramIdx}`);
        values.push(body[colName]);
        paramIdx++;
      }
    }

    if (setClauses.length === 0) {
      return c.json({ error: "No valid columns provided for update" }, 400);
    }

    const id = c.req.param("id");
    values.push(id);

    const safeName = sanitizeIdentifier(table.tableName);
    const safePk = sanitizeIdentifier(pkCol.columnName);
    const sql = `UPDATE ${safeName} SET ${setClauses.join(", ")} WHERE ${safePk} = $${paramIdx}`;

    const conn = await ctx.dataSource.getConnection();
    try {
      const ps = conn.prepareStatement(sql);
      try {
        for (let i = 0; i < values.length; i++) {
          ps.setParameter(i + 1, values[i] as any);
        }
        const affected = await ps.executeUpdate();
        if (affected === 0) {
          return c.json({ error: "Row not found" }, 404);
        }
        return c.json({ affected });
      } finally {
        await ps.close();
      }
    } catch (err) {
      return c.json({ error: sanitizeErrorMessage(err) }, 500);
    } finally {
      await conn.close();
    }
  });

  app.delete("/api/tables/:table/rows/:id", async (c) => {
    if (ctx.readOnly) {
      return c.json({ error: "Write operations disabled. Start studio with --write-mode." }, 403);
    }

    const tableName = c.req.param("table");
    const table = findTable(ctx.schema, tableName);
    if (!table) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }

    const pkCol = table.columns.find((col) => col.isPrimaryKey);
    if (!pkCol) {
      return c.json({ error: `No primary key column found for table "${tableName}"` }, 400);
    }

    const id = c.req.param("id");
    const safeName = sanitizeIdentifier(table.tableName);
    const safePk = sanitizeIdentifier(pkCol.columnName);

    const conn = await ctx.dataSource.getConnection();
    try {
      const ps = conn.prepareStatement(
        `DELETE FROM ${safeName} WHERE ${safePk} = $1`,
      );
      try {
        ps.setParameter(1, id);
        const affected = await ps.executeUpdate();
        if (affected === 0) {
          return c.json({ error: "Row not found" }, 404);
        }
        return c.json({ affected });
      } finally {
        await ps.close();
      }
    } catch (err) {
      return c.json({ error: sanitizeErrorMessage(err) }, 500);
    } finally {
      await conn.close();
    }
  });

  app.post("/api/query", async (c) => {
    let body: { sql?: string; params?: unknown[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const sql = body.sql?.trim();
    if (!sql) {
      return c.json({ error: "SQL query is required" }, 400);
    }

    if (sql.length > 10000) {
      return c.json({ error: "Query too long (max 10000 characters)" }, 400);
    }

    // Reject multi-statement queries (semicolons outside string literals)
    if (containsSemicolon(sql)) {
      return c.json(
        { error: "Multi-statement queries are not allowed. Remove semicolons." },
        400,
      );
    }

    const isReadQuery = isReadOnlyQuery(sql);

    if (!isReadQuery && ctx.readOnly) {
      return c.json(
        { error: "Write queries disabled in read-only mode. Start studio with --write-mode." },
        403,
      );
    }

    const params = Array.isArray(body.params) ? body.params : [];

    const conn = await ctx.dataSource.getConnection();
    try {
      // Set query timeout for all paths (30 seconds)
      if (!ctx.readOnly) {
        const timeoutStmt = conn.createStatement();
        try {
          await timeoutStmt.executeUpdate("SET statement_timeout = '30000'");
        } finally {
          await timeoutStmt.close();
        }
      }

      if (ctx.readOnly) {
        // Use a read-only transaction as defense-in-depth
        const tx = await conn.beginTransaction();
        try {
          const setupStmt = conn.createStatement();
          try {
            await setupStmt.executeUpdate("SET TRANSACTION READ ONLY");
            await setupStmt.executeUpdate("SET LOCAL statement_timeout = '30000'");
          } finally {
            await setupStmt.close();
          }

          const ps = conn.prepareStatement(sql);
          try {
            for (let i = 0; i < params.length; i++) {
              ps.setParameter(i + 1, params[i] as any);
            }
            const rs = await ps.executeQuery();
            const rows: Record<string, unknown>[] = [];
            let count = 0;
            const maxRows = 1000;
            while (await rs.next()) {
              if (count >= maxRows) break;
              rows.push(rs.getRow());
              count++;
            }
            await rs.close();
            await tx.commit();
            return c.json({ rows, truncated: count >= maxRows });
          } finally {
            await ps.close();
          }
        } catch (err) {
          await tx.rollback().catch(() => {});
          throw err;
        }
      } else if (isReadQuery) {
        const ps = conn.prepareStatement(sql);
        try {
          for (let i = 0; i < params.length; i++) {
            ps.setParameter(i + 1, params[i] as any);
          }
          const rs = await ps.executeQuery();
          const rows: Record<string, unknown>[] = [];
          let count = 0;
          const maxRows = 1000;
          while (await rs.next()) {
            if (count >= maxRows) break;
            rows.push(rs.getRow());
            count++;
          }
          await rs.close();
          return c.json({ rows, truncated: count >= maxRows });
        } finally {
          await ps.close();
        }
      } else {
        const ps = conn.prepareStatement(sql);
        try {
          for (let i = 0; i < params.length; i++) {
            ps.setParameter(i + 1, params[i] as any);
          }
          const affected = await ps.executeUpdate();
          return c.json({ affected, rows: [] });
        } finally {
          await ps.close();
        }
      }
    } catch (err) {
      return c.json({ error: sanitizeErrorMessage(err) }, 500);
    } finally {
      await conn.close();
    }
  });
}
