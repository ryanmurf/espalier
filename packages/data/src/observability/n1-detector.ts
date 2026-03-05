import { AsyncLocalStorage } from "node:async_hooks";
import { getGlobalLogger, LogLevel } from "espalier-jdbc";

/**
 * Configuration for N+1 query detection.
 */
export interface N1DetectionConfig {
  /** Enable N+1 detection. Default: false. */
  enabled?: boolean;
  /** Number of repeated query pattern executions before flagging. Default: 5. */
  threshold?: number;
  /** 'warn' logs a warning; 'strict' throws an N1DetectionError. Default: 'warn'. */
  mode?: "warn" | "strict";
  /** Optional callback invoked when an N+1 pattern is detected. */
  callback?: (event: N1DetectionEvent) => void;
}

/**
 * Event emitted when an N+1 query pattern is detected.
 */
export interface N1DetectionEvent {
  /** The normalized SQL pattern that triggered detection. */
  pattern: string;
  /** Number of times the pattern was executed in this scope. */
  count: number;
  /** The threshold that was exceeded. */
  threshold: number;
  /** The operation scope name (if set via withScope). */
  scopeName?: string;
  /** Suggested fix. */
  suggestion: string;
}

/**
 * Error thrown in 'strict' mode when an N+1 pattern is detected.
 */
export class N1DetectionError extends Error {
  readonly event: N1DetectionEvent;

  constructor(event: N1DetectionEvent) {
    super(
      `N+1 query detected: pattern executed ${event.count} times (threshold: ${event.threshold}). ` +
        `${event.suggestion}`,
    );
    this.name = "N1DetectionError";
    this.event = event;
  }
}

/**
 * Internal state for a single scope.
 */
interface ScopeState {
  name?: string;
  /** Map from normalized SQL pattern to execution count. */
  patterns: Map<string, number>;
  /** Set of patterns already reported (to avoid duplicate warnings). */
  reported: Set<string>;
}

/**
 * Normalizes SQL by replacing literal values with placeholders.
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.)*'/g, "'?'")
    .replace(/\b0x[0-9a-f]+\b/gi, "?")
    .replace(/(?<![a-zA-Z_])\d+(\.\d+)?(?![a-zA-Z_])/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts entity/relation hints from SQL for better suggestions.
 */
function extractEntityHint(sql: string): string {
  const fromMatch = sql.match(/FROM\s+"?(\w+)"?/i);
  if (fromMatch) return fromMatch[1];
  return "unknown table";
}

/**
 * Detects N+1 query patterns within scoped operations.
 *
 * Usage:
 * ```
 * const detector = new N1Detector({ enabled: true, threshold: 5 });
 *
 * // Wrap operations in a scope
 * await detector.withScope('loadUsers', async () => {
 *   // queries executed here are tracked
 * });
 *
 * // Or manually record queries
 * detector.record('SELECT * FROM orders WHERE user_id = $1');
 * ```
 */
export class N1Detector {
  private readonly enabled: boolean;
  private readonly threshold: number;
  private readonly mode: "warn" | "strict";
  private readonly callback?: (event: N1DetectionEvent) => void;
  private readonly storage = new AsyncLocalStorage<ScopeState>();
  private readonly logger = getGlobalLogger().child("n1-detector");

  constructor(config?: N1DetectionConfig) {
    this.enabled = config?.enabled ?? false;
    this.threshold = config?.threshold ?? 5;
    this.mode = config?.mode ?? "warn";
    this.callback = config?.callback;
  }

  /**
   * Whether the detector is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Run an operation within a named scope. All queries recorded inside
   * the callback are grouped and checked for N+1 patterns.
   */
  async withScope<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();

    const state: ScopeState = {
      name,
      patterns: new Map(),
      reported: new Set(),
    };

    return this.storage.run(state, fn);
  }

  /**
   * Synchronous version of withScope for non-async code.
   */
  withScopeSync<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();

    const state: ScopeState = {
      name,
      patterns: new Map(),
      reported: new Set(),
    };

    return this.storage.run(state, fn);
  }

  /**
   * Record a query execution. If inside a scope, checks for N+1 patterns.
   * Can also be called outside a scope (no-op when outside scope or disabled).
   */
  record(sql: string): void {
    if (!this.enabled) return;

    const state = this.storage.getStore();
    if (!state) return;

    const pattern = normalizeSql(sql);
    const count = (state.patterns.get(pattern) ?? 0) + 1;
    state.patterns.set(pattern, count);

    if (count >= this.threshold && !state.reported.has(pattern)) {
      state.reported.add(pattern);
      const entity = extractEntityHint(pattern);
      const event: N1DetectionEvent = {
        pattern,
        count,
        threshold: this.threshold,
        scopeName: state.name,
        suggestion:
          `Consider using eager fetching (fetch: "EAGER") or batch loading (fetch: "BATCH") ` +
          `for the relation that queries "${entity}". ` +
          `You can also use findAllStream() or configure @OneToMany/@ManyToOne with batch fetch strategy.`,
      };

      this.callback?.(event);

      if (this.mode === "strict") {
        throw new N1DetectionError(event);
      }

      if (this.logger.isEnabled(LogLevel.WARN)) {
        this.logger.warn("N+1 query pattern detected", {
          pattern: pattern.length > 200 ? pattern.slice(0, 200) + "..." : pattern,
          count,
          threshold: this.threshold,
          scope: state.name,
        });
      }
    }
  }

  /**
   * Get current scope statistics (for testing/debugging).
   * Returns undefined if not in a scope.
   */
  getScopeStats(): Map<string, number> | undefined {
    const state = this.storage.getStore();
    return state ? new Map(state.patterns) : undefined;
  }

  /**
   * Reset the current scope's pattern tracking.
   */
  resetScope(): void {
    const state = this.storage.getStore();
    if (state) {
      state.patterns.clear();
      state.reported.clear();
    }
  }
}
