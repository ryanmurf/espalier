import type {
  TracerProvider,
  SlowQueryEvent,
  HealthCheck,
  DataSource,
  MonitoredPooledDataSource,
} from "espalier-jdbc";
import {
  setGlobalTracerProvider,
  SlowQueryDetector,
  QueryStatisticsCollector,
  HealthCheckRegistry,
  PoolHealthCheck,
  ConnectivityHealthCheck,
} from "espalier-jdbc";

/**
 * Unified observability configuration.
 */
export interface ObservabilityConfig {
  /** Custom tracer provider. When set, enables distributed tracing. */
  tracerProvider?: TracerProvider;
  /** Slow query threshold in ms. Default: 1000. */
  slowQueryThresholdMs?: number;
  /** Callback invoked when a slow query is detected. */
  slowQueryCallback?: (event: SlowQueryEvent) => void;
  /** Enable per-pattern query statistics collection. Default: false. */
  enableQueryStatistics?: boolean;
  /** Maximum number of query patterns to track. Default: 1000. */
  maxQueryPatterns?: number;
  /** Additional health checks to register. */
  healthChecks?: HealthCheck[];
  /** Max pool connections for PoolHealthCheck. Default: 20. */
  maxPoolConnections?: number;
  /** Connectivity probe timeout in ms. Default: 5000. */
  connectivityTimeoutMs?: number;
  /**
   * Wire the slow query detector into the adapter layer.
   * For PG: pass `setSlowQueryDetector` from espalier-jdbc-pg.
   */
  wireSlowQueryDetector?: (detector: SlowQueryDetector) => void;
  /**
   * Wire the query statistics collector into the adapter layer.
   * For PG: pass `setQueryStatisticsCollector` from espalier-jdbc-pg.
   */
  wireQueryStatisticsCollector?: (collector: QueryStatisticsCollector) => void;
}

/**
 * Handle returned by configureObservability with access to observability components.
 */
export interface ObservabilityHandle {
  /** The health check registry with all registered checks. */
  getHealthRegistry(): HealthCheckRegistry;
  /** The query statistics collector (undefined if not enabled). */
  getQueryStatistics(): QueryStatisticsCollector | undefined;
  /** The slow query detector. */
  getSlowQueryDetector(): SlowQueryDetector;
}

function isMonitoredPool(ds: DataSource): ds is MonitoredPooledDataSource {
  return "getPoolStats" in ds && typeof (ds as any).getPoolStats === "function";
}

/**
 * Configures observability for a DataSource with a single function call.
 * Sets up tracing, slow query detection, statistics collection, and health checks.
 */
export function configureObservability(
  dataSource: DataSource,
  config: ObservabilityConfig = {},
): ObservabilityHandle {
  // 1. Tracing
  if (config.tracerProvider) {
    setGlobalTracerProvider(config.tracerProvider);
  }

  // 2. Slow query detection
  const slowQueryDetector = new SlowQueryDetector({
    thresholdMs: config.slowQueryThresholdMs ?? 1000,
    callback: config.slowQueryCallback,
  });
  config.wireSlowQueryDetector?.(slowQueryDetector);

  // 3. Query statistics
  let statsCollector: QueryStatisticsCollector | undefined;
  if (config.enableQueryStatistics) {
    statsCollector = new QueryStatisticsCollector(config.maxQueryPatterns ?? 1000);
    config.wireQueryStatisticsCollector?.(statsCollector);
  }

  // 4. Health checks
  const registry = new HealthCheckRegistry();

  // Default: connectivity check
  registry.register(new ConnectivityHealthCheck("connectivity", dataSource, {
    timeoutMs: config.connectivityTimeoutMs ?? 5000,
  }));

  // Default: pool health check (if monitored pool)
  if (isMonitoredPool(dataSource)) {
    registry.register(new PoolHealthCheck("pool", dataSource, config.maxPoolConnections ?? 20));
  }

  // Register additional checks
  if (config.healthChecks) {
    for (const check of config.healthChecks) {
      registry.register(check);
    }
  }

  return {
    getHealthRegistry: () => registry,
    getQueryStatistics: () => statsCollector,
    getSlowQueryDetector: () => slowQueryDetector,
  };
}
