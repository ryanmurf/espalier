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

function parsePageParams(query: Record<string, string>): { offset: number; limit: number } {
  const page = Math.max(0, parseInt(query.page ?? "0", 10) || 0);
  let size = parseInt(query.size ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;
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
      return c.json({ error: (err as Error).message }, 500);
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
      return c.json({ error: (err as Error).message }, 500);
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
    let paramIdx = 1;

    for (const colName of columnNames) {
      if (colName in body) {
        insertCols.push(sanitizeIdentifier(colName));
        values.push(body[colName]);
        paramIdx++;
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
      return c.json({ error: (err as Error).message }, 500);
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
      return c.json({ error: (err as Error).message }, 500);
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
      return c.json({ error: (err as Error).message }, 500);
    } finally {
      await conn.close();
    }
  });
}
