import type { Connection, DataSource } from "espalier-jdbc";
import { TenantContext } from "./tenant-context.js";

/**
 * Options for creating a RoutingDataSource.
 */
export interface RoutingDataSourceOptions {
  /** Map of route keys to their DataSources. */
  dataSources: Map<string, DataSource>;

  /** Resolves the current route key from context. */
  routeResolver: () => string | undefined;

  /** Route to use when routeResolver returns undefined. */
  defaultRoute?: string;
}

/**
 * A DataSource that routes to different underlying DataSources
 * based on a routing key resolved from context.
 */
export class RoutingDataSource implements DataSource {
  private readonly dataSources: Map<string, DataSource>;
  private readonly routeResolver: () => string | undefined;
  private readonly defaultRoute: string | undefined;

  constructor(options: RoutingDataSourceOptions) {
    this.dataSources = new Map(options.dataSources);
    this.routeResolver = options.routeResolver;
    this.defaultRoute = options.defaultRoute;
  }

  async getConnection(): Promise<Connection> {
    const route = this.routeResolver() ?? this.defaultRoute;

    if (route === undefined) {
      throw new RoutingError("No route resolved and no default route configured");
    }

    const ds = this.dataSources.get(route);
    if (!ds) {
      throw new RoutingError("No DataSource found for the resolved route");
    }

    return ds.getConnection();
  }

  async close(): Promise<void> {
    const errors: Error[] = [];
    for (const [_key, ds] of this.dataSources) {
      try {
        await ds.close();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error("Failed to close a routed DataSource"));
      }
    }
    if (errors.length > 0) {
      const msg = errors.map((e) => e.message).join("; ");
      throw new RoutingError(`Failed to close ${errors.length} DataSource(s): ${msg}`);
    }
  }

  /**
   * Add a DataSource for the given route key at runtime.
   */
  addDataSource(key: string, ds: DataSource): void {
    this.dataSources.set(key, ds);
  }

  /**
   * Remove a DataSource by route key. Returns the removed DataSource, or undefined.
   * Does NOT close the DataSource — caller is responsible for closing it.
   */
  removeDataSource(key: string): DataSource | undefined {
    const ds = this.dataSources.get(key);
    this.dataSources.delete(key);
    return ds;
  }

  /**
   * Returns the set of currently registered route keys.
   */
  getRoutes(): ReadonlySet<string> {
    return new Set(this.dataSources.keys());
  }
}

/**
 * A RoutingDataSource that uses TenantContext.current() as the route key.
 * Each tenant maps to its own DataSource.
 */
export class TenantRoutingDataSource extends RoutingDataSource {
  constructor(options: Omit<RoutingDataSourceOptions, "routeResolver"> & { defaultRoute?: string }) {
    super({
      dataSources: options.dataSources,
      routeResolver: () => TenantContext.current(),
      defaultRoute: options.defaultRoute,
    });
  }
}

/**
 * Error thrown when connection routing fails.
 * Messages are kept generic to avoid leaking internal route topology.
 */
export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }

  /** Returns a generic message safe for external API responses. */
  toSafeString(): string {
    return "Connection routing failed";
  }

  /** Omits internal details from JSON serialization. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.toSafeString(),
    };
  }
}
