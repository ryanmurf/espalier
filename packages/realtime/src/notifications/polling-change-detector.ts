import type { DataSource } from "espalier-jdbc";
import type { ChangeNotification, PollingOptions } from "./types.js";

const MIN_POLL_INTERVAL = 100;
const MAX_POLL_INTERVAL = 60_000;

/**
 * Fallback change detector for non-PostgreSQL databases that polls for changes
 * at a configurable interval.
 *
 * The provided query should return rows representing changes since the last poll.
 * Each row is serialized to JSON and emitted as a ChangeNotification.
 */
export class PollingChangeDetector {
  private readonly dataSource: DataSource;
  private readonly intervalMs: number;
  private readonly query: string;
  private readonly params: unknown[];
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(dataSource: DataSource, options: PollingOptions) {
    this.dataSource = dataSource;
    this.intervalMs = clampInterval(options.intervalMs);
    this.query = options.query;
    this.params = options.params ?? [];
  }

  /**
   * Watch for changes by polling the database at the configured interval.
   * Yields ChangeNotification objects for each row returned by the polling query.
   */
  async *watch(channel: string): AsyncIterable<ChangeNotification> {
    if (this.closed) {
      throw new Error("PollingChangeDetector has been closed");
    }
    if (this.abortController) {
      throw new Error("PollingChangeDetector is already watching");
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      while (!signal.aborted) {
        const connection = await this.dataSource.getConnection();
        try {
          const stmt = connection.prepareStatement(this.query);
          for (let i = 0; i < this.params.length; i++) {
            stmt.setParameter(i + 1, this.params[i] as string | number | boolean | null);
          }
          const rs = await stmt.executeQuery();
          const rows: Record<string, unknown>[] = [];
          while (await rs.next()) {
            rows.push(rs.getRow());
          }
          await rs.close();

          for (const row of rows) {
            yield {
              channel,
              payload: JSON.stringify(row),
              timestamp: new Date(),
            };
          }
        } finally {
          await connection.close();
        }

        // Wait for the polling interval or abort
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.intervalMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.abortController?.abort();
  }

  /**
   * Permanently close this detector.
   */
  close(): void {
    this.closed = true;
    this.stop();
  }
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_POLL_INTERVAL;
  return Math.max(MIN_POLL_INTERVAL, Math.min(MAX_POLL_INTERVAL, ms));
}
