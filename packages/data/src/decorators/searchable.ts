import { Column } from "./column.js";

export interface SearchableOptions {
  /** PostgreSQL text search language. Default: 'english'. */
  language?: string;
  /** tsvector weight for ranking (A highest, D lowest). Default: 'A'. */
  weight?: "A" | "B" | "C" | "D";
  /** Index type for the generated tsvector index. Default: 'gin'. */
  indexType?: "gin" | "gist";
}

export interface SearchableMetadataEntry {
  fieldName: string | symbol;
  columnName: string;
  language: string;
  weight: "A" | "B" | "C" | "D";
  indexType: "gin" | "gist";
}

const VALID_WEIGHTS = new Set(["A", "B", "C", "D"]);
const VALID_INDEX_TYPES = new Set(["gin", "gist"]);
/** Only allow simple alphanumeric language names to prevent injection. */
const SAFE_LANGUAGE_PATTERN = /^[a-z_]+$/;

/**
 * Converts a camelCase string to snake_case for column name generation.
 */
function camelToSnakeCase(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

const searchableMetadata = new WeakMap<object, Map<string | symbol, SearchableMetadataEntry>>();

/**
 * @Searchable field decorator — marks a text field for full-text search.
 *
 * Stores search-specific metadata and auto-registers the field as a @Column
 * with type TEXT if not already specified.
 *
 * @example
 * ```ts
 * @Table("articles")
 * class Article {
 *   @Id @Column() id!: string;
 *   @Searchable({ weight: 'A' }) title!: string;
 *   @Searchable({ weight: 'B' }) body!: string;
 * }
 * ```
 */
export function Searchable(options?: SearchableOptions) {
  const language = options?.language ?? "english";
  const weight = options?.weight ?? "A";
  const indexType = options?.indexType ?? "gin";

  if (!SAFE_LANGUAGE_PATTERN.test(language)) {
    throw new Error(
      `@Searchable language must be a simple identifier (lowercase letters and underscores), got: "${language}"`,
    );
  }

  if (!VALID_WEIGHTS.has(weight)) {
    throw new Error(
      `@Searchable weight must be one of A, B, C, D, got: "${weight}"`,
    );
  }

  if (!VALID_INDEX_TYPES.has(indexType)) {
    throw new Error(
      `@Searchable indexType must be "gin" or "gist", got: "${indexType}"`,
    );
  }

  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const columnName = camelToSnakeCase(String(context.name));

    const entry: SearchableMetadataEntry = {
      fieldName: context.name,
      columnName,
      language,
      weight,
      indexType,
    };

    // Also register as a @Column with TEXT type if not already registered.
    const columnDecorator = Column({ type: "TEXT" });
    columnDecorator(_target, context);

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!searchableMetadata.has(constructor)) {
        searchableMetadata.set(constructor, new Map());
      }
      searchableMetadata.get(constructor)!.set(context.name, entry);
    });
  };
}

/**
 * Returns all searchable field metadata entries for an entity class.
 */
export function getSearchableFields(
  target: object,
): Map<string | symbol, SearchableMetadataEntry> {
  return new Map(searchableMetadata.get(target) ?? []);
}

/**
 * Returns searchable metadata for a specific field, or undefined if not searchable.
 */
export function getSearchableFieldMetadata(
  target: object,
  fieldName: string | symbol,
): SearchableMetadataEntry | undefined {
  const fields = searchableMetadata.get(target);
  if (!fields) return undefined;
  const entry = fields.get(fieldName);
  return entry ? { ...entry } : undefined;
}
