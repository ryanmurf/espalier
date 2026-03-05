import initSqlJs, { type Database } from "sql.js";
import type { PlaygroundOptions, PlaygroundResult } from "./types.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const SAFE_TYPE_RE = /^[A-Za-z][A-Za-z0-9_ ]*(\(\d+\))?$/;

function validateType(type: string): string {
  if (!SAFE_TYPE_RE.test(type.trim())) {
    throw new Error(`Invalid column type: "${type}"`);
  }
  return type;
}

export class PlaygroundEngine {
  private db: Database | null = null;
  private sqlLog: string[] = [];
  private readonly options: PlaygroundOptions;

  constructor(options?: PlaygroundOptions) {
    this.options = options ?? {};
  }

  private async ensureDb(): Promise<Database> {
    if (!this.db) {
      const SQL = await initSqlJs();
      this.db = new SQL.Database();
      await this.applyPreloads();
    }
    return this.db;
  }

  private async applyPreloads(): Promise<void> {
    if (!this.db) return;

    if (this.options.preloadEntities) {
      for (const entity of this.options.preloadEntities) {
        const tableName = entity?.tableName ?? entity?.name?.toLowerCase();
        if (!tableName) continue;
        const columns = entity?.columns;
        if (Array.isArray(columns) && columns.length > 0) {
          const colDefs = columns
            .map((c: { name: string; type?: string }) => `${quoteIdent(c.name)} ${validateType(c.type ?? "TEXT")}`)
            .join(", ");
          const ddl = `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (${colDefs})`;
          this.db.run(ddl);
          this.sqlLog.push(ddl);
        }
      }
    }

    if (this.options.preloadData) {
      for (const [table, rows] of Object.entries(this.options.preloadData)) {
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.length === 0) continue;
          const cols = keys.map((k) => quoteIdent(k)).join(", ");
          const placeholders = keys.map(() => "?").join(", ");
          const values = keys.map((k) => row[k]);
          const sql = `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${placeholders})`;
          this.db.run(sql, values);
          this.sqlLog.push(sql);
        }
      }
    }
  }

  async execute(code: string): Promise<PlaygroundResult> {
    const start = performance.now();
    this.sqlLog = [];

    try {
      const db = await this.ensureDb();
      const sqlStatements = this.extractSqlStatements(code);

      let output: any = null;

      for (const sql of sqlStatements) {
        this.sqlLog.push(sql);
        const trimmed = sql.trim().toUpperCase();

        if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN")) {
          const result = db.exec(sql);
          output = result.length > 0
            ? result[0].values.map((row: any[]) => {
                const obj: Record<string, any> = {};
                result[0].columns.forEach((col: string, i: number) => {
                  obj[col] = row[i];
                });
                return obj;
              })
            : [];
        } else {
          db.run(sql);
          const changes = db.getRowsModified();
          output = { rowsAffected: changes };
        }
      }

      const duration = performance.now() - start;
      return {
        success: true,
        output,
        sql: [...this.sqlLog],
        duration,
      };
    } catch (err: unknown) {
      const duration = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: null,
        sql: [...this.sqlLog],
        duration,
        error: message,
      };
    }
  }

  private extractSqlStatements(code: string): string[] {
    const statements: string[] = [];
    const lines = code.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("--")) {
        continue;
      }
      // Collect lines that look like SQL statements
      if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed)) {
        statements.push(trimmed.replace(/;$/, ""));
      }
    }

    // If no SQL statements found, try treating the whole input as a single statement
    if (statements.length === 0) {
      const cleaned = code.trim().replace(/;$/, "");
      if (cleaned.length > 0) {
        statements.push(cleaned);
      }
    }

    return statements;
  }

  async reset(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.sqlLog = [];
  }

  async getSchema(): Promise<string> {
    const db = await this.ensureDb();
    const result = db.exec(
      "SELECT sql FROM sqlite_master WHERE type IN ('table', 'index', 'view') AND sql IS NOT NULL ORDER BY type, name"
    );
    if (result.length === 0) return "";
    return result[0].values.map((row: any[]) => `${row[0]};`).join("\n\n");
  }
}
