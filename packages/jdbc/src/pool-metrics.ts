import type {
  AcquireEvent,
  ErrorEvent,
  PoolEventListener,
  PoolMonitor,
  ReleaseEvent,
  TimeoutEvent,
} from "./pool-monitor.js";

export interface PoolMetricsSnapshot {
  totalAcquires: number;
  totalReleases: number;
  totalTimeouts: number;
  totalErrors: number;
  avgAcquireTimeMs: number;
  maxAcquireTimeMs: number;
  avgHeldTimeMs: number;
  maxHeldTimeMs: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  warmupConnectionsCreated?: number;
  prePingSuccesses?: number;
  prePingFailures?: number;
  deadConnectionsEvicted?: number;
}

export interface PoolMetricsCollector extends PoolMonitor {
  getMetrics(): PoolMetricsSnapshot;
  reset(): void;
}

export class DefaultPoolMetricsCollector implements PoolMetricsCollector {
  private acquireListeners: PoolEventListener<AcquireEvent>[] = [];
  private releaseListeners: PoolEventListener<ReleaseEvent>[] = [];
  private timeoutListeners: PoolEventListener<TimeoutEvent>[] = [];
  private errorListeners: PoolEventListener<ErrorEvent>[] = [];

  private totalAcquires = 0;
  private totalReleases = 0;
  private totalTimeouts = 0;
  private totalErrors = 0;
  private totalAcquireTimeMs = 0;
  private maxAcquireTimeMs = 0;
  private totalHeldTimeMs = 0;
  private maxHeldTimeMs = 0;

  private lastActiveConnections = 0;
  private lastIdleConnections = 0;
  private lastWaitingRequests = 0;

  onAcquire(listener: PoolEventListener<AcquireEvent>): void {
    this.acquireListeners.push(listener);
  }

  onRelease(listener: PoolEventListener<ReleaseEvent>): void {
    this.releaseListeners.push(listener);
  }

  onTimeout(listener: PoolEventListener<TimeoutEvent>): void {
    this.timeoutListeners.push(listener);
  }

  onError(listener: PoolEventListener<ErrorEvent>): void {
    this.errorListeners.push(listener);
  }

  removeAllListeners(): void {
    this.acquireListeners = [];
    this.releaseListeners = [];
    this.timeoutListeners = [];
    this.errorListeners = [];
  }

  emitAcquire(event: AcquireEvent): void {
    this.totalAcquires++;
    this.totalAcquireTimeMs += event.acquireTimeMs;
    if (event.acquireTimeMs > this.maxAcquireTimeMs) {
      this.maxAcquireTimeMs = event.acquireTimeMs;
    }
    this.updatePoolStats(event);
    for (const listener of this.acquireListeners) {
      listener(event);
    }
  }

  emitRelease(event: ReleaseEvent): void {
    this.totalReleases++;
    this.totalHeldTimeMs += event.heldTimeMs;
    if (event.heldTimeMs > this.maxHeldTimeMs) {
      this.maxHeldTimeMs = event.heldTimeMs;
    }
    this.updatePoolStats(event);
    for (const listener of this.releaseListeners) {
      listener(event);
    }
  }

  emitTimeout(event: TimeoutEvent): void {
    this.totalTimeouts++;
    this.updatePoolStats(event);
    for (const listener of this.timeoutListeners) {
      listener(event);
    }
  }

  emitError(event: ErrorEvent): void {
    this.totalErrors++;
    this.updatePoolStats(event);
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }

  getMetrics(): PoolMetricsSnapshot {
    return {
      totalAcquires: this.totalAcquires,
      totalReleases: this.totalReleases,
      totalTimeouts: this.totalTimeouts,
      totalErrors: this.totalErrors,
      avgAcquireTimeMs: this.totalAcquires > 0 ? this.totalAcquireTimeMs / this.totalAcquires : 0,
      maxAcquireTimeMs: this.maxAcquireTimeMs,
      avgHeldTimeMs: this.totalReleases > 0 ? this.totalHeldTimeMs / this.totalReleases : 0,
      maxHeldTimeMs: this.maxHeldTimeMs,
      activeConnections: this.lastActiveConnections,
      idleConnections: this.lastIdleConnections,
      waitingRequests: this.lastWaitingRequests,
    };
  }

  reset(): void {
    this.totalAcquires = 0;
    this.totalReleases = 0;
    this.totalTimeouts = 0;
    this.totalErrors = 0;
    this.totalAcquireTimeMs = 0;
    this.maxAcquireTimeMs = 0;
    this.totalHeldTimeMs = 0;
    this.maxHeldTimeMs = 0;
    this.lastActiveConnections = 0;
    this.lastIdleConnections = 0;
    this.lastWaitingRequests = 0;
  }

  private updatePoolStats(event: { poolStats: { total: number; idle: number; waiting: number } }): void {
    this.lastActiveConnections = event.poolStats.total - event.poolStats.idle;
    this.lastIdleConnections = event.poolStats.idle;
    this.lastWaitingRequests = event.poolStats.waiting;
  }
}
