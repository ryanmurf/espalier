import type { DataSource, SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import type { RowMapper } from "../mapping/row-mapper.js";

/**
 * Configuration for the QueryBatcher.
 */
export interface QueryBatcherConfig {
  /** Maximum number of IDs to batch in a single query. Default: 1000. */
  maxBatchSize?: number;
  /**
   * Scheduling strategy for batch execution.
   * - "microtask": execute on the next microtask (Promise.resolve().then)
   * - "nextTick": execute on process.nextTick (Node.js only)
   * Default: "microtask".
   */
  schedule?: "microtask" | "nextTick";
}

interface PendingRequest<T> {
  id: unknown;
  resolve: (value: T | null) => void;
  reject: (error: Error) => void;
}

/**
 * Batches multiple findById calls within the same microtask into a single
 * WHERE id IN (...) query. Similar to the DataLoader pattern.
 *
 * Each QueryBatcher instance handles a single entity type.
 */
export class QueryBatcher<T> {
  private readonly dataSource: DataSource;
  private readonly metadata: EntityMetadata;
  private readonly rowMapper: RowMapper<T>;
  private readonly maxBatchSize: number;
  private readonly schedule: "microtask" | "nextTick";
  private pending: PendingRequest<T>[] = [];
  private scheduled = false;

  constructor(dataSource: DataSource, metadata: EntityMetadata, rowMapper: RowMapper<T>, config?: QueryBatcherConfig) {
    this.dataSource = dataSource;
    this.metadata = metadata;
    this.rowMapper = rowMapper;
    this.maxBatchSize = config?.maxBatchSize ?? 1000;
    this.schedule = config?.schedule ?? "microtask";
  }

  /**
   * Load an entity by ID. The actual query is deferred and batched
   * with other requests from the same tick.
   */
  load(id: unknown): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      this.pending.push({ id, resolve, reject });

      if (!this.scheduled) {
        this.scheduled = true;
        if (this.schedule === "nextTick" && typeof process !== "undefined" && process.nextTick) {
          process.nextTick(() => this.executeBatch());
        } else {
          Promise.resolve().then(() => this.executeBatch());
        }
      }
    });
  }

  private async executeBatch(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.scheduled = false;

    if (batch.length === 0) return;

    // Process in chunks of maxBatchSize
    for (let i = 0; i < batch.length; i += this.maxBatchSize) {
      const chunk = batch.slice(i, i + this.maxBatchSize);
      await this.executeChunk(chunk);
    }
  }

  private async executeChunk(chunk: PendingRequest<T>[]): Promise<void> {
    // Deduplicate IDs by string representation.
    // Note: IDs are deduplicated by string representation. Integer 1 and
    // string "1" are treated as the same ID. This matches typical DB behavior
    // where parameter binding normalizes types.
    const idMap = new Map<string, PendingRequest<T>[]>();
    for (const req of chunk) {
      const key = String(req.id);
      const existing = idMap.get(key);
      if (existing) {
        existing.push(req);
      } else {
        idMap.set(key, [req]);
      }
    }

    // Normalize IDs to strings for consistent dedup — mirrors the string-keyed
    // idMap above so that integer 1 and string "1" are treated as the same key.
    const idValues = [...new Set(chunk.map((r) => String(r.id)))];

    // Find the ID column
    const idField = this.metadata.fields.find((f: FieldMapping) => f.fieldName === this.metadata.idField);
    if (!idField) {
      const err = new Error(`Cannot find ID column for entity "${this.metadata.tableName}"`);
      for (const req of chunk) req.reject(err);
      return;
    }

    const columns = this.metadata.fields.map((f: FieldMapping) => quoteIdentifier(f.columnName));
    const table = quoteIdentifier(this.metadata.tableName);
    const idCol = quoteIdentifier(idField.columnName);

    // Build parameterized IN query
    const placeholders = idValues.map((_, i) => `$${i + 1}`);
    const sql = `SELECT ${columns.join(", ")} FROM ${table} WHERE ${idCol} IN (${placeholders.join(", ")})`;

    // Collect results first, then close resources, then resolve/reject callers
    let resultMap: Map<string, T> | undefined;
    let queryError: Error | undefined;

    try {
      const conn = await this.dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(sql);
        try {
          for (let i = 0; i < idValues.length; i++) {
            stmt.setParameter(i + 1, idValues[i] as SqlValue);
          }
          const rs = await stmt.executeQuery();

          resultMap = new Map<string, T>();
          while (await rs.next()) {
            const entity = this.rowMapper.mapRow(rs);
            const entityId = (entity as any)[this.metadata.idField as string];
            resultMap.set(String(entityId), entity);
          }
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    } catch (err) {
      queryError = err instanceof Error ? err : new Error(String(err));
    }

    // Resolve or reject after all resources are closed
    if (queryError) {
      for (const req of chunk) {
        req.reject(queryError);
      }
    } else {
      for (const [idKey, requests] of idMap) {
        const result = resultMap!.get(idKey) ?? null;
        for (const req of requests) {
          req.resolve(result);
        }
      }
    }
  }

  /**
   * Clear any pending (unscheduled) requests and reset state.
   * Useful for testing.
   */
  clear(): void {
    this.pending = [];
    this.scheduled = false;
  }
}

/**
 * Registry that manages QueryBatcher instances per entity class.
 */
export class QueryBatcherRegistry {
  private readonly batchers = new Map<Function, QueryBatcher<any>>();
  private readonly dataSource: DataSource;
  private readonly config?: QueryBatcherConfig;

  constructor(dataSource: DataSource, config?: QueryBatcherConfig) {
    this.dataSource = dataSource;
    this.config = config;
  }

  /**
   * Get or create a batcher for the given entity class.
   */
  getBatcher<T>(
    entityClass: new (...args: any[]) => T,
    metadata: EntityMetadata,
    rowMapper: RowMapper<T>,
  ): QueryBatcher<T> {
    let batcher = this.batchers.get(entityClass);
    if (!batcher) {
      batcher = new QueryBatcher(this.dataSource, metadata, rowMapper, this.config);
      this.batchers.set(entityClass, batcher);
    }
    return batcher as QueryBatcher<T>;
  }

  /**
   * Clear all batchers.
   */
  clear(): void {
    for (const batcher of this.batchers.values()) {
      batcher.clear();
    }
    this.batchers.clear();
  }
}
