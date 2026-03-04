/**
 * Statistics for a single query pattern.
 */
export interface QueryStatistics {
  /** Normalized SQL pattern (literals replaced with ?). */
  pattern: string;
  /** Number of times this pattern was executed. */
  count: number;
  /** Total execution time in ms. */
  totalTime: number;
  /** Average execution time in ms. */
  avgTime: number;
  /** Maximum execution time in ms. */
  maxTime: number;
  /** Minimum execution time in ms. */
  minTime: number;
  /** 95th percentile execution time in ms. */
  p95: number;
  /** 99th percentile execution time in ms. */
  p99: number;
}

interface PatternStats {
  count: number;
  totalTime: number;
  maxTime: number;
  minTime: number;
  /** Sorted array of durations for percentile calculation. */
  durations: number[];
}

/**
 * Normalizes SQL by replacing literal values with placeholders.
 * Groups queries by their structural pattern.
 */
function normalizeSql(sql: string): string {
  return sql
    // Replace string literals
    .replace(/'[^']*'/g, "'?'")
    // Replace numeric literals (integers and decimals)
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Collects per-query-pattern execution statistics.
 */
export class QueryStatisticsCollector {
  private readonly stats = new Map<string, PatternStats>();
  private readonly maxPatterns: number;

  constructor(maxPatterns = 1000) {
    this.maxPatterns = maxPatterns;
  }

  /**
   * Records a query execution.
   */
  record(sql: string, durationMs: number): void {
    const pattern = normalizeSql(sql);
    let entry = this.stats.get(pattern);

    if (!entry) {
      if (this.stats.size >= this.maxPatterns) return; // prevent unbounded growth
      entry = { count: 0, totalTime: 0, maxTime: 0, minTime: Infinity, durations: [] };
      this.stats.set(pattern, entry);
    }

    entry.count++;
    entry.totalTime += durationMs;
    entry.maxTime = Math.max(entry.maxTime, durationMs);
    entry.minTime = Math.min(entry.minTime, durationMs);

    // Insert into sorted position for percentile calculation
    const insertIdx = binarySearchInsert(entry.durations, durationMs);
    entry.durations.splice(insertIdx, 0, durationMs);
  }

  /**
   * Returns statistics for all collected query patterns, sorted by total time descending.
   */
  getStatistics(): QueryStatistics[] {
    const result: QueryStatistics[] = [];
    for (const [pattern, entry] of this.stats) {
      result.push({
        pattern,
        count: entry.count,
        totalTime: entry.totalTime,
        avgTime: entry.count > 0 ? entry.totalTime / entry.count : 0,
        maxTime: entry.maxTime,
        minTime: entry.minTime === Infinity ? 0 : entry.minTime,
        p95: percentile(entry.durations, 95),
        p99: percentile(entry.durations, 99),
      });
    }
    return result.sort((a, b) => b.totalTime - a.totalTime);
  }

  /**
   * Returns the top N slowest query patterns by total time.
   */
  getTopN(n: number): QueryStatistics[] {
    return this.getStatistics().slice(0, n);
  }

  /**
   * Clears all collected statistics.
   */
  reset(): void {
    this.stats.clear();
  }
}

function binarySearchInsert(arr: number[], val: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < val) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
