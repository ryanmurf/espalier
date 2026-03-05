import { quoteIdentifier, validateIdentifier } from "espalier-jdbc";
import type { VectorMetadataEntry } from "../decorators/vector.js";

/**
 * Supported distance metrics for vector similarity search.
 */
export type VectorMetric = "l2" | "cosine" | "inner_product";

/**
 * Options for creating a vector index via DDL.
 */
export interface VectorIndexOptions {
  tableName: string;
  columnName: string;
  dimensions: number;
  metric: VectorMetric;
  indexType: "hnsw" | "ivfflat";
  /** HNSW: max connections per node (default 16) */
  m?: number;
  /** HNSW: build-time search width (default 64) */
  efConstruction?: number;
  /** IVFFlat: number of inverted lists (default 100) */
  lists?: number;
  /** PostgreSQL schema to qualify table names with. */
  schema?: string;
}

/**
 * Qualifies a table name with a schema prefix if provided.
 */
function qualifyTableName(tableName: string, schema?: string): string {
  if (!schema) return quoteIdentifier(tableName);
  validateIdentifier(schema, "schema");
  return `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
}

/**
 * Generates DDL for pgvector HNSW and IVFFlat indexes.
 *
 * Supports the three standard distance metrics (L2, cosine, inner product)
 * and their corresponding operator classes in pgvector.
 */
export class VectorIndexManager {
  /**
   * Generates `CREATE EXTENSION IF NOT EXISTS vector` statement.
   */
  generateCreateExtension(): string {
    return "CREATE EXTENSION IF NOT EXISTS vector";
  }

  /**
   * Maps a distance metric to the corresponding pgvector operator class.
   */
  getOperatorClass(metric: VectorMetric): string {
    switch (metric) {
      case "l2":
        return "vector_l2_ops";
      case "cosine":
        return "vector_cosine_ops";
      case "inner_product":
        return "vector_ip_ops";
      default: {
        const exhaustive: never = metric;
        throw new Error(`Unknown vector metric: ${exhaustive as string}`);
      }
    }
  }

  /**
   * Generates a CREATE INDEX statement for a vector column.
   *
   * @example HNSW
   * ```sql
   * CREATE INDEX "idx_documents_embedding_hnsw"
   *   ON "documents"
   *   USING hnsw ("embedding" vector_cosine_ops)
   *   WITH (m = 16, ef_construction = 64)
   * ```
   *
   * @example IVFFlat
   * ```sql
   * CREATE INDEX "idx_documents_embedding_ivfflat"
   *   ON "documents"
   *   USING ivfflat ("embedding" vector_l2_ops)
   *   WITH (lists = 100)
   * ```
   */
  generateCreateIndex(options: VectorIndexOptions): string {
    const {
      tableName,
      columnName,
      metric,
      indexType,
      schema,
    } = options;

    validateIdentifier(tableName, "tableName");
    validateIdentifier(columnName, "columnName");

    const indexName = `idx_${tableName}_${columnName}_${indexType}`;
    const operatorClass = this.getOperatorClass(metric);
    const qualifiedTable = qualifyTableName(tableName, schema);

    const parts: string[] = [
      `CREATE INDEX ${quoteIdentifier(indexName)}`,
      `ON ${qualifiedTable}`,
      `USING ${indexType} (${quoteIdentifier(columnName)} ${operatorClass})`,
    ];

    const withParams = this.buildWithParams(options);
    if (withParams) {
      parts.push(`WITH (${withParams})`);
    }

    return parts.join(" ");
  }

  /**
   * Generates DROP INDEX statements for a vector index.
   * Drops both HNSW and IVFFlat variants if they exist.
   */
  generateDropIndex(tableName: string, columnName: string): string[] {
    validateIdentifier(tableName, "tableName");
    validateIdentifier(columnName, "columnName");

    return [
      `DROP INDEX IF EXISTS ${quoteIdentifier(`idx_${tableName}_${columnName}_hnsw`)}`,
      `DROP INDEX IF EXISTS ${quoteIdentifier(`idx_${tableName}_${columnName}_ivfflat`)}`,
    ];
  }

  /**
   * Convenience method: generates index DDL from a VectorMetadataEntry and table name.
   * Returns undefined if the entry's indexType is "none".
   */
  generateIndexFromMetadata(
    tableName: string,
    entry: VectorMetadataEntry,
    schema?: string,
  ): string | undefined {
    if (entry.indexType === "none") return undefined;

    return this.generateCreateIndex({
      tableName,
      columnName: entry.columnName,
      dimensions: entry.dimensions,
      metric: entry.metric,
      indexType: entry.indexType,
      schema,
    });
  }

  /**
   * Builds the WITH (...) parameter string for index-specific options.
   */
  private buildWithParams(options: VectorIndexOptions): string | undefined {
    const params: string[] = [];

    if (options.indexType === "hnsw") {
      const m = options.m ?? 16;
      const efConstruction = options.efConstruction ?? 64;

      if (!Number.isInteger(m) || m < 2 || m > 100) {
        throw new Error(`HNSW m must be an integer between 2 and 100, got: ${m}`);
      }
      if (!Number.isInteger(efConstruction) || efConstruction < 1 || efConstruction > 1000) {
        throw new Error(
          `HNSW ef_construction must be an integer between 1 and 1000, got: ${efConstruction}`,
        );
      }

      params.push(`m = ${m}`, `ef_construction = ${efConstruction}`);
    } else if (options.indexType === "ivfflat") {
      const lists = options.lists ?? 100;

      if (!Number.isInteger(lists) || lists < 1 || lists > 10000) {
        throw new Error(`IVFFlat lists must be an integer between 1 and 10000, got: ${lists}`);
      }

      params.push(`lists = ${lists}`);
    }

    return params.length > 0 ? params.join(", ") : undefined;
  }
}
