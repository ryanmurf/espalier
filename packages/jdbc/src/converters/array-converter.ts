import type { TypeConverter } from "../type-converter.js";

export class ArrayConverter<T> implements TypeConverter<T[] | null, string | null> {
  readonly name: string;
  readonly dbType: string;

  constructor(name: string = "array", dbType: string = "text") {
    this.name = name;
    this.dbType = dbType;
  }

  toDatabaseValue(value: T[] | null): string | null {
    if (value == null) return null;
    return JSON.stringify(value);
  }

  fromDatabaseValue(value: string | null): T[] | null {
    if (value == null) return null;
    if (Array.isArray(value)) return value as T[];
    return JSON.parse(value) as T[];
  }
}

export class PostgresArrayConverter<T> implements TypeConverter<T[] | null, string | null> {
  readonly name: string;
  readonly dbType: string;

  constructor(name: string = "pg-array", dbType: string = "text[]") {
    this.name = name;
    this.dbType = dbType;
  }

  toDatabaseValue(value: T[] | null): string | null {
    if (value == null) return null;
    const escaped = (value as unknown[]).map((v) => {
      if (v == null) return "NULL";
      const str = String(v);
      if (str.includes(",") || str.includes('"') || str.includes("\\") || str.includes("{") || str.includes("}")) {
        return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      }
      return str;
    });
    return `{${escaped.join(",")}}`;
  }

  fromDatabaseValue(value: string | null): T[] | null {
    if (value == null) return null;
    if (Array.isArray(value)) return value as T[];
    // Parse Postgres array literal {a,b,c}
    if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
      return parsePostgresArray(value.slice(1, -1)) as T[];
    }
    return JSON.parse(value) as T[];
  }
}

function parsePostgresArray(inner: string): string[] {
  if (inner.length === 0) return [];
  const results: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      results.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  results.push(current);
  return results.map((v) => (v === "NULL" ? "" : v));
}
