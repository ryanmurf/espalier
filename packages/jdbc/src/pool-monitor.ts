import type { PoolStats } from "./pool.js";

export interface PoolEvent {
  timestamp: Date;
  poolStats: PoolStats;
}

export interface AcquireEvent extends PoolEvent {
  acquireTimeMs: number;
}

export interface ReleaseEvent extends PoolEvent {
  heldTimeMs: number;
}

export interface TimeoutEvent extends PoolEvent {
  waitTimeMs: number;
}

export interface ErrorEvent extends PoolEvent {
  error: Error;
  context: "acquire" | "release" | "idle" | "query" | "prePing";
}

export type PoolEventListener<T extends PoolEvent> = (event: T) => void;

export interface PoolMonitor {
  onAcquire(listener: PoolEventListener<AcquireEvent>): void;
  onRelease(listener: PoolEventListener<ReleaseEvent>): void;
  onTimeout(listener: PoolEventListener<TimeoutEvent>): void;
  onError(listener: PoolEventListener<ErrorEvent>): void;
  removeAllListeners(): void;
}
