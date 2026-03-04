import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection, DataSource } from "espalier-jdbc";

/**
 * Context flag for read/write routing.
 */
type ReadWriteMode = "read-only" | "read-write";

const rwStorage = new AsyncLocalStorage<ReadWriteMode>();

/**
 * Controls whether the current async context is read-only or read-write.
 * Used by ReadReplicaDataSource to route queries to replicas or primary.
 */
export class ReadWriteContext {
  /**
   * Executes `fn` in a read-only context. ReadReplicaDataSource will route
   * getConnection() calls to a replica within this scope.
   */
  static runReadOnly<T>(fn: () => T | Promise<T>): Promise<T> {
    return rwStorage.run("read-only", async () => fn());
  }

  /**
   * Executes `fn` in an explicit read-write context.
   * This is the default behavior, but can be used to override an outer read-only scope.
   */
  static runReadWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    return rwStorage.run("read-write", async () => fn());
  }

  /**
   * Returns true if the current context is read-only.
   */
  static isReadOnly(): boolean {
    return rwStorage.getStore() === "read-only";
  }
}

/**
 * Interface for selecting a replica DataSource from a pool.
 */
export interface LoadBalancer {
  pick(replicas: DataSource[]): DataSource;
}

/**
 * Round-robin load balancer. Cycles through replicas in order.
 */
export class RoundRobinBalancer implements LoadBalancer {
  private index = 0;

  pick(replicas: DataSource[]): DataSource {
    const ds = replicas[this.index % replicas.length];
    this.index = (this.index + 1) % replicas.length;
    return ds;
  }
}

/**
 * Random load balancer. Picks a random replica each time.
 */
export class RandomBalancer implements LoadBalancer {
  pick(replicas: DataSource[]): DataSource {
    return replicas[Math.floor(Math.random() * replicas.length)];
  }
}

/**
 * Options for creating a ReadReplicaDataSource.
 */
export interface ReadReplicaDataSourceOptions {
  /** The primary (read-write) DataSource. */
  primary: DataSource;

  /** Read-replica DataSources. If empty, all queries go to primary. */
  replicas: DataSource[];

  /** Strategy for selecting a replica. Defaults to round-robin. */
  loadBalancer?: LoadBalancer;

  /**
   * Whether to fall back to the primary when a replica connection fails.
   * Defaults to true.
   */
  fallbackToPrimary?: boolean;
}

/**
 * A DataSource that routes to read replicas for read-only operations
 * and to the primary for all write operations.
 *
 * Use `ReadWriteContext.runReadOnly()` to mark a scope as read-only.
 * By default (no context), all queries go to the primary.
 */
export class ReadReplicaDataSource implements DataSource {
  private readonly primary: DataSource;
  private readonly replicas: DataSource[];
  private readonly loadBalancer: LoadBalancer;
  private readonly fallbackToPrimary: boolean;

  constructor(options: ReadReplicaDataSourceOptions) {
    this.primary = options.primary;
    this.replicas = [...options.replicas];
    this.loadBalancer = options.loadBalancer ?? new RoundRobinBalancer();
    this.fallbackToPrimary = options.fallbackToPrimary ?? true;
  }

  async getConnection(): Promise<Connection> {
    if (ReadWriteContext.isReadOnly() && this.replicas.length > 0) {
      const replica = this.loadBalancer.pick(this.replicas);
      try {
        return await replica.getConnection();
      } catch (err) {
        if (this.fallbackToPrimary) {
          return this.primary.getConnection();
        }
        throw err;
      }
    }
    return this.primary.getConnection();
  }

  async close(): Promise<void> {
    const errors: Error[] = [];

    try {
      await this.primary.close();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    for (const replica of this.replicas) {
      try {
        await replica.close();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (errors.length > 0) {
      const msg = errors.map((e) => e.message).join("; ");
      throw new Error(`Failed to close ${errors.length} DataSource(s): ${msg}`);
    }
  }
}
