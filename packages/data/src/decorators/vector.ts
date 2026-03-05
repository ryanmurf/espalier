import { Column } from "./column.js";

export interface VectorOptions {
  dimensions: number;
  metric?: "l2" | "cosine" | "inner_product";
  indexType?: "hnsw" | "ivfflat" | "none";
}

export interface VectorMetadataEntry {
  fieldName: string | symbol;
  columnName: string;
  dimensions: number;
  metric: "l2" | "cosine" | "inner_product";
  indexType: "hnsw" | "ivfflat" | "none";
}

/**
 * Converts a camelCase string to snake_case for column name generation.
 */
function camelToSnakeCase(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

const vectorMetadata = new WeakMap<object, Map<string | symbol, VectorMetadataEntry>>();

/**
 * @Vector field decorator — marks a field as a vector/embedding column.
 *
 * Validates dimensions, stores vector-specific metadata, and auto-registers
 * the field as a @Column with `type: 'vector(N)'`.
 *
 * @example
 * ```ts
 * @Table("documents")
 * class Document {
 *   @Id @Column() id!: string;
 *   @Vector({ dimensions: 1536, metric: 'cosine' }) embedding!: number[];
 * }
 * ```
 */
export function Vector(options: VectorOptions) {
  const { dimensions } = options;

  if (
    typeof dimensions !== "number" ||
    !Number.isInteger(dimensions) ||
    dimensions <= 0 ||
    dimensions > 65535
  ) {
    throw new Error(
      `@Vector dimensions must be a positive integer between 1 and 65535, got: ${dimensions}`,
    );
  }

  const metric = options.metric ?? "l2";
  const indexType = options.indexType ?? "hnsw";

  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const columnName = camelToSnakeCase(String(context.name));

    const entry: VectorMetadataEntry = {
      fieldName: context.name,
      columnName,
      dimensions,
      metric,
      indexType,
    };

    // Also register as a @Column with the appropriate vector type.
    const columnDecorator = Column({ type: `vector(${dimensions})` });
    columnDecorator(_target, context);

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!vectorMetadata.has(constructor)) {
        vectorMetadata.set(constructor, new Map());
      }
      vectorMetadata.get(constructor)!.set(context.name, entry);
    });
  };
}

/**
 * Returns all vector field metadata entries for an entity class.
 */
export function getVectorFields(
  target: object,
): Map<string | symbol, VectorMetadataEntry> {
  return new Map(vectorMetadata.get(target) ?? []);
}

/**
 * Returns vector metadata for a specific field, or undefined if not a vector field.
 */
export function getVectorFieldMetadata(
  target: object,
  fieldName: string | symbol,
): VectorMetadataEntry | undefined {
  const fields = vectorMetadata.get(target);
  if (!fields) return undefined;
  const entry = fields.get(fieldName);
  return entry ? { ...entry } : undefined;
}
