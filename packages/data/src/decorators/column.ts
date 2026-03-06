/**
 * Converts a camelCase string to snake_case for column name generation.
 * Examples: "firstName" -> "first_name", "createdAt" -> "created_at",
 * "HTMLParser" -> "html_parser", "userID" -> "user_id"
 */
function camelToSnakeCase(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export interface ColumnOptions {
  name?: string;
  type?: string;
  nullable?: boolean;
  unique?: boolean;
  defaultValue?: string;
  length?: number;
}

export interface ColumnMetadataEntry {
  columnName: string;
  type?: string;
  nullable?: boolean;
  unique?: boolean;
  defaultValue?: string;
  length?: number;
}

const columnMetadata = new WeakMap<object, Map<string | symbol, ColumnMetadataEntry>>();

/**
 * Known SQL type keywords that users commonly pass as the first string argument
 * to @Column() by mistake, e.g. @Column("VARCHAR(36)") or @Column("TEXT").
 * The string argument sets the COLUMN NAME, not the column type.
 */
const SQL_TYPE_KEYWORDS = new Set([
  "varchar",
  "char",
  "text",
  "nvarchar",
  "nchar",
  "clob",
  "int",
  "integer",
  "bigint",
  "smallint",
  "tinyint",
  "mediumint",
  "float",
  "double",
  "real",
  "decimal",
  "numeric",
  "boolean",
  "bool",
  "bit",
  "date",
  "time",
  "datetime",
  "timestamp",
  "timestamptz",
  "interval",
  "blob",
  "bytea",
  "binary",
  "varbinary",
  "json",
  "jsonb",
  "xml",
  "uuid",
  "serial",
  "bigserial",
  "smallserial",
  "array",
  "enum",
]);

function looksLikeSqlType(value: string): boolean {
  // Contains parentheses — e.g. VARCHAR(255), DECIMAL(10,2)
  if (value.includes("(") || value.includes(")")) return true;
  // All uppercase (common SQL type notation) with only word chars and spaces
  if (value === value.toUpperCase() && /^[A-Z][A-Z0-9\s_]*$/.test(value)) return true;
  // Matches a known SQL type keyword (case-insensitive)
  if (SQL_TYPE_KEYWORDS.has(value.toLowerCase())) return true;
  return false;
}

export function Column(options?: ColumnOptions | string) {
  return <T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void => {
    if (typeof options === "string" && looksLikeSqlType(options)) {
      throw new Error(
        `@Column("${options}") sets the column NAME, not the type. ` +
          `Use @Column({ type: "${options}" }) to set the SQL type instead.`,
      );
    }
    const opts = typeof options === "string" ? { name: options } : (options ?? {});
    const columnName = opts.name ?? camelToSnakeCase(String(context.name));

    const entry: ColumnMetadataEntry = {
      columnName,
      type: opts.type,
      nullable: opts.nullable,
      unique: opts.unique,
      defaultValue: opts.defaultValue,
      length: opts.length,
    };

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!columnMetadata.has(constructor)) {
        columnMetadata.set(constructor, new Map());
      }
      columnMetadata.get(constructor)!.set(context.name, entry);
    });
  };
}

/** Returns field -> column name mappings (backward compatible). */
export function getColumnMappings(target: object): Map<string | symbol, string> {
  const entries = columnMetadata.get(target);
  if (!entries) return new Map();
  const result = new Map<string | symbol, string>();
  for (const [field, entry] of entries) {
    result.set(field, entry.columnName);
  }
  return result;
}

/** Returns field -> explicit SQL type mappings (backward compatible). */
export function getColumnTypeMappings(target: object): Map<string | symbol, string> {
  const entries = columnMetadata.get(target);
  if (!entries) return new Map();
  const result = new Map<string | symbol, string>();
  for (const [field, entry] of entries) {
    if (entry.type) {
      result.set(field, entry.type);
    }
  }
  return result;
}

/** Returns full column metadata entries for constraint support. */
export function getColumnMetadataEntries(target: object): Map<string | symbol, ColumnMetadataEntry> {
  return columnMetadata.get(target) ?? new Map();
}
